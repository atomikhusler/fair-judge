-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 17.7.0 PART B1 — TIE DECISIONS DATABASE MIGRATION (WRITE ONLY — DO NOT AUTO-RUN)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Run each PART independently in the Supabase SQL Editor.
-- Each PART ends with a read-only single-cell JSONB verification query.
-- Hard rules:
--   - NO note column on public.tie_decisions.
--   - RLS ON and zero direct grants on public.tie_decisions.
--   - All organiser RPCs verify the organiser token via public._fj_verify_org_token.
--   - Projector RPC (projector_changes) returns ONLY id, event_id, group_key, mode,
--     ordered_participant_ids, score_fingerprint, decided_at, version — NEVER decided_by,
--     phone numbers, PINs, passwords, or organiser tokens.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ===============================================================================
-- PART 1: public.tie_decisions TABLE, RLS, ZERO DIRECT GRANTS & SYNC TRIGGERS
-- ===============================================================================

create table if not exists public.tie_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  event_id uuid not null references public.events(id) on delete cascade,
  group_key text not null,
  mode text not null check (mode in ('shared', 'olympic', 'manual')),
  ordered_participant_ids text[] not null default '{}'::text[],
  score_fingerprint text not null default '',
  decided_by text not null default '',
  decided_at timestamptz not null default now(),
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  constraint uq_tie_decisions_event_group unique (event_id, group_key)
);

create index if not exists idx_tie_decisions_org_ver
  on public.tie_decisions (upper(org_id), version);

create index if not exists idx_tie_decisions_event_ver
  on public.tie_decisions (event_id, version);

alter table public.tie_decisions enable row level security;
revoke all on table public.tie_decisions from public, anon, authenticated;

-- Attach existing sync triggers so changes bump organizations.sync_version and
-- deletions log tombstones into public.sync_deletions (table_name = 'tie_decisions').
drop trigger if exists trg_fj_sync_tie_decisions_version on public.tie_decisions;
create trigger trg_fj_sync_tie_decisions_version
  before insert or update on public.tie_decisions
  for each row
  execute function public._fj_trg_sync_child_upsert();

drop trigger if exists trg_fj_sync_tie_decisions_delete on public.tie_decisions;
create trigger trg_fj_sync_tie_decisions_delete
  after delete on public.tie_decisions
  for each row
  execute function public._fj_trg_sync_child_delete();

-- PART 1 VERIFICATION (read-only, returns ONE jsonb cell)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_1',
  'table_exists', to_regclass('public.tie_decisions') is not null,
  'no_note_column', not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tie_decisions' and column_name = 'note'
  ),
  'unique_event_group', exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('public.tie_decisions')
      and conname = 'uq_tie_decisions_event_group'
  ),
  'rls_enabled', coalesce((
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'tie_decisions'
  ), false),
  'direct_table_grants', (
    select count(*)::int
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'tie_decisions'
      and grantee in ('anon', 'authenticated', 'PUBLIC')
  ),
  'upsert_trigger_exists', exists (
    select 1 from pg_trigger
    where tgrelid = to_regclass('public.tie_decisions')
      and tgname = 'trg_fj_sync_tie_decisions_version'
      and not tgisinternal
  ),
  'delete_trigger_exists', exists (
    select 1 from pg_trigger
    where tgrelid = to_regclass('public.tie_decisions')
      and tgname = 'trg_fj_sync_tie_decisions_delete'
      and not tgisinternal
  )
) as verify_17_7_0_part_1;


-- ===============================================================================
-- PART 2: organizations.tie_management_enabled & EXTENDED org_update RPC
-- ===============================================================================

alter table public.organizations
  add column if not exists tie_management_enabled boolean not null default true;

