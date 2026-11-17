-- ═══════════════════════════════════════════════════════════════════
-- EPIC 16.5.0 — Organiser Active Sessions (Max 3 Devices, SHA-256 Hash)
-- ═══════════════════════════════════════════════════════════════════
-- Additive, upgrade-safe migration for organiser multi-device control:
-- 1. Evolves public.org_sessions with id (PK), token_hash (SHA-256 hex),
--    device_id, device_label, last_seen_at, revoked_at; keeps legacy token
--    column nullable until a future cleanup migration.
-- 2. Purges pre-migration unhashed rows so zero raw tokens remain stored
--    (one-time organiser sign-out at migration) and old rows cannot occupy
--    the 3-device quota.
-- 3. Updates _fj_verify_org_token to verify SHA-256 token_hash only, reject
--    revoked/expired/suspended/deleted sessions, and rate-limit last_seen_at
--    updates to at most once every 10 minutes per session.
-- 4. Adds org_login_v2, org_session_revoke_on_limit, org_sessions_list,
--    org_session_terminate, org_sessions_terminate_others, and
--    org_change_password_v2.
-- 5. Keeps legacy org_login, org_register, and org_logout working using
--    hashed tokens (never writing new raw tokens).
-- 6. Ends with a single-cell JSONB verification query.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ─────────────────────────────────────────────────────────────────
-- 1. EVOLVE public.org_sessions SCHEMA (Additive & Idempotent)
-- ─────────────────────────────────────────────────────────────────

alter table public.org_sessions
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists token_hash text,
  add column if not exists device_id text,
  add column if not exists device_label text,
  add column if not exists last_seen_at timestamptz not null default now(),
  add column if not exists revoked_at timestamptz;

-- Backfill id on any pre-existing rows and enforce NOT NULL + default
update public.org_sessions
set id = gen_random_uuid()
where id is null;

alter table public.org_sessions
  alter column id set default gen_random_uuid(),
  alter column id set not null;

-- Move PRIMARY KEY from legacy token column to id (safe & idempotent)
do $$
declare
  v_pk_name text;
  v_pk_cols text[];
begin
  select c.conname,
         array_agg(a.attname order by u.ord)
  into v_pk_name, v_pk_cols
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  cross join lateral unnest(c.conkey) with ordinality as u(attnum, ord)
  join pg_attribute a on a.attrelid = t.oid and a.attnum = u.attnum
  where n.nspname = 'public'
    and t.relname = 'org_sessions'
    and c.contype = 'p'
  group by c.conname;

  if v_pk_name is null then
    alter table public.org_sessions
      add constraint org_sessions_pkey primary key (id);
  elsif v_pk_cols <> array['id']::text[] then
    execute format('alter table public.org_sessions drop constraint %I', v_pk_name);
    alter table public.org_sessions
      add constraint org_sessions_pkey primary key (id);
  end if;
end;
$$;

-- Keep legacy token column until next cleanup file, but allow NULL so raw tokens are never stored
alter table public.org_sessions
  alter column token drop not null;

-- Purge legacy unhashed rows so zero raw tokens remain and old rows do not consume the 3-device quota
delete from public.org_sessions
where token_hash is null;

-- Helpful partial & expiry indexes
create unique index if not exists idx_org_sessions_token_hash
  on public.org_sessions(token_hash)
  where token_hash is not null;

create index if not exists idx_org_sessions_org_active
  on public.org_sessions(org_id, created_at)
  where revoked_at is null;

create index if not exists idx_org_sessions_expires_at
  on public.org_sessions(expires_at);

alter table public.org_sessions enable row level security;
revoke all on table public.org_sessions from anon, authenticated, public;

-- ─────────────────────────────────────────────────────────────────
-- 2. INTERNAL TOKEN HASH & SESSION CONTEXT HELPERS
-- ─────────────────────────────────────────────────────────────────

create or replace function public._fj_hash_org_token(p_token text)
returns text
language sql
immutable
security definer
set search_path = public, extensions
as $$
  select case
    when btrim(coalesce(p_token, '')) = '' then null
    else encode(extensions.digest(convert_to(btrim(p_token), 'utf8'), 'sha256'), 'hex')
  end;
$$;

revoke all on function public._fj_hash_org_token(text) from public, anon, authenticated;

