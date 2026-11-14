-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.12 — PHASE 2A: TOKEN-CHECKED READ RPCS (STAGED ROLLOUT)
-- ═══════════════════════════════════════════════════════════════════
-- Safe to run BEFORE Phase 2B lockdown:
--   - Does NOT drop existing public SELECT policies or change table grants yet.
--   - Does NOT modify _fj_verify_org_token yet (scheduled for Phase 2B).
--   - Adds token-verified SECURITY DEFINER read RPCs for:
--       1. read_organization (own org only)
--       2. read_events (org-scoped)
--       3. read_judges (org-scoped; NEVER returns pin or current_session_token)
--       4. read_participants (org-scoped; NEVER returns mobile_number; enforces blind_judging_enabled for judges)
--       5. read_event_scores (single-event scoped; enforces blind_judging_enabled & isolated_jury_enabled for judges)
--       6. read_score_for_ballot (single-ballot scoped; enforces judge ownership)
--       7. read_org_scores (organiser-only org-scoped scores replacing getAllScores)
--       8. read_can_delete_event (organiser-only event score existence check)
--       9. read_org_roster_credentials (organiser-only roster export/QR management with pin & mobile_number; NEVER returns current_session_token)
--   - Includes verification query at the bottom.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ─────────────────────────────────────────────────────────────────
-- 0. INTERNAL UNIFIED READ TOKEN VERIFIER (Org OR Judge)
-- ─────────────────────────────────────────────────────────────────
create or replace function public._fj_verify_read_token(
  p_token text,
  p_org_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_judge_auth jsonb;
  v_judge_org text;
begin
  -- 1. Check Organiser session token first
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is not null then
    return jsonb_build_object(
      'ok', true,
      'role', 'organiser',
      'org_id', v_org_id,
      'judge_id', null
    );
  end if;

  -- If an explicit org filter was requested and org token existed for a DIFFERENT org, reject
  if p_org_id is not null and btrim(p_org_id) <> '' and public._fj_verify_org_token(p_token, null) is not null then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  -- 2. Check Judge session token
  v_judge_auth := public._fj_verify_judge_token(p_token);
  if coalesce((v_judge_auth->>'ok')::boolean, false) then
    v_judge_org := v_judge_auth->>'org_id';
    if p_org_id is not null and btrim(p_org_id) <> '' and upper(v_judge_org) <> upper(btrim(p_org_id)) then
      return jsonb_build_object('ok', false, 'error', 'forbidden');
    end if;

    return jsonb_build_object(
      'ok', true,
      'role', 'judge',
      'org_id', v_judge_org,
      'judge_id', v_judge_auth->>'judge_id'
    );
  end if;

  return jsonb_build_object('ok', false, 'error', 'unauthorized');
end;
$$;

revoke all on function public._fj_verify_read_token(text, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 1. read_organization (Own org only)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.read_organization(
  p_token text,
  p_org_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_auth jsonb;
  v_org_id text;
  v_role text;
  v_row public.organizations;
  v_out jsonb;
begin
  v_auth := public._fj_verify_read_token(p_token, p_org_id);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_org_id := v_auth->>'org_id';
  v_role := v_auth->>'role';

  select * into v_row
  from public.organizations o
  where upper(o.org_id) = upper(v_org_id)
  limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', true, 'data', null, 'not_found', true);
  end if;

  v_out := to_jsonb(v_row) - 'password';
  if v_role = 'judge' then
    -- Strip organiser email from judge-terminal org responses
    v_out := v_out - 'email';
  end if;

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.read_organization(text, text) from public;
grant execute on function public.read_organization(text, text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 2. read_events (Strictly org-scoped)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.read_events(
  p_token text,
  p_event_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_auth jsonb;
  v_org_id text;
  v_out jsonb;
begin
  v_auth := public._fj_verify_read_token(p_token, null);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_org_id := v_auth->>'org_id';

  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb)
  into v_out
  from public.events e
  where upper(e.org_id) = upper(v_org_id)
    and (p_event_id is null or e.id = p_event_id);

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.read_events(text, uuid) from public;
grant execute on function public.read_events(text, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 3. read_judges (Strictly org-scoped; NEVER exposes pin or current_session_token)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.read_judges(
  p_token text,
  p_judge_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_auth jsonb;
  v_org_id text;
  v_out jsonb;
begin
  v_auth := public._fj_verify_read_token(p_token, null);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_org_id := v_auth->>'org_id';

  select coalesce(
    jsonb_agg(
      (to_jsonb(j) - 'pin' - 'current_session_token')
      order by j.created_at desc
    ),
    '[]'::jsonb
  )
  into v_out
  from public.judges j
  where upper(j.org_id) = upper(v_org_id)
    and (p_judge_id is null or j.id = p_judge_id);

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.read_judges(text, uuid) from public;
grant execute on function public.read_judges(text, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 4. read_participants (Strictly org-scoped; NEVER exposes mobile_number;
--    also masks name/school/class_or_age/custom_values for judges in blind mode)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.read_participants(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_auth jsonb;
  v_org_id text;
  v_role text;
  v_blind boolean := false;
  v_out jsonb;
begin
  v_auth := public._fj_verify_read_token(p_token, null);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_org_id := v_auth->>'org_id';
  v_role := v_auth->>'role';

  if v_role = 'judge' then
    select coalesce(o.blind_judging_enabled, false)
    into v_blind
    from public.organizations o
    where upper(o.org_id) = upper(v_org_id)
    limit 1;
  end if;

  select coalesce(
    jsonb_agg(
      case
        when v_role = 'judge' and v_blind then
          (to_jsonb(p) - 'mobile_number') || jsonb_build_object(
            'name', 'Anonymous',
            'school', '',
            'class_or_age', null,
            'custom_values', '{}'::jsonb
          )
        else
          (to_jsonb(p) - 'mobile_number')
      end
      order by p.created_at asc
    ),
    '[]'::jsonb
  )
  into v_out
  from public.participants p
  where upper(p.org_id) = upper(v_org_id);

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.read_participants(text) from public;
grant execute on function public.read_participants(text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 5. read_event_scores (Single event scoped; server enforces blind
--    judging & isolated jury rules so judges only see own scores)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.read_event_scores(
  p_token text,
  p_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_auth jsonb;
  v_org_id text;
  v_role text;
  v_judge_id uuid;
  v_event_org text;
  v_blind boolean := false;
  v_isolated boolean := false;
  v_out jsonb;
begin
  v_auth := public._fj_verify_read_token(p_token, null);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_org_id := v_auth->>'org_id';
  v_role := v_auth->>'role';
  if v_role = 'judge' and nullif(v_auth->>'judge_id', '') is not null then
    v_judge_id := (v_auth->>'judge_id')::uuid;
  end if;

  select e.org_id into v_event_org
  from public.events e
  where e.id = p_event_id
  limit 1;

  if v_event_org is null then
    return jsonb_build_object('ok', true, 'data', '[]'::jsonb, 'not_found', true);
  end if;

  if upper(v_event_org) <> upper(v_org_id) then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Cannot read scores from another organization.');
  end if;

  if v_role = 'judge' then
    select coalesce(o.blind_judging_enabled, false), coalesce(o.isolated_jury_enabled, false)
    into v_blind, v_isolated
    from public.organizations o
    where upper(o.org_id) = upper(v_org_id)
    limit 1;
  end if;

  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at asc), '[]'::jsonb)
  into v_out
  from public.scores s
  where s.event_id = p_event_id
    and (
      v_role = 'organiser'
      or (not v_blind and not v_isolated)
      or s.judge_id = v_judge_id
    );

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.read_event_scores(text, uuid) from public;
grant execute on function public.read_event_scores(text, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 6. read_score_for_ballot (Single ballot lookup with strict ownership check)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.read_score_for_ballot(
  p_token text,
  p_event_id uuid,
  p_judge_id uuid,
  p_participant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_auth jsonb;
  v_org_id text;
  v_role text;
  v_token_judge_id uuid;
  v_event_org text;
  v_row public.scores;
begin
  v_auth := public._fj_verify_read_token(p_token, null);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_org_id := v_auth->>'org_id';
  v_role := v_auth->>'role';
  if v_role = 'judge' and nullif(v_auth->>'judge_id', '') is not null then
    v_token_judge_id := (v_auth->>'judge_id')::uuid;
  end if;

  select e.org_id into v_event_org
  from public.events e
  where e.id = p_event_id
  limit 1;

  if v_event_org is null then
    return jsonb_build_object('ok', true, 'data', null, 'not_found', true);
  end if;

  if upper(v_event_org) <> upper(v_org_id) then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Cannot read scores from another organization.');
  end if;

  if v_role = 'judge' and p_judge_id <> v_token_judge_id then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Judges may only inspect their own ballots.');
  end if;

  select * into v_row
  from public.scores s
  where s.event_id = p_event_id
    and s.judge_id = p_judge_id
    and s.participant_id = p_participant_id
  limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', true, 'data', null, 'not_found', true);
  end if;

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
end;
$$;

revoke all on function public.read_score_for_ballot(text, uuid, uuid, uuid) from public;
grant execute on function public.read_score_for_ballot(text, uuid, uuid, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 7. read_org_scores (Organiser-only org-scoped scores replacing getAllScores)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.read_org_scores(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_out jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Organiser session expired or invalid. Please sign in again.'
    );
  end if;

  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at asc), '[]'::jsonb)
  into v_out
  from public.scores s
  join public.events e on e.id = s.event_id
  where upper(e.org_id) = upper(v_org_id);

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.read_org_scores(text) from public;
grant execute on function public.read_org_scores(text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 8. read_can_delete_event (Organiser-only score existence check)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.read_can_delete_event(
  p_token text,
  p_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_event_org text;
  v_has_scores boolean;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  select e.org_id into v_event_org
  from public.events e
  where e.id = p_event_id
  limit 1;

  if v_event_org is null or upper(v_event_org) <> upper(v_org_id) then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Event not found or access denied.');
  end if;

  select exists(
    select 1 from public.scores s where s.event_id = p_event_id
  ) into v_has_scores;

  return jsonb_build_object('ok', true, 'can_delete', not coalesce(v_has_scores, false));
end;
$$;

revoke all on function public.read_can_delete_event(text, uuid) from public;
grant execute on function public.read_can_delete_event(text, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 9. read_org_roster_credentials (Organiser-only management & backup)
--    Strictly requires org_sessions token (rejects judge tokens).
--    Still NEVER exposes judges.current_session_token.
-- ─────────────────────────────────────────────────────────────────
create or replace function public.read_org_roster_credentials(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_judges jsonb;
  v_participants jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Organiser session expired or invalid. Please sign in again.'
    );
  end if;

  select coalesce(
    jsonb_agg((to_jsonb(j) - 'current_session_token') order by j.created_at desc),
    '[]'::jsonb
  )
  into v_judges
  from public.judges j
  where upper(j.org_id) = upper(v_org_id);

  select coalesce(
    jsonb_agg(to_jsonb(p) order by p.created_at asc),
    '[]'::jsonb
  )
  into v_participants
  from public.participants p
  where upper(p.org_id) = upper(v_org_id);

  return jsonb_build_object(
    'ok', true,
    'judges', v_judges,
    'participants', v_participants
  );
end;
$$;

revoke all on function public.read_org_roster_credentials(text) from public;
grant execute on function public.read_org_roster_credentials(text) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION QUERY (Run after applying above in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════════
-- 1) Verify all 9 Phase 2A read functions exist and are SECURITY DEFINER:
select
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as args,
  p.prosecdef as is_security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    '_fj_verify_read_token',
    'read_organization',
    'read_events',
    'read_judges',
    'read_participants',
    'read_event_scores',
    'read_score_for_ballot',
    'read_org_scores',
    'read_can_delete_event',
    'read_org_roster_credentials'
  )
order by p.proname;

-- 2) Verify unauthenticated/bogus-token calls are rejected:
select public.read_organization('invalid-token', null) as invalid_org_check,
       public.read_events('invalid-token', null) as invalid_events_check,
       public.read_judges('invalid-token', null) as invalid_judges_check,
       public.read_participants('invalid-token') as invalid_participants_check,
       public.read_org_scores('invalid-token') as invalid_org_scores_check;

-- 3) Verify Phase 2A left existing SELECT policies untouched (should list all 5):
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('organizations', 'events', 'judges', 'participants', 'scores')
  and cmd = 'SELECT'
order by tablename, policyname;
