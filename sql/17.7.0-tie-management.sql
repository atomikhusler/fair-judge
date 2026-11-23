-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 17.7.0 — TIE MANAGEMENT DATABASE MIGRATION (WRITE ONLY — DO NOT AUTO-RUN)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Supersedes sql/17.7.0-tie-decisions.sql (do NOT run 17.7.0-tie-decisions.sql).
-- Run each PART independently in the Supabase SQL Editor.
-- Each PART ends with a read-only single-cell JSONB verification query.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ===============================================================================
-- PART 1: ORG SETTINGS, LEGACY BACKFILL & EXTENDED org_update RPC
-- ===============================================================================

alter table public.organizations
  add column if not exists tie_management_enabled boolean not null default false;

alter table public.organizations
  add column if not exists tie_rule text not null default 'countback';

-- Ensure default stays false if column already existed from an earlier draft
alter table public.organizations
  alter column tie_management_enabled set default false;

-- Exact legacy mapping: maps every existing tie_breaker_method value
-- ('olympic', 'recompete', 'manual', 'shared', NULL, or any other value) to a valid tie_rule.
update public.organizations
set tie_rule = case lower(btrim(coalesce(tie_breaker_method, '')))
  when 'olympic' then 'olympic'
  when 'recompete' then 'recompete'
  else 'countback'
end;

alter table public.organizations
  drop constraint if exists chk_organizations_tie_rule;

alter table public.organizations
  add constraint chk_organizations_tie_rule
  check (tie_rule in ('countback', 'olympic', 'recompete'));

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
  v_tie_rule text;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
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

  if p_updates ? 'tie_rule' then
    v_tie_rule := lower(btrim(coalesce(p_updates->>'tie_rule', '')));
    if v_tie_rule not in ('countback', 'olympic', 'recompete') then
      return jsonb_build_object(
        'ok', false,
        'error', 'invalid_input',
        'message', 'Tie rule must be countback, olympic, or recompete.'
      );
    end if;
  end if;

  update public.organizations
  set
    name = case when p_updates ? 'name' then coalesce(nullif(btrim(p_updates->>'name'), ''), name) else name end,
    email = case when p_updates ? 'email' then nullif(btrim(p_updates->>'email'), '') else email end,
    tie_breaker_enabled = case when p_updates ? 'tie_breaker_enabled' then coalesce((p_updates->>'tie_breaker_enabled')::boolean, tie_breaker_enabled) else tie_breaker_enabled end,
    tie_breaker_method = case when p_updates ? 'tie_breaker_method' then coalesce(p_updates->>'tie_breaker_method', tie_breaker_method) else tie_breaker_method end,
    tie_management_enabled = case when p_updates ? 'tie_management_enabled' then coalesce((p_updates->>'tie_management_enabled')::boolean, tie_management_enabled) else tie_management_enabled end,
    tie_rule = case when p_updates ? 'tie_rule' then v_tie_rule else tie_rule end,
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

-- PART 1 VERIFICATION (read-only, returns ONE jsonb cell)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_1',
  'tie_management_enabled_exists', exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations' and column_name = 'tie_management_enabled'
  ),
  'tie_management_default_false', coalesce((
    select column_default ilike '%false%'
    from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations' and column_name = 'tie_management_enabled'
  ), false),
  'tie_rule_exists', exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations' and column_name = 'tie_rule'
  ),
  'tie_rule_check_constraint', exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('public.organizations')
      and conname = 'chk_organizations_tie_rule'
  ),
  'invalid_tie_rule_rows', (
    select count(*)::int
    from public.organizations
    where tie_rule is null or tie_rule not in ('countback', 'olympic', 'recompete')
  ),
  'org_update_supports_tie_management', position(
    'tie_management_enabled' in coalesce(pg_get_functiondef(to_regprocedure('public.org_update(text, text, jsonb)')), '')
  ) > 0,
  'org_update_supports_tie_rule', position(
    'tie_rule' in coalesce(pg_get_functiondef(to_regprocedure('public.org_update(text, text, jsonb)')), '')
  ) > 0,
  'verification_status_absent', position(
    'verification_status' in coalesce(pg_get_functiondef(to_regprocedure('public.org_update(text, text, jsonb)')), '')
  ) = 0
) as verify_17_7_0_part_1;


-- ===============================================================================
-- PART 2: TABLES, RLS, ZERO DIRECT GRANTS, APPEND-ONLY AUDIT TRIGGER &
--         SERVER-SIDE TIE DETECTION / STALE ROUND HELPERS
-- ===============================================================================

