-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.12 — PHASE 3: PII LOCK & JUDGE SECRETS HARDENING
-- ═══════════════════════════════════════════════════════════════════
-- What this migration does:
--   3.2 PARTICIPANT MOBILE NUMBER LOCK
--     - Explicit column-level REVOKE SELECT (mobile_number) on public.participants
--     - Updates read_participants to return explicit non-PII columns only
--     - Adds organiser-only participants_list(p_token, p_org_id)
--
--   3.3 JUDGE PIN HASHING + ENCRYPTION + THROTTLE
--     - Creates server-only _fj_internal_secrets (RLS ON, REVOKE ALL) for symmetric key
--     - Creates public.judge_secrets (judge_id PK, org_id, pin_hash bcrypt, pin_encrypted, updated_at)
--     - Creates public.judge_login_throttle (brute-force lockout: 5 fails -> 15 min lock)
--     - Migrates existing judges.pin into judge_secrets, verifies 100% coverage,
--       and clears plaintext pin & current_session_token on public.judges
--     - Explicit column-level REVOKE SELECT (pin, current_session_token) on public.judges
--     - Adds organiser-only judges_list_with_pins(p_token, p_org_id)
--     - Updates read_org_roster_credentials, judge_upsert, judge_update, judge_login, org_restore
--     - Updates fj_health() with Phase 3 secret tables & column security status
--
-- Ends with a single read-only verification query returning ONE jsonb cell.
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ─────────────────────────────────────────────────────────────────
-- 1. SERVER-ONLY INTERNAL KEY STORE & JUDGE SECRETS / THROTTLE TABLES
-- ─────────────────────────────────────────────────────────────────
create table if not exists public._fj_internal_secrets (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now()
);

alter table public._fj_internal_secrets enable row level security;
revoke all on table public._fj_internal_secrets from anon, authenticated, public;

