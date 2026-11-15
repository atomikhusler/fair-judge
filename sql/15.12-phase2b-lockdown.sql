-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.12 — PHASE 2B: READ POLICY LOCKDOWN & SUSPENDED-ORG TOKEN CHECK
-- ═══════════════════════════════════════════════════════════════════
-- Prerequisites:
--   - sql/15.12-phase2a-read-rpcs.sql is live and verified (all 9 read_* RPCs).
--   - Client has been updated to use token-checked read RPCs and org-scoped realtime.
--
-- What this migration does:
--   1. Updates _fj_verify_org_token to reject suspended or soft-deleted organisations.
--   2. Updates _fj_verify_judge_token to reject suspended/deleted orgs & inactive judges.
--   3. Adds read_org_sync_stamp(p_token) (org-scoped change hashes, zero PII) so
--      clients detect remote/admin updates reliably after public SELECT policies drop.
--   4. Updates fj_health() with public_select_policies count.
--   5. Drops public SELECT policies on events, judges, participants, scores,
--      and organizations (organizations_select_anon), while keeping
--      organizations_select_admin (authenticated + is_platform_admin()).
--   6. Revokes direct SELECT/INSERT/UPDATE/DELETE grants from anon (and non-admin roles).
--   7. Includes verification queries at the bottom.
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- 1. HARDEN _fj_verify_org_token (Reject suspended & deleted orgs)
-- ─────────────────────────────────────────────────────────────────
create or replace function public._fj_verify_org_token(p_token text, p_org_id text default null)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tok text;
  v_org_id text;
  v_suspended boolean;
  v_deleted_at timestamptz;
begin
  v_tok := btrim(coalesce(p_token, ''));
  if v_tok = '' then
    return null;
  end if;

  select
    s.org_id,
    coalesce(o.suspended, false),
    o.deleted_at
  into v_org_id, v_suspended, v_deleted_at
  from public.org_sessions s
  join public.organizations o on upper(o.org_id) = upper(s.org_id)
  where s.token = v_tok
    and s.expires_at > now()
  limit 1;

  if v_org_id is null then
    return null;
  end if;

  -- Reject suspended or deleted organisations immediately on every RPC call
  if v_deleted_at is not null or v_suspended then
    return null;
  end if;

  if p_org_id is not null and btrim(p_org_id) <> '' and upper(v_org_id) <> upper(btrim(p_org_id)) then
    return null;
  end if;

  return v_org_id;
end;
$$;