-- 2A. public.tie_rounds
create table if not exists public.tie_rounds (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  event_id uuid not null references public.events(id) on delete cascade,
  group_key text not null,
  tied_rank integer not null check (tied_rank >= 1),
  tied_participant_ids text[] not null default '{}'::text[],
  rule text not null check (rule in ('countback', 'olympic', 'recompete', 'shared')),
  status text not null check (status in ('open', 'closed', 'published', 'cancelled_stale')),
  is_stale boolean not null default false,
  score_fingerprint text not null default '',
  preview_payload jsonb not null default '{}'::jsonb,
  result_payload jsonb not null default '{}'::jsonb,
  reopen_count integer not null default 0,
  last_reopen_reason text not null default '',
  opened_at timestamptz not null default now(),
  closed_at timestamptz null,
  published_at timestamptz null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_tie_rounds_active_event_group
  on public.tie_rounds (event_id, group_key)
  where status in ('open', 'closed', 'published');

create index if not exists idx_tie_rounds_org_ver
  on public.tie_rounds (upper(org_id), version);

create index if not exists idx_tie_rounds_event_status
  on public.tie_rounds (event_id, status);

alter table public.tie_rounds enable row level security;
revoke all on table public.tie_rounds from public, anon, authenticated;

drop trigger if exists trg_fj_sync_tie_rounds_version on public.tie_rounds;
create trigger trg_fj_sync_tie_rounds_version
  before insert or update on public.tie_rounds
  for each row
  execute function public._fj_trg_sync_child_upsert();

drop trigger if exists trg_fj_sync_tie_rounds_delete on public.tie_rounds;
create trigger trg_fj_sync_tie_rounds_delete
  after delete on public.tie_rounds
  for each row
  execute function public._fj_trg_sync_child_delete();

-- 2B. public.tie_round_grades (strictly 1..5, idempotent per round + judge + participant)
create table if not exists public.tie_round_grades (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  round_id uuid not null references public.tie_rounds(id) on delete cascade,
  event_id uuid not null references public.events(id) on delete cascade,
  judge_id uuid not null references public.judges(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  grade smallint not null constraint chk_tie_round_grades_scale check (grade between 1 and 5),
  submitted_at timestamptz not null default now(),
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  constraint uq_tie_round_grades_rjp unique (round_id, judge_id, participant_id)
);

create index if not exists idx_tie_round_grades_round_judge
  on public.tie_round_grades (round_id, judge_id);

create index if not exists idx_tie_round_grades_org_ver
  on public.tie_round_grades (upper(org_id), version);

alter table public.tie_round_grades enable row level security;
revoke all on table public.tie_round_grades from public, anon, authenticated;

drop trigger if exists trg_fj_sync_tie_round_grades_version on public.tie_round_grades;
create trigger trg_fj_sync_tie_round_grades_version
  before insert or update on public.tie_round_grades
  for each row
  execute function public._fj_trg_sync_child_upsert();

drop trigger if exists trg_fj_sync_tie_round_grades_delete on public.tie_round_grades;
create trigger trg_fj_sync_tie_round_grades_delete
  after delete on public.tie_round_grades
  for each row
  execute function public._fj_trg_sync_child_delete();

-- 2C. public.tie_audit_log (append-only; ZERO foreign keys to events or tie_rounds)
create table if not exists public.tie_audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  event_id uuid null,
  event_name text not null,
  round_id uuid null,
  group_key text not null,
  action text not null constraint chk_tie_audit_action check (
    action in (
      'apply_countback',
      'apply_olympic',
      'open_recompete',
      'close_recompete',
      'publish_recompete',
      'reopen_recompete',
      'close_stale_round',
      'close_event_shared'
    )
  ),
  rule text not null constraint chk_tie_audit_rule check (
    rule in ('countback', 'olympic', 'recompete', 'shared')
  ),
  actor_label text not null,
  preview_json jsonb not null default '{}'::jsonb,
  result_json jsonb not null default '{}'::jsonb,
  outcome text not null,
  reason text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_tie_audit_log_org_created
  on public.tie_audit_log (upper(org_id), created_at desc);

create index if not exists idx_tie_audit_log_event
  on public.tie_audit_log (event_id, created_at desc);

alter table public.tie_audit_log enable row level security;
revoke all on table public.tie_audit_log from public, anon, authenticated;

create or replace function public._fj_trg_tie_audit_immutable()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  raise exception 'tie_audit_log is append-only and cannot be modified or deleted';
end;
$$;

revoke all on function public._fj_trg_tie_audit_immutable() from public, anon, authenticated;

drop trigger if exists trg_fj_tie_audit_immutable on public.tie_audit_log;
create trigger trg_fj_tie_audit_immutable
  before update or delete on public.tie_audit_log
  for each row
  execute function public._fj_trg_tie_audit_immutable();

-- 2D. Internal server-side tie detection helper (active participants & judges, latest scores only)
create or replace function public._fj_detect_event_tie_groups(
  p_event_id uuid
)
returns table (
  group_key text,
  tied_rank integer,
  tied_avg numeric,
  tied_participant_ids text[],
  score_fingerprint text,
  member_scores jsonb
)
language sql
security definer
set search_path = public, extensions
as $$
  with latest_scores as (
    select distinct on (s.participant_id, s.judge_id)
      s.participant_id,
      s.judge_id,
      s.total_score::numeric as score_val
    from public.scores s
    join public.events e on e.id = s.event_id
    join public.participants p
      on p.id = s.participant_id
     and upper(p.org_id) = upper(e.org_id)
    join public.judges j
      on j.id = s.judge_id
     and upper(j.org_id) = upper(e.org_id)
    where s.event_id = p_event_id
      and s.total_score is not null
      and coalesce(p.is_active, true) = true
      and coalesce(j.is_active, true) = true
      and (
        cardinality(coalesce(e.assigned_participants, '{}'::text[])) = 0
        or p.id::text = any(coalesce(e.assigned_participants, '{}'::text[]))
      )
      and (
        cardinality(coalesce(e.assigned_judges, '{}'::text[])) = 0
        or j.id::text = any(coalesce(e.assigned_judges, '{}'::text[]))
        or e.id::text = any(coalesce(j.assigned_events, '{}'::text[]))
      )
    order by s.participant_id, s.judge_id, s.created_at desc, s.id desc
  ),
  per_participant as (
    select
      ls.participant_id,
      round(avg(ls.score_val), 2) as avg_val,
      count(*)::int as ballot_count,
      array_agg(ls.score_val order by ls.score_val desc) as scores_desc,
      string_agg(
        ls.judge_id::text || '=' || to_char(ls.score_val, 'FM999999990.0000'),
        ',' order by ls.judge_id::text
      ) as ballots_canon,
      jsonb_agg(
        jsonb_build_object('judge_id', ls.judge_id, 'score', ls.score_val)
        order by ls.judge_id::text
      ) as judge_scores
    from latest_scores ls
    group by ls.participant_id
  ),
  ranked as (
    select
      pp.*,
      rank() over (order by pp.avg_val desc)::int as comp_rank
    from per_participant pp
  ),
  grouped as (
    select
      r.comp_rank as tied_rank,
      min(r.avg_val) as tied_avg,
      string_agg(r.participant_id::text, ',' order by r.participant_id::text) as group_key,
      array_agg(r.participant_id::text order by r.participant_id::text) as tied_participant_ids,
      's1:' || md5(
        string_agg(
          r.participant_id::text || '[' || r.ballots_canon || ']',
          '|' order by r.participant_id::text
        )
      ) as score_fingerprint,
      jsonb_agg(
        jsonb_build_object(
          'participant_id', r.participant_id,
          'avg_score', r.avg_val,
          'ballot_count', r.ballot_count,
          'scores_desc', to_jsonb(r.scores_desc),
          'judge_scores', r.judge_scores
        )
        order by r.participant_id::text
      ) as member_scores,
      count(*)::int as member_count
    from ranked r
    group by r.comp_rank
    having count(*) >= 2
  )
  select
    g.group_key,
    g.tied_rank,
    g.tied_avg,
    g.tied_participant_ids,
    g.score_fingerprint,
    g.member_scores
  from grouped g
  order by g.tied_rank asc;
$$;

revoke all on function public._fj_detect_event_tie_groups(uuid) from public, anon, authenticated;

-- 2E. Internal stale round detector (compares open/closed rounds against live sealed scores)
create or replace function public._fj_find_stale_tie_rounds(
  p_event_id uuid
)
returns table (
  round_id uuid,
  group_key text,
  status text,
  reason text
)
language sql
security definer
set search_path = public, extensions
as $$
  with live_groups as (
    select * from public._fj_detect_event_tie_groups(p_event_id)
  )
  select
    r.id as round_id,
    r.group_key,
    r.status,
    case
      when r.is_stale then 'marked_stale'
      when lg.group_key is null then 'tie_changed_or_dissolved'
      else 'sealed_scores_changed'
    end as reason
  from public.tie_rounds r
  left join live_groups lg on lg.group_key = r.group_key
  where r.event_id = p_event_id
    and r.status in ('open', 'closed')
    and (
      r.is_stale = true
      or lg.group_key is null
      or coalesce(r.score_fingerprint, '') <> coalesce(lg.score_fingerprint, '')
    )
  order by r.opened_at asc, r.id asc;
$$;

revoke all on function public._fj_find_stale_tie_rounds(uuid) from public, anon, authenticated;

-- PART 2 VERIFICATION (read-only, returns ONE jsonb cell)
with det as (
  select p.oid, p.prosecdef, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = '_fj_detect_event_tie_groups'
    and pg_get_function_identity_arguments(p.oid) = 'p_event_id uuid'
),
st as (
  select p.oid, p.prosecdef
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = '_fj_find_stale_tie_rounds'
    and pg_get_function_identity_arguments(p.oid) = 'p_event_id uuid'
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_2',
  'tables_exist', (
    to_regclass('public.tie_rounds') is not null
    and to_regclass('public.tie_round_grades') is not null
    and to_regclass('public.tie_audit_log') is not null
  ),
  'all_rls_enabled', (
    select count(*)::int = 3
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('tie_rounds', 'tie_round_grades', 'tie_audit_log')
      and c.relrowsecurity = true
  ),
  'direct_table_grants', (
    select count(*)::int
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('tie_rounds', 'tie_round_grades', 'tie_audit_log')
      and grantee in ('anon', 'authenticated', 'PUBLIC')
  ),
  'grade_check_1_to_5', exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('public.tie_round_grades')
      and conname = 'chk_tie_round_grades_scale'
  ),
  'unique_grade_rjp', exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('public.tie_round_grades')
      and conname = 'uq_tie_round_grades_rjp'
  ),
  'partial_unique_active_round', exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'tie_rounds'
      and indexname = 'uq_tie_rounds_active_event_group'
  ),
  'tie_audit_log_fk_count', (
    select count(*)::int
    from pg_constraint
    where conrelid = to_regclass('public.tie_audit_log')
      and contype = 'f'
  ),
  'audit_immutable_trigger_exists', exists (
    select 1 from pg_trigger
    where tgrelid = to_regclass('public.tie_audit_log')
      and tgname = 'trg_fj_tie_audit_immutable'
      and not tgisinternal
  ),
  'sync_triggers_attached', (
    select count(*)::int = 4
    from pg_trigger
    where tgname in (
      'trg_fj_sync_tie_rounds_version',
      'trg_fj_sync_tie_rounds_delete',
      'trg_fj_sync_tie_round_grades_version',
      'trg_fj_sync_tie_round_grades_delete'
    )
      and not tgisinternal
  ),
  'server_detector_exists_and_revoked', (
    exists (select 1 from det where prosecdef)
    and not has_function_privilege('anon', 'public._fj_detect_event_tie_groups(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._fj_detect_event_tie_groups(uuid)', 'execute')
  ),
  'server_detector_active_and_latest_only', exists (
    select 1 from det
    where def ilike '%p.is_active%'
      and def ilike '%j.is_active%'
      and def ilike '%distinct on (s.participant_id, s.judge_id)%'
      and def ilike '%s.created_at desc%'
  ),
  'stale_finder_exists_and_revoked', (
    exists (select 1 from st where prosecdef)
    and not has_function_privilege('anon', 'public._fj_find_stale_tie_rounds(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public._fj_find_stale_tie_rounds(uuid)', 'execute')
  )
) as verify_17_7_0_part_2;