create or replace function public.org_update(
  p_token text,
  p_org_id text,
  p_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_row public.organizations;
  v_clean_ticker text;
  v_interval int;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  if p_updates ? 'projector_ticker_text' then
    v_clean_ticker := coalesce(p_updates->>'projector_ticker_text', '');
    v_clean_ticker := regexp_replace(v_clean_ticker, '<[^>]*>', '', 'g');
    v_clean_ticker := replace(replace(v_clean_ticker, '<', ''), '>', '');
    v_clean_ticker := regexp_replace(v_clean_ticker, '[\r\n\t]+', ' ', 'g');
    v_clean_ticker := left(btrim(v_clean_ticker), 120);
  end if;

  if p_updates ? 'projector_carousel_interval' then
    v_interval := greatest(15, least(180, coalesce((p_updates->>'projector_carousel_interval')::int, 60)));
  end if;

  update public.organizations
  set
    name = case when p_updates ? 'name' then coalesce(nullif(btrim(p_updates->>'name'), ''), name) else name end,
    email = case when p_updates ? 'email' then nullif(btrim(p_updates->>'email'), '') else email end,
    tie_breaker_enabled = case when p_updates ? 'tie_breaker_enabled' then coalesce((p_updates->>'tie_breaker_enabled')::boolean, tie_breaker_enabled) else tie_breaker_enabled end,
    tie_breaker_method = case when p_updates ? 'tie_breaker_method' then coalesce(p_updates->>'tie_breaker_method', tie_breaker_method) else tie_breaker_method end,
    tie_management_enabled = case when p_updates ? 'tie_management_enabled' then coalesce((p_updates->>'tie_management_enabled')::boolean, tie_management_enabled) else tie_management_enabled end,
    custom_participant_fields = case when p_updates ? 'custom_participant_fields' then coalesce(p_updates->'custom_participant_fields', custom_participant_fields) else custom_participant_fields end,
    blind_judging_enabled = case when p_updates ? 'blind_judging_enabled' then coalesce((p_updates->>'blind_judging_enabled')::boolean, blind_judging_enabled) else blind_judging_enabled end,
    auto_advance_enabled = case when p_updates ? 'auto_advance_enabled' then coalesce((p_updates->>'auto_advance_enabled')::boolean, auto_advance_enabled) else auto_advance_enabled end,
    grace_period_enabled = case when p_updates ? 'grace_period_enabled' then coalesce((p_updates->>'grace_period_enabled')::boolean, grace_period_enabled) else grace_period_enabled end,
    isolated_jury_enabled = case when p_updates ? 'isolated_jury_enabled' then coalesce((p_updates->>'isolated_jury_enabled')::boolean, isolated_jury_enabled) else isolated_jury_enabled end,
    projector_blind_mode = case when p_updates ? 'projector_blind_mode' then coalesce((p_updates->>'projector_blind_mode')::boolean, projector_blind_mode) else projector_blind_mode end,
    projector_spotlight_mode = case when p_updates ? 'projector_spotlight_mode' then coalesce((p_updates->>'projector_spotlight_mode')::boolean, projector_spotlight_mode) else projector_spotlight_mode end,
    projector_ticker_text = case when p_updates ? 'projector_ticker_text' then coalesce(v_clean_ticker, '') else projector_ticker_text end,
    projector_carousel_interval = case when p_updates ? 'projector_carousel_interval' then v_interval else projector_carousel_interval end,
    projector_confetti_at = case when p_updates ? 'projector_confetti_at' then nullif(p_updates->>'projector_confetti_at', '')::timestamptz else projector_confetti_at end
  where upper(org_id) = upper(v_org_id)
  returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'Organization not found.');
  end if;

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row) - 'password');
end;
$$;

revoke all on function public.org_update(text, text, jsonb) from public;
grant execute on function public.org_update(text, text, jsonb) to anon, authenticated;

-- PART 2 VERIFICATION (read-only, returns ONE jsonb cell)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_2',
  'column_exists', exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organizations'
      and column_name = 'tie_management_enabled'
  ),
  'column_default_true', coalesce((
    select column_default ilike '%true%'
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organizations'
      and column_name = 'tie_management_enabled'
  ), false),
  'org_update_supports_tie_management', position(
    'tie_management_enabled' in coalesce(pg_get_functiondef(to_regprocedure('public.org_update(text, text, jsonb)')), '')
  ) > 0,
  'verification_status_absent', position(
    'verification_status' in coalesce(pg_get_functiondef(to_regprocedure('public.org_update(text, text, jsonb)')), '')
  ) = 0
) as verify_17_7_0_part_2;


-- ===============================================================================
-- PART 3: ORGANISER TIE DECISION RPCs, org_reset_all & read_org_changes SYNC
-- ===============================================================================
-- Note: The live organiser delta-sync RPC in Supabase is public.read_org_changes
-- (deployed in sql/15.12-phase4d-simple-sync.sql and called by src/lib/syncEngine.ts).
-- It is extended below so organiser devices receive tie_decisions changes & deletions.

-- 3A. tie_decisions_list
create or replace function public.tie_decisions_list(
  p_token text,
  p_org_id text,
  p_event_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_rows jsonb := '[]'::jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', td.id,
        'org_id', td.org_id,
        'event_id', td.event_id,
        'group_key', td.group_key,
        'mode', td.mode,
        'ordered_participant_ids', coalesce(td.ordered_participant_ids, '{}'::text[]),
        'score_fingerprint', coalesce(td.score_fingerprint, ''),
        'decided_by', coalesce(td.decided_by, ''),
        'decided_at', td.decided_at,
        'version', coalesce(td.version, 1),
        'updated_at', td.updated_at
      )
      order by td.decided_at desc, td.id asc
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.tie_decisions td
  where upper(td.org_id) = upper(v_org_id)
    and (p_event_id is null or td.event_id = p_event_id);

  return jsonb_build_object('ok', true, 'data', v_rows);
end;
$$;

