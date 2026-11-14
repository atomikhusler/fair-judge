-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.12 — PROJECTOR VIEW + READ LOCK + PII LOCK
-- ═══════════════════════════════════════════════════════════════════
-- Adds secure 6-digit pairing & read-locked projector snapshot RPCs:
--   1. public.projector_pairings (hashes only; RLS ON; zero table grants)
--   2. public.projector_approve_throttle (5-fail / 5-minute lockout)
--   3. org_id / event_id indexes for fast fingerprint & snapshot queries
--   4. 7 SECURITY DEFINER RPCs (execute granted to anon, authenticated):
--      - projector_request_code()
--      - projector_approve(p_token, p_org_id, p_code, p_event_id, p_label)
--      - projector_claim(p_device_secret)
--      - projector_fingerprint(p_view_token)
--      - projector_snapshot(p_view_token)
--      - projector_list(p_token, p_org_id)
--      - projector_revoke(p_token, p_org_id, p_pairing_id)
-- ═══════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- 1. Projector Pairings Table (Hashes only — never plaintext codes, secrets, or tokens)
create table if not exists public.projector_pairings (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null,
  device_hash text not null,
  org_id text,
  event_id text,
  label text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'revoked', 'expired')),
  view_token_hash text,
  claimed boolean not null default false,
  fail_count int not null default 0,
  locked_until timestamptz,
  expires_at timestamptz not null,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

alter table public.projector_pairings enable row level security;
revoke all on table public.projector_pairings from anon, authenticated, public;

create index if not exists idx_projector_pairings_code_hash
  on public.projector_pairings(code_hash);
create index if not exists idx_projector_pairings_device_hash
  on public.projector_pairings(device_hash);
create index if not exists idx_projector_pairings_view_token_hash
  on public.projector_pairings(view_token_hash);
create index if not exists idx_projector_pairings_org_id
  on public.projector_pairings(org_id);
create index if not exists idx_projector_pairings_status_expires
  on public.projector_pairings(status, expires_at);

-- Per-org approval throttle table (protects against brute-force guessing 6-digit codes)
create table if not exists public.projector_approve_throttle (
  org_id text primary key,
  fail_count int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.projector_approve_throttle enable row level security;
revoke all on table public.projector_approve_throttle from anon, authenticated, public;

-- Core table indexes for cheap org-scoped fingerprints & snapshots
create index if not exists idx_events_org_id on public.events(org_id);
create index if not exists idx_participants_org_id on public.participants(org_id);
create index if not exists idx_judges_org_id on public.judges(org_id);
create index if not exists idx_scores_event_id on public.scores(event_id);

-- 2. Private Hash & Token Verification Helpers (never directly callable)
create or replace function public._fj_projector_sha256(p_value text)
returns text
language sql
immutable
security definer
set search_path = public, extensions
as $$
  select encode(extensions.digest(convert_to(coalesce(p_value, ''), 'UTF8'), 'sha256'), 'hex');
$$;

revoke all on function public._fj_projector_sha256(text) from public, anon, authenticated;

create or replace function public._fj_verify_projector_token(p_view_token text)
returns public.projector_pairings
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_tok text;
  v_hash text;
  v_row public.projector_pairings;
  v_org_active boolean := false;
begin
  v_tok := btrim(coalesce(p_view_token, ''));
  if v_tok = '' then
    return null;
  end if;

  v_hash := public._fj_projector_sha256(v_tok);

  select * into v_row
  from public.projector_pairings
  where view_token_hash = v_hash
    and status = 'approved'
    and claimed = true
  limit 1;

  if v_row.id is null then
    return null;
  end if;

  -- Expire view token after 24 hours without a successful call
  if coalesce(v_row.last_seen_at, v_row.approved_at, v_row.created_at) < (now() - interval '24 hours') then
    update public.projector_pairings
    set status = 'expired'
    where id = v_row.id;
    return null;
  end if;

  -- Verify org still exists and is not suspended or deleted
  select exists(
    select 1
    from public.organizations o
    where upper(o.org_id) = upper(v_row.org_id)
      and o.deleted_at is null
      and coalesce(o.suspended, false) = false
  ) into v_org_active;

  if not v_org_active then
    return null;
  end if;

  update public.projector_pairings
  set last_seen_at = now()
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public._fj_verify_projector_token(text) from public, anon, authenticated;

-- 3. RPC a) projector_request_code()
create or replace function public.projector_request_code()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pending_count int;
  v_bytes bytea;
  v_num bigint;
  v_code text;
  v_code_hash text;
  v_device_secret text;
  v_device_hash text;
  v_expires_at timestamptz;
  v_attempts int := 0;