-- ===============================================================================
-- PART 3a: ORGANISER APPLY & CLOSE RPCs
--   - public.tie_round_apply_auto
--   - public.tie_event_close_shared
--   - public.tie_round_open
--   - public.tie_round_close
--   - public.tie_round_close_stale
-- Server-authoritative: no p_groups parameter anywhere.
-- ===============================================================================

-- 3a.1 public.tie_round_apply_auto
create or replace function public.tie_round_apply_auto(
  p_token text,
  p_event_id uuid,
  p_group_key text,
  p_rule text,
  p_actor_label text default 'Organiser',
  p_close_event boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_event public.events;
  v_rule text;
  v_group_key text;
  v_actor text;
  v_stale_rounds jsonb;
  v_existing public.tie_rounds;
  v_group record;
  v_placements jsonb;
  v_before_ranks jsonb;
  v_after_ranks jsonb;
  v_still_tied boolean := false;
  v_low_judge_warning boolean := false;
  v_preview jsonb;
  v_result jsonb;
  v_round public.tie_rounds;
  v_remaining_groups jsonb := '[]'::jsonb;
  v_pending_rounds int := 0;
  v_event_closed boolean := false;
  v_elapsed int;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_rule := lower(btrim(coalesce(p_rule, '')));
  if v_rule not in ('countback', 'olympic') then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Automatic tie rule must be countback or olympic.'
    );
  end if;

  v_group_key := btrim(coalesce(p_group_key, ''));
  if v_group_key = '' then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Tie group key is required.'
    );
  end if;

  v_actor := left(
    btrim(
      regexp_replace(
        replace(replace(regexp_replace(coalesce(p_actor_label, ''), '<[^>]*>', '', 'g'), '<', ''), '>', ''),
        '[\r\n\t]+', ' ', 'g'
      )
    ),
    80
  );
  if v_actor = '' then
    v_actor := 'Organiser';
  end if;

  -- Lock parent event row to serialize all tie mutations and close checks
  select * into v_event
  from public.events
  where id = p_event_id
    and upper(org_id) = upper(v_org_id)
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Event not found or access denied.'
    );
  end if;

  -- Stale guard: refuse any apply or close while a stale round exists on this event
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'round_id', st.round_id,
        'group_key', st.group_key,
        'status', st.status,
        'reason', st.reason
      )
    ),
    '[]'::jsonb
  )
  into v_stale_rounds
  from public._fj_find_stale_tie_rounds(v_event.id) st;

  if jsonb_array_length(v_stale_rounds) > 0 then
    update public.tie_rounds r
    set is_stale = true,
        updated_at = now()
    where r.event_id = v_event.id
      and r.id in (select st.round_id from public._fj_find_stale_tie_rounds(v_event.id) st)
      and r.is_stale = false;

    return jsonb_build_object(
      'ok', false,
      'error', 'stale_round_present',
      'message', 'A tie round is stale because sealed scores changed. Close it as stale first.',
      'stale_rounds', v_stale_rounds
    );
  end if;

  -- Check active round on this group
  select * into v_existing
  from public.tie_rounds
  where event_id = v_event.id
    and group_key = v_group_key
    and status in ('open', 'closed', 'published')
  for update;

  if found then
    if v_existing.status = 'open' then
      return jsonb_build_object(
        'ok', false,
        'error', 'open_tie_round_exists',
        'round_id', v_existing.id,
        'message', 'An open re-compete round already exists for this tie group.'
      );
    end if;
    if v_existing.status = 'closed' then
      return jsonb_build_object(
        'ok', false,
        'error', 'closed_round_unpublished',
        'round_id', v_existing.id,
        'message', 'A closed re-compete round is awaiting publish for this tie group.'
      );
    end if;
  end if;

  -- Server-side tie detection from live sealed scores
  select * into v_group
  from public._fj_detect_event_tie_groups(v_event.id)
  where group_key = v_group_key
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'tie_not_found',
      'message', 'No live tie group matches this selection.'
    );
  end if;

  -- Compute deterministic Countback or Olympic trim placements strictly on server
  with members as (
    select
      (m->>'participant_id') as participant_id,
      (m->>'avg_score')::numeric as avg_score,
      (m->>'ballot_count')::int as ballot_count,
      array(
        select (x)::numeric
        from jsonb_array_elements_text(m->'scores_desc') as x
      ) as scores_desc,
      (
        select coalesce(sum((x)::numeric), 0)
        from jsonb_array_elements_text(m->'scores_desc') as x
      ) as sum_scores,
      (
        select max((x)::numeric)
        from jsonb_array_elements_text(m->'scores_desc') as x
      ) as max_score,
      (
        select min((x)::numeric)
        from jsonb_array_elements_text(m->'scores_desc') as x
      ) as min_score
    from jsonb_array_elements(v_group.member_scores) as m
  ),
  computed as (
    select
      mb.*,
      case
        when v_rule = 'olympic' and mb.ballot_count >= 3 then
          round((mb.sum_scores - mb.max_score - mb.min_score) / (mb.ballot_count - 2), 2)
        when v_rule = 'olympic' then
          mb.avg_score
        else
          null::numeric
      end as trimmed_avg
    from members mb
  ),
  ranked as (
    select
      c.*,
      (
        v_group.tied_rank - 1 +
        case
          when v_rule = 'countback' then
            rank() over (order by c.scores_desc desc)::int
          else
            rank() over (order by c.trimmed_avg desc)::int
        end
      ) as after_rank
    from computed c
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'participant_id', r.participant_id,
          'before_rank', v_group.tied_rank,
          'after_rank', r.after_rank,
          'base_avg', r.avg_score,
          'ballot_count', r.ballot_count,
          'scores_desc', to_jsonb(r.scores_desc),
          'trimmed_avg', r.trimmed_avg
        )
        order by r.after_rank asc, r.participant_id asc
      ),
      '[]'::jsonb
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'participant_id', r.participant_id,
          'rank', v_group.tied_rank,
          'avg_score', r.avg_score
        )
        order by r.participant_id asc
      ),
      '[]'::jsonb
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'participant_id', r.participant_id,
          'rank', r.after_rank,
          'avg_score', coalesce(r.trimmed_avg, r.avg_score)
        )
        order by r.after_rank asc, r.participant_id asc
      ),
      '[]'::jsonb
    ),
    exists (
      select 1
      from ranked r2
      group by r2.after_rank
      having count(*) >= 2
    ),
    (v_rule = 'olympic' and exists (select 1 from ranked r3 where r3.ballot_count < 5))
  into
    v_placements,
    v_before_ranks,
    v_after_ranks,
    v_still_tied,
    v_low_judge_warning
  from ranked r;

  v_preview := jsonb_build_object(
    'rule', v_rule,
    'tied_rank', v_group.tied_rank,
    'tied_avg', v_group.tied_avg,
    'before_ranks', v_before_ranks,
    'after_ranks', v_after_ranks,
    'low_judge_warning', v_low_judge_warning
  );

  v_result := jsonb_build_object(
    'rule', v_rule,
    'tied_rank', v_group.tied_rank,
    'score_fingerprint', v_group.score_fingerprint,
    'resolved', not v_still_tied,
    'still_tied', v_still_tied,
    'low_judge_warning', v_low_judge_warning,
    'placements', v_placements
  );

  if v_existing.id is not null and v_existing.status = 'published' then
    update public.tie_rounds
    set
      tied_rank = v_group.tied_rank,
      tied_participant_ids = v_group.tied_participant_ids,
      rule = v_rule,
      status = 'published',
      is_stale = false,
      score_fingerprint = v_group.score_fingerprint,
      preview_payload = v_preview,
      result_payload = v_result,
      closed_at = now(),
      published_at = now(),
      updated_at = now()
    where id = v_existing.id
    returning * into v_round;
  else
    insert into public.tie_rounds (
      org_id,
      event_id,
      group_key,
      tied_rank,
      tied_participant_ids,
      rule,
      status,
      is_stale,
      score_fingerprint,
      preview_payload,
      result_payload,
      opened_at,
      closed_at,
      published_at
    )
    values (
      v_event.org_id,
      v_event.id,
      v_group.group_key,
      v_group.tied_rank,
      v_group.tied_participant_ids,
      v_rule,
      'published',
      false,
      v_group.score_fingerprint,
      v_preview,
      v_result,
      now(),
      now(),
      now()
    )
    returning * into v_round;
  end if;

  -- Append exactly one immutable audit row
  insert into public.tie_audit_log (
    org_id,
    event_id,
    event_name,
    round_id,
    group_key,
    action,
    rule,
    actor_label,
    preview_json,
    result_json,
    outcome,
    reason
  )
  values (
    v_event.org_id,
    v_event.id,
    v_event.name,
    v_round.id,
    v_group.group_key,
    case when v_rule = 'countback' then 'apply_countback' else 'apply_olympic' end,
    v_rule,
    v_actor,
    v_preview,
    v_result,
    case when v_still_tied then 'partial_or_shared' else 'resolved' end,
    ''
  );

  -- Compute remaining unresolved tied groups and any pending rounds
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'group_key', g.group_key,
        'tied_rank', g.tied_rank,
        'tied_participant_ids', to_jsonb(g.tied_participant_ids)
      )
      order by g.tied_rank asc
    ),
    '[]'::jsonb
  )
  into v_remaining_groups
  from public._fj_detect_event_tie_groups(v_event.id) g
  where not exists (
    select 1
    from public.tie_rounds r
    where r.event_id = v_event.id
      and r.group_key = g.group_key
      and r.status = 'published'
      and coalesce(r.is_stale, false) = false
      and coalesce(r.score_fingerprint, '') = coalesce(g.score_fingerprint, '')
  );

  select count(*)::int
  into v_pending_rounds
  from public.tie_rounds
  where event_id = v_event.id
    and status in ('open', 'closed');

  if coalesce(p_close_event, false) = true
     and jsonb_array_length(v_remaining_groups) = 0
     and v_pending_rounds = 0 then
    if lower(coalesce(v_event.status, '')) not in ('ended', 'archived') then
      v_elapsed := coalesce(v_event.elapsed_seconds, 0)
        + case
            when v_event.started_at is not null then
              greatest(0, floor(extract(epoch from (now() - v_event.started_at)))::int)
            else 0
          end;

      update public.events
      set
        status = 'ended',
        elapsed_seconds = v_elapsed,
        started_at = null,
        updated_at = now()
      where id = v_event.id
      returning * into v_event;
    end if;
    v_event_closed := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'round', to_jsonb(v_round),
    'event_closed', v_event_closed,
    'remaining_groups', v_remaining_groups,
    'pending_round_count', v_pending_rounds
  );
