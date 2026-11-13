-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.7 — Stage D2: Server-Issued Session Tokens & Judge Login RPC
-- ═══════════════════════════════════════════════════════════════════
-- Additive, zero-breakage foundation for Phase 2 tenant isolation:
-- 1. Creates server-only org_sessions & judge_sessions tables (RLS ON, zero public access).
-- 2. Adds internal token verification helpers (_fj_verify_org_token, _fj_verify_judge_token).
-- 3. Updates org_login & org_register to mint a 30-day session_token alongside org data.
-- 4. Adds judge_login RPC (server-side PIN verification + judge_sessions token).
-- 5. Adds org_logout & judge_logout RPCs to revoke tokens on sign-out.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- 1. Server-Only Session Tables (Never accessible to anon/authenticated)
create table if not exists public.org_sessions (
  token text primary key,
  org_id text not null references public.organizations(org_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists idx_org_sessions_org_id on public.org_sessions(org_id);
alter table public.org_sessions enable row level security;
revoke all on table public.org_sessions from anon, authenticated, public;

create table if not exists public.judge_sessions (
  token text primary key,
  judge_id uuid not null references public.judges(id) on delete cascade,
  org_id text not null references public.organizations(org_id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days')
);

create index if not exists idx_judge_sessions_judge_id on public.judge_sessions(judge_id);
create index if not exists idx_judge_sessions_org_id on public.judge_sessions(org_id);
alter table public.judge_sessions enable row level security;
revoke all on table public.judge_sessions from anon, authenticated, public;

-- 2. Internal Token Verification Helpers (for SECURITY DEFINER RPCs only)
create or replace function public._fj_verify_org_token(p_token text, p_org_id text default null)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tok text;
  v_org_id text;
begin
  v_tok := btrim(coalesce(p_token, ''));
  if v_tok = '' then
    return null;
  end if;

  select s.org_id into v_org_id
  from public.org_sessions s
  where s.token = v_tok
    and s.expires_at > now()
  limit 1;

  if v_org_id is null then
    return null;
  end if;

  if p_org_id is not null and btrim(p_org_id) <> '' and upper(v_org_id) <> upper(btrim(p_org_id)) then
    return null;
  end if;

  return v_org_id;
end;
$$;

revoke all on function public._fj_verify_org_token(text, text) from public, anon, authenticated;

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

  select s.judge_id, s.org_id into v_rec
  from public.judge_sessions s
  where s.token = v_tok
    and s.expires_at > now()
  limit 1;

  if v_rec.judge_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  return jsonb_build_object('ok', true, 'judge_id', v_rec.judge_id, 'org_id', v_rec.org_id);
end;
$$;

revoke all on function public._fj_verify_judge_token(text) from public, anon, authenticated;

-- 3. Update org_login to mint & return session_token
create or replace function public.org_login(p_identifier text, p_password text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v jsonb;
  v_org jsonb;
  v_org_id text;
  v_token text;
begin
  v := public._fj_verify_org(p_identifier, p_password);
  if not (v->>'ok')::boolean then
    return v;
  end if;

  v_org_id := v->>'org_id';

  select to_jsonb(o) - 'password' into v_org
  from public.organizations o
  where o.org_id = v_org_id;

  -- Prune expired tokens for this org and mint a fresh 30-day session token
  delete from public.org_sessions where org_id = v_org_id and expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.org_sessions (token, org_id, created_at, expires_at)
  values (v_token, v_org_id, now(), now() + interval '30 days');

  return jsonb_build_object(
    'ok', true,
    'org', v_org,
    'session_token', v_token
  );
end;
$$;

revoke all on function public.org_login(text, text) from public;
grant execute on function public.org_login(text, text) to anon, authenticated;

-- 4. Update org_register to mint & return session_token (preserving gen_random_uuid() uuid type)
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
  v_token text;
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
  insert into public.org_sessions (token, org_id, created_at, expires_at)
  values (v_token, clean_org_id, now(), now() + interval '30 days');

  return jsonb_build_object(
    'ok', true,
    'org', to_jsonb(v_org_row) - 'password',
    'session_token', v_token
  );
end;
$$;

revoke all on function public.org_register(text, text, text, text) from public;
grant execute on function public.org_register(text, text, text, text) to anon, authenticated;

-- 5. Server-Side Judge Login RPC (validates credentials, mints judge_sessions token)
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

  select to_jsonb(o) - 'password' into v_org
  from public.organizations o
  where upper(o.org_id) = upper(v_judge.org_id)
  limit 1;

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

-- 6. Logout RPCs to revoke session tokens
create or replace function public.org_logout(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if btrim(coalesce(p_token, '')) <> '' then
    delete from public.org_sessions where token = btrim(p_token);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.org_logout(text) from public;
grant execute on function public.org_logout(text) to anon, authenticated;

create or replace function public.judge_logout(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if btrim(coalesce(p_token, '')) <> '' then
    delete from public.judge_sessions where token = btrim(p_token);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.judge_logout(text) from public;
grant execute on function public.judge_logout(text) to anon, authenticated;