begin
  -- Clear expired pending codes first
  update public.projector_pairings
  set status = 'expired'
  where status = 'pending'
    and expires_at <= now();

  -- Cleanup old expired/revoked rows (> 48 hours) to keep table lean
  delete from public.projector_pairings
  where status in ('expired', 'revoked')
    and created_at < (now() - interval '48 hours');

  -- Max 5 active pending codes at a time
  select count(*) into v_pending_count
  from public.projector_pairings
  where status = 'pending'
    and expires_at > now();

  if v_pending_count >= 5 then
    return jsonb_build_object(
      'ok', false,
      'error', 'too_many_pending',
      'message', 'Too many pending pairing codes. Wait for an existing code to expire or try again shortly.'
    );
  end if;

  -- Generate unique 6-digit numeric code
  loop
    v_attempts := v_attempts + 1;
    v_bytes := extensions.gen_random_bytes(4);
    v_num := (
      ((get_byte(v_bytes, 0) & 127)::bigint * 16777216) +
      (get_byte(v_bytes, 1)::bigint * 65536) +
      (get_byte(v_bytes, 2)::bigint * 256) +
      get_byte(v_bytes, 3)::bigint
    ) % 1000000;
    v_code := lpad(v_num::text, 6, '0');
    v_code_hash := public._fj_projector_sha256(v_code);

    exit when not exists (
      select 1 from public.projector_pairings
      where code_hash = v_code_hash
        and status = 'pending'
        and expires_at > now()
    ) or v_attempts >= 10;
  end loop;

  -- 32 random hex chars (16 random bytes)
  v_device_secret := encode(extensions.gen_random_bytes(16), 'hex');
  v_device_hash := public._fj_projector_sha256(v_device_secret);
  v_expires_at := now() + interval '10 minutes';

  insert into public.projector_pairings (
    code_hash,
    device_hash,
    status,
    claimed,
    fail_count,
    expires_at,
    created_at
  ) values (
    v_code_hash,
    v_device_hash,
    'pending',
    false,
    0,
    v_expires_at,
    now()
  );

  return jsonb_build_object(
    'ok', true,
    'code', v_code,
    'device_secret', v_device_secret,
    'expires_at', v_expires_at
  );
end;
$$;

revoke all on function public.projector_request_code() from public;
grant execute on function public.projector_request_code() to anon, authenticated;