end;
$$;

revoke all on function public.tie_round_apply_auto(text, uuid, text, text, text, boolean) from public;
grant execute on function public.tie_round_apply_auto(text, uuid, text, text, text, boolean) to anon, authenticated;


-- 3a.2 public.tie_event_close_shared
create or replace function public.tie_event_close_shared(
  p_token text,
  p_event_id uuid,
  p_actor_label text default 'Organiser'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_event public.events;
  v_actor text;
  v_stale_rounds jsonb;
  v_group record;
  v_existing public.tie_rounds;
  v_round public.tie_rounds;
  v_placements jsonb;
  v_before_ranks jsonb;
  v_preview jsonb;
  v_result jsonb;
  v_shared_rounds jsonb := '[]'::jsonb;
  v_shared_keys text[] := '{}'::text[];
  v_elapsed int;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_actor := left(
    btrim(
      regexp_replace(
        replace(replace(regexp_replace(coalesce(p_actor_label, ''), '<[^>]*>', '', 'g'), '<', ''), '>', ''),
        '[\r\n\t]+', ' ', 'g'
      )
    ),
    80
  );
  if v_actor = '' then
    v_actor := 'Organiser';
  end if;

  -- Lock parent event row
  select * into v_event
  from public.events
  where id = p_event_id
    and upper(org_id) = upper(v_org_id)
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Event not found or access denied.'
    );
  end if;

  -- Guard 1: Stale rounds must be cancelled first
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'round_id', st.round_id,
        'group_key', st.group_key,
        'status', st.status,
        'reason', st.reason
      )
    ),
    '[]'::jsonb
  )
  into v_stale_rounds
  from public._fj_find_stale_tie_rounds(v_event.id) st;

  if jsonb_array_length(v_stale_rounds) > 0 then
    update public.tie_rounds r
    set is_stale = true,
        updated_at = now()
    where r.event_id = v_event.id
      and r.id in (select st.round_id from public._fj_find_stale_tie_rounds(v_event.id) st)
      and r.is_stale = false;

    return jsonb_build_object(
      'ok', false,
      'error', 'stale_round_present',
      'message', 'A tie round is stale because sealed scores changed. Close it as stale first.',
      'stale_rounds', v_stale_rounds
    );
  end if;

  -- Guard 2: Refuse if any open tie round exists
  if exists (
    select 1
    from public.tie_rounds
    where event_id = v_event.id
      and status = 'open'
  ) then
    return jsonb_build_object(
      'ok', false,
      'error', 'open_tie_round_exists',
      'message', 'Close and publish open tie rounds before closing the event.'
    );
  end if;

  -- Guard 3: Refuse if any closed-but-unpublished tie round exists
  if exists (
    select 1
    from public.tie_rounds
    where event_id = v_event.id
      and status = 'closed'
  ) then
    return jsonb_build_object(
      'ok', false,
      'error', 'closed_round_unpublished',
      'message', 'Publish closed tie rounds before closing the event.'
    );
  end if;

  -- Server-side tie detection: store published shared tie rounds for all unresolved live ties
  for v_group in
    select *
    from public._fj_detect_event_tie_groups(v_event.id)
    order by tied_rank asc
  loop
    select * into v_existing
    from public.tie_rounds
    where event_id = v_event.id
      and group_key = v_group.group_key
      and status = 'published'
    for update;

    if found
       and coalesce(v_existing.is_stale, false) = false
       and coalesce(v_existing.score_fingerprint, '') = coalesce(v_group.score_fingerprint, '') then
      -- Already has a fresh published decision for this exact group and sealed scores
      continue;
    end if;

    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'participant_id', (m->>'participant_id'),
            'before_rank', v_group.tied_rank,
            'after_rank', v_group.tied_rank,
            'base_avg', (m->>'avg_score')::numeric,
            'ballot_count', (m->>'ballot_count')::int
          )
          order by (m->>'participant_id') asc
        ),
        '[]'::jsonb
      ),
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'participant_id', (m->>'participant_id'),
            'rank', v_group.tied_rank,
            'avg_score', (m->>'avg_score')::numeric
          )
          order by (m->>'participant_id') asc
        ),
        '[]'::jsonb
      )
    into v_placements, v_before_ranks
    from jsonb_array_elements(v_group.member_scores) as m;

    v_preview := jsonb_build_object(
      'rule', 'shared',
      'tied_rank', v_group.tied_rank,
      'tied_avg', v_group.tied_avg,
      'before_ranks', v_before_ranks,
      'after_ranks', v_before_ranks
    );

    v_result := jsonb_build_object(
      'rule', 'shared',
      'tied_rank', v_group.tied_rank,
      'score_fingerprint', v_group.score_fingerprint,
      'resolved', false,
      'still_tied', true,
      'placements', v_placements
    );

    if v_existing.id is not null then
      update public.tie_rounds
      set
        tied_rank = v_group.tied_rank,
        tied_participant_ids = v_group.tied_participant_ids,
        rule = 'shared',
        status = 'published',
        is_stale = false,
        score_fingerprint = v_group.score_fingerprint,
        preview_payload = v_preview,
        result_payload = v_result,
        closed_at = now(),
        published_at = now(),
        updated_at = now()
      where id = v_existing.id
      returning * into v_round;
    else
      insert into public.tie_rounds (
        org_id,
        event_id,
        group_key,
        tied_rank,
        tied_participant_ids,
        rule,
        status,
        is_stale,
        score_fingerprint,
        preview_payload,
        result_payload,
        opened_at,
        closed_at,
        published_at
      )
      values (
        v_event.org_id,
        v_event.id,
        v_group.group_key,
        v_group.tied_rank,
        v_group.tied_participant_ids,
        'shared',
        'published',
        false,
        v_group.score_fingerprint,
        v_preview,
        v_result,
        now(),
        now(),
        now()
      )
      returning * into v_round;
    end if;

    v_shared_keys := array_append(v_shared_keys, v_group.group_key);
    v_shared_rounds := v_shared_rounds || jsonb_build_array(
      jsonb_build_object(
        'round_id', v_round.id,
        'group_key', v_round.group_key,
        'tied_rank', v_round.tied_rank,
        'tied_participant_ids', to_jsonb(v_round.tied_participant_ids)
      )
    );
  end loop;

  -- Close the event
  if lower(coalesce(v_event.status, '')) not in ('ended', 'archived') then
    v_elapsed := coalesce(v_event.elapsed_seconds, 0)
      + case
          when v_event.started_at is not null then
            greatest(0, floor(extract(epoch from (now() - v_event.started_at)))::int)
          else 0
        end;

    update public.events
    set
      status = 'ended',
      elapsed_seconds = v_elapsed,
      started_at = null,
      updated_at = now()
    where id = v_event.id
    returning * into v_event;
  end if;

  -- Append exactly one immutable audit row
  insert into public.tie_audit_log (
    org_id,
    event_id,
    event_name,
    round_id,
    group_key,
    action,
    rule,
    actor_label,
    preview_json,
    result_json,
    outcome,
    reason
  )
  values (
    v_event.org_id,
    v_event.id,
    v_event.name,
    null,
    case
      when cardinality(v_shared_keys) = 0 then 'none'
      when cardinality(v_shared_keys) = 1 then v_shared_keys[1]
      else 'multiple:' || cardinality(v_shared_keys)::text
    end,
    'close_event_shared',
    'shared',
    v_actor,
    jsonb_build_object('shared_rounds', v_shared_rounds),
    jsonb_build_object(
      'event_status', v_event.status,
      'shared_group_count', cardinality(v_shared_keys),
      'shared_rounds', v_shared_rounds
    ),
    case
      when cardinality(v_shared_keys) > 0 then 'closed_with_shared_places'
      else 'closed_no_unresolved_ties'
    end,
    ''
  );

  return jsonb_build_object(
    'ok', true,
    'event', to_jsonb(v_event),
    'event_closed', true,
    'shared_group_count', cardinality(v_shared_keys),
    'shared_rounds', v_shared_rounds
  );
