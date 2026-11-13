-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.8 — Stage A: Admin Console, Support Inbox, Announcements & Enforcement
-- ═══════════════════════════════════════════════════════════════════
-- Prerequisites: Epic 15.7 (org_secrets, org_login_throttle, org_sessions,
-- judge_sessions, _fj_verify_org, org_login, Stage D3 SELECT-only policies).
-- Order of sections:
--   A3. platform_admins + is_platform_admin()
--   A2. Tighten organizations RLS (anon + admin authenticated only)
--   A4. Schema additions, platform_settings, audit/security/announcements/support tables,
--       _fj_verify_org lockout logging, org_change_password must_change reset
--   A5. fj_org_can_run() + additive enforcement triggers + org_login/judge_login blocks
--   A6. 18 admin_* SECURITY DEFINER RPCs
--   A7. Public get_active_announcements() & support_submit() RPCs
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ─────────────────────────────────────────────────────────────────
-- A3. PLATFORM ADMINS & HELPER
-- ─────────────────────────────────────────────────────────────────

create table if not exists public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;
revoke all on table public.platform_admins from anon, authenticated, public;

create or replace function public.is_platform_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select auth.uid() is not null
    and exists (
      select 1
      from public.platform_admins pa
      where pa.user_id = auth.uid()
    );
$$;

revoke all on function public.is_platform_admin() from public, anon;
grant execute on function public.is_platform_admin() to authenticated;

-- ─────────────────────────────────────────────────────────────────
-- A2. TIGHTEN ORGANIZATIONS SELECT POLICY
-- ─────────────────────────────────────────────────────────────────
-- Drops wide "organizations_select" (to public) and replaces with explicit
-- anon read + admin-only authenticated read. Non-admin authenticated users
-- cannot SELECT organizations.

drop policy if exists "organizations_select" on public.organizations;
drop policy if exists "organizations_select_anon" on public.organizations;
drop policy if exists "organizations_select_admin" on public.organizations;

create policy "organizations_select_anon"
  on public.organizations
  for select
  to anon
  using (true);

create policy "organizations_select_admin"
  on public.organizations
  for select
  to authenticated
  using (public.is_platform_admin());

-- ─────────────────────────────────────────────────────────────────
-- A4. SCHEMA ADDITIONS, TABLES & SECURITY LOGGING
-- ─────────────────────────────────────────────────────────────────

alter table public.organizations
  add column if not exists suspended boolean not null default false,
  add column if not exists suspended_reason text,
  add column if not exists deleted_at timestamptz,
  add column if not exists rejection_reason text,
  add column if not exists verified_at timestamptz;

alter table public.org_secrets
  add column if not exists must_change boolean not null default false;