-- 3B. tie_decision_upsert (optimistic concurrency check on p_expected_version)
create or replace function public.tie_decision_upsert(
  p_token text,
  p_org_id text,
  p_event_id uuid,
  p_group_key text,
  p_mode text,
  p_ordered_participant_ids text[],
  p_score_fingerprint text,
  p_expected_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_org_name text;
  v_device_label text;
  v_decided_by text;
  v_group_key text;
  v_mode text;
  v_ordered text[];
  v_fingerprint text;
  v_existing public.tie_decisions;
  v_row public.tie_decisions;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  if p_event_id is null or not exists (
    select 1 from public.events e
    where e.id = p_event_id and upper(e.org_id) = upper(v_org_id)
  ) then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Event not found for this organisation.'
    );
  end if;

  v_group_key := left(btrim(coalesce(p_group_key, '')), 2000);
  if v_group_key = '' then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Missing tie group identifier.'
    );
  end if;

  v_mode := lower(btrim(coalesce(p_mode, '')));
  if v_mode not in ('shared', 'olympic', 'manual') then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Mode must be shared, olympic, or manual.'
    );
  end if;

  v_ordered := coalesce(p_ordered_participant_ids, '{}'::text[]);
  v_fingerprint := left(btrim(coalesce(p_score_fingerprint, '')), 128);

  -- Build safe organiser audit label (never password, PIN, or token)
  select coalesce(nullif(btrim(o.name), ''), v_org_id)
  into v_org_name
  from public.organizations o
  where upper(o.org_id) = upper(v_org_id)
  limit 1;

  select nullif(btrim(s.device_label), '')
  into v_device_label
  from public.org_sessions s
  where s.token_hash = public._fj_hash_org_token(p_token)
    and s.revoked_at is null
  limit 1;

  v_decided_by := left(
    case
      when v_device_label is not null then v_org_name || ' (' || v_device_label || ')'
      else v_org_name
    end,
    120
  );

  -- Lock existing row if present to guard against concurrent organiser edits
  select *
  into v_existing
  from public.tie_decisions td
  where td.event_id = p_event_id
    and td.group_key = v_group_key
  for update;

  if p_expected_version is not null then
    if (v_existing.id is null and p_expected_version > 0)
       or (v_existing.id is not null and coalesce(v_existing.version, 0) <> p_expected_version) then
      return jsonb_build_object(
        'ok', false,
        'error', 'conflict',
        'message', 'This tie decision was updated by another organiser.',
        'current', case
          when v_existing.id is not null then jsonb_build_object(
            'id', v_existing.id,
            'org_id', v_existing.org_id,
            'event_id', v_existing.event_id,
            'group_key', v_existing.group_key,
            'mode', v_existing.mode,
            'ordered_participant_ids', coalesce(v_existing.ordered_participant_ids, '{}'::text[]),
            'score_fingerprint', coalesce(v_existing.score_fingerprint, ''),
            'decided_by', coalesce(v_existing.decided_by, ''),
            'decided_at', v_existing.decided_at,
            'version', coalesce(v_existing.version, 1),
            'updated_at', v_existing.updated_at
          )
          else null
        end
      );
    end if;
  end if;

  if v_existing.id is null then
    insert into public.tie_decisions (
      org_id,
      event_id,
      group_key,
      mode,
      ordered_participant_ids,
      score_fingerprint,
      decided_by,
      decided_at
    )
    values (
      v_org_id,
      p_event_id,
      v_group_key,
      v_mode,
      v_ordered,
      v_fingerprint,
      v_decided_by,
      now()
    )
    returning * into v_row;
  else
    update public.tie_decisions
    set
      mode = v_mode,
      ordered_participant_ids = v_ordered,
      score_fingerprint = v_fingerprint,
      decided_by = v_decided_by,
      decided_at = now()
    where id = v_existing.id
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'id', v_row.id,
      'org_id', v_row.org_id,
      'event_id', v_row.event_id,
      'group_key', v_row.group_key,
      'mode', v_row.mode,
      'ordered_participant_ids', coalesce(v_row.ordered_participant_ids, '{}'::text[]),
      'score_fingerprint', coalesce(v_row.score_fingerprint, ''),
      'decided_by', coalesce(v_row.decided_by, ''),
      'decided_at', v_row.decided_at,
      'version', coalesce(v_row.version, 1),
      'updated_at', v_row.updated_at
    )
  );
end;
$$;

-- 3C. tie_decision_delete
create or replace function public.tie_decision_delete(
  p_token text,
  p_org_id text,
  p_event_id uuid,
  p_group_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_group_key text;
  v_deleted int := 0;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  if p_event_id is null or not exists (
    select 1 from public.events e
    where e.id = p_event_id and upper(e.org_id) = upper(v_org_id)
  ) then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Event not found for this organisation.'
    );
  end if;

  v_group_key := nullif(btrim(coalesce(p_group_key, '')), '');

  if v_group_key is null then
    delete from public.tie_decisions
    where event_id = p_event_id
      and upper(org_id) = upper(v_org_id);
  else
    delete from public.tie_decisions
    where event_id = p_event_id
      and upper(org_id) = upper(v_org_id)
      and group_key = v_group_key;
  end if;

  get diagnostics v_deleted = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_deleted);