-- 4. RPC b) projector_approve(p_token, p_org_id, p_code, p_event_id, p_label)
create or replace function public.projector_approve(
  p_token text,
  p_org_id text,
  p_code text,
  p_event_id text default null,
  p_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_clean_code text;
  v_code_hash text;
  v_clean_event_id text;
  v_clean_label text;
  v_locked_until timestamptz;
  v_fails int;
  v_pairing public.projector_pairings;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  -- Check 5-minute approval lock for this org
  select t.locked_until into v_locked_until
  from public.projector_approve_throttle t
  where upper(t.org_id) = upper(v_org_id);

  if v_locked_until is not null and v_locked_until > now() then
    return jsonb_build_object(
      'ok', false,
      'error', 'locked',
      'locked_until', v_locked_until,
      'message', 'Too many wrong codes. Approval is locked for 5 minutes.'
    );
  end if;

  v_clean_code := regexp_replace(coalesce(p_code, ''), '\D', '', 'g');
  v_clean_event_id := nullif(btrim(coalesce(p_event_id, '')), '');
  v_clean_label := left(coalesce(nullif(btrim(coalesce(p_label, '')), ''), 'Projector Screen'), 60);

  -- Validate optional event belongs to this org
  if v_clean_event_id is not null then
    if not exists (
      select 1 from public.events e
      where e.id::text = v_clean_event_id
        and upper(e.org_id) = upper(v_org_id)
    ) then
      return jsonb_build_object(
        'ok', false,
        'error', 'invalid_event',
        'message', 'Selected event was not found for this organization.'
      );
    end if;
  end if;

  -- Expire stale pending rows first
  update public.projector_pairings
  set status = 'expired'
  where status = 'pending'
    and expires_at <= now();

  if length(v_clean_code) = 6 then
    v_code_hash := public._fj_projector_sha256(v_clean_code);

    select * into v_pairing
    from public.projector_pairings p
    where p.code_hash = v_code_hash
      and p.status = 'pending'
      and p.expires_at > now()
    order by p.created_at desc
    limit 1;
  end if;

  if v_pairing.id is null then
    insert into public.projector_approve_throttle (org_id, fail_count, locked_until, updated_at)
    values (upper(v_org_id), 1, null, now())
    on conflict (org_id) do update set
      fail_count = case
        when public.projector_approve_throttle.locked_until is not null
         and public.projector_approve_throttle.locked_until <= now() then 1
        else public.projector_approve_throttle.fail_count + 1
      end,
      locked_until = case
        when (
          case
            when public.projector_approve_throttle.locked_until is not null
             and public.projector_approve_throttle.locked_until <= now() then 1
            else public.projector_approve_throttle.fail_count + 1
          end
        ) >= 5 then now() + interval '5 minutes'
        else null
      end,
      updated_at = now()
    returning fail_count, locked_until into v_fails, v_locked_until;

    if v_locked_until is not null then
      return jsonb_build_object(
        'ok', false,
        'error', 'locked',
        'fail_count', v_fails,
        'locked_until', v_locked_until,
        'message', 'Too many wrong codes. Approval locked for 5 minutes.'
      );
    end if;

    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_code',
      'fail_count', v_fails,
      'message', 'Code not found or expired. Check the 6-digit code on the projector screen.'
    );
  end if;

  -- Clear throttle on valid code
  delete from public.projector_approve_throttle where upper(org_id) = upper(v_org_id);

  update public.projector_pairings
  set
    org_id = v_org_id,
    event_id = v_clean_event_id,
    label = v_clean_label,
    status = 'approved',
    approved_at = now(),
    fail_count = 0,
    locked_until = null
  where id = v_pairing.id
  returning * into v_pairing;

  return jsonb_build_object(
    'ok', true,
    'pairing_id', v_pairing.id,
    'org_id', v_pairing.org_id,
    'event_id', v_pairing.event_id,
    'label', v_pairing.label
  );
end;
$$;

revoke all on function public.projector_approve(text, text, text, text, text) from public;
grant execute on function public.projector_approve(text, text, text, text, text) to anon, authenticated;