end;
$$;

revoke all on function public.tie_event_close_shared(text, uuid, text) from public;
grant execute on function public.tie_event_close_shared(text, uuid, text) to anon, authenticated;


-- 3a.3 public.tie_round_open
create or replace function public.tie_round_open(
  p_token text,
  p_event_id uuid,
  p_group_key text,
  p_actor_label text default 'Organiser'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_event public.events;
  v_group_key text;
  v_actor text;
  v_stale_rounds jsonb;
  v_group record;
  v_existing public.tie_rounds;
  v_conflict_round_id uuid;
  v_preview jsonb;
  v_round public.tie_rounds;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_group_key := btrim(coalesce(p_group_key, ''));
  if v_group_key = '' then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Tie group key is required.'
    );
  end if;

  v_actor := left(
    btrim(
      regexp_replace(
        replace(replace(regexp_replace(coalesce(p_actor_label, ''), '<[^>]*>', '', 'g'), '<', ''), '>', ''),
        '[\r\n\t]+', ' ', 'g'
      )
    ),
    80
  );
  if v_actor = '' then
    v_actor := 'Organiser';
  end if;

  -- Lock parent event row to serialize participant overlap and state transitions
  select * into v_event
  from public.events
  where id = p_event_id
    and upper(org_id) = upper(v_org_id)
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Event not found or access denied.'
    );
  end if;

  if coalesce(v_event.is_archived, false) = true
     or lower(coalesce(v_event.status, '')) in ('ended', 'archived') then
    return jsonb_build_object(
      'ok', false,
      'error', 'event_ended',
      'message', 'Cannot open a re-compete round on an ended or archived event.'
    );
  end if;

  -- Stale guard
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'round_id', st.round_id,
        'group_key', st.group_key,
        'status', st.status,
        'reason', st.reason
      )
    ),
    '[]'::jsonb
  )
  into v_stale_rounds
  from public._fj_find_stale_tie_rounds(v_event.id) st;

  if jsonb_array_length(v_stale_rounds) > 0 then
    update public.tie_rounds r
    set is_stale = true,
        updated_at = now()
    where r.event_id = v_event.id
      and r.id in (select st.round_id from public._fj_find_stale_tie_rounds(v_event.id) st)
      and r.is_stale = false;

    return jsonb_build_object(
      'ok', false,
      'error', 'stale_round_present',
      'message', 'A tie round is stale because sealed scores changed. Close it as stale first.',
      'stale_rounds', v_stale_rounds
    );
  end if;

  -- Server-side tie detection
  select * into v_group
  from public._fj_detect_event_tie_groups(v_event.id)
  where group_key = v_group_key
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'tie_not_found',
      'message', 'No live tie group matches this selection.'
    );
  end if;

  -- Check existing active round for this group
  select * into v_existing
  from public.tie_rounds
  where event_id = v_event.id
    and group_key = v_group.group_key
    and status in ('open', 'closed', 'published')
  for update;

  if found then
    if v_existing.status = 'open' then
      return jsonb_build_object(
        'ok', false,
        'error', 'open_tie_round_exists',
        'round_id', v_existing.id,
        'message', 'A tie round is already open for this group.'
      );
    end if;
    if v_existing.status = 'closed' then
      return jsonb_build_object(
        'ok', false,
        'error', 'closed_round_unpublished',
        'round_id', v_existing.id,
        'message', 'A closed tie round already exists for this group.'
      );
    end if;
    if v_existing.status = 'published' and v_existing.rule = 'recompete' then
      return jsonb_build_object(
        'ok', false,
        'error', 'round_already_published',
        'round_id', v_existing.id,
        'message', 'Use reopen with a reason to reopen a published re-compete round.'
      );
    end if;
  end if;

  -- Enforce at most ONE open round per participant per event
  select r.id into v_conflict_round_id
  from public.tie_rounds r
  where r.event_id = v_event.id
    and r.status = 'open'
    and r.tied_participant_ids && v_group.tied_participant_ids
  limit 1;

  if v_conflict_round_id is not null then
    return jsonb_build_object(
      'ok', false,
      'error', 'participant_in_open_round',
      'conflict_round_id', v_conflict_round_id,
      'message', 'A participant in this group is already in an open tie round.'
    );
  end if;

  v_preview := jsonb_build_object(
    'rule', 'recompete',
    'tied_rank', v_group.tied_rank,
    'tied_avg', v_group.tied_avg,
    'tied_participant_ids', to_jsonb(v_group.tied_participant_ids)
  );

  if v_existing.id is not null and v_existing.status = 'published' then
    -- Replacing an earlier non-recompete published decision (countback/olympic/shared)
    delete from public.tie_round_grades where round_id = v_existing.id;

    update public.tie_rounds
    set
      tied_rank = v_group.tied_rank,
      tied_participant_ids = v_group.tied_participant_ids,
      rule = 'recompete',
      status = 'open',
      is_stale = false,
      score_fingerprint = v_group.score_fingerprint,
      preview_payload = v_preview,
      result_payload = '{}'::jsonb,
      opened_at = now(),
      closed_at = null,
      published_at = null,
      updated_at = now()
    where id = v_existing.id
    returning * into v_round;
  else
    insert into public.tie_rounds (
      org_id,
      event_id,
      group_key,
      tied_rank,
      tied_participant_ids,
      rule,
      status,
      is_stale,
      score_fingerprint,
      preview_payload,
      result_payload,
      opened_at
    )
    values (
      v_event.org_id,
      v_event.id,
      v_group.group_key,
      v_group.tied_rank,
      v_group.tied_participant_ids,
      'recompete',
      'open',
      false,
      v_group.score_fingerprint,
      v_preview,
      '{}'::jsonb,
      now()
    )
    returning * into v_round;
  end if;

  -- Append exactly one immutable audit row
  insert into public.tie_audit_log (
    org_id,
    event_id,
    event_name,
    round_id,
    group_key,
    action,
    rule,
    actor_label,
    preview_json,
    result_json,
    outcome,
    reason
  )
  values (
    v_event.org_id,
    v_event.id,
    v_event.name,
    v_round.id,
    v_round.group_key,
    'open_recompete',
    'recompete',
    v_actor,
    v_preview,
    jsonb_build_object(
      'round_id', v_round.id,
      'status', v_round.status,
      'tied_rank', v_round.tied_rank,
      'tied_participant_ids', to_jsonb(v_round.tied_participant_ids)
    ),
    'round_opened',
    ''
  );

  return jsonb_build_object(
    'ok', true,
    'round', to_jsonb(v_round)
  );