end;
$$;

revoke all on function public.tie_decisions_list(text, text, uuid) from public;
grant execute on function public.tie_decisions_list(text, text, uuid) to anon, authenticated;

revoke all on function public.tie_decision_upsert(text, text, uuid, text, text, text[], text, bigint) from public;
grant execute on function public.tie_decision_upsert(text, text, uuid, text, text, text[], text, bigint) to anon, authenticated;

revoke all on function public.tie_decision_delete(text, text, uuid, text) from public;
grant execute on function public.tie_decision_delete(text, text, uuid, text) to anon, authenticated;

-- 3D. Extend org_reset_all to wipe tie_decisions for the org
create or replace function public.org_reset_all(
  p_token text,
  p_org_id text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_auth jsonb;
  v_reason text;

  c_events int := 0;
  c_locked_events int := 0;
  c_judges int := 0;
  c_participants int := 0;
  c_scores int := 0;
  c_tie_decisions int := 0;
  c_judge_sessions int := 0;
  v_sync_version bigint := 1;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_auth := public._fj_verify_org(v_org_id, p_password);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    v_reason := coalesce(v_auth->>'error', v_auth->>'reason', 'invalid_credentials');
    return jsonb_build_object(
      'ok', false,
      'error', v_reason,
      'reason', v_reason,
      'message', case
        when v_reason = 'too_many_attempts'
          then 'Too many wrong password attempts. Try again in 15 minutes.'
        else 'Wrong master password. Nothing was deleted.'
      end
    );
  end if;

  select count(*)::int,
         count(*) filter (where is_locked = true)::int
  into c_events, c_locked_events
  from public.events
  where upper(org_id) = upper(v_org_id);

  select count(*)::int into c_judges
  from public.judges
  where upper(org_id) = upper(v_org_id);

  select count(*)::int into c_participants
  from public.participants
  where upper(org_id) = upper(v_org_id);

  select count(*)::int into c_scores
  from public.scores s
  where upper(coalesce(s.org_id, '')) = upper(v_org_id)
     or s.event_id in (select id from public.events where upper(org_id) = upper(v_org_id));

  select count(*)::int into c_tie_decisions
  from public.tie_decisions td
  where upper(td.org_id) = upper(v_org_id)
     or td.event_id in (select id from public.events where upper(org_id) = upper(v_org_id));

  select count(*)::int into c_judge_sessions
  from public.judge_sessions js
  where upper(js.org_id) = upper(v_org_id)
     or js.judge_id in (select id from public.judges where upper(org_id) = upper(v_org_id));

  update public.events
  set is_locked = false
  where upper(org_id) = upper(v_org_id)
    and is_locked = true;

  delete from public.tie_decisions
  where upper(org_id) = upper(v_org_id)
     or event_id in (select id from public.events where upper(org_id) = upper(v_org_id));

  delete from public.scores
  where event_id in (select id from public.events where upper(org_id) = upper(v_org_id))
     or upper(coalesce(org_id, '')) = upper(v_org_id);

  delete from public.judge_sessions
  where upper(org_id) = upper(v_org_id)
     or judge_id in (select id from public.judges where upper(org_id) = upper(v_org_id));

  delete from public.judge_secrets
  where upper(org_id) = upper(v_org_id)
     or judge_id in (select id from public.judges where upper(org_id) = upper(v_org_id));

  delete from public.judges
  where upper(org_id) = upper(v_org_id);

  delete from public.participants
  where upper(org_id) = upper(v_org_id);

  delete from public.events
  where upper(org_id) = upper(v_org_id);

  v_sync_version := public._fj_bump_org_sync_version(v_org_id);

  return jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'events', c_events,
      'locked_events', c_locked_events,
      'judges', c_judges,
      'participants', c_participants,
      'scores', c_scores,
      'tie_decisions', c_tie_decisions,
      'judge_sessions', c_judge_sessions,
      'sync_version', v_sync_version
    ),
    'events', c_events,
    'locked_events', c_locked_events,
    'judges', c_judges,
    'participants', c_participants,
    'scores', c_scores,
    'tie_decisions', c_tie_decisions,
    'judge_sessions', c_judge_sessions,
    'sync_version', v_sync_version
  );
end;
$$;

