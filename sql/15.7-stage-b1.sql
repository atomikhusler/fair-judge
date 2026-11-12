-- ====================================================================
-- EPIC 15.7 STAGE B1: Password Hashing, Secret Table & Brute-Force Lockout
-- Safe additive migration: existing password column remains intact until B3.
-- ====================================================================

-- 1. Crypto Extension
create extension if not exists pgcrypto with schema extensions;

-- Ensure organizations.org_id has a unique constraint if not already unique
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.organizations'::regclass
      and contype in ('p', 'u')
      and conkey = array[(select attnum from pg_attribute where attrelid = 'public.organizations'::regclass and attname = 'org_id')]
  ) then
    alter table public.organizations add constraint organizations_org_id_key unique (org_id);
  end if;
end $$;

-- 2. Secret Tables (Never accessible to public anon key)
create table if not exists public.org_secrets (
  org_id text primary key references public.organizations(org_id) on delete cascade,
  password_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.org_login_throttle (
  key text primary key,
  fails int not null default 0,
  first_fail_at timestamptz,
  locked_until timestamptz
);

-- 3. Row Level Security & Explicit Revocation
alter table public.org_secrets enable row level security;
alter table public.org_login_throttle enable row level security;

revoke all on public.org_secrets from anon, authenticated, public;
revoke all on public.org_login_throttle from anon, authenticated, public;

-- 4. Initial Migration of Existing Plaintext Passwords into bcrypt Hashes
insert into public.org_secrets(org_id, password_hash)
select org_id, extensions.crypt(btrim(password), extensions.gen_salt('bf', 10))
from public.organizations
where password is not null and btrim(password) <> ''
on conflict (org_id) do nothing;

-- Audit notice
do $$
declare
  org_count int;
  secret_count int;
  unmigrated_list text;
begin
  select count(*) into org_count from public.organizations;
  select count(*) into secret_count from public.org_secrets;
  select string_agg(org_id, ', ') into unmigrated_list 
  from public.organizations 
  where org_id not in (select org_id from public.org_secrets);
  
  raise notice 'MIGRATION AUDIT: % organizations, % org_secrets rows created.', org_count, secret_count;
  if unmigrated_list is not null then
    raise notice 'WARNING: The following org_ids do not have a password secret: %', unmigrated_list;
  else
    raise notice 'SUCCESS: All organizations successfully migrated to org_secrets.';
  end if;
end $$;

-- 5. Internal Verification Helper (never accessible to public/anon)
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
begin
  v_key := lower(btrim(coalesce(p_identifier, '')));
  v_pwd := btrim(coalesce(p_password, ''));

  if v_key = '' or v_pwd = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_credentials');
  end if;

  -- Resolve org_id by org_id or email
  select o.org_id into v_org_id
  from public.organizations o
  where lower(o.org_id) = v_key or lower(coalesce(o.email, '')) = v_key
  limit 1;

  v_tkey := lower(coalesce(v_org_id, v_key));

  -- Check brute-force lockout
  select locked_until into v_locked_until
  from public.org_login_throttle
  where key = v_tkey;

  if v_locked_until is not null and v_locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'too_many_attempts');
  end if;

  -- Load hash from org_secrets
  if v_org_id is not null then
    select password_hash into v_hash
    from public.org_secrets
    where org_id = v_org_id;
  end if;

  -- Verify bcrypt hash
  if v_hash is not null and extensions.crypt(v_pwd, v_hash) = v_hash then
    delete from public.org_login_throttle where key = v_tkey;
    return jsonb_build_object('ok', true, 'org_id', v_org_id);
  else
    -- Record failed attempt (lock after 5 fails for 15 minutes)
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
    returning fails into v_fails;

    -- 2% probability background maintenance
    if random() < 0.02 then
      delete from public.org_login_throttle
      where first_fail_at < now() - interval '1 day'
        and (locked_until is null or locked_until < now());
    end if;

    return jsonb_build_object('ok', false, 'reason', 'invalid_credentials');
  end if;