-- 5. RPC c) projector_claim(p_device_secret)
create or replace function public.projector_claim(p_device_secret text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_secret text;
  v_device_hash text;
  v_pairing public.projector_pairings;
  v_view_token text;
  v_view_token_hash text;
begin
  v_secret := btrim(coalesce(p_device_secret, ''));
  if v_secret = '' then
    return jsonb_build_object('status', 'expired');
  end if;

  v_device_hash := public._fj_projector_sha256(v_secret);

  select * into v_pairing
  from public.projector_pairings
  where device_hash = v_device_hash
  limit 1;

  if v_pairing.id is null then
    return jsonb_build_object('status', 'expired');
  end if;

  if v_pairing.status in ('revoked', 'expired') then
    return jsonb_build_object('status', 'expired');
  end if;

  if v_pairing.status = 'pending' then
    if v_pairing.expires_at <= now() then
      update public.projector_pairings set status = 'expired' where id = v_pairing.id;
      return jsonb_build_object('status', 'expired');
    end if;
    return jsonb_build_object('status', 'pending');
  end if;

  -- Approved: view_token is minted and returned ONCE only (if not yet claimed)
  if v_pairing.status = 'approved' then
    if v_pairing.claimed then
      return jsonb_build_object('status', 'expired');
    end if;

    v_view_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_view_token_hash := public._fj_projector_sha256(v_view_token);

    update public.projector_pairings
    set
      view_token_hash = v_view_token_hash,
      claimed = true,
      last_seen_at = now()
    where id = v_pairing.id
      and claimed = false;

    if not found then
      return jsonb_build_object('status', 'expired');
    end if;

    return jsonb_build_object(
      'status', 'approved',
      'view_token', v_view_token,
      'org_id', v_pairing.org_id,
      'event_id', v_pairing.event_id,
      'label', v_pairing.label
    );
  end if;

  return jsonb_build_object('status', 'expired');
end;
$$;

revoke all on function public.projector_claim(text) from public;
grant execute on function public.projector_claim(text) to anon, authenticated;

-- 6. RPC d) projector_fingerprint(p_view_token)
create or replace function public.projector_fingerprint(p_view_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pairing public.projector_pairings;
  v_org_sig text;
  v_evt_sig text;
  v_part_sig text;
  v_judge_sig text;
  v_score_sig text;
  v_version text;
begin
  v_pairing := public._fj_verify_projector_token(p_view_token);
  if v_pairing.id is null then
    return jsonb_build_object('ok', false, 'error', 'expired_or_revoked');
  end if;

  select md5(
    coalesce(o.name, '') || '|' ||
    coalesce(o.tie_breaker_enabled::text, 'false') || '|' ||
    coalesce(o.tie_breaker_method, 'olympic') || '|' ||
    coalesce(o.blind_judging_enabled::text, 'false')
  ) into v_org_sig
  from public.organizations o
  where upper(o.org_id) = upper(v_pairing.org_id)
  limit 1;

  select count(*)::text || ':' || coalesce(max(greatest(e.created_at, coalesce(e.updated_at, e.created_at)))::text, '0')
  into v_evt_sig
  from public.events e
  where upper(e.org_id) = upper(v_pairing.org_id)
    and (v_pairing.event_id is null or e.id::text = v_pairing.event_id);

  select count(*)::text || ':' || coalesce(max(p.created_at)::text, '0')
  into v_part_sig
  from public.participants p
  where upper(p.org_id) = upper(v_pairing.org_id);

  select count(*)::text || ':' || coalesce(max(j.created_at)::text, '0')
  into v_judge_sig
  from public.judges j
  where upper(j.org_id) = upper(v_pairing.org_id);

  select count(*)::text || ':' || coalesce(max(s.created_at)::text, '0') || ':' || coalesce(sum(s.total_score)::text, '0')
  into v_score_sig
  from public.scores s
  join public.events e on e.id = s.event_id
  where upper(e.org_id) = upper(v_pairing.org_id)
    and (v_pairing.event_id is null or e.id::text = v_pairing.event_id);

  v_version := public._fj_projector_sha256(
    coalesce(v_org_sig, '') || '|' ||
    coalesce(v_evt_sig, '') || '|' ||
    coalesce(v_part_sig, '') || '|' ||
    coalesce(v_judge_sig, '') || '|' ||
    coalesce(v_score_sig, '') || '|' ||
    coalesce(v_pairing.event_id, '')
  );

  return jsonb_build_object(
    'ok', true,
    'version', v_version,
    'org_id', v_pairing.org_id,
    'event_id', v_pairing.event_id,
    'label', v_pairing.label
  );
end;
$$;

revoke all on function public.projector_fingerprint(text) from public;
grant execute on function public.projector_fingerprint(text) to anon, authenticated;

-- 7. RPC e) projector_snapshot(p_view_token) — Strict PII & Secret Lock
-- NEVER returns participants.mobile_number, judges.pin, judges.current_session_token, or org secrets.
create or replace function public.projector_snapshot(p_view_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pairing public.projector_pairings;
  v_org jsonb;
  v_events jsonb;
  v_judges jsonb;
  v_participants jsonb;
  v_scores jsonb;
  v_scoped_event public.events;
begin
  v_pairing := public._fj_verify_projector_token(p_view_token);
  if v_pairing.id is null then
    return jsonb_build_object('ok', false, 'error', 'expired_or_revoked');
  end if;

  select jsonb_build_object(
    'org_id', o.org_id,
    'name', o.name,
    'tie_breaker_enabled', coalesce(o.tie_breaker_enabled, false),
    'tie_breaker_method', coalesce(o.tie_breaker_method, 'olympic'),
    'blind_judging_enabled', coalesce(o.blind_judging_enabled, false)
  ) into v_org
  from public.organizations o
  where upper(o.org_id) = upper(v_pairing.org_id)
  limit 1;

  if v_pairing.event_id is not null then
    select * into v_scoped_event
    from public.events e
    where e.id::text = v_pairing.event_id
      and upper(e.org_id) = upper(v_pairing.org_id)
    limit 1;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', e.id,
        'org_id', e.org_id,
        'name', e.name,
        'category', e.category,
        'date', e.date,
        'status', e.status,
        'started_at', e.started_at,
        'elapsed_seconds', e.elapsed_seconds,
        'rubric_schema', coalesce(e.rubric_schema, '[]'::jsonb),
        'assigned_judges', coalesce(e.assigned_judges, '{}'::text[]),
        'assigned_participants', coalesce(e.assigned_participants, '{}'::text[]),
        'participant_sl_numbers', coalesce(e.participant_sl_numbers, '{}'::jsonb),
        'is_locked', coalesce(e.is_locked, false),
        'is_archived', coalesce(e.is_archived, false),
        'created_at', e.created_at,
        'updated_at', e.updated_at
      )
      order by e.created_at desc
    ),
    '[]'::jsonb
  ) into v_events
  from public.events e
  where upper(e.org_id) = upper(v_pairing.org_id)
    and coalesce(e.is_archived, false) = false
    and lower(coalesce(e.status, '')) <> 'archived'
    and (v_pairing.event_id is null or e.id::text = v_pairing.event_id);

  -- Safe Judge fields only (NO pin, NO current_session_token)
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
      order by j.created_at asc
    ),
    '[]'::jsonb
  ) into v_judges
  from public.judges j
  where upper(j.org_id) = upper(v_pairing.org_id)
    and (
      v_pairing.event_id is null
      or (
        v_scoped_event.id is not null and (
          j.id::text = any(coalesce(v_scoped_event.assigned_judges, '{}'::text[]))
          or v_pairing.event_id = any(coalesce(j.assigned_events, '{}'::text[]))
        )
      )
    );

  -- Safe Participant fields only (NO mobile_number)
  select coalesce(
    jsonb_agg(
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
      order by p.created_at asc
    ),
    '[]'::jsonb
  ) into v_participants
  from public.participants p
  where upper(p.org_id) = upper(v_pairing.org_id)
    and (
      v_pairing.event_id is null
      or (
        v_scoped_event.id is not null and (
          cardinality(coalesce(v_scoped_event.assigned_participants, '{}'::text[])) = 0
          or p.id::text = any(v_scoped_event.assigned_participants)
        )
      )
    );

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'event_id', s.event_id,
        'judge_id', s.judge_id,
        'participant_id', s.participant_id,
        'score_payload', s.score_payload,
        'total_score', s.total_score,
        'created_at', s.created_at
      )
      order by s.created_at asc
    ),
    '[]'::jsonb
  ) into v_scores
  from public.scores s
  join public.events e on e.id = s.event_id
  where upper(e.org_id) = upper(v_pairing.org_id)
    and coalesce(e.is_archived, false) = false
    and lower(coalesce(e.status, '')) <> 'archived'
    and (v_pairing.event_id is null or e.id::text = v_pairing.event_id);

  return jsonb_build_object(
    'ok', true,
    'org', v_org,
    'events', v_events,
    'judges', v_judges,
    'participants', v_participants,
    'scores', v_scores,
    'scoped_event_id', v_pairing.event_id,
    'label', v_pairing.label
  );
