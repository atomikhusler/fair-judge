-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.12 — PHASE 4D-1: SIMPLE SYNC (MONOTONIC VERSION + DELTAS)
-- ═══════════════════════════════════════════════════════════════════
-- Replaces expensive full-table fingerprint hashing (read_org_sync_stamp)
-- and public broadcast channels with an authoritative per-organization
-- monotonic version counter, deletion tombstones, and a single delta RPC:
--   read_org_changes(p_token text, p_since bigint default 0)
--
-- Security & Privacy Guarantees:
--   - Uses _fj_verify_read_token(p_token, null) for organiser & judge auth.
--   - Rejects suspended/deleted orgs and inactive judges automatically.
--   - NEVER returns judges.pin, pin_hash, pin_encrypted, or current_session_token.
--   - NEVER returns participants.mobile_number or organizations.email (for judges).
--   - Enforces blind_judging_enabled & isolated_jury_enabled for judge sessions,
--     and promotes mid-session org-setting flips to full_resync so stale
--     unmasked data is purged from judge caches.
--   - sync_deletions has RLS ON and zero direct anon/authenticated grants.
--
-- IMPORTANT: Does NOT drop read_org_sync_stamp yet inside Supabase until all
-- live clients are on >= 15.12.3 (can be retired in a future cleanup).
-- Ends with a single read-only verification query returning ONE jsonb cell.
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- 1. SCHEMA ADDITIONS: VERSION COUNTERS, UPDATED_AT & SCORES.ORG_ID
-- ─────────────────────────────────────────────────────────────────
alter table public.organizations
  add column if not exists sync_version bigint not null default 1,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();

alter table public.events
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();

alter table public.judges
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();

alter table public.participants
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();

alter table public.scores
  add column if not exists org_id text,
  add column if not exists version bigint not null default 1,
  add column if not exists updated_at timestamptz not null default now();

-- Backfill scores.org_id from parent events
update public.scores s
set org_id = e.org_id
from public.events e
where s.event_id = e.id
  and (s.org_id is null or btrim(s.org_id) = '');

-- Ensure initial versions are valid positive integers
update public.organizations
set sync_version = greatest(coalesce(sync_version, 1), 1),
    version = greatest(coalesce(version, 1), 1),
    updated_at = coalesce(updated_at, created_at, now())
where sync_version is null or sync_version < 1 or version is null or version < 1 or updated_at is null;

-- Composite org + version indexes for fast O(delta) index scans
create index if not exists idx_events_org_version
  on public.events (upper(org_id), version);

create index if not exists idx_judges_org_version
  on public.judges (upper(org_id), version);

create index if not exists idx_participants_org_version
  on public.participants (upper(org_id), version);

create index if not exists idx_scores_org_version
  on public.scores (upper(org_id), version);

-- ─────────────────────────────────────────────────────────────────
-- 2. DELETION TOMBSTONE LOG (Server-only, RLS ON)
-- ─────────────────────────────────────────────────────────────────
create table if not exists public.sync_deletions (
  id bigserial primary key,
  org_id text not null,
  table_name text not null,
  record_id text not null,
  version bigint not null,
  deleted_at timestamptz not null default now()
);

create index if not exists idx_sync_deletions_org_ver
  on public.sync_deletions (upper(org_id), version);

create index if not exists idx_sync_deletions_deleted_at
  on public.sync_deletions (deleted_at);

alter table public.sync_deletions enable row level security;
revoke all on table public.sync_deletions from anon, authenticated, public;