create table if not exists public.platform_settings (
  id int primary key check (id = 1),
  enforce_verification boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

insert into public.platform_settings (id, enforce_verification)
values (1, false)
on conflict (id) do nothing;

alter table public.platform_settings enable row level security;
revoke all on table public.platform_settings from anon, authenticated, public;

create table if not exists public.admin_audit_log (
  id bigserial primary key,
  admin_id uuid not null,
  action text not null,
  target_org_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_log_created
  on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;
revoke all on table public.admin_audit_log from anon, authenticated, public;

create table if not exists public.security_events (
  id bigserial primary key,
  kind text not null,
  org_id text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_security_events_created
  on public.security_events (created_at desc);
create index if not exists idx_security_events_org
  on public.security_events (org_id);

alter table public.security_events enable row level security;
revoke all on table public.security_events from anon, authenticated, public;

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  severity text not null default 'info' check (severity in ('info', 'warning', 'urgent')),
  audience text not null default 'all' check (audience in ('all', 'organisers', 'judges', 'org')),
  target_org_id text,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid
);

create index if not exists idx_announcements_active
  on public.announcements (active, starts_at desc);

alter table public.announcements enable row level security;
revoke all on table public.announcements from anon, authenticated, public;

create table if not exists public.support_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  org_id text,
  role text not null,
  app_version text,
  summary text not null,
  report jsonb not null,
  status text not null default 'new' check (status in ('new', 'acknowledged', 'resolved')),
  admin_note text,
  resolved_at timestamptz
);

create index if not exists idx_support_reports_status_created
  on public.support_reports (status, created_at desc);

alter table public.support_reports enable row level security;
revoke all on table public.support_reports from anon, authenticated, public;

-- Update _fj_verify_org to log brute-force lockouts into security_events
create or replace function public._fj_verify_org(p_identifier text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text;
  v_pwd text;
  v_org_id text;
  v_tkey text;
  v_locked_until timestamptz;
  v_hash text;
  v_fails int;
  v_new_locked timestamptz;
  v_plain text;
begin
  v_key := lower(btrim(coalesce(p_identifier, '')));
  v_pwd := btrim(coalesce(p_password, ''));

  if v_key = '' or v_pwd = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials', 'reason', 'invalid_credentials');
  end if;

  select o.org_id into v_org_id
  from public.organizations o
  where lower(o.org_id) = v_key or lower(coalesce(o.email, '')) = v_key
  limit 1;

  v_tkey := lower(coalesce(v_org_id, v_key));

  select locked_until into v_locked_until
  from public.org_login_throttle
  where key = v_tkey;

  if v_locked_until is not null and v_locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts', 'reason', 'too_many_attempts');
  end if;

  if v_org_id is not null then
    select password_hash into v_hash
    from public.org_secrets
    where org_id = v_org_id;
  end if;

  if v_hash is null and v_org_id is not null then
    begin
      execute 'select password from public.organizations where org_id = $1' into v_plain using v_org_id;
      if v_plain is not null and btrim(v_plain) = v_pwd then
        insert into public.org_secrets (org_id, password_hash, updated_at)
        values (v_org_id, extensions.crypt(v_pwd, extensions.gen_salt('bf', 10)), now())
        on conflict (org_id) do update set password_hash = excluded.password_hash;
        delete from public.org_login_throttle where key = v_tkey;
        return jsonb_build_object('ok', true, 'org_id', v_org_id);
      end if;
    exception when others then
      null;
    end;
  end if;

  if v_hash is not null and extensions.crypt(v_pwd, v_hash) = v_hash then
    delete from public.org_login_throttle where key = v_tkey;
    return jsonb_build_object('ok', true, 'org_id', v_org_id);
  else
    insert into public.org_login_throttle (key, fails, first_fail_at, locked_until)
    values (v_tkey, 1, now(), null)
    on conflict (key) do update set
      fails = case
        when public.org_login_throttle.first_fail_at < now() - interval '15 minutes' then 1
        else public.org_login_throttle.fails + 1
      end,
      first_fail_at = case
        when public.org_login_throttle.first_fail_at < now() - interval '15 minutes' then now()
        else public.org_login_throttle.first_fail_at
      end,
      locked_until = case
        when (case when public.org_login_throttle.first_fail_at < now() - interval '15 minutes' then 1 else public.org_login_throttle.fails + 1 end) >= 5
        then now() + interval '15 minutes'
        else null
      end
    returning fails, locked_until into v_fails, v_new_locked;

    if v_new_locked is not null then
      insert into public.security_events (kind, org_id, detail)
      values (
        'lockout',
        coalesce(v_org_id, upper(v_tkey)),
        jsonb_build_object('fails', v_fails, 'locked_until', v_new_locked)
      );
    end if;

    return jsonb_build_object('ok', false, 'error', 'invalid_credentials', 'reason', 'invalid_credentials');
  end if;
end;
$$;

revoke all on function public._fj_verify_org(text, text) from public, anon, authenticated;

-- Clear must_change when organiser changes password
create or replace function public.org_change_password(p_org_id text, p_old text, p_new text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
  clean_new text;
begin
  v := public._fj_verify_org(p_org_id, p_old);
  if not (v->>'ok')::boolean then
    return v;
  end if;

  clean_new := btrim(coalesce(p_new, ''));
  if length(clean_new) < 6 or length(clean_new) > 72 then
    return jsonb_build_object('ok', false, 'error', 'weak_password', 'reason', 'weak_password');
  end if;

  update public.org_secrets
  set password_hash = extensions.crypt(clean_new, extensions.gen_salt('bf', 10)),
      must_change = false,
      updated_at = now()
  where org_id = v->>'org_id';

  delete from public.org_login_throttle where key = lower(v->>'org_id');

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.org_change_password(text, text, text) from public;
grant execute on function public.org_change_password(text, text, text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- A5. DATABASE-LEVEL ENFORCEMENT & LOGIN BLOCKS
-- ─────────────────────────────────────────────────────────────────

create or replace function public.fj_org_can_run(p_org_id text)
returns text
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_org record;
  v_enforce boolean;
begin
  select verification_status, suspended, deleted_at
  into v_org
  from public.organizations
  where upper(org_id) = upper(btrim(coalesce(p_org_id, '')))
  limit 1;

  if not found then
    return 'NOT_FOUND';
  end if;

  if v_org.deleted_at is not null then
    return 'DELETED';
  end if;

  if coalesce(v_org.suspended, false) then
    return 'SUSPENDED';
  end if;

  select coalesce(enforce_verification, false)
  into v_enforce
  from public.platform_settings
  where id = 1;

  if coalesce(v_enforce, false) and coalesce(v_org.verification_status, 'pending') <> 'verified' then
    return 'NOT_VERIFIED';
  end if;

  return 'OK';
end;
$$;

revoke all on function public.fj_org_can_run(text) from public;
grant execute on function public.fj_org_can_run(text) to anon, authenticated;

create or replace function public._fj_trg_enforce_event_run()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check text;
begin
  if lower(coalesce(new.status, '')) = 'active'
     and (tg_op = 'INSERT' or lower(coalesce(old.status, '')) <> 'active') then
    v_check := public.fj_org_can_run(new.org_id);
    if v_check <> 'OK' then
      raise exception 'ORG_NOT_ALLOWED: %', v_check using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public._fj_trg_enforce_event_run() from public, anon, authenticated;

drop trigger if exists trg_fj_enforce_event_run on public.events;
create trigger trg_fj_enforce_event_run
  before insert or update on public.events
  for each row execute function public._fj_trg_enforce_event_run();

create or replace function public._fj_trg_enforce_score_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id text;
  v_check text;
begin
  select e.org_id into v_org_id
  from public.events e
  where e.id = new.event_id;

  if v_org_id is not null then
    v_check := public.fj_org_can_run(v_org_id);
    if v_check <> 'OK' then
      raise exception 'ORG_NOT_ALLOWED: %', v_check using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public._fj_trg_enforce_score_org() from public, anon, authenticated;

drop trigger if exists trg_fj_enforce_score_org on public.scores;
create trigger trg_fj_enforce_score_org
  before insert on public.scores
  for each row execute function public._fj_trg_enforce_score_org();

-- Update org_login: block suspended/deleted, return must_change, KEEP D2 org_sessions token
create or replace function public.org_login(p_identifier text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
  v_org_row public.organizations;
  v_org jsonb;
  v_org_id text;
  v_token text;
  v_must_change boolean;
begin
  v := public._fj_verify_org(p_identifier, p_password);
  if not (v->>'ok')::boolean then
    return v;
  end if;

  v_org_id := v->>'org_id';

  select * into v_org_row
  from public.organizations o
  where o.org_id = v_org_id;

  if v_org_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials', 'reason', 'invalid_credentials');
  end if;

  if v_org_row.deleted_at is not null then
    return jsonb_build_object('ok', false, 'error', 'org_deleted', 'reason', 'org_deleted');
  end if;

  if coalesce(v_org_row.suspended, false) then
    return jsonb_build_object(
      'ok', false,
      'error', 'org_suspended',
      'reason', 'org_suspended',
      'detail', coalesce(v_org_row.suspended_reason, '')
    );
  end if;

  v_org := to_jsonb(v_org_row) - 'password';

  select coalesce(s.must_change, false) into v_must_change
  from public.org_secrets s
  where upper(s.org_id) = upper(v_org_id)
  limit 1;

  delete from public.org_sessions where org_id = v_org_id and expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.org_sessions (token, org_id, created_at, expires_at)
  values (v_token, v_org_id, now(), now() + interval '30 days');

  return jsonb_build_object(
    'ok', true,
    'org', v_org,
    'session_token', v_token,
    'must_change', coalesce(v_must_change, false)
  );
end;
$$;

revoke all on function public.org_login(text, text) from public;
grant execute on function public.org_login(text, text) to anon, authenticated;

-- Update judge_login: also block suspended/deleted orgs cleanly
create or replace function public.judge_login(
  p_org_id text default null,
  p_judge_id text default null,
  p_pin text default null,
  p_event_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  clean_org_id text;
  clean_judge_id text;
  clean_pin text;
  clean_event_id text;
  v_judge public.judges;
  v_org_row public.organizations;
  v_token text;
  v_events jsonb;
  v_org jsonb;
begin
  clean_org_id := upper(btrim(coalesce(p_org_id, '')));
  clean_judge_id := btrim(coalesce(p_judge_id, ''));
  clean_pin := btrim(coalesce(p_pin, ''));
  clean_event_id := btrim(coalesce(p_event_id, ''));

  if clean_pin = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials', 'reason', 'invalid_credentials');
  end if;

  select j.* into v_judge
  from public.judges j
  where lower(btrim(j.pin)) = lower(clean_pin)
    and (clean_org_id = '' or upper(j.org_id) = clean_org_id)
    and (
      clean_judge_id = ''
      or lower(j.id::text) = lower(clean_judge_id)
      or lower(coalesce(j.judge_id, '')) = lower(clean_judge_id)
      or lower(j.name) = lower(clean_judge_id)
    )
    and (
      clean_event_id = ''
      or clean_event_id = any(coalesce(j.assigned_events, '{}'::text[]))
      or exists (
        select 1 from public.events e
        where e.id::text = clean_event_id
          and j.id::text = any(coalesce(e.assigned_judges, '{}'::text[]))
      )
    )
  order by j.created_at desc
  limit 1;

  if v_judge.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials', 'reason', 'invalid_credentials');
  end if;

  select * into v_org_row
  from public.organizations o
  where upper(o.org_id) = upper(v_judge.org_id)
  limit 1;

  if v_org_row.deleted_at is not null then
    return jsonb_build_object('ok', false, 'error', 'org_deleted', 'reason', 'org_deleted');
  end if;

  if coalesce(v_org_row.suspended, false) then
    return jsonb_build_object(
      'ok', false,
      'error', 'org_suspended',
      'reason', 'org_suspended',
      'detail', coalesce(v_org_row.suspended_reason, '')
    );
  end if;

  delete from public.judge_sessions where judge_id = v_judge.id and expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.judge_sessions (token, judge_id, org_id, created_at, expires_at)
  values (v_token, v_judge.id, v_judge.org_id, now(), now() + interval '30 days');

  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb)
  into v_events
  from public.events e
  where upper(e.org_id) = upper(v_judge.org_id)
    and (
      v_judge.id::text = any(coalesce(e.assigned_judges, '{}'::text[]))
      or e.id::text = any(coalesce(v_judge.assigned_events, '{}'::text[]))
      or lower(coalesce(e.status, '')) = 'active'
    );

  v_org := to_jsonb(v_org_row) - 'password';

  return jsonb_build_object(
    'ok', true,
    'judge', to_jsonb(v_judge),
    'assigned_events', v_events,
    'org', v_org,
    'session_token', v_token
  );
end;
$$;

revoke all on function public.judge_login(text, text, text, text) from public;
grant execute on function public.judge_login(text, text, text, text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- A6. ADMIN RPC FUNCTIONS (18 total, all gated by is_platform_admin())
-- ─────────────────────────────────────────────────────────────────

-- 1. admin_overview
create or replace function public.admin_overview()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_enforce boolean;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select coalesce(enforce_verification, false) into v_enforce
  from public.platform_settings where id = 1;

  return jsonb_build_object(
    'total_orgs', (select count(*) from public.organizations where deleted_at is null),
    'pending_orgs', (select count(*) from public.organizations where deleted_at is null and not suspended and verification_status = 'pending'),
    'verified_orgs', (select count(*) from public.organizations where deleted_at is null and not suspended and verification_status = 'verified'),
    'rejected_orgs', (select count(*) from public.organizations where deleted_at is null and not suspended and verification_status = 'rejected'),
    'suspended_orgs', (select count(*) from public.organizations where deleted_at is null and suspended = true),
    'deleted_orgs', (select count(*) from public.organizations where deleted_at is not null),
    'total_events', (select count(*) from public.events),
    'active_events', (select count(*) from public.events where lower(coalesce(status, '')) = 'active'),
    'total_judges', (select count(*) from public.judges),
    'total_participants', (select count(*) from public.participants),
    'total_scores', (select count(*) from public.scores),
    'scores_7d', (select count(*) from public.scores where created_at > now() - interval '7 days'),
    'lockouts_24h', (select count(*) from public.security_events where kind = 'lockout' and created_at > now() - interval '24 hours'),
    'new_reports', (select count(*) from public.support_reports where status = 'new'),
    'open_reports', (select count(*) from public.support_reports where status in ('new', 'acknowledged')),
    'db_bytes', pg_database_size(current_database()),
    'enforce_verification', coalesce(v_enforce, false)
  );
end;
$$;

revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;

-- 2. admin_list_orgs
create or replace function public.admin_list_orgs(
  p_filter text default 'all',
  p_search text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_filter text := lower(btrim(coalesce(p_filter, 'all')));
  v_search text := btrim(coalesce(p_search, ''));
  v_result jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select coalesce(jsonb_agg(row_data order by sort_ts desc), '[]'::jsonb)
  into v_result
  from (
    select
      coalesce(o.created_at, now()) as sort_ts,
      (to_jsonb(o) - 'password') || jsonb_build_object(
        'events_count', (select count(*) from public.events e where upper(e.org_id) = upper(o.org_id)),
        'active_events_count', (select count(*) from public.events e where upper(e.org_id) = upper(o.org_id) and lower(coalesce(e.status, '')) = 'active'),
        'judges_count', (select count(*) from public.judges j where upper(j.org_id) = upper(o.org_id)),
        'participants_count', (select count(*) from public.participants p where upper(p.org_id) = upper(o.org_id)),
        'scores_count', (select count(*) from public.scores s join public.events e on e.id = s.event_id where upper(e.org_id) = upper(o.org_id)),
        'must_change', coalesce((select sec.must_change from public.org_secrets sec where upper(sec.org_id) = upper(o.org_id) limit 1), false),
        'locked_until', (
          select max(t.locked_until)
          from public.org_login_throttle t
          where t.locked_until > now()
            and (t.key = lower(o.org_id) or (o.email is not null and t.key = lower(o.email)))
        )
      ) as row_data
    from public.organizations o
    where (
      case v_filter
        when 'deleted' then o.deleted_at is not null
        when 'suspended' then o.deleted_at is null and o.suspended = true
        when 'pending' then o.deleted_at is null and o.suspended = false and o.verification_status = 'pending'
        when 'verified' then o.deleted_at is null and o.suspended = false and o.verification_status = 'verified'
        when 'rejected' then o.deleted_at is null and o.suspended = false and o.verification_status = 'rejected'
        else o.deleted_at is null
      end
    )
    and (
      v_search = ''
      or o.org_id ilike '%' || v_search || '%'
      or coalesce(o.name, '') ilike '%' || v_search || '%'
      or coalesce(o.email, '') ilike '%' || v_search || '%'
    )
  ) sub;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.admin_list_orgs(text, text) from public, anon;
grant execute on function public.admin_list_orgs(text, text) to authenticated;

-- 3. admin_set_verification
create or replace function public.admin_set_verification(
  p_org_id text,
  p_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_org_id text;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  if v_status not in ('pending', 'verified', 'rejected') then
    return jsonb_build_object('ok', false, 'error', 'invalid_status');
  end if;

  update public.organizations
  set
    verification_status = v_status,
    verified_at = case when v_status = 'verified' then now() else null end,
    rejection_reason = case when v_status = 'rejected' then nullif(btrim(coalesce(p_reason, '')), '') else null end
  where upper(org_id) = upper(btrim(coalesce(p_org_id, '')))
  returning org_id into v_org_id;

  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    'set_verification',
    v_org_id,
    jsonb_build_object('status', v_status, 'reason', nullif(btrim(coalesce(p_reason, '')), ''))
  );

  return jsonb_build_object('ok', true, 'org_id', v_org_id, 'status', v_status);
end;
$$;

revoke all on function public.admin_set_verification(text, text, text) from public, anon;
grant execute on function public.admin_set_verification(text, text, text) to authenticated;

-- 4. admin_set_suspended
create or replace function public.admin_set_suspended(
  p_org_id text,
  p_suspended boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_susp boolean := coalesce(p_suspended, false);
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  update public.organizations
  set
    suspended = v_susp,
    suspended_reason = case when v_susp then nullif(btrim(coalesce(p_reason, '')), '') else null end
  where upper(org_id) = upper(btrim(coalesce(p_org_id, '')))
  returning org_id into v_org_id;

  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if v_susp then
    delete from public.org_sessions where org_id = v_org_id;
    delete from public.judge_sessions where org_id = v_org_id;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    case when v_susp then 'suspend_org' else 'unsuspend_org' end,
    v_org_id,
    jsonb_build_object('suspended', v_susp, 'reason', nullif(btrim(coalesce(p_reason, '')), ''))
  );

  return jsonb_build_object('ok', true, 'org_id', v_org_id, 'suspended', v_susp);
end;
$$;

revoke all on function public.admin_set_suspended(text, boolean, text) from public, anon;
grant execute on function public.admin_set_suspended(text, boolean, text) to authenticated;

-- 5. admin_reset_org_password
create or replace function public.admin_reset_org_password(p_org_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_email text;
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  v_bytes bytea;
  v_temp text := '';
  i int;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select org_id, email into v_org_id, v_email
  from public.organizations
  where upper(org_id) = upper(btrim(coalesce(p_org_id, '')))
  limit 1;

  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  v_bytes := extensions.gen_random_bytes(12);
  for i in 0..11 loop
    v_temp := v_temp || substr(v_alphabet, (get_byte(v_bytes, i) % length(v_alphabet)) + 1, 1);
  end loop;

  insert into public.org_secrets (org_id, password_hash, must_change, updated_at)
  values (v_org_id, extensions.crypt(v_temp, extensions.gen_salt('bf', 10)), true, now())
  on conflict (org_id) do update set
    password_hash = excluded.password_hash,
    must_change = true,
    updated_at = now();

  delete from public.org_login_throttle
  where key in (lower(v_org_id), lower(coalesce(v_email, '')));

  delete from public.org_sessions where org_id = v_org_id;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    'reset_org_password',
    v_org_id,
    jsonb_build_object('must_change', true)
  );

  return jsonb_build_object('ok', true, 'org_id', v_org_id, 'temp_password', v_temp);
end;
$$;

revoke all on function public.admin_reset_org_password(text) from public, anon;
grant execute on function public.admin_reset_org_password(text) to authenticated;

-- 6. admin_soft_delete_org
create or replace function public.admin_soft_delete_org(p_org_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  update public.organizations
  set deleted_at = coalesce(deleted_at, now())
  where upper(org_id) = upper(btrim(coalesce(p_org_id, '')))
  returning org_id into v_org_id;

  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  delete from public.org_sessions where org_id = v_org_id;
  delete from public.judge_sessions where org_id = v_org_id;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (auth.uid(), 'soft_delete_org', v_org_id, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'org_id', v_org_id);
end;
$$;

revoke all on function public.admin_soft_delete_org(text) from public, anon;
grant execute on function public.admin_soft_delete_org(text) to authenticated;

-- 7. admin_restore_org
create or replace function public.admin_restore_org(p_org_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  update public.organizations
  set deleted_at = null
  where upper(org_id) = upper(btrim(coalesce(p_org_id, '')))
  returning org_id into v_org_id;

  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (auth.uid(), 'restore_org', v_org_id, '{}'::jsonb);

  return jsonb_build_object('ok', true, 'org_id', v_org_id);
end;
$$;

revoke all on function public.admin_restore_org(text) from public, anon;
grant execute on function public.admin_restore_org(text) to authenticated;

-- 8. admin_purge_deleted
create or replace function public.admin_purge_deleted(p_older_than_days int default 30)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_days int := greatest(0, coalesce(p_older_than_days, 30));
  v_org_ids text[];
  v_count int := 0;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select coalesce(array_agg(o.org_id), '{}'::text[])
  into v_org_ids
  from public.organizations o
  where o.deleted_at is not null
    and o.deleted_at <= now() - make_interval(days => v_days);

  v_count := coalesce(array_length(v_org_ids, 1), 0);

  if v_count > 0 then
    -- Clear roster locks so locked-event/judge/participant delete triggers allow purge
    update public.events
    set is_locked = false
    where org_id = any(v_org_ids) and is_locked = true;

    delete from public.scores
    where event_id in (select id from public.events where org_id = any(v_org_ids));

    delete from public.participants where org_id = any(v_org_ids);
    delete from public.judges where org_id = any(v_org_ids);
    delete from public.events where org_id = any(v_org_ids);
    delete from public.org_sessions where org_id = any(v_org_ids);
    delete from public.judge_sessions where org_id = any(v_org_ids);
    delete from public.org_secrets where org_id = any(v_org_ids);
    delete from public.organizations where org_id = any(v_org_ids);

    insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
    values (
      auth.uid(),
      'purge_deleted',
      null,
      jsonb_build_object('older_than_days', v_days, 'purged_count', v_count, 'org_ids', to_jsonb(v_org_ids))
    );
  end if;

  return jsonb_build_object('ok', true, 'purged_count', v_count, 'purged_org_ids', to_jsonb(coalesce(v_org_ids, '{}'::text[])));
end;
$$;

revoke all on function public.admin_purge_deleted(int) from public, anon;
grant execute on function public.admin_purge_deleted(int) to authenticated;

-- 9. admin_list_security_events
create or replace function public.admin_list_security_events(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_result jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select coalesce(jsonb_agg(item order by created_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      se.created_at,
      jsonb_build_object(
        'id', se.id,
        'kind', se.kind,
        'org_id', se.org_id,
        'org_name', (select o.name from public.organizations o where upper(o.org_id) = upper(se.org_id) limit 1),
        'detail', se.detail,
        'created_at', se.created_at,
        'still_locked_until', (
          select max(t.locked_until)
          from public.org_login_throttle t
          where t.locked_until > now()
            and t.key = lower(coalesce(se.org_id, ''))
        )
      ) as item
    from public.security_events se
    order by se.created_at desc
    limit v_lim
  ) sub;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.admin_list_security_events(int) from public, anon;
grant execute on function public.admin_list_security_events(int) to authenticated;

-- 10. admin_unlock_org
create or replace function public.admin_unlock_org(p_org_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text := lower(btrim(coalesce(p_org_id, '')));
  v_email text;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  if v_key = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_org_id');
  end if;

  select lower(email) into v_email
  from public.organizations
  where lower(org_id) = v_key
  limit 1;

  delete from public.org_login_throttle
  where key = v_key or (v_email is not null and key = v_email);

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (auth.uid(), 'unlock_org', upper(v_key), '{}'::jsonb);

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.admin_unlock_org(text) from public, anon;
grant execute on function public.admin_unlock_org(text) to authenticated;

-- 11. admin_list_audit
create or replace function public.admin_list_audit(p_limit int default 50)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_result jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select coalesce(jsonb_agg(to_jsonb(a) order by a.created_at desc), '[]'::jsonb)
  into v_result
  from (
    select id, admin_id, action, target_org_id, detail, created_at
    from public.admin_audit_log
    order by created_at desc
    limit v_lim
  ) a;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.admin_list_audit(int) from public, anon;
grant execute on function public.admin_list_audit(int) to authenticated;

-- 12. admin_set_enforcement
create or replace function public.admin_set_enforcement(p_enforce boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_val boolean := coalesce(p_enforce, false);
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  insert into public.platform_settings (id, enforce_verification, updated_at, updated_by)
  values (1, v_val, now(), auth.uid())
  on conflict (id) do update set
    enforce_verification = v_val,
    updated_at = now(),
    updated_by = auth.uid();

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    'set_enforcement',
    null,
    jsonb_build_object('enforce_verification', v_val)
  );

  return jsonb_build_object('ok', true, 'enforce_verification', v_val);
end;
$$;

revoke all on function public.admin_set_enforcement(boolean) from public, anon;
grant execute on function public.admin_set_enforcement(boolean) to authenticated;

-- 13. admin_list_announcements
create or replace function public.admin_list_announcements()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_result jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select coalesce(jsonb_agg(to_jsonb(a) order by a.active desc, a.created_at desc), '[]'::jsonb)
  into v_result
  from public.announcements a;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.admin_list_announcements() from public, anon;
grant execute on function public.admin_list_announcements() to authenticated;

-- 14. admin_save_announcement
create or replace function public.admin_save_announcement(
  p_id uuid default null,
  p_title text default '',
  p_body text default '',
  p_severity text default 'info',
  p_audience text default 'all',
  p_target_org_id text default null,
  p_ends_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_title text := btrim(coalesce(p_title, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_severity text := lower(btrim(coalesce(p_severity, 'info')));
  v_audience text := lower(btrim(coalesce(p_audience, 'all')));
  v_target text := upper(nullif(btrim(coalesce(p_target_org_id, '')), ''));
  v_row public.announcements;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  if v_title = '' or v_body = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;

  if v_severity not in ('info', 'warning', 'urgent') then
    v_severity := 'info';
  end if;

  if v_audience not in ('all', 'organisers', 'judges', 'org') then
    v_audience := 'all';
  end if;

  if p_id is not null then
    update public.announcements
    set
      title = v_title,
      body = v_body,
      severity = v_severity,
      audience = v_audience,
      target_org_id = case when v_audience = 'org' then v_target else null end,
      ends_at = p_ends_at,
      active = true
    where id = p_id
    returning * into v_row;

    if v_row.id is null then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
  else
    insert into public.announcements (
      title, body, severity, audience, target_org_id, starts_at, ends_at, active, created_by
    ) values (
      v_title,
      v_body,
      v_severity,
      v_audience,
      case when v_audience = 'org' then v_target else null end,
      now(),
      p_ends_at,
      true,
      auth.uid()
    )
    returning * into v_row;
  end if;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    case when p_id is null then 'create_announcement' else 'update_announcement' end,
    v_row.target_org_id,
    jsonb_build_object('id', v_row.id, 'title', v_row.title, 'audience', v_row.audience, 'severity', v_row.severity)
  );

  return jsonb_build_object('ok', true, 'announcement', to_jsonb(v_row));
end;
$$;

revoke all on function public.admin_save_announcement(uuid, text, text, text, text, text, timestamptz) from public, anon;
grant execute on function public.admin_save_announcement(uuid, text, text, text, text, text, timestamptz) to authenticated;

-- 15. admin_end_announcement
create or replace function public.admin_end_announcement(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  update public.announcements
  set active = false, ends_at = coalesce(ends_at, now())
  where id = p_id
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (auth.uid(), 'end_announcement', null, jsonb_build_object('id', v_id));

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.admin_end_announcement(uuid) from public, anon;
grant execute on function public.admin_end_announcement(uuid) to authenticated;

-- 16. admin_list_reports (excludes full report jsonb payload for fast listing)
create or replace function public.admin_list_reports(
  p_status text default 'all',
  p_limit int default 50
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := lower(btrim(coalesce(p_status, 'all')));
  v_lim int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_result jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select coalesce(jsonb_agg(row_data order by created_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      r.created_at,
      jsonb_build_object(
        'id', r.id,
        'created_at', r.created_at,
        'org_id', r.org_id,
        'role', r.role,
        'app_version', r.app_version,
        'summary', r.summary,
        'status', r.status,
        'admin_note', r.admin_note,
        'resolved_at', r.resolved_at
      ) as row_data
    from public.support_reports r
    where (v_status = 'all' or r.status = v_status)
    order by r.created_at desc
    limit v_lim
  ) sub;

  return coalesce(v_result, '[]'::jsonb);
end;
$$;

revoke all on function public.admin_list_reports(text, int) from public, anon;
grant execute on function public.admin_list_reports(text, int) to authenticated;

-- 17. admin_get_report (full payload)
create or replace function public.admin_get_report(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.support_reports;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  select * into v_row
  from public.support_reports
  where id = p_id;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  return jsonb_build_object('ok', true, 'report', to_jsonb(v_row));
end;
$$;

revoke all on function public.admin_get_report(uuid) from public, anon;
grant execute on function public.admin_get_report(uuid) to authenticated;

-- 18. admin_set_report_status
create or replace function public.admin_set_report_status(
  p_id uuid,
  p_status text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_status text := lower(btrim(coalesce(p_status, '')));
  v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'forbidden';
  end if;

  if v_status not in ('new', 'acknowledged', 'resolved') then
    return jsonb_build_object('ok', false, 'error', 'invalid_status');
  end if;

  update public.support_reports
  set
    status = v_status,
    admin_note = case when p_note is not null then nullif(btrim(p_note), '') else admin_note end,
    resolved_at = case when v_status = 'resolved' then now() else null end
  where id = p_id
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  insert into public.admin_audit_log (admin_id, action, target_org_id, detail)
  values (
    auth.uid(),
    'set_report_status',
    null,
    jsonb_build_object('id', v_id, 'status', v_status)
  );

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.admin_set_report_status(uuid, text, text) from public, anon;
grant execute on function public.admin_set_report_status(uuid, text, text) to authenticated;

-- ─────────────────────────────────────────────────────────────────
-- A7. PUBLIC RPCS: ANNOUNCEMENTS & SUPPORT REPORT SUBMISSION
-- ─────────────────────────────────────────────────────────────────

create or replace function public.get_active_announcements(p_org_id text default null)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'title', a.title,
        'body', a.body,
        'severity', a.severity,
        'audience', a.audience,
        'target_org_id', a.target_org_id,
        'starts_at', a.starts_at,
        'ends_at', a.ends_at
      )
      order by
        case a.severity when 'urgent' then 1 when 'warning' then 2 else 3 end,
        a.starts_at desc
    ),
    '[]'::jsonb
  )
  from public.announcements a
  where a.active = true
    and a.starts_at <= now()
    and (a.ends_at is null or a.ends_at > now())
    and (
      a.audience <> 'org'
      or (
        nullif(btrim(coalesce(p_org_id, '')), '') is not null
        and upper(coalesce(a.target_org_id, '')) = upper(btrim(p_org_id))
      )
    );
$$;

revoke all on function public.get_active_announcements(text) from public;
grant execute on function public.get_active_announcements(text) to anon, authenticated;

create or replace function public.support_submit(
  p_org_id text,
  p_role text,
  p_app_version text,
  p_summary text,
  p_report jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text := upper(nullif(btrim(coalesce(p_org_id, '')), ''));
  v_role text := lower(btrim(coalesce(p_role, '')));
  v_version text := left(btrim(coalesce(p_app_version, '')), 40);
  v_summary text := btrim(coalesce(p_summary, ''));
  v_report jsonb := coalesce(p_report, '{}'::jsonb);
  v_recent int;
  v_id uuid;
  v_created_at timestamptz;
begin
  if v_role not in ('organiser', 'judge', 'public', 'guest') then
    return jsonb_build_object('ok', false, 'error', 'invalid_role', 'message', 'Invalid reporter role.');
  end if;

  if v_summary = '' or length(v_summary) > 2000 then
    return jsonb_build_object('ok', false, 'error', 'invalid_summary', 'message', 'Summary must be between 1 and 2000 characters.');
  end if;

  if octet_length(v_report::text) > 307200 then
    return jsonb_build_object('ok', false, 'error', 'payload_too_large', 'message', 'Report exceeds 300 KB limit.');
  end if;

  if v_org_id is not null then
    if not exists (select 1 from public.organizations where upper(org_id) = v_org_id) then
      return jsonb_build_object('ok', false, 'error', 'org_not_found', 'message', 'Organization not found.');
    end if;
  elsif v_role in ('organiser', 'judge') then
    return jsonb_build_object('ok', false, 'error', 'org_required', 'message', 'Organization ID is required.');
  end if;

  select count(*) into v_recent
  from public.support_reports r
  where coalesce(upper(r.org_id), '') = coalesce(v_org_id, '')
    and lower(r.role) = v_role
    and r.created_at > now() - interval '1 hour';

  if v_recent >= 3 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited', 'message', 'Limit reached: max 3 reports per hour.');
  end if;

  insert into public.support_reports (org_id, role, app_version, summary, report)
  values (v_org_id, v_role, nullif(v_version, ''), v_summary, v_report)
  returning id, created_at into v_id, v_created_at;

  return jsonb_build_object('ok', true, 'id', v_id, 'created_at', v_created_at);
end;
$$;

revoke all on function public.support_submit(text, text, text, text, jsonb) from public;
grant execute on function public.support_submit(text, text, text, text, jsonb) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- ADMIN ACTIVATION (A3):
-- Uncomment the line below, replace PUT_YOUR_ADMIN_EMAIL_HERE with your
-- Supabase Auth admin email, and run it in SQL Editor:
-- ═══════════════════════════════════════════════════════════════════
-- insert into public.platform_admins(user_id) select id from auth.users where email = 'PUT_YOUR_ADMIN_EMAIL_HERE' on conflict (user_id) do nothing;