end;
$$;

revoke all on function public.projector_snapshot(text) from public;
grant execute on function public.projector_snapshot(text) to anon, authenticated;

-- 8. RPC f) projector_list(p_token, p_org_id)
create or replace function public.projector_list(
  p_token text,
  p_org_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_list jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  -- Mark 24h inactive approved tokens expired
  update public.projector_pairings
  set status = 'expired'
  where upper(org_id) = upper(v_org_id)
    and status = 'approved'
    and coalesce(last_seen_at, approved_at, created_at) < (now() - interval '24 hours');

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'label', coalesce(p.label, 'Projector Screen'),
        'event_id', p.event_id,
        'event_name', e.name,
        'created_at', p.created_at,
        'approved_at', p.approved_at,
        'last_seen_at', p.last_seen_at
      )
      order by coalesce(p.last_seen_at, p.approved_at, p.created_at) desc
    ),
    '[]'::jsonb
  ) into v_list
  from public.projector_pairings p
  left join public.events e on e.id::text = p.event_id and upper(e.org_id) = upper(v_org_id)
  where upper(p.org_id) = upper(v_org_id)
    and p.status = 'approved';

  return jsonb_build_object('ok', true, 'pairings', v_list);
end;
$$;

revoke all on function public.projector_list(text, text) from public;
grant execute on function public.projector_list(text, text) to anon, authenticated;