end;
$$;

revoke all on function public.tie_round_open(text, uuid, text, text) from public;
grant execute on function public.tie_round_open(text, uuid, text, text) to anon, authenticated;


-- 3a.4 public.tie_round_close
create or replace function public.tie_round_close(
  p_token text,
  p_round_id uuid,
  p_actor_label text default 'Organiser'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_event_id uuid;
  v_event public.events;
  v_round public.tie_rounds;
  v_actor text;
  v_live_group record;
  v_placements jsonb;
  v_still_tied boolean := false;
  v_submitted_judges int := 0;
  v_total_grades int := 0;
  v_result jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_actor := left(
    btrim(
      regexp_replace(
        replace(replace(regexp_replace(coalesce(p_actor_label, ''), '<[^>]*>', '', 'g'), '<', ''), '>', ''),
        '[\r\n\t]+', ' ', 'g'
      )
    ),
    80
  );
  if v_actor = '' then
    v_actor := 'Organiser';
  end if;

  select event_id into v_event_id
  from public.tie_rounds
  where id = p_round_id
    and upper(org_id) = upper(v_org_id);

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Tie round not found or access denied.'
    );
  end if;

  -- Consistent lock ordering: parent event row FOR UPDATE first, then round row
  select * into v_event
  from public.events
  where id = v_event_id
    and upper(org_id) = upper(v_org_id)
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Event not found or access denied.'
    );
  end if;

  select * into v_round
  from public.tie_rounds
  where id = p_round_id
    and event_id = v_event.id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Tie round not found.'
    );
  end if;

  if v_round.status <> 'open' then
    return jsonb_build_object(
      'ok', false,
      'error', 'round_not_open',
      'status', v_round.status,
      'message', 'Only an open tie round can be closed.'
    );
  end if;

  -- Check if this round has gone stale against live sealed scores
  if exists (
    select 1
    from public._fj_find_stale_tie_rounds(v_event.id) st
    where st.round_id = v_round.id
  ) then
    update public.tie_rounds
    set is_stale = true,
        updated_at = now()
    where id = v_round.id;

    return jsonb_build_object(
      'ok', false,
      'error', 'stale_round_present',
      'round_id', v_round.id,
      'message', 'Sealed scores changed since this round opened. Close it as stale instead.'
    );
  end if;

  select * into v_live_group
  from public._fj_detect_event_tie_groups(v_event.id)
  where group_key = v_round.group_key
  limit 1;

  if not found then
    update public.tie_rounds
    set is_stale = true,
        updated_at = now()
    where id = v_round.id;

    return jsonb_build_object(
      'ok', false,
      'error', 'stale_round_present',
      'round_id', v_round.id,
      'message', 'This tie no longer exists in sealed scores. Close the round as stale.'
    );
  end if;

  -- Count active-judge submissions (no judge identifiers, PINs, or per-judge ballots exposed)
  select
    count(distinct g.judge_id)::int,
    count(g.id)::int
  into v_submitted_judges, v_total_grades
  from public.tie_round_grades g
  join public.judges j
    on j.id = g.judge_id
   and upper(j.org_id) = upper(v_event.org_id)
   and coalesce(j.is_active, true) = true
  where g.round_id = v_round.id;

  -- Final order: grade sum desc -> sealed countback (scores_desc desc) -> shared place
  with sealed_members as (
    select
      (m->>'participant_id') as participant_id,
      (m->>'avg_score')::numeric as base_avg,
      array(
        select (x)::numeric
        from jsonb_array_elements_text(m->'scores_desc') as x
      ) as scores_desc
    from jsonb_array_elements(v_live_group.member_scores) as m
  ),
  grade_totals as (
    select
      pid_txt as participant_id,
      coalesce(sum(g.grade), 0)::int as grade_sum,
      count(g.id)::int as grade_count
    from unnest(v_round.tied_participant_ids) as pid_txt
    left join public.tie_round_grades g
      on g.round_id = v_round.id
     and g.participant_id::text = pid_txt
     and exists (
       select 1
       from public.judges j
       where j.id = g.judge_id
         and upper(j.org_id) = upper(v_event.org_id)
         and coalesce(j.is_active, true) = true
     )
    group by pid_txt
  ),
  combined as (
    select
      gt.participant_id,
      gt.grade_sum,
      gt.grade_count,
      coalesce(sm.base_avg, v_live_group.tied_avg) as base_avg,
      coalesce(sm.scores_desc, '{}'::numeric[]) as scores_desc
    from grade_totals gt
    left join sealed_members sm on sm.participant_id = gt.participant_id
  ),
  ranked as (
    select
      c.*,
      (
        v_round.tied_rank - 1
        + rank() over (order by c.grade_sum desc, c.scores_desc desc)::int
      ) as after_rank
    from combined c
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'participant_id', r.participant_id,
          'before_rank', v_round.tied_rank,
          'after_rank', r.after_rank,
          'base_avg', r.base_avg,
          'grade_sum', r.grade_sum,
          'grade_count', r.grade_count,
          'scores_desc', to_jsonb(r.scores_desc)
        )
        order by r.after_rank asc, r.participant_id asc
      ),
      '[]'::jsonb
    ),
    exists (
      select 1
      from ranked r2
      group by r2.after_rank
      having count(*) >= 2
    )
  into v_placements, v_still_tied
  from ranked r;

  v_result := jsonb_build_object(
    'rule', 'recompete',
    'tied_rank', v_round.tied_rank,
    'score_fingerprint', v_round.score_fingerprint,
    'submitted_judge_count', v_submitted_judges,
    'total_grades', v_total_grades,
    'resolved', not v_still_tied,
    'still_tied', v_still_tied,
    'placements', v_placements
  );

  update public.tie_rounds
  set
    status = 'closed',
    closed_at = now(),
    result_payload = v_result,
    updated_at = now()
  where id = v_round.id
  returning * into v_round;

  -- Append exactly one immutable audit row
  insert into public.tie_audit_log (
    org_id,
    event_id,
    event_name,
    round_id,
    group_key,
    action,
    rule,
    actor_label,
    preview_json,
    result_json,
    outcome,
    reason
  )
  values (
    v_event.org_id,
    v_event.id,
    v_event.name,
    v_round.id,
    v_round.group_key,
    'close_recompete',
    'recompete',
    v_actor,
    v_round.preview_payload,
    v_result,
    case when v_still_tied then 'closed_still_tied' else 'closed_ready_to_publish' end,
    ''
  );

  return jsonb_build_object(
    'ok', true,
    'round', to_jsonb(v_round)
  );