-- ─────────────────────────────────────────────────────────────────
-- 3. MONOTONIC VERSION BUMP HELPER & TRIGGERS
-- ─────────────────────────────────────────────────────────────────
create or replace function public._fj_bump_org_sync_version(p_org_id text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_clean text := upper(btrim(coalesce(p_org_id, '')));
  v_next bigint;
begin
  if v_clean = '' then
    return 1;
  end if;

  -- Guard against re-entering _fj_trg_sync_org_upsert on organizations update
  perform set_config('app.fj_bumping_sync', '1', true);

  update public.organizations
  set sync_version = coalesce(sync_version, 1) + 1
  where upper(org_id) = v_clean
  returning sync_version into v_next;

  perform set_config('app.fj_bumping_sync', '0', true);
  return coalesce(v_next, 1);
exception
  when others then
    perform set_config('app.fj_bumping_sync', '0', true);
    raise;
end;
$$;

revoke all on function public._fj_bump_org_sync_version(text) from public, anon, authenticated;

-- Organization BEFORE INSERT / UPDATE trigger
create or replace function public._fj_trg_sync_org_upsert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if current_setting('app.fj_bumping_sync', true) = '1' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.sync_version := greatest(coalesce(new.sync_version, 1), 1);
    new.version := new.sync_version;
    new.updated_at := coalesce(new.updated_at, now());
    return new;
  end if;

  -- Direct / admin / settings update on public.organizations
  if (to_jsonb(new) - 'sync_version' - 'version' - 'updated_at')
     is distinct from
     (to_jsonb(old) - 'sync_version' - 'version' - 'updated_at') then
    new.sync_version := greatest(coalesce(old.sync_version, 1), 1) + 1;
    new.version := new.sync_version;
    new.updated_at := now();
  end if;

  return new;
end;
$$;

revoke all on function public._fj_trg_sync_org_upsert() from public, anon, authenticated;

drop trigger if exists trg_fj_sync_org_version on public.organizations;
create trigger trg_fj_sync_org_version
  before insert or update on public.organizations
  for each row
  execute function public._fj_trg_sync_org_upsert();

-- Organization AFTER DELETE trigger (cleanup orphaned tombstones)
create or replace function public._fj_trg_sync_org_delete()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  delete from public.sync_deletions
  where upper(org_id) = upper(btrim(coalesce(old.org_id, '')));
  return old;
end;
$$;

revoke all on function public._fj_trg_sync_org_delete() from public, anon, authenticated;

drop trigger if exists trg_fj_sync_org_delete on public.organizations;
create trigger trg_fj_sync_org_delete
  after delete on public.organizations
  for each row
  execute function public._fj_trg_sync_org_delete();

-- Child tables (events, judges, participants, scores) BEFORE INSERT / UPDATE trigger
create or replace function public._fj_trg_sync_child_upsert()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
begin
  if tg_table_name = 'scores' then
    v_org_id := nullif(btrim(coalesce(new.org_id, '')), '');
    if v_org_id is null and new.event_id is not null then
      select e.org_id into v_org_id
      from public.events e
      where e.id = new.event_id
      limit 1;
      new.org_id := v_org_id;
    end if;
  else
    v_org_id := new.org_id;
  end if;

  new.version := public._fj_bump_org_sync_version(v_org_id);
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public._fj_trg_sync_child_upsert() from public, anon, authenticated;

drop trigger if exists trg_fj_sync_events_version on public.events;
create trigger trg_fj_sync_events_version
  before insert or update on public.events
  for each row
  execute function public._fj_trg_sync_child_upsert();

drop trigger if exists trg_fj_sync_judges_version on public.judges;
create trigger trg_fj_sync_judges_version
  before insert or update on public.judges
  for each row
  execute function public._fj_trg_sync_child_upsert();

drop trigger if exists trg_fj_sync_participants_version on public.participants;
create trigger trg_fj_sync_participants_version
  before insert or update on public.participants
  for each row
  execute function public._fj_trg_sync_child_upsert();

drop trigger if exists trg_fj_sync_scores_version on public.scores;
create trigger trg_fj_sync_scores_version
  before insert or update on public.scores
  for each row
  execute function public._fj_trg_sync_child_upsert();

-- Child tables AFTER DELETE trigger (bumps org sync_version & logs tombstone)
create or replace function public._fj_trg_sync_child_delete()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_ver bigint;
begin
  if tg_table_name = 'scores' then
    v_org_id := nullif(btrim(coalesce(old.org_id, '')), '');
    if v_org_id is null and old.event_id is not null then
      select e.org_id into v_org_id
      from public.events e
      where e.id = old.event_id
      limit 1;
    end if;
  else
    v_org_id := old.org_id;
  end if;

  v_org_id := upper(btrim(coalesce(v_org_id, '')));
  if v_org_id = '' then
    return old;
  end if;

  -- Skip if parent organization has already been removed
  if not exists (select 1 from public.organizations o where upper(o.org_id) = v_org_id) then
    return old;
  end if;

  v_ver := public._fj_bump_org_sync_version(v_org_id);

  insert into public.sync_deletions (org_id, table_name, record_id, version, deleted_at)
  values (v_org_id, tg_table_name, old.id::text, v_ver, now());

  -- Opportunistic pruning beyond 30-day session horizon
  if random() < 0.02 then
    delete from public.sync_deletions
    where deleted_at < now() - interval '30 days';
  end if;

  return old;
end;
$$;

revoke all on function public._fj_trg_sync_child_delete() from public, anon, authenticated;

drop trigger if exists trg_fj_sync_events_delete on public.events;
create trigger trg_fj_sync_events_delete
  after delete on public.events
  for each row
  execute function public._fj_trg_sync_child_delete();

drop trigger if exists trg_fj_sync_judges_delete on public.judges;
create trigger trg_fj_sync_judges_delete
  after delete on public.judges
  for each row
  execute function public._fj_trg_sync_child_delete();

drop trigger if exists trg_fj_sync_participants_delete on public.participants;
create trigger trg_fj_sync_participants_delete
  after delete on public.participants
  for each row
  execute function public._fj_trg_sync_child_delete();

drop trigger if exists trg_fj_sync_scores_delete on public.scores;
create trigger trg_fj_sync_scores_delete
  after delete on public.scores
  for each row
  execute function public._fj_trg_sync_child_delete();

-- ─────────────────────────────────────────────────────────────────
-- 4. DELTA SYNC RPC: read_org_changes(p_token, p_since)
-- ─────────────────────────────────────────────────────────────────
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

  -- Fast unchanged short-circuit when client is already at the latest version
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
      'deletions', '[]'::jsonb
    );
  end if;

  if v_req_since = 0 or v_req_since > v_cur_ver then
    v_effective_since := 0;
    v_full_resync := true;
  else
    v_effective_since := v_req_since;
  end if;

  -- If organization row changed for a judge session (e.g. blind_judging_enabled or
  -- isolated_jury_enabled toggled), force full_resync so cached names/scores mask immediately.
  if v_role = 'judge' and v_effective_since > 0 and coalesce(v_org.version, 1) > v_effective_since then
    v_effective_since := 0;
    v_full_resync := true;
  end if;

  if v_role = 'judge' then
    v_blind := coalesce(v_org.blind_judging_enabled, false);
    v_isolated := coalesce(v_org.isolated_jury_enabled, false);
  end if;

  -- 1. Organization delta (never expose password; strip organiser email for judges)
  if v_effective_since = 0 or coalesce(v_org.version, 1) > v_effective_since then
    v_org_json := to_jsonb(v_org) - 'password';
    if v_role = 'judge' then
      v_org_json := v_org_json - 'email';
    end if;
  end if;

  -- 2. Events delta
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb)
  into v_events
  from public.events e
  where upper(e.org_id) = upper(v_org_id)
    and (v_effective_since = 0 or coalesce(e.version, 1) > v_effective_since);

  -- 3. Judges delta (explicit safe columns; NEVER returns pin, pin_hash, pin_encrypted, current_session_token)
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

  -- 4. Participants delta (explicit safe columns; NEVER returns mobile_number; masks PII in blind mode for judges)
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

  -- 5. Scores delta (organiser sees all org scores; judge sees own scores when blind or isolated)
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

  -- 6. Deletions delta (omitted on full_resync since full snapshot already excludes deleted rows)
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
      and d.version > v_effective_since;
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
    'deletions', v_deletions
  );