-- 3E. Extend read_org_changes so organiser devices receive tie_decisions changes & deletions
create or replace function public.read_org_changes(
  p_token text,
  p_since bigint default 0
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
  v_org public.organizations;
  v_cur_ver bigint;
  v_req_since bigint;
  v_effective_since bigint;
  v_full_resync boolean := false;
  v_blind boolean := false;
  v_isolated boolean := false;
  v_org_json jsonb := null;
  v_events jsonb := '[]'::jsonb;
  v_judges jsonb := '[]'::jsonb;
  v_participants jsonb := '[]'::jsonb;
  v_scores jsonb := '[]'::jsonb;
  v_tie_decisions jsonb := '[]'::jsonb;
  v_deletions jsonb := '[]'::jsonb;
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

  select * into v_org
  from public.organizations o
  where upper(o.org_id) = upper(v_org_id)
  limit 1;

  if v_org.id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Organization not found or unavailable.'
    );
  end if;

  v_cur_ver := greatest(coalesce(v_org.sync_version, 1), 1);
  v_req_since := greatest(coalesce(p_since, 0), 0);

  if v_req_since = v_cur_ver then
    return jsonb_build_object(
      'ok', true,
      'org_id', v_org.org_id,
      'version', v_cur_ver,
      'since', v_req_since,
      'unchanged', true,
      'full_resync', false,
      'organization', null,
      'events', '[]'::jsonb,
      'judges', '[]'::jsonb,
      'participants', '[]'::jsonb,
      'scores', '[]'::jsonb,
      'tie_decisions', '[]'::jsonb,
      'deletions', '[]'::jsonb
    );
  end if;

  if v_req_since = 0 or v_req_since > v_cur_ver then
    v_effective_since := 0;
    v_full_resync := true;
  else
    v_effective_since := v_req_since;
  end if;

  if v_role = 'judge' and v_effective_since > 0 and coalesce(v_org.version, 1) > v_effective_since then
    v_effective_since := 0;
    v_full_resync := true;
  end if;

  if v_role = 'judge' then
    v_blind := coalesce(v_org.blind_judging_enabled, false);
    v_isolated := coalesce(v_org.isolated_jury_enabled, false);
  end if;

  if v_effective_since = 0 or coalesce(v_org.version, 1) > v_effective_since then
    v_org_json := to_jsonb(v_org) - 'password';
    if v_role = 'judge' then
      v_org_json := v_org_json - 'email';
    end if;
  end if;

  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb)
  into v_events
  from public.events e
  where upper(e.org_id) = upper(v_org_id)
    and (v_effective_since = 0 or coalesce(e.version, 1) > v_effective_since);

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', j.id,
        'org_id', j.org_id,
        'name', j.name,
        'judge_id', j.judge_id,
        'assigned_events', coalesce(j.assigned_events, '{}'::text[]),
        'created_at', j.created_at,
        'version', j.version,
        'updated_at', j.updated_at
      )
      || case
           when to_jsonb(j) ? 'is_active' then jsonb_build_object('is_active', to_jsonb(j)->'is_active')
           else '{}'::jsonb
         end
      order by j.created_at desc
    ),
    '[]'::jsonb
  )
  into v_judges
  from public.judges j
  where upper(j.org_id) = upper(v_org_id)
    and (v_effective_since = 0 or coalesce(j.version, 1) > v_effective_since);

  select coalesce(
    jsonb_agg(
      (
        case
          when v_role = 'judge' and v_blind then
            jsonb_build_object(
              'id', p.id,
              'org_id', p.org_id,
              'identity_id', p.identity_id,
              'sl_no', p.sl_no,
              'name', 'Anonymous',
              'school', '',
              'class_or_age', null,
              'custom_values', '{}'::jsonb,
              'created_at', p.created_at,
              'version', p.version,
              'updated_at', p.updated_at
            )
          else
            jsonb_build_object(
              'id', p.id,
              'org_id', p.org_id,
              'identity_id', p.identity_id,
              'sl_no', p.sl_no,
              'name', p.name,
              'school', p.school,
              'class_or_age', p.class_or_age,
              'custom_values', coalesce(p.custom_values, '{}'::jsonb),
              'created_at', p.created_at,
              'version', p.version,
              'updated_at', p.updated_at
            )
        end
      )
      || case
           when to_jsonb(p) ? 'is_active' then jsonb_build_object('is_active', to_jsonb(p)->'is_active')
           else '{}'::jsonb
         end
      order by p.created_at asc
    ),
    '[]'::jsonb
  )
  into v_participants
  from public.participants p
  where upper(p.org_id) = upper(v_org_id)
    and (v_effective_since = 0 or coalesce(p.version, 1) > v_effective_since);

  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at asc), '[]'::jsonb)
  into v_scores
  from public.scores s
  where upper(s.org_id) = upper(v_org_id)
    and (v_effective_since = 0 or coalesce(s.version, 1) > v_effective_since)
    and (
      v_role = 'organiser'
      or (not v_blind and not v_isolated)
      or s.judge_id = v_judge_id
    );

  -- Tie decisions delta (organiser sessions only; judges never receive tie_decisions)
  if v_role = 'organiser' then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', td.id,
          'org_id', td.org_id,
          'event_id', td.event_id,
          'group_key', td.group_key,
          'mode', td.mode,
          'ordered_participant_ids', coalesce(td.ordered_participant_ids, '{}'::text[]),
          'score_fingerprint', coalesce(td.score_fingerprint, ''),
          'decided_by', coalesce(td.decided_by, ''),
          'decided_at', td.decided_at,
          'version', coalesce(td.version, 1),
          'updated_at', td.updated_at
        )
        order by td.decided_at desc, td.id asc
      ),
      '[]'::jsonb
    )
    into v_tie_decisions
    from public.tie_decisions td
    where upper(td.org_id) = upper(v_org_id)
      and (v_effective_since = 0 or coalesce(td.version, 1) > v_effective_since);
  end if;

  if not v_full_resync and v_effective_since > 0 then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'table_name', d.table_name,
          'record_id', d.record_id,
          'version', d.version,
          'deleted_at', d.deleted_at
        )
        order by d.version asc, d.id asc
      ),
      '[]'::jsonb
    )
    into v_deletions
    from public.sync_deletions d
    where upper(d.org_id) = upper(v_org_id)
      and d.version > v_effective_since
      and (v_role = 'organiser' or d.table_name <> 'tie_decisions');
  end if;

  return jsonb_build_object(
    'ok', true,
    'org_id', v_org.org_id,
    'version', v_cur_ver,
    'since', v_req_since,
    'unchanged', false,
    'full_resync', v_full_resync,
    'organization', v_org_json,
    'events', v_events,
    'judges', v_judges,
    'participants', v_participants,
    'scores', v_scores,
    'tie_decisions', v_tie_decisions,
    'deletions', v_deletions
  );