revoke all on function public._fj_verify_org_token(text, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 2. HARDEN _fj_verify_judge_token (Reject suspended/deleted orgs & inactive judges)
-- ─────────────────────────────────────────────────────────────────
create or replace function public._fj_verify_judge_token(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tok text;
  v_rec record;
begin
  v_tok := btrim(coalesce(p_token, ''));
  if v_tok = '' then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  select
    s.judge_id,
    s.org_id,
    coalesce(o.suspended, false) as org_suspended,
    o.deleted_at as org_deleted_at,
    coalesce((to_jsonb(j)->>'is_active')::boolean, true) as judge_active
  into v_rec
  from public.judge_sessions s
  join public.organizations o on upper(o.org_id) = upper(s.org_id)
  join public.judges j on j.id = s.judge_id and upper(j.org_id) = upper(s.org_id)
  where s.token = v_tok
    and s.expires_at > now()
  limit 1;

  if v_rec.judge_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  if v_rec.org_deleted_at is not null or v_rec.org_suspended or not v_rec.judge_active then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  return jsonb_build_object('ok', true, 'judge_id', v_rec.judge_id, 'org_id', v_rec.org_id);
end;
$$;

revoke all on function public._fj_verify_judge_token(text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 3. LIGHTWEIGHT ORG-SCOPED CHANGE STAMP (Zero PII, replaces postgres_changes)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.read_org_sync_stamp(
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
  v_org_sig text;
  v_events_sig text;
  v_judges_sig text;
  v_participants_sig text;
  v_scores_sig text;
begin
  v_auth := public._fj_verify_read_token(p_token, null);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Session expired or invalid.'
    );
  end if;

  v_org_id := v_auth->>'org_id';

  select coalesce(md5((to_jsonb(o) - 'password')::text), '0')
  into v_org_sig
  from public.organizations o
  where upper(o.org_id) = upper(v_org_id)
  limit 1;

  select coalesce(
    md5(
      string_agg(
        (to_jsonb(e))::text,
        '|' order by e.id
      )
    ),
    '0'
  )
  into v_events_sig
  from public.events e
  where upper(e.org_id) = upper(v_org_id);

  select coalesce(
    md5(
      string_agg(
        (to_jsonb(j) - 'pin' - 'current_session_token')::text,
        '|' order by j.id
      )
    ),
    '0'
  )
  into v_judges_sig
  from public.judges j
  where upper(j.org_id) = upper(v_org_id);

  select coalesce(
    md5(
      string_agg(
        (to_jsonb(p) - 'mobile_number')::text,
        '|' order by p.id
      )
    ),
    '0'
  )
  into v_participants_sig
  from public.participants p
  where upper(p.org_id) = upper(v_org_id);

  select count(*)::text || ':' || coalesce(max(s.created_at)::text, '0') || ':' || coalesce(sum(s.total_score)::text, '0')
  into v_scores_sig
  from public.scores s
  join public.events e on e.id = s.event_id
  where upper(e.org_id) = upper(v_org_id);

  return jsonb_build_object(
    'ok', true,
    'org_id', v_org_id,
    'organizations', coalesce(v_org_sig, '0'),
    'events', coalesce(v_events_sig, '0'),
    'judges', coalesce(v_judges_sig, '0'),
    'participants', coalesce(v_participants_sig, '0'),
    'scores', coalesce(v_scores_sig, '0')
  );
end;
$$;

revoke all on function public.read_org_sync_stamp(text) from public;
grant execute on function public.read_org_sync_stamp(text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 4. SYNC fj_health() METADATA
-- ─────────────────────────────────────────────────────────────────
create or replace function public.fj_health()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rls jsonb;
  v_public_select_count int;
begin
  select jsonb_object_agg(relname, rowsecurity)
  into v_rls
  from pg_class
  join pg_namespace n on n.oid = pg_class.relnamespace
  where n.nspname = 'public'
    and relname in ('organizations', 'org_secrets', 'org_login_throttle', 'events', 'judges', 'participants', 'scores');

  select count(*)
  into v_public_select_count
  from pg_policies
  where schemaname = 'public'
    and cmd = 'SELECT'
    and (
      tablename in ('events', 'judges', 'participants', 'scores')
      or (tablename = 'organizations' and 'anon' = any(roles))
      or (tablename = 'organizations' and 'public' = any(roles))
    );

  return jsonb_build_object(
    'ok', true,
    'rls_enabled', coalesce(v_rls, '{}'::jsonb),
    'triggers', jsonb_build_object('roster_guard', true),
    'public_select_policies', coalesce(v_public_select_count, 0)
  );
end;
$$;

revoke all on function public.fj_health() from public;
grant execute on function public.fj_health() to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 5. DROP PUBLIC SELECT POLICIES & LOCK DOWN TABLE PRIVILEGES
-- ─────────────────────────────────────────────────────────────────
alter table public.organizations enable row level security;
alter table public.events enable row level security;
alter table public.judges enable row level security;
alter table public.participants enable row level security;
alter table public.scores enable row level security;

-- Drop public / anon SELECT policies on organizations (keep organizations_select_admin for authenticated admins)
drop policy if exists "organizations_select" on public.organizations;
drop policy if exists "organizations_select_anon" on public.organizations;

-- Ensure organizations_select_admin exists for Super Admin authenticated role
drop policy if exists "organizations_select_admin" on public.organizations;
create policy "organizations_select_admin"
  on public.organizations
  for select
  to authenticated
  using (public.is_platform_admin());

-- Drop public SELECT policies on events, judges, participants, scores
drop policy if exists "events_select" on public.events;
drop policy if exists "Enable read/write for events" on public.events;
drop policy if exists "Enable read for events" on public.events;

drop policy if exists "judges_select" on public.judges;
drop policy if exists "Enable read/write for judges" on public.judges;
drop policy if exists "Enable read for judges" on public.judges;

drop policy if exists "participants_select" on public.participants;
drop policy if exists "Enable read/write for participants" on public.participants;
drop policy if exists "Enable read for participants" on public.participants;

drop policy if exists "scores_select" on public.scores;
drop policy if exists "Enable read for scores" on public.scores;

-- Revoke direct table privileges from anon, authenticated, public
revoke select, insert, update, delete on table public.events from anon, authenticated, public;
revoke select, insert, update, delete on table public.judges from anon, authenticated, public;
revoke select, insert, update, delete on table public.participants from anon, authenticated, public;
revoke select, insert, update, delete on table public.scores from anon, authenticated, public;
revoke select, insert, update, delete on table public.organizations from anon, public;
revoke insert, update, delete on table public.organizations from authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION QUERIES (Run after applying above in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════════
-- 1) Confirm ONLY organizations_select_admin remains for SELECT on the 5 core tables:
select schemaname, tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and tablename in ('organizations', 'events', 'judges', 'participants', 'scores')
  and cmd = 'SELECT'
order by tablename, policyname;

-- 2) Confirm anon has ZERO direct privileges on the 5 core tables (should return 0 rows):
select table_name, grantee, privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and grantee = 'anon'
  and table_name in ('organizations', 'events', 'judges', 'participants', 'scores')
order by table_name, privilege_type;

-- 3) Confirm read_org_sync_stamp exists and rejects invalid tokens:
select public.read_org_sync_stamp('invalid-token') as invalid_stamp_check;

-- 4) Confirm _fj_verify_org_token and _fj_verify_judge_token check suspended & deleted_at:
select p.proname,
       (pg_get_functiondef(p.oid) ilike '%suspended%') as checks_suspended,
       (pg_get_functiondef(p.oid) ilike '%deleted_at%') as checks_deleted
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('_fj_verify_org_token', '_fj_verify_judge_token')
order by p.proname;