end;
$$;

revoke all on function public.tie_round_close(text, uuid, text) from public;
grant execute on function public.tie_round_close(text, uuid, text) to anon, authenticated;


-- 3a.5 public.tie_round_close_stale
create or replace function public.tie_round_close_stale(
  p_token text,
  p_round_id uuid,
  p_reason text default '',
  p_actor_label text default 'Organiser'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_event_id uuid;
  v_event public.events;
  v_round public.tie_rounds;
  v_prev_status text;
  v_stale_reason text;
  v_clean_reason text;
  v_actor text;
  v_result jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_actor := left(
    btrim(
      regexp_replace(
        replace(replace(regexp_replace(coalesce(p_actor_label, ''), '<[^>]*>', '', 'g'), '<', ''), '>', ''),
        '[\r\n\t]+', ' ', 'g'
      )
    ),
    80
  );
  if v_actor = '' then
    v_actor := 'Organiser';
  end if;

  select event_id into v_event_id
  from public.tie_rounds
  where id = p_round_id
    and upper(org_id) = upper(v_org_id);

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Tie round not found or access denied.'
    );
  end if;

  -- Lock parent event row FOR UPDATE first, then round row
  select * into v_event
  from public.events
  where id = v_event_id
    and upper(org_id) = upper(v_org_id)
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Event not found or access denied.'
    );
  end if;

  select * into v_round
  from public.tie_rounds
  where id = p_round_id
    and event_id = v_event.id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Tie round not found.'
    );
  end if;

  if v_round.status not in ('open', 'closed') then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_state',
      'status', v_round.status,
      'message', 'Only an open or closed tie round can be cancelled as stale.'
    );
  end if;

  select st.reason into v_stale_reason
  from public._fj_find_stale_tie_rounds(v_event.id) st
  where st.round_id = v_round.id
  limit 1;

  if v_stale_reason is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'round_not_stale',
      'message', 'This tie round still matches live sealed scores.'
    );
  end if;

  v_clean_reason := left(
    btrim(
      regexp_replace(
        replace(replace(regexp_replace(coalesce(p_reason, ''), '<[^>]*>', '', 'g'), '<', ''), '>', ''),
        '[\r\n\t]+', ' ', 'g'
      )
    ),
    240
  );
  if v_clean_reason = '' then
    v_clean_reason := v_stale_reason;
  end if;

  v_prev_status := v_round.status;
  v_result := coalesce(v_round.result_payload, '{}'::jsonb) || jsonb_build_object(
    'cancelled_stale', true,
    'previous_status', v_prev_status,
    'stale_reason', v_stale_reason,
    'cancel_reason', v_clean_reason
  );

  update public.tie_rounds
  set
    status = 'cancelled_stale',
    is_stale = true,
    closed_at = coalesce(closed_at, now()),
    result_payload = v_result,
    updated_at = now()
  where id = v_round.id
  returning * into v_round;

  -- Append exactly one immutable audit row
  insert into public.tie_audit_log (
    org_id,
    event_id,
    event_name,
    round_id,
    group_key,
    action,
    rule,
    actor_label,
    preview_json,
    result_json,
    outcome,
    reason
  )
  values (
    v_event.org_id,
    v_event.id,
    v_event.name,
    v_round.id,
    v_round.group_key,
    'close_stale_round',
    v_round.rule,
    v_actor,
    v_round.preview_payload,
    jsonb_build_object(
      'round_id', v_round.id,
      'previous_status', v_prev_status,
      'new_status', 'cancelled_stale',
      'stale_reason', v_stale_reason
    ),
    'cancelled_stale',
    v_clean_reason
  );

  return jsonb_build_object(
    'ok', true,
    'round', to_jsonb(v_round)
  );