end;
$$;

revoke all on function public.read_org_changes(text, bigint) from public;
grant execute on function public.read_org_changes(text, bigint) to anon, authenticated;

-- PART 3 VERIFICATION (read-only, returns ONE jsonb cell)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_3',
  'tie_decisions_list_exists', to_regprocedure('public.tie_decisions_list(text, text, uuid)') is not null,
  'tie_decision_upsert_exists', to_regprocedure('public.tie_decision_upsert(text, text, uuid, text, text, text[], text, bigint)') is not null,
  'tie_decision_delete_exists', to_regprocedure('public.tie_decision_delete(text, text, uuid, text)') is not null,
  'anon_can_execute_all_3', (
    has_function_privilege('anon', 'public.tie_decisions_list(text, text, uuid)', 'execute')
    and has_function_privilege('anon', 'public.tie_decision_upsert(text, text, uuid, text, text, text[], text, bigint)', 'execute')
    and has_function_privilege('anon', 'public.tie_decision_delete(text, text, uuid, text)', 'execute')
  ),
  'org_reset_all_wipes_tie_decisions', position(
    'tie_decisions' in coalesce(pg_get_functiondef(to_regprocedure('public.org_reset_all(text, text, text)')), '')
  ) > 0,
  'read_org_changes_syncs_tie_decisions', position(
    'tie_decisions' in coalesce(pg_get_functiondef(to_regprocedure('public.read_org_changes(text, bigint)')), '')
  ) > 0
) as verify_17_7_0_part_3;


-- ===============================================================================
-- PART 4: EXTEND public.projector_changes WITH CHANGED tie_decisions DELTA
-- ===============================================================================
-- Built on sql/17.6.1-projector-changes-fix.sql:
--   - Adds v_tie_decisions returning ONLY: id, event_id, group_key, mode,
--     ordered_participant_ids, score_fingerprint, decided_at, version.
--   - NEVER returns decided_by, phone numbers, PINs, passwords, or organiser tokens.
--   - Adds 'tie_decisions' to sync_deletions filter.
--   - Preserves '{}'::text[] casts (zero array[]::uuid[]) and zero ranking maths in SQL.