end;
$$;

revoke all on function public.read_org_changes(text, bigint) from public;
grant execute on function public.read_org_changes(text, bigint) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 5. UPDATE fj_health() TO REPORT PHASE 4D SYNC METADATA
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
  select jsonb_object_agg(relname, relrowsecurity)
  into v_rls
  from pg_class
  join pg_namespace n on n.oid = pg_class.relnamespace
  where n.nspname = 'public'
    and relname in (
      'organizations', 'org_secrets', 'org_login_throttle',
      'judge_secrets', 'judge_login_throttle', '_fj_internal_secrets',
      'events', 'judges', 'participants', 'scores', 'sync_deletions'
    );

  select count(*)
  into v_public_select_count
  from pg_policies
  where schemaname = 'public'
    and cmd = 'SELECT'
    and (
      tablename in ('events', 'judges', 'participants', 'scores', 'judge_secrets', 'judge_login_throttle', 'sync_deletions')
      or (tablename = 'organizations' and 'anon' = any(roles))
      or (tablename = 'organizations' and 'public' = any(roles))
    );

  return jsonb_build_object(
    'ok', true,
    'rls_enabled', coalesce(v_rls, '{}'::jsonb),
    'triggers', jsonb_build_object('roster_guard', true, 'sync_version', true),
    'public_select_policies', coalesce(v_public_select_count, 0),
    'pii_locked', true,
    'delta_sync', true
  );
end;
$$;

revoke all on function public.fj_health() from public;
grant execute on function public.fj_health() to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION QUERY (Read-only, returns ONE jsonb cell)
-- ═══════════════════════════════════════════════════════════════════
select jsonb_build_object(
  'phase4d_simple_sync', 'verified',
  'version_columns_present', (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and (
        (table_name = 'organizations' and column_name in ('sync_version', 'version', 'updated_at'))
        or (table_name in ('events', 'judges', 'participants') and column_name in ('version', 'updated_at'))
        or (table_name = 'scores' and column_name in ('org_id', 'version', 'updated_at'))
      )
  ),
  'scores_missing_org_id', (
    select count(*) from public.scores where org_id is null or btrim(org_id) = ''
  ),
  'sync_deletions_rls', (
    select relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'sync_deletions'
  ),
  'sync_deletions_anon_grants', (
    select count(*)
    from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'sync_deletions'
      and grantee in ('anon', 'authenticated')
  ),
  'indexes_present', (
    select count(*)
    from pg_indexes
    where schemaname = 'public'
      and indexname in (
        'idx_events_org_version',
        'idx_judges_org_version',
        'idx_participants_org_version',
        'idx_scores_org_version',
        'idx_sync_deletions_org_ver'
      )
  ),
  'triggers_present', (
    select count(*)
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and not t.tgisinternal
      and t.tgname in (
        'trg_fj_sync_org_version',
        'trg_fj_sync_org_delete',
        'trg_fj_sync_events_version',
        'trg_fj_sync_events_delete',
        'trg_fj_sync_judges_version',
        'trg_fj_sync_judges_delete',
        'trg_fj_sync_participants_version',
        'trg_fj_sync_participants_delete',
        'trg_fj_sync_scores_version',
        'trg_fj_sync_scores_delete'
      )
  ),
  'read_org_changes_security_definer', (
    select p.prosecdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'read_org_changes'
  ),
  'invalid_token_check', public.read_org_changes('invalid-token', 0),
  'fj_health', public.fj_health()
) as phase4d_verification;