end;
$$;

revoke all on function public.tie_round_close_stale(text, uuid, text, text) from public;
grant execute on function public.tie_round_close_stale(text, uuid, text, text) to anon, authenticated;


-- PART 3a VERIFICATION (read-only, returns ONE jsonb cell)
with target_rpcs as (
  select
    p.oid,
    p.proname,
    p.prosecdef,
    p.proacl,
    pg_get_function_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'tie_round_apply_auto',
      'tie_event_close_shared',
      'tie_round_open',
      'tie_round_close',
      'tie_round_close_stale'
    )
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_3a',
  'rpc_count', (select count(*)::int from target_rpcs),
  'all_five_exist', (
    (select count(distinct proname)::int from target_rpcs) = 5
  ),
  'all_security_definer', (
    (select count(*)::int from target_rpcs where prosecdef = true) = 5
  ),
  'all_granted_to_anon', (
    (select count(*)::int from target_rpcs where has_function_privilege('anon', oid, 'execute')) = 5
  ),
  'all_granted_to_authenticated', (
    (select count(*)::int from target_rpcs where has_function_privilege('authenticated', oid, 'execute')) = 5
  ),
  'all_revoked_from_public', (
    (
      select count(*)::int
      from target_rpcs
      where proacl is not null
        and not exists (
          select 1
          from unnest(proacl) a
          where a::text like '=X/%'
        )
    ) = 5
  ),
  'zero_p_groups_params', (
    (
      select count(*)::int
      from target_rpcs
      where position('p_groups' in lower(coalesce(args, ''))) > 0
    ) = 0
  ),
  'rpcs', (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'name', proname,
          'security_definer', prosecdef,
          'args', args
        )
        order by proname
      ),
      '[]'::jsonb
    )
    from target_rpcs
  )
) as verify_17_7_0_part_3a;