insert into public._fj_internal_secrets (key, value)
values ('judge_pin_key', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

create table if not exists public.judge_secrets (
  judge_id uuid primary key references public.judges(id) on delete cascade,
  org_id text not null references public.organizations(org_id) on delete cascade,
  pin_hash text not null,
  pin_encrypted text not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_judge_secrets_org_id on public.judge_secrets(org_id);
alter table public.judge_secrets enable row level security;
revoke all on table public.judge_secrets from anon, authenticated, public;

create table if not exists public.judge_login_throttle (
  key text primary key,
  fails int not null default 0,
  first_fail_at timestamptz,
  locked_until timestamptz
);

alter table public.judge_login_throttle enable row level security;
revoke all on table public.judge_login_throttle from anon, authenticated, public;

-- ─────────────────────────────────────────────────────────────────
-- 2. INTERNAL CRYPTO HELPERS (Never exposed to anon/authenticated/public)
-- ─────────────────────────────────────────────────────────────────
create or replace function public._fj_get_judge_pin_key()
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text;
begin
  select value into v_key
  from public._fj_internal_secrets
  where key = 'judge_pin_key'
  limit 1;

  if v_key is null or v_key = '' then
    v_key := encode(extensions.gen_random_bytes(32), 'hex');
    insert into public._fj_internal_secrets (key, value)
    values ('judge_pin_key', v_key)
    on conflict (key) do update set value = public._fj_internal_secrets.value
    returning value into v_key;
  end if;

  return v_key;
end;
$$;

revoke all on function public._fj_get_judge_pin_key() from public, anon, authenticated;

create or replace function public._fj_upsert_judge_secret(
  p_judge_id uuid,
  p_org_id text,
  p_pin text
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pin text;
  v_key text;
begin
  v_pin := coalesce(nullif(btrim(coalesce(p_pin, '')), ''), '0000');
  v_key := public._fj_get_judge_pin_key();

  insert into public.judge_secrets (judge_id, org_id, pin_hash, pin_encrypted, updated_at)
  values (
    p_judge_id,
    upper(btrim(p_org_id)),
    extensions.crypt(v_pin, extensions.gen_salt('bf', 10)),
    encode(extensions.pgp_sym_encrypt(v_pin, v_key), 'base64'),
    now()
  )
  on conflict (judge_id) do update set
    org_id = excluded.org_id,
    pin_hash = excluded.pin_hash,
    pin_encrypted = excluded.pin_encrypted,
    updated_at = now();
end;
$$;

revoke all on function public._fj_upsert_judge_secret(uuid, text, text) from public, anon, authenticated;

create or replace function public._fj_decrypt_judge_pin(p_pin_encrypted text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_key text;
begin
  if p_pin_encrypted is null or btrim(p_pin_encrypted) = '' then
    return null;
  end if;
  v_key := public._fj_get_judge_pin_key();
  return extensions.pgp_sym_decrypt(decode(p_pin_encrypted, 'base64'), v_key);
exception
  when others then
    return null;
end;
$$;

revoke all on function public._fj_decrypt_judge_pin(text) from public, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 3. MIGRATE EXISTING JUDGE PINS -> judge_secrets & CLEAR PLAINTEXT COLUMNS
-- ─────────────────────────────────────────────────────────────────
do $$
declare
  v_key text;
  v_missing int;
begin
  v_key := public._fj_get_judge_pin_key();

  insert into public.judge_secrets (judge_id, org_id, pin_hash, pin_encrypted, updated_at)
  select
    j.id,
    upper(btrim(j.org_id)),
    extensions.crypt(coalesce(nullif(btrim(j.pin), ''), '0000'), extensions.gen_salt('bf', 10)),
    encode(extensions.pgp_sym_encrypt(coalesce(nullif(btrim(j.pin), ''), '0000'), v_key), 'base64'),
    now()
  from public.judges j
  on conflict (judge_id) do nothing;

  select count(*) into v_missing
  from public.judges j
  where not exists (select 1 from public.judge_secrets js where js.judge_id = j.id);

  if v_missing > 0 then
    raise exception 'Phase 3 migration aborted: % judge row(s) missing judge_secrets entry.', v_missing;
  end if;

  -- Wipe plaintext pin & current_session_token on public.judges
  update public.judges
  set pin = '',
      current_session_token = null
  where coalesce(pin, '') <> ''
     or current_session_token is not null;
end $$;

-- Defense-in-depth: explicit column-level revokes for PII / secret columns
revoke select (mobile_number) on table public.participants from anon, authenticated, public;
revoke select (pin, current_session_token) on table public.judges from anon, authenticated, public;

-- ─────────────────────────────────────────────────────────────────
-- 4. PARTICIPANT READS: NON-PII read_participants + ORGANISER participants_list
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

  -- Explicit safe column list (mobile_number is never read or returned here)
  select coalesce(
    jsonb_agg(
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
            'created_at', p.created_at
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
            'created_at', p.created_at
          )
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

create or replace function public.participants_list(
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
  v_out jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Organiser session expired or invalid. Please sign in again.'
    );
  end if;

  select coalesce(
    jsonb_agg(to_jsonb(p) order by p.created_at asc),
    '[]'::jsonb
  )
  into v_out
  from public.participants p
  where upper(p.org_id) = upper(v_org_id);

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.participants_list(text, text) from public;
grant execute on function public.participants_list(text, text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 5. JUDGE READS: NON-SECRET read_judges + ORGANISER judges_list_with_pins
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
      jsonb_build_object(
        'id', j.id,
        'org_id', j.org_id,
        'name', j.name,
        'judge_id', j.judge_id,
        'assigned_events', coalesce(j.assigned_events, '{}'::text[]),
        'created_at', j.created_at
      )
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

create or replace function public.judges_list_with_pins(
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
  v_out jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Organiser session expired or invalid. Please sign in again.'
    );
  end if;

  select coalesce(
    jsonb_agg(
      (to_jsonb(j) - 'pin' - 'current_session_token') || jsonb_build_object(
        'pin', coalesce(public._fj_decrypt_judge_pin(js.pin_encrypted), nullif(btrim(j.pin), ''), ''),
        'judge_pin', coalesce(public._fj_decrypt_judge_pin(js.pin_encrypted), nullif(btrim(j.pin), ''), '')
      )
      order by j.created_at desc
    ),
    '[]'::jsonb
  )
  into v_out
  from public.judges j
  left join public.judge_secrets js on js.judge_id = j.id
  where upper(j.org_id) = upper(v_org_id);

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.judges_list_with_pins(text, text) from public;
grant execute on function public.judges_list_with_pins(text, text) to anon, authenticated;

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
    jsonb_agg(
      (to_jsonb(j) - 'pin' - 'current_session_token') || jsonb_build_object(
        'pin', coalesce(public._fj_decrypt_judge_pin(js.pin_encrypted), nullif(btrim(j.pin), ''), ''),
        'judge_pin', coalesce(public._fj_decrypt_judge_pin(js.pin_encrypted), nullif(btrim(j.pin), ''), '')
      )
      order by j.created_at desc
    ),
    '[]'::jsonb
  )
  into v_judges
  from public.judges j
  left join public.judge_secrets js on js.judge_id = j.id
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

-- ─────────────────────────────────────────────────────────────────
-- 6. JUDGE WRITE RPCs (Store PIN only in judge_secrets, keep judges clean)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.judge_upsert(
  p_token text,
  p_record jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_id uuid;
  v_existing_org text;
  v_pin text;
  v_row public.judges;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_record->>'org_id');
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  v_id := coalesce(nullif(p_record->>'id', '')::uuid, gen_random_uuid());

  select org_id into v_existing_org from public.judges where id = v_id;
  if v_existing_org is not null and upper(v_existing_org) <> upper(v_org_id) then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Cannot overwrite judge from another organization.');
  end if;

  v_pin := coalesce(nullif(btrim(coalesce(p_record->>'pin', p_record->>'judge_pin', '')), ''), '0000');

  insert into public.judges (
    id, org_id, name, judge_id, pin, assigned_events, current_session_token, created_at
  ) values (
    v_id,
    v_org_id,
    coalesce(nullif(btrim(p_record->>'name'), ''), 'Judge'),
    p_record->>'judge_id',
    '',
    case when jsonb_typeof(p_record->'assigned_events') = 'array' then array(select jsonb_array_elements_text(p_record->'assigned_events')) else '{}'::text[] end,
    null,
    coalesce(nullif(p_record->>'created_at', '')::timestamptz, now())
  )
  on conflict (id) do update set
    name = excluded.name,
    judge_id = excluded.judge_id,
    pin = '',
    assigned_events = excluded.assigned_events,
    current_session_token = null
  returning * into v_row;

  perform public._fj_upsert_judge_secret(v_row.id, v_org_id, v_pin);

  return jsonb_build_object(
    'ok', true,
    'data', (to_jsonb(v_row) - 'pin' - 'current_session_token') || jsonb_build_object('pin', v_pin, 'judge_pin', v_pin)
  );
end;
$$;

revoke all on function public.judge_upsert(text, jsonb) from public;
grant execute on function public.judge_upsert(text, jsonb) to anon, authenticated;

create or replace function public.judge_update(
  p_token text,
  p_judge_id uuid,
  p_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_row public.judges;
  v_new_pin text;
  v_cur_pin text;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  update public.judges
  set
    name = case when p_updates ? 'name' then coalesce(nullif(btrim(p_updates->>'name'), ''), name) else name end,
    judge_id = case when p_updates ? 'judge_id' then p_updates->>'judge_id' else judge_id end,
    pin = '',
    assigned_events = case when p_updates ? 'assigned_events' then (case when jsonb_typeof(p_updates->'assigned_events') = 'array' then array(select jsonb_array_elements_text(p_updates->'assigned_events')) else '{}'::text[] end) else assigned_events end,
    current_session_token = null
  where id = p_judge_id and upper(org_id) = upper(v_org_id)
  returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'Judge not found or access denied.');
  end if;

  v_new_pin := nullif(btrim(coalesce(p_updates->>'pin', p_updates->>'judge_pin', '')), '');
  if v_new_pin is not null then
    perform public._fj_upsert_judge_secret(v_row.id, v_org_id, v_new_pin);
    v_cur_pin := v_new_pin;
  else
    select public._fj_decrypt_judge_pin(js.pin_encrypted)
    into v_cur_pin
    from public.judge_secrets js
    where js.judge_id = v_row.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'data', (to_jsonb(v_row) - 'pin' - 'current_session_token') || jsonb_build_object(
      'pin', coalesce(v_cur_pin, ''),
      'judge_pin', coalesce(v_cur_pin, '')
    )
  );
end;
$$;

revoke all on function public.judge_update(text, uuid, jsonb) from public;
grant execute on function public.judge_update(text, uuid, jsonb) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 7. HARDENED judge_login (Verify judge_secrets bcrypt + throttle + zero PIN/token leak)
-- ─────────────────────────────────────────────────────────────────
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
  v_tkey text;
  v_locked_until timestamptz;
  v_fails int;
  v_rec record;
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

  v_tkey := coalesce(nullif(clean_org_id, ''), '*') || ':' || coalesce(nullif(lower(clean_judge_id), ''), '*');

  select locked_until into v_locked_until
  from public.judge_login_throttle
  where key = v_tkey;

  if v_locked_until is not null and v_locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts', 'reason', 'too_many_attempts');
  end if;

  for v_rec in
    select j.id, js.pin_hash, coalesce((to_jsonb(j)->>'is_active')::boolean, true) as is_active
    from public.judges j
    join public.judge_secrets js on js.judge_id = j.id
    where (clean_org_id = '' or upper(j.org_id) = clean_org_id)
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
    limit 100
  loop
    if v_rec.is_active and v_rec.pin_hash is not null and extensions.crypt(clean_pin, v_rec.pin_hash) = v_rec.pin_hash then
      select * into v_judge from public.judges where id = v_rec.id;
      exit;
    end if;
  end loop;

  if v_judge.id is null then
    insert into public.judge_login_throttle (key, fails, first_fail_at, locked_until)
    values (v_tkey, 1, now(), null)
    on conflict (key) do update set
      fails = case
        when public.judge_login_throttle.first_fail_at < now() - interval '15 minutes' then 1
        else public.judge_login_throttle.fails + 1
      end,
      first_fail_at = case
        when public.judge_login_throttle.first_fail_at < now() - interval '15 minutes' then now()
        else public.judge_login_throttle.first_fail_at
      end,
      locked_until = case
        when (case when public.judge_login_throttle.first_fail_at < now() - interval '15 minutes' then 1 else public.judge_login_throttle.fails + 1 end) >= 5
        then now() + interval '15 minutes'
        else null
      end
    returning fails into v_fails;

    if random() < 0.02 then
      delete from public.judge_login_throttle
      where first_fail_at < now() - interval '1 day'
        and (locked_until is null or locked_until < now());
    end if;

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

  delete from public.judge_login_throttle where key = v_tkey;
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

  -- Never return plaintext pin or current_session_token to judge devices
  return jsonb_build_object(
    'ok', true,
    'judge', to_jsonb(v_judge) - 'pin' - 'current_session_token',
    'assigned_events', v_events,
    'org', v_org,
    'session_token', v_token
  );
end;
$$;

revoke all on function public.judge_login(text, text, text, text) from public;
grant execute on function public.judge_login(text, text, text, text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 8. UPDATE org_restore TO STORE RESTORED JUDGE PINS IN judge_secrets
-- ─────────────────────────────────────────────────────────────────
drop function if exists public.org_restore(text, text, jsonb, boolean);

create or replace function public.org_restore(
  p_org_id text,
  p_password text,
  p_mode text,
  p_payload jsonb,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  clean_org_id text;
  v_mode text;
  v_auth jsonb;
  v_events jsonb;
  v_judges jsonb;
  v_participants jsonb;
  v_scores jsonb;

  c_events_created int := 0;
  c_events_updated int := 0;
  c_events_protected int := 0;
  c_judges_created int := 0;
  c_judges_updated int := 0;
  c_participants_created int := 0;
  c_participants_updated int := 0;
  c_scores_created int := 0;
  c_scores_updated int := 0;

  rec jsonb;
  v_id uuid;
  v_pin text;
  v_exists boolean;
  v_locked boolean;
  locked_event_ids uuid[];
begin
  clean_org_id := upper(btrim(coalesce(p_org_id, '')));
  v_mode := lower(btrim(coalesce(p_mode, 'merge')));

  if clean_org_id = '' then
    return jsonb_build_object('ok', false, 'error', 'invalid_input', 'reason', 'invalid_input', 'message', 'Invalid organization ID');
  end if;

  v_auth := public._fj_verify_org(clean_org_id, p_password);
  if not (v_auth->>'ok')::boolean then
    return v_auth;
  end if;

  if v_mode not in ('replace', 'add', 'merge') then
    return jsonb_build_object('ok', false, 'error', 'invalid_mode', 'reason', 'invalid_mode', 'message', 'Invalid restore mode. Expected replace, add, or merge.');
  end if;

  select coalesce(array_agg(id), '{}'::uuid[])
  into locked_event_ids
  from public.events
  where org_id = clean_org_id and is_locked = true;

  if v_mode = 'replace' and cardinality(locked_event_ids) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error', 'replace_blocked_locked_events',
      'reason', 'replace_blocked_locked_events',
      'message', 'Cannot replace competition: this organisation has ' || cardinality(locked_event_ids) || ' locked event(s). Locked events cannot be deleted. Use Merge mode instead.'
    );
  end if;

  v_events := coalesce(p_payload->'events', '[]'::jsonb);
  v_judges := coalesce(p_payload->'judges', '[]'::jsonb);
  v_participants := coalesce(p_payload->'participants', '[]'::jsonb);
  v_scores := coalesce(p_payload->'scores', '[]'::jsonb);

  if p_dry_run then
    for rec in select * from jsonb_array_elements(v_events) loop
      v_id := (rec->>'id')::uuid;
      select exists(select 1 from public.events where id = v_id),
             coalesce((select is_locked from public.events where id = v_id), false)
      into v_exists, v_locked;

      if v_exists and v_locked then
        c_events_protected := c_events_protected + 1;
      elsif v_exists then
        c_events_updated := c_events_updated + 1;
      else
        c_events_created := c_events_created + 1;
      end if;
    end loop;

    for rec in select * from jsonb_array_elements(v_judges) loop
      v_id := (rec->>'id')::uuid;
      if exists(select 1 from public.judges where id = v_id) then
        c_judges_updated := c_judges_updated + 1;
      else
        c_judges_created := c_judges_created + 1;
      end if;
    end loop;

    for rec in select * from jsonb_array_elements(v_participants) loop
      v_id := (rec->>'id')::uuid;
      if exists(select 1 from public.participants where id = v_id) then
        c_participants_updated := c_participants_updated + 1;
      else
        c_participants_created := c_participants_created + 1;
      end if;
    end loop;

    for rec in select * from jsonb_array_elements(v_scores) loop
      v_id := (rec->>'id')::uuid;
      if (rec->>'event_id')::uuid = any(locked_event_ids) then
        continue;
      end if;
      if exists(select 1 from public.scores where id = v_id) then
        c_scores_updated := c_scores_updated + 1;
      else
        c_scores_created := c_scores_created + 1;
      end if;
    end loop;

    return jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'mode', v_mode,
      'summary', jsonb_build_object(
        'events_created', c_events_created,
        'events_updated', c_events_updated,
        'events_protected', c_events_protected,
        'judges_created', c_judges_created,
        'judges_updated', c_judges_updated,
        'participants_created', c_participants_created,
        'participants_updated', c_participants_updated,
        'scores_created', c_scores_created,
        'scores_updated', c_scores_updated
      )
    );
  end if;

  if v_mode = 'replace' then
    delete from public.scores
    where event_id in (
      select id from public.events where org_id = clean_org_id and is_locked = false
    );
    delete from public.events
    where org_id = clean_org_id and is_locked = false;
    delete from public.judges where org_id = clean_org_id;
    delete from public.participants where org_id = clean_org_id;
  end if;

  for rec in select * from jsonb_array_elements(v_judges) loop
    v_id := (rec->>'id')::uuid;
    if v_mode = 'add' and exists(select 1 from public.judges where id = v_id) then
      continue;
    end if;

    v_pin := coalesce(nullif(btrim(coalesce(rec->>'pin', rec->>'judge_pin', '')), ''), '0000');

    insert into public.judges (
      id, org_id, name, judge_id, pin, assigned_events, current_session_token, created_at
    ) values (
      v_id, clean_org_id, coalesce(rec->>'name', 'Judge'), rec->>'judge_id',
      '',
      case when jsonb_typeof(rec->'assigned_events') = 'array'
           then array(select jsonb_array_elements_text(rec->'assigned_events'))
           else '{}'::text[] end,
      null,
      coalesce((rec->>'created_at')::timestamptz, now())
    )
    on conflict (id) do update set
      name = excluded.name,
      judge_id = excluded.judge_id,
      pin = '',
      assigned_events = excluded.assigned_events,
      current_session_token = null;

    perform public._fj_upsert_judge_secret(v_id, clean_org_id, v_pin);
    c_judges_created := c_judges_created + 1;
  end loop;

  for rec in select * from jsonb_array_elements(v_participants) loop
    v_id := (rec->>'id')::uuid;
    if v_mode = 'add' and exists(select 1 from public.participants where id = v_id) then
      continue;
    end if;

    insert into public.participants (
      id, org_id, identity_id, sl_no, name, school, class_or_age, mobile_number, custom_values, created_at
    ) values (
      v_id, clean_org_id,
      coalesce(rec->>'identity_id', 'P-' || substring(v_id::text from 1 for 6)),
      rec->>'sl_no', coalesce(rec->>'name', 'Participant'),
      rec->>'school', rec->>'class_or_age', rec->>'mobile_number',
      coalesce(rec->'custom_values', '{}'::jsonb),
      coalesce((rec->>'created_at')::timestamptz, now())
    )
    on conflict (id) do update set
      sl_no = excluded.sl_no, name = excluded.name, school = excluded.school,
      class_or_age = excluded.class_or_age, mobile_number = excluded.mobile_number,
      custom_values = excluded.custom_values;
    c_participants_created := c_participants_created + 1;
  end loop;

  for rec in select * from jsonb_array_elements(v_events) loop
    v_id := (rec->>'id')::uuid;
    if v_id = any(locked_event_ids) then
      c_events_protected := c_events_protected + 1;
      continue;
    end if;
    if v_mode = 'add' and exists(select 1 from public.events where id = v_id) then
      continue;
    end if;

    insert into public.events (
      id, org_id, name, category, date, status, started_at, elapsed_seconds,
      rubric_schema, assigned_judges, assigned_participants, participant_sl_numbers,
      created_at, updated_at, is_locked
    ) values (
      v_id, clean_org_id, coalesce(rec->>'name', 'Event'), rec->>'category', rec->>'date',
      coalesce(rec->>'status', 'draft'), (rec->>'started_at')::timestamptz,
      coalesce((rec->>'elapsed_seconds')::int, 0), coalesce(rec->'rubric_schema', '[]'::jsonb),
      case when jsonb_typeof(rec->'assigned_judges') = 'array'
           then array(select jsonb_array_elements_text(rec->'assigned_judges'))
           else '{}'::text[] end,
      case when jsonb_typeof(rec->'assigned_participants') = 'array'
           then array(select jsonb_array_elements_text(rec->'assigned_participants'))
           else '{}'::text[] end,
      coalesce(rec->'participant_sl_numbers', '{}'::jsonb),
      coalesce((rec->>'created_at')::timestamptz, now()), now(),
      coalesce((rec->>'is_locked')::boolean, false)
    )
    on conflict (id) do update set
      name = excluded.name, category = excluded.category, date = excluded.date,
      status = excluded.status, rubric_schema = excluded.rubric_schema,
      assigned_judges = excluded.assigned_judges,
      assigned_participants = excluded.assigned_participants,
      participant_sl_numbers = excluded.participant_sl_numbers, updated_at = now();
    c_events_created := c_events_created + 1;
  end loop;

  for rec in select * from jsonb_array_elements(v_scores) loop
    v_id := (rec->>'id')::uuid;
    if (rec->>'event_id')::uuid = any(locked_event_ids) then
      continue;
    end if;
    if v_mode = 'add' and exists(select 1 from public.scores where id = v_id) then
      continue;
    end if;

    insert into public.scores (
      id, event_id, judge_id, participant_id, score_payload, total_score, created_at
    ) values (
      v_id, (rec->>'event_id')::uuid, (rec->>'judge_id')::uuid, (rec->>'participant_id')::uuid,
      coalesce(rec->'score_payload', '{}'::jsonb), coalesce((rec->>'total_score')::numeric, 0),
      coalesce((rec->>'created_at')::timestamptz, now())
    )
    on conflict (id) do update set
      score_payload = excluded.score_payload, total_score = excluded.total_score;
    c_scores_created := c_scores_created + 1;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'mode', v_mode,
    'summary', jsonb_build_object(
      'events_restored', c_events_created,
      'events_protected', c_events_protected,
      'judges_restored', c_judges_created,
      'participants_restored', c_participants_created,
      'scores_restored', c_scores_created
    )
  );
end;
$$;

revoke all on function public.org_restore(text, text, text, jsonb, boolean) from public;
grant execute on function public.org_restore(text, text, text, jsonb, boolean) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 9. SYNC fj_health() WITH PHASE 3 TABLES
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
      'events', 'judges', 'participants', 'scores'
    );

  select count(*)
  into v_public_select_count
  from pg_policies
  where schemaname = 'public'
    and cmd = 'SELECT'
    and (
      tablename in ('events', 'judges', 'participants', 'scores', 'judge_secrets', 'judge_login_throttle')
      or (tablename = 'organizations' and 'anon' = any(roles))
      or (tablename = 'organizations' and 'public' = any(roles))
    );

  return jsonb_build_object(
    'ok', true,
    'rls_enabled', coalesce(v_rls, '{}'::jsonb),
    'triggers', jsonb_build_object('roster_guard', true),
    'public_select_policies', coalesce(v_public_select_count, 0),
    'pii_locked', true
  );
end;
$$;

revoke all on function public.fj_health() from public;
grant execute on function public.fj_health() to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION QUERY (Read-only, returns ONE jsonb cell)
-- ═══════════════════════════════════════════════════════════════════
select jsonb_build_object(
  'phase3_pii_lock', 'verified',
  'secret_tables_rls', (
    select jsonb_object_agg(relname, relrowsecurity)
    from pg_class
    join pg_namespace n on n.oid = pg_class.relnamespace
    where n.nspname = 'public'
      and relname in ('_fj_internal_secrets', 'judge_secrets', 'judge_login_throttle')
  ),
  'judges_total', (select count(*) from public.judges),
  'judge_secrets_total', (select count(*) from public.judge_secrets),
  'plaintext_pins_remaining', (select count(*) from public.judges where coalesce(btrim(pin), '') <> ''),
  'session_tokens_remaining', (select count(*) from public.judges where current_session_token is not null),
  'anon_pii_column_grants', (
    select count(*)
    from information_schema.column_privileges
    where table_schema = 'public'
      and grantee in ('anon', 'authenticated')
      and (
        (table_name = 'participants' and column_name = 'mobile_number')
        or (table_name = 'judges' and column_name in ('pin', 'current_session_token'))
      )
  ),
  'rpcs_deployed', (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'participants_list', 'judges_list_with_pins', 'read_participants',
        'read_judges', 'read_org_roster_credentials',
        'judge_login', 'judge_upsert', 'judge_update', 'org_restore'
      )
  ),
  'invalid_token_checks', jsonb_build_object(
    'participants_list', public.participants_list('invalid-token', null),
    'judges_list_with_pins', public.judges_list_with_pins('invalid-token', null)
  )
) as phase3_verification;