-- 9. RPC g) projector_revoke(p_token, p_org_id, p_pairing_id)
create or replace function public.projector_revoke(
  p_token text,
  p_org_id text,
  p_pairing_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_revoked_count int := 0;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  if p_pairing_id is null then
    update public.projector_pairings
    set status = 'revoked'
    where upper(org_id) = upper(v_org_id)
      and status in ('approved', 'pending');
    get diagnostics v_revoked_count = row_count;
  else
    update public.projector_pairings
    set status = 'revoked'
    where id = p_pairing_id
      and upper(org_id) = upper(v_org_id)
      and status in ('approved', 'pending');
    get diagnostics v_revoked_count = row_count;
  end if;

  return jsonb_build_object('ok', true, 'revoked_count', v_revoked_count);
end;
$$;

revoke all on function public.projector_revoke(text, text, uuid) from public;
grant execute on function public.projector_revoke(text, text, uuid) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- READ-ONLY VERIFICATION QUERY (returns one jsonb cell)
-- ═══════════════════════════════════════════════════════════════════
select jsonb_build_object(
  'migration', '15.12-projector',
  'table_exists', to_regclass('public.projector_pairings') is not null,
  'throttle_table_exists', to_regclass('public.projector_approve_throttle') is not null,
  'rls_enabled', (
    select coalesce(bool_and(c.relrowsecurity), false)
    from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relname in ('projector_pairings', 'projector_approve_throttle')
  ),
  'anon_table_grants', (
    select count(*)
    from information_schema.table_privileges
    where table_schema = 'public'
      and table_name in ('projector_pairings', 'projector_approve_throttle')
      and grantee in ('anon', 'authenticated', 'public')
  ),
  'rpcs', (
    select jsonb_agg(
      jsonb_build_object(
        'name', p.proname,
        'args', pg_get_function_identity_arguments(p.oid),
        'security_definer', p.prosecdef
      )
      order by p.proname
    )
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname in (
        'projector_request_code',
        'projector_approve',
        'projector_claim',
        'projector_fingerprint',
        'projector_snapshot',
        'projector_list',
        'projector_revoke'
      )
  )
) as verification_result;