create or replace function public.projector_changes(
  p_token text,
  p_since bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_pt record;
  v_org_sess record;
  v_org record;
  v_event record;
  v_since bigint := greatest(coalesce(p_since, 0), 0);
  v_cursor bigint := 0;
  v_event_ended boolean := false;
  v_participants jsonb := '[]'::jsonb;
  v_judges jsonb := '[]'::jsonb;
  v_scores jsonb := '[]'::jsonb;
  v_tie_decisions jsonb := '[]'::jsonb;
  v_deletions jsonb := '[]'::jsonb;
begin
  v_hash := public._fj_hash_org_token(p_token);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'revoked', 'message', 'Missing projector token.');
  end if;

  select *
  into v_pt
  from public.projector_token pt
  where pt.token_hash = v_hash
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'revoked', 'message', 'Projector session not found.');
  end if;

  if v_pt.revoked_at is not null then
    return jsonb_build_object(
      'ok', false,
      'error', case coalesce(v_pt.revoked_reason, 'revoked')
        when 'replaced' then 'replaced'
        when 'expired' then 'expired'
        when 'event_ended' then 'event_ended'
        else 'revoked'
      end,
      'message', case coalesce(v_pt.revoked_reason, 'revoked')
        when 'replaced' then 'Another projector signed in for this organisation.'
        when 'expired' then 'Projector session expired (8-hour limit).'
        when 'event_ended' then 'This event has ended.'
        else 'Projector session was ended by the organiser.'
      end
    );
  end if;

  if v_pt.expires_at <= now() then
    update public.projector_token
    set revoked_at = now(), revoked_reason = 'expired'
    where id = v_pt.id and revoked_at is null;

    if v_pt.org_session_id is not null then
      update public.org_sessions
      set revoked_at = now()
      where id = v_pt.org_session_id and revoked_at is null;
    end if;

    return jsonb_build_object(
      'ok', false,
      'error', 'expired',
      'message', 'Projector session expired (8-hour limit).'
    );
  end if;

  if v_pt.org_session_id is not null then
    select s.id, s.revoked_at, s.expires_at
    into v_org_sess
    from public.org_sessions s
    where s.id = v_pt.org_session_id
    limit 1;

    if not found or v_org_sess.revoked_at is not null or v_org_sess.expires_at <= now() then
      update public.projector_token
      set revoked_at = now(),
          revoked_reason = case
            when found and v_org_sess.revoked_at is null and v_org_sess.expires_at <= now() then 'expired'
            else 'organiser_ended'
          end
      where id = v_pt.id and revoked_at is null;

      return jsonb_build_object(
        'ok', false,
        'error', case
          when found and v_org_sess.revoked_at is null and v_org_sess.expires_at <= now() then 'expired'
          else 'revoked'
        end,
        'message', 'Projector session was ended.'
      );
    end if;
  end if;

  select
    o.org_id,
    o.name,
    o.tie_breaker_enabled,
    o.tie_breaker_method,
    o.projector_spotlight_mode,
    o.projector_ticker_text,
    o.sync_version,
    o.created_at,
    o.suspended,
    o.deleted_at
  into v_org
  from public.organizations o
  where upper(o.org_id) = upper(v_pt.org_id)
  limit 1;

  if not found or coalesce(v_org.suspended, false) or v_org.deleted_at is not null then
    update public.projector_token
    set revoked_at = now(), revoked_reason = 'organiser_ended'
    where id = v_pt.id and revoked_at is null;

    if v_pt.org_session_id is not null then
      update public.org_sessions
      set revoked_at = now()
      where id = v_pt.org_session_id and revoked_at is null;
    end if;

    return jsonb_build_object('ok', false, 'error', 'revoked', 'message', 'Organisation is not active.');
  end if;

  v_cursor := coalesce(v_org.sync_version, 1);

  select
    e.id,
    e.org_id,
    e.name,
    e.category,
    e.status,
    e.is_locked,
    e.is_archived,
    e.rubric_schema,
    e.assigned_judges,
    e.assigned_participants,
    e.participant_sl_numbers,
    e.date,
    e.created_at,
    e.version
  into v_event
  from public.events e
  where e.id = v_pt.event_id
    and upper(e.org_id) = upper(v_pt.org_id)
  limit 1;

  if not found then
    update public.projector_token
    set revoked_at = now(), revoked_reason = 'event_ended'
    where id = v_pt.id and revoked_at is null;

    if v_pt.org_session_id is not null then
      update public.org_sessions
      set revoked_at = now()
      where id = v_pt.org_session_id and revoked_at is null;
    end if;

    return jsonb_build_object('ok', false, 'error', 'event_ended', 'message', 'This event is no longer available.');
  end if;

  v_event_ended := coalesce(v_event.is_archived, false)
    or lower(coalesce(v_event.status, 'draft')) in ('ended', 'archived');

  if not v_event_ended and v_since > 0 and v_since >= v_cursor then
    if v_pt.last_seen_at is null or v_pt.last_seen_at < now() - interval '10 minutes' then
      update public.projector_token set last_seen_at = now() where id = v_pt.id;
      if v_pt.org_session_id is not null then
        update public.org_sessions set last_seen_at = now() where id = v_pt.org_session_id;
      end if;
    end if;

    return jsonb_build_object(
      'ok', true,
      'changed', false,
      'cursor', v_cursor,
      'expires_at', v_pt.expires_at,
      'event_ended', false
    );
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'org_id', p.org_id,
        'identity_id', coalesce(p.identity_id, ''),
        'sl_no', coalesce(p.sl_no::text, ''),
        'name', coalesce(p.name, ''),
        'school', coalesce(p.school, ''),
        'class_or_age', p.class_or_age,
        'custom_values', coalesce(p.custom_values, '{}'::jsonb),
        'is_active', coalesce(p.is_active, true),
        'created_at', p.created_at
      )
    ),
    '[]'::jsonb
  )
  into v_participants
  from public.participants p
  where upper(p.org_id) = upper(v_pt.org_id)
    and coalesce(p.version, 1) > v_since;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', j.id,
        'org_id', j.org_id,
        'name', coalesce(j.name, ''),
        'judge_id', coalesce(j.judge_id, ''),
        'assigned_events', coalesce(j.assigned_events, '{}'::text[]),
        'is_active', coalesce(j.is_active, true),
        'created_at', j.created_at
      )
    ),
    '[]'::jsonb
  )
  into v_judges
  from public.judges j
  where upper(j.org_id) = upper(v_pt.org_id)
    and coalesce(j.version, 1) > v_since;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'event_id', s.event_id,
        'judge_id', s.judge_id,
        'participant_id', s.participant_id,
        'total_score', s.total_score,
        'created_at', s.created_at
      )
    ),
    '[]'::jsonb
  )
  into v_scores
  from public.scores s
  where s.event_id = v_pt.event_id
    and coalesce(s.version, 1) > v_since;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', td.id,
        'event_id', td.event_id,
        'group_key', td.group_key,
        'mode', td.mode,
        'ordered_participant_ids', coalesce(td.ordered_participant_ids, '{}'::text[]),
        'score_fingerprint', coalesce(td.score_fingerprint, ''),
        'decided_at', td.decided_at,
        'version', coalesce(td.version, 1)
      )
      order by td.decided_at asc, td.id asc
    ),
    '[]'::jsonb
  )
  into v_tie_decisions
  from public.tie_decisions td
  where td.event_id = v_pt.event_id
    and coalesce(td.version, 1) > v_since;

  if v_since > 0 then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'table_name', d.table_name,
          'record_id', d.record_id,
          'version', d.version
        )
        order by d.version asc
      ),
      '[]'::jsonb
    )
    into v_deletions
    from public.sync_deletions d
    where upper(d.org_id) = upper(v_pt.org_id)
      and d.version > v_since
      and d.table_name in ('participants', 'judges', 'scores', 'tie_decisions');
  end if;

  if v_event_ended then
    update public.projector_token
    set revoked_at = now(),
        revoked_reason = 'event_ended',
        last_seen_at = now()
    where id = v_pt.id and revoked_at is null;

    if v_pt.org_session_id is not null then
      update public.org_sessions
      set revoked_at = now(),
          last_seen_at = now()
      where id = v_pt.org_session_id and revoked_at is null;
    end if;
  elsif v_pt.last_seen_at is null or v_pt.last_seen_at < now() - interval '10 minutes' then
    update public.projector_token set last_seen_at = now() where id = v_pt.id;
    if v_pt.org_session_id is not null then
      update public.org_sessions set last_seen_at = now() where id = v_pt.org_session_id;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'changed', true,
    'cursor', v_cursor,
    'expires_at', v_pt.expires_at,
    'event_ended', v_event_ended,
    'org', jsonb_build_object(
      'org_id', v_org.org_id,
      'name', v_org.name,
      'tie_breaker_enabled', coalesce(v_org.tie_breaker_enabled, false),
      'tie_breaker_method', coalesce(v_org.tie_breaker_method, 'olympic'),
      'projector_spotlight_mode', coalesce(v_org.projector_spotlight_mode, true),
      'projector_ticker_text', coalesce(v_org.projector_ticker_text, ''),
      'created_at', v_org.created_at
    ),
    'event', jsonb_build_object(
      'id', v_event.id,
      'org_id', v_event.org_id,
      'name', v_event.name,
      'category', coalesce(v_event.category, ''),
      'status', lower(coalesce(v_event.status, 'draft')),
      'is_locked', coalesce(v_event.is_locked, false),
      'is_archived', coalesce(v_event.is_archived, false),
      'rubric_schema', coalesce(v_event.rubric_schema, '[]'::jsonb),
      'assigned_judges', coalesce(v_event.assigned_judges, '{}'::text[]),
      'assigned_participants', coalesce(v_event.assigned_participants, '{}'::text[]),
      'participant_sl_numbers', coalesce(v_event.participant_sl_numbers, '{}'::jsonb),
      'date', v_event.date,
      'created_at', v_event.created_at
    ),
    'participants', v_participants,
    'judges', v_judges,
    'scores', v_scores,
    'tie_decisions', v_tie_decisions,
    'deletions', v_deletions
  );
end;
$$;

revoke all on function public.projector_changes(text, bigint) from public;
grant execute on function public.projector_changes(text, bigint) to anon, authenticated;

-- PART 4 VERIFICATION (read-only, returns ONE jsonb cell)
with fn as (
  select p.oid, p.prosecdef, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'projector_changes'
    and pg_get_function_identity_arguments(p.oid) = 'p_token text, p_since bigint'
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_4',
  'projector_changes_exists', exists (select 1 from fn where prosecdef),
  'anon_can_execute', has_function_privilege('anon', 'public.projector_changes(text, bigint)', 'execute'),
  'has_tie_decisions', exists (select 1 from fn where def ilike '%v_tie_decisions%'),
  'no_decided_by', not exists (select 1 from fn where def ilike '%decided_by%'),
  'no_uuid_array_cast', not exists (select 1 from fn where def ilike '%array[]::uuid[]%'),
  'no_mobile_or_pin', not exists (select 1 from fn where def ilike '%mobile_number%' or def ~* '\mj\.pin\M')
) as verify_17_7_0_part_4;