create or replace function public._fj_org_session_context(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_rec record;
begin
  v_hash := public._fj_hash_org_token(p_token);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  select
    s.id,
    s.org_id,
    s.last_seen_at,
    coalesce(o.suspended, false) as org_suspended,
    o.deleted_at as org_deleted_at
  into v_rec
  from public.org_sessions s
  join public.organizations o on upper(o.org_id) = upper(s.org_id)
  where s.token_hash = v_hash
    and s.revoked_at is null
    and s.expires_at > now()
  limit 1;

  if v_rec.id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  if v_rec.org_deleted_at is not null or v_rec.org_suspended then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  -- Rate-limit last_seen_at writes to at most once every 10 minutes per session
  if v_rec.last_seen_at is null or v_rec.last_seen_at <= now() - interval '10 minutes' then
    update public.org_sessions
    set last_seen_at = now()
    where id = v_rec.id
      and (last_seen_at is null or last_seen_at <= now() - interval '10 minutes');
  end if;

  return jsonb_build_object(
    'ok', true,
    'session_id', v_rec.id,
    'org_id', v_rec.org_id
  );
end;
$$;

revoke all on function public._fj_org_session_context(text) from public, anon, authenticated;

-- Update _fj_verify_org_token used by all read & write RPCs
create or replace function public._fj_verify_org_token(p_token text, p_org_id text default null)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ctx jsonb;
  v_org_id text;
begin
  v_ctx := public._fj_org_session_context(p_token);
  if not coalesce((v_ctx->>'ok')::boolean, false) then
    return null;
  end if;

  v_org_id := v_ctx->>'org_id';
  if p_org_id is not null and btrim(p_org_id) <> '' and upper(v_org_id) <> upper(btrim(p_org_id)) then
    return null;
  end if;

  return v_org_id;
end;
$$;

revoke all on function public._fj_verify_org_token(text, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 3. ORGANISER LOGIN V2 (MAX 3 DEVICES, SHA-256 HASH ONLY)
-- ─────────────────────────────────────────────────────────────────

create or replace function public.org_login_v2(
  p_identifier text,
  p_password text,
  p_device_id text default null,
  p_device_label text default null
)
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
  v_must_change boolean;
  v_device_id text;
  v_device_label text;
  v_active_count int := 0;
  v_sessions jsonb := '[]'::jsonb;
  v_token text;
  v_hash text;
  v_session_id uuid;
begin
  v := public._fj_verify_org(p_identifier, p_password);
  if not coalesce((v->>'ok')::boolean, false) then
    return v;
  end if;

  v_org_id := v->>'org_id';

  select * into v_org_row
  from public.organizations o
  where upper(o.org_id) = upper(v_org_id)
  limit 1;

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

  -- Serialize concurrent logins per org so max-3 cannot race
  perform pg_advisory_xact_lock(hashtext('org_sessions:' || upper(v_org_row.org_id)));

  -- Remove expired and terminated rows for this org at login to keep table small
  delete from public.org_sessions
  where upper(org_id) = upper(v_org_row.org_id)
    and (expires_at <= now() or revoked_at is not null);

  v_device_id := left(nullif(btrim(coalesce(p_device_id, '')), ''), 128);
  v_device_label := left(
    coalesce(nullif(btrim(coalesce(p_device_label, '')), ''), 'Web browser'),
    120
  );

  select
    count(*)::int,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'device_label', coalesce(nullif(btrim(s.device_label), ''), 'Unknown device'),
          'created_at', s.created_at,
          'last_seen_at', s.last_seen_at,
          'expires_at', s.expires_at,
          'is_same_device', (v_device_id is not null and s.device_id = v_device_id)
        )
        order by s.last_seen_at desc, s.created_at desc
      ),
      '[]'::jsonb
    )
  into v_active_count, v_sessions
  from public.org_sessions s
  where upper(s.org_id) = upper(v_org_row.org_id)
    and s.revoked_at is null
    and s.expires_at > now();

  if v_active_count >= 3 then
    return jsonb_build_object(
      'ok', false,
      'error', 'session_limit',
      'reason', 'session_limit',
      'max_sessions', 3,
      'sessions', v_sessions
    );
  end if;

  select coalesce(s.must_change, false) into v_must_change
  from public.org_secrets s
  where upper(s.org_id) = upper(v_org_row.org_id)
  limit 1;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := public._fj_hash_org_token(v_token);

  insert into public.org_sessions (
    org_id,
    token,
    token_hash,
    device_id,
    device_label,
    created_at,
    last_seen_at,
    expires_at,
    revoked_at
  )
  values (
    v_org_row.org_id,
    null,
    v_hash,
    v_device_id,
    v_device_label,
    now(),
    now(),
    now() + interval '30 days',
    null
  )
  returning id into v_session_id;

  v_org := to_jsonb(v_org_row) - 'password';

  return jsonb_build_object(
    'ok', true,
    'org', v_org,
    'session_token', v_token,
    'session_id', v_session_id,
    'must_change', coalesce(v_must_change, false)
  );
