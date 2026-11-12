-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.7 — Auth & Registration Hotfix
-- ═══════════════════════════════════════════════════════════════════
-- 1. Unlocks any locked accounts in throttle table
-- 2. Aligns password length requirement with the app (6+ chars instead of 8+)
-- 3. Returns both 'error' and 'reason' keys in JSON response
-- 4. Auto-heals legacy accounts into org_secrets if needed
-- ═══════════════════════════════════════════════════════════════════

-- Ensure pgcrypto extension is installed
create extension if not exists pgcrypto with schema extensions;

-- Clear any temporary throttle locks from failed attempts
truncate table public.org_login_throttle;

-- Migrate any organizations that still don't have an entry in org_secrets
do $$
begin
  if exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' and table_name = 'organizations' and column_name = 'password'
  ) then
    insert into public.org_secrets(org_id, password_hash)
    select org_id, extensions.crypt(btrim(password), extensions.gen_salt('bf', 10))
    from public.organizations
    where password is not null and btrim(password) <> ''
    on conflict (org_id) do nothing;
  end if;
end $$;

-- 1. Internal Verification Helper with Auto-Heal & dual error/reason keys
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
  v_plain text;
begin
  v_key := lower(btrim(coalesce(p_identifier, '')));
  v_pwd := btrim(coalesce(p_password, ''));

  if v_key = '' or v_pwd = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials', 'reason', 'invalid_credentials');
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
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts', 'reason', 'too_many_attempts');
  end if;

  -- Load hash from org_secrets
  if v_org_id is not null then
    select password_hash into v_hash
    from public.org_secrets
    where org_id = v_org_id;
  end if;

  -- Auto-heal fallback: if org_secrets missing but organizations.password column exists
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
      end;

    return jsonb_build_object('ok', false, 'error', 'invalid_credentials', 'reason', 'invalid_credentials');
  end if;
end;
$$;

revoke all on function public._fj_verify_org(text, text) from public, anon, authenticated;

-- 2. Public Login Function
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

revoke all on function public.org_login(text, text) from public;
grant execute on function public.org_login(text, text) to anon, authenticated;

-- 3. Public Verify Password Function
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

revoke all on function public.org_verify_password(text, text) from public;
grant execute on function public.org_verify_password(text, text) to anon, authenticated;

-- 4. Public Change Password Function (min 6 characters)
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
      updated_at = now()
  where org_id = v->>'org_id';

  delete from public.org_login_throttle where key = lower(v->>'org_id');

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.org_change_password(text, text, text) from public;
grant execute on function public.org_change_password(text, text, text) to anon, authenticated;

-- 5. Public Register Organization Function (min 6 characters, standard gen_random_uuid)
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
    return jsonb_build_object('ok', false, 'error', 'invalid_input', 'reason', 'invalid_input');
  end if;

  -- 6 characters minimum (matches Fair Judge UI requirements)
  if length(clean_pass) < 6 or length(clean_pass) > 72 then
    return jsonb_build_object('ok', false, 'error', 'weak_password', 'reason', 'weak_password');
  end if;

  -- Duplicate check: org_id or email
  select org_id into existing_id
  from public.organizations
  where lower(org_id) = lower(clean_org_id)
     or (clean_email is not null and lower(coalesce(email, '')) = clean_email)
  limit 1;

  if existing_id is not null then
    return jsonb_build_object('ok', false, 'error', 'duplicate', 'reason', 'duplicate');
  end if;

  -- Insert organizations row
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
    gen_random_uuid()::text,
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

  -- Insert secret hash into org_secrets
  insert into public.org_secrets (org_id, password_hash, updated_at)
  values (clean_org_id, extensions.crypt(clean_pass, extensions.gen_salt('bf', 10)), now())
  on conflict (org_id) do update set password_hash = excluded.password_hash, updated_at = now();

  -- Clear throttle
  delete from public.org_login_throttle where key in (lower(clean_org_id), lower(coalesce(clean_email, '')));

  return jsonb_build_object('ok', true, 'org', to_jsonb(v_org_row) - 'password');
end;
$$;

revoke all on function public.org_register(text, text, text, text) from public;
grant execute on function public.org_register(text, text, text, text) to anon, authenticated;