end;
$$;

revoke all on function public._fj_verify_org(text, text) from public, anon, authenticated;

-- 6. Public API Functions (SECURITY DEFINER, sanitize password output)

-- Login
create or replace function public.org_login(p_identifier text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
  v_org jsonb;
begin
  v := public._fj_verify_org(p_identifier, p_password);
  if not (v->>'ok')::boolean then
    return v;
  end if;

  select to_jsonb(o) - 'password' into v_org
  from public.organizations o
  where o.org_id = v->>'org_id';

  return jsonb_build_object('ok', true, 'org', v_org);
end;
$$;

-- Verify Password (for sensitive confirmations such as deleting ended events)
create or replace function public.org_verify_password(p_org_id text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
begin
  v := public._fj_verify_org(p_org_id, p_password);
  if (v->>'ok')::boolean then
    return jsonb_build_object('ok', true);
  else
    return v;
  end if;
end;
$$;

-- Change Password
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
  if length(clean_new) < 8 or length(clean_new) > 72 then
    return jsonb_build_object('ok', false, 'reason', 'weak_password');
  end if;

  update public.org_secrets
  set password_hash = extensions.crypt(clean_new, extensions.gen_salt('bf', 10)),
      updated_at = now()
  where org_id = v->>'org_id';

  delete from public.org_login_throttle where key = lower(v->>'org_id');

  return jsonb_build_object('ok', true);
end;
$$;

-- Register New Organization
create or replace function public.org_register(p_org_id text, p_name text, p_email text, p_password text)
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
begin
  clean_org_id := upper(btrim(coalesce(p_org_id, '')));
  clean_name := btrim(coalesce(p_name, ''));
  clean_email := lower(btrim(coalesce(p_email, '')));
  if clean_email = '' then
    clean_email := null;
  end if;
  clean_pass := btrim(coalesce(p_password, ''));

  if clean_org_id = '' or clean_name = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_input');
  end if;

  if length(clean_pass) < 8 or length(clean_pass) > 72 then
    return jsonb_build_object('ok', false, 'reason', 'weak_password');
  end if;

  -- Duplicate check: org_id or email
  select org_id into existing_id
  from public.organizations
  where lower(org_id) = lower(clean_org_id)
     or (clean_email is not null and lower(coalesce(email, '')) = clean_email)
  limit 1;

  if existing_id is not null then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;

  -- Insert organizations row (atomic with org_secrets)
  insert into public.organizations (
    id,
    org_id,
    name,
    email,
    verification_status,
    tie_breaker_enabled,
    tie_breaker_method,
    custom_participant_fields,
    blind_judging_enabled,
    auto_advance_enabled,
    grace_period_enabled,
    isolated_jury_enabled,
    created_at
  ) values (
    gen_random_uuid(),
    clean_org_id,
    clean_name,
    clean_email,
    'pending',
    false,
    'olympic',
    '[]'::jsonb,
    false,
    true,
    false,
    false,
    now()
  )
  returning * into v_org_row;

  -- Insert secret hash
  insert into public.org_secrets (org_id, password_hash, updated_at)
  values (clean_org_id, extensions.crypt(clean_pass, extensions.gen_salt('bf', 10)), now());

  return jsonb_build_object('ok', true, 'org', to_jsonb(v_org_row) - 'password');
end;
$$;

-- 7. Grant execution permissions to anon and authenticated
revoke all on function public.org_login(text, text) from public;
grant execute on function public.org_login(text, text) to anon, authenticated;

revoke all on function public.org_verify_password(text, text) from public;
grant execute on function public.org_verify_password(text, text) to anon, authenticated;

revoke all on function public.org_change_password(text, text, text) from public;
grant execute on function public.org_change_password(text, text, text) to anon, authenticated;

revoke all on function public.org_register(text, text, text, text) from public;
grant execute on function public.org_register(text, text, text, text) to anon, authenticated;