end;
$$;

revoke all on function public.org_login_v2(text, text, text, text) from public;
grant execute on function public.org_login_v2(text, text, text, text) to anon, authenticated;

-- Evict a chosen active session when a 4th device hits session_limit (re-verifies credentials)
create or replace function public.org_session_revoke_on_limit(
  p_identifier text,
  p_password text,
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
  v_org_row public.organizations;
  v_revoked_id uuid;
begin
  if p_session_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;

  v := public._fj_verify_org(p_identifier, p_password);
  if not coalesce((v->>'ok')::boolean, false) then
    return v;
  end if;

  select * into v_org_row
  from public.organizations o
  where upper(o.org_id) = upper(v->>'org_id')
  limit 1;

  if v_org_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  end if;

  if v_org_row.deleted_at is not null then
    return jsonb_build_object('ok', false, 'error', 'org_deleted');
  end if;

  if coalesce(v_org_row.suspended, false) then
    return jsonb_build_object('ok', false, 'error', 'org_suspended');
  end if;

  update public.org_sessions
  set revoked_at = now()
  where id = p_session_id
    and upper(org_id) = upper(v_org_row.org_id)
    and revoked_at is null
  returning id into v_revoked_id;

  if v_revoked_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  return jsonb_build_object('ok', true, 'revoked_id', v_revoked_id);
end;
$$;

revoke all on function public.org_session_revoke_on_limit(text, text, uuid) from public;
grant execute on function public.org_session_revoke_on_limit(text, text, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 4. SESSION MANAGEMENT RPCs (LIST, TERMINATE ONE, TERMINATE OTHERS)
-- ─────────────────────────────────────────────────────────────────

create or replace function public.org_sessions_list(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ctx jsonb;
  v_org_id text;
  v_cur_id uuid;
  v_sessions jsonb := '[]'::jsonb;
begin
  v_ctx := public._fj_org_session_context(p_token);
  if not coalesce((v_ctx->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  v_org_id := v_ctx->>'org_id';
  v_cur_id := (v_ctx->>'session_id')::uuid;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'device_label', coalesce(nullif(btrim(s.device_label), ''), 'Unknown device'),
        'created_at', s.created_at,
        'last_seen_at', s.last_seen_at,
        'expires_at', s.expires_at,
        'is_current', (s.id = v_cur_id)
      )
      order by (s.id = v_cur_id) desc, s.last_seen_at desc, s.created_at desc
    ),
    '[]'::jsonb
  )
  into v_sessions
  from public.org_sessions s
  where upper(s.org_id) = upper(v_org_id)
    and s.revoked_at is null
    and s.expires_at > now();

  return jsonb_build_object('ok', true, 'sessions', v_sessions);
end;
$$;

revoke all on function public.org_sessions_list(text) from public;
grant execute on function public.org_sessions_list(text) to anon, authenticated;

create or replace function public.org_session_terminate(p_token text, p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ctx jsonb;
  v_org_id text;
  v_cur_id uuid;
  v_terminated_id uuid;
begin
  v_ctx := public._fj_org_session_context(p_token);
  if not coalesce((v_ctx->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  if p_session_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;

  v_org_id := v_ctx->>'org_id';
  v_cur_id := (v_ctx->>'session_id')::uuid;

  -- Server-enforced rule: current device can never be terminated from its own list
  if p_session_id = v_cur_id then
    return jsonb_build_object('ok', false, 'error', 'cannot_terminate_current');
  end if;

  update public.org_sessions
  set revoked_at = now()
  where id = p_session_id
    and upper(org_id) = upper(v_org_id)
    and id <> v_cur_id
    and revoked_at is null
  returning id into v_terminated_id;

  if v_terminated_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  return jsonb_build_object('ok', true, 'terminated_id', v_terminated_id);
end;
$$;

revoke all on function public.org_session_terminate(text, uuid) from public;
grant execute on function public.org_session_terminate(text, uuid) to anon, authenticated;

create or replace function public.org_sessions_terminate_others(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ctx jsonb;
  v_org_id text;
  v_cur_id uuid;
  v_count int := 0;
begin
  v_ctx := public._fj_org_session_context(p_token);
  if not coalesce((v_ctx->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  v_org_id := v_ctx->>'org_id';
  v_cur_id := (v_ctx->>'session_id')::uuid;

  update public.org_sessions
  set revoked_at = now()
  where upper(org_id) = upper(v_org_id)
    and id <> v_cur_id
    and revoked_at is null;

  get diagnostics v_count = row_count;

  return jsonb_build_object('ok', true, 'terminated_count', v_count);
end;
$$;

revoke all on function public.org_sessions_terminate_others(text) from public;
grant execute on function public.org_sessions_terminate_others(text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 5. PASSWORD CHANGE V2 (REVOKES ALL OTHER SESSIONS, KEEPS CURRENT)
-- ─────────────────────────────────────────────────────────────────

create or replace function public.org_change_password_v2(
  p_token text,
  p_old text,
  p_new text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ctx jsonb;
  v_org_id text;
  v_cur_id uuid;
  v_verify jsonb;
  clean_new text;
  v_revoked_count int := 0;
begin
  v_ctx := public._fj_org_session_context(p_token);
  if not coalesce((v_ctx->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  v_org_id := v_ctx->>'org_id';
  v_cur_id := (v_ctx->>'session_id')::uuid;

  v_verify := public._fj_verify_org(v_org_id, p_old);
  if not coalesce((v_verify->>'ok')::boolean, false) then
    return v_verify;
  end if;

  clean_new := btrim(coalesce(p_new, ''));
  if length(clean_new) < 6 or length(clean_new) > 72 then
    return jsonb_build_object('ok', false, 'error', 'weak_password', 'reason', 'weak_password');
  end if;

  update public.org_secrets
  set password_hash = extensions.crypt(clean_new, extensions.gen_salt('bf', 10)),
      must_change = false,
      updated_at = now()
  where upper(org_id) = upper(v_org_id);

  delete from public.org_login_throttle where key = lower(v_org_id);

  update public.org_sessions
  set revoked_at = now()
  where upper(org_id) = upper(v_org_id)
    and id <> v_cur_id
    and revoked_at is null;

  get diagnostics v_revoked_count = row_count;

  return jsonb_build_object('ok', true, 'terminated_others', v_revoked_count);
end;
$$;

revoke all on function public.org_change_password_v2(text, text, text) from public;
grant execute on function public.org_change_password_v2(text, text, text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 6. UPGRADE-SAFE LEGACY WRAPPERS (org_login, org_register, org_logout)
--    Keep signatures intact for rolling clients; store SHA-256 hash only.
-- ─────────────────────────────────────────────────────────────────

create or replace function public.org_login(p_identifier text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return public.org_login_v2(p_identifier, p_password, null, 'Web browser (legacy client)');
end;
$$;

revoke all on function public.org_login(text, text) from public;
grant execute on function public.org_login(text, text) to anon, authenticated;

create or replace function public.org_register(
  p_org_id text,
  p_name text,
  p_email text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  clean_org_id text;
  clean_name text;
  clean_email text;
  clean_pass text;
  existing_id text;
  v_org_row public.organizations;
  v_token text;
  v_hash text;
begin
  clean_org_id := upper(btrim(coalesce(p_org_id, '')));
  clean_name := btrim(coalesce(p_name, ''));
  clean_email := lower(btrim(coalesce(p_email, '')));
  if clean_email = '' then
    clean_email := null;
  end if;
  clean_pass := btrim(coalesce(p_password, ''));

  if clean_org_id = '' or clean_name = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input', 'reason', 'invalid_input');
  end if;

  if length(clean_pass) < 6 or length(clean_pass) > 72 then
    return jsonb_build_object('ok', false, 'error', 'weak_password', 'reason', 'weak_password');
  end if;

  select org_id into existing_id
  from public.organizations
  where lower(org_id) = lower(clean_org_id)
     or (clean_email is not null and lower(coalesce(email, '')) = clean_email)
  limit 1;

  if existing_id is not null then
    return jsonb_build_object('ok', false, 'error', 'duplicate', 'reason', 'duplicate');
  end if;

  insert into public.organizations (
    id, org_id, name, email, verification_status,
    tie_breaker_enabled, tie_breaker_method, custom_participant_fields,
    blind_judging_enabled, auto_advance_enabled, grace_period_enabled,
    isolated_jury_enabled, created_at
  ) values (
    gen_random_uuid(),
    clean_org_id, clean_name, clean_email, 'pending',
    false, 'olympic', '[]'::jsonb,
    false, true, false,
    false, now()
  )
  returning * into v_org_row;

  insert into public.org_secrets (org_id, password_hash, updated_at)
  values (clean_org_id, extensions.crypt(clean_pass, extensions.gen_salt('bf', 10)), now())
  on conflict (org_id) do update set password_hash = excluded.password_hash, updated_at = now();

  delete from public.org_login_throttle where key in (lower(clean_org_id), lower(coalesce(clean_email, '')));

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := public._fj_hash_org_token(v_token);

  insert into public.org_sessions (
    org_id,
    token,
    token_hash,
    device_id,
    device_label,
    created_at,
    last_seen_at,
    expires_at,
    revoked_at
  )
  values (
    clean_org_id,
    null,
    v_hash,
    null,
    'Primary device',
    now(),
    now(),
    now() + interval '30 days',
    null
  );

  return jsonb_build_object(
    'ok', true,
    'org', to_jsonb(v_org_row) - 'password',
    'session_token', v_token
  );
end;
$$;

revoke all on function public.org_register(text, text, text, text) from public;
grant execute on function public.org_register(text, text, text, text) to anon, authenticated;

create or replace function public.org_logout(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tok text;
  v_hash text;
begin
  v_tok := btrim(coalesce(p_token, ''));
  if v_tok <> '' then
    v_hash := public._fj_hash_org_token(v_tok);
    update public.org_sessions
    set revoked_at = now()
    where revoked_at is null
      and (token_hash = v_hash or token = v_tok);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.org_logout(text) from public;
grant execute on function public.org_logout(text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 7. SINGLE-CELL JSONB VERIFICATION CHECK
-- ─────────────────────────────────────────────────────────────────

select jsonb_build_object(
  'epic', '16.5.0',
  'org_sessions_rls', (
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'org_sessions'
  ),
  'org_sessions_pk', (
    select array_agg(a.attname order by u.ord)
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    cross join lateral unnest(c.conkey) with ordinality as u(attnum, ord)
    join pg_attribute a on a.attrelid = t.oid and a.attnum = u.attnum
    where n.nspname = 'public' and t.relname = 'org_sessions' and c.contype = 'p'
  ),
  'token_nullable', (
    select is_nullable = 'YES'
    from information_schema.columns
    where table_schema = 'public' and table_name = 'org_sessions' and column_name = 'token'
  ),
  'columns_present', (
    select jsonb_agg(column_name order by column_name)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'org_sessions'
      and column_name in ('id', 'org_id', 'token_hash', 'device_id', 'device_label', 'created_at', 'last_seen_at', 'expires_at', 'revoked_at')
  ),
  'raw_tokens_remaining', (
    select count(*)::int from public.org_sessions where token is not null
  ),
  'table_grants_to_public_roles', (
    select count(*)::int
    from information_schema.table_privileges
    where table_schema = 'public'
      and table_name = 'org_sessions'
      and grantee in ('anon', 'authenticated', 'PUBLIC')
  ),
  'rpcs_deployed', (
    select jsonb_agg(p.proname order by p.proname)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        '_fj_hash_org_token',
        '_fj_org_session_context',
        '_fj_verify_org_token',
        'org_login_v2',
        'org_session_revoke_on_limit',
        'org_sessions_list',
        'org_session_terminate',
        'org_sessions_terminate_others',
        'org_change_password_v2',
        'org_login',
        'org_logout',
        'org_register'
      )
  ),
  'anon_can_exec_internal_helpers', (
    select
      has_function_privilege('anon', 'public._fj_verify_org_token(text, text)', 'EXECUTE')
      or has_function_privilege('anon', 'public._fj_org_session_context(text)', 'EXECUTE')
      or has_function_privilege('anon', 'public._fj_hash_org_token(text)', 'EXECUTE')
  ),
  'verify_uses_hash_not_raw', (
    select position('token_hash' in pg_get_functiondef('public._fj_org_session_context(text)'::regprocedure)) > 0
       and position('s.token =' in pg_get_functiondef('public._fj_org_session_context(text)'::regprocedure)) = 0
  ),
  'limit_check_present', (
    select position('session_limit' in pg_get_functiondef('public.org_login_v2(text, text, text, text)'::regprocedure)) > 0
       and position('>= 3' in pg_get_functiondef('public.org_login_v2(text, text, text, text)'::regprocedure)) > 0
  ),
  'self_terminate_blocked', (
    select position('cannot_terminate_current' in pg_get_functiondef('public.org_session_terminate(text, uuid)'::regprocedure)) > 0
  ),
  'sessions_list_hides_hashes', (
    select position('token_hash' in pg_get_functiondef('public.org_sessions_list(text)'::regprocedure)) = 0
       and position('s.token' in pg_get_functiondef('public.org_sessions_list(text)'::regprocedure)) = 0
       and position('''token''' in pg_get_functiondef('public.org_sessions_list(text)'::regprocedure)) = 0
  )
) as epic_16_5_0_verification;
