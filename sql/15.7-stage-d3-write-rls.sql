-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.7 — Stage D3: Token-Authenticated Write RPCs & Write RLS Lockdown
-- ═══════════════════════════════════════════════════════════════════
-- 1. Adds SECURITY DEFINER write RPCs requiring valid org_sessions / judge_sessions tokens.
-- 2. Enforces tenant isolation (a token can ONLY write rows belonging to its own org/judge).
-- 3. Replaces wide-open ALL/INSERT/UPDATE/DELETE policies with strict SELECT-only policies
--    and revokes direct INSERT/UPDATE/DELETE privileges from anon & authenticated.
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- 1. ORGANIZATION WRITES (org_update, org_reset_data, org_delete)
-- ─────────────────────────────────────────────────────────────────

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
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  update public.organizations
  set
    name = case when p_updates ? 'name' then coalesce(nullif(btrim(p_updates->>'name'), ''), name) else name end,
    email = case when p_updates ? 'email' then nullif(btrim(p_updates->>'email'), '') else email end,
    verification_status = case when p_updates ? 'verification_status' then coalesce(p_updates->>'verification_status', verification_status) else verification_status end,
    tie_breaker_enabled = case when p_updates ? 'tie_breaker_enabled' then coalesce((p_updates->>'tie_breaker_enabled')::boolean, tie_breaker_enabled) else tie_breaker_enabled end,
    tie_breaker_method = case when p_updates ? 'tie_breaker_method' then coalesce(p_updates->>'tie_breaker_method', tie_breaker_method) else tie_breaker_method end,
    custom_participant_fields = case when p_updates ? 'custom_participant_fields' then coalesce(p_updates->'custom_participant_fields', custom_participant_fields) else custom_participant_fields end,
    blind_judging_enabled = case when p_updates ? 'blind_judging_enabled' then coalesce((p_updates->>'blind_judging_enabled')::boolean, blind_judging_enabled) else blind_judging_enabled end,
    auto_advance_enabled = case when p_updates ? 'auto_advance_enabled' then coalesce((p_updates->>'auto_advance_enabled')::boolean, auto_advance_enabled) else auto_advance_enabled end,
    grace_period_enabled = case when p_updates ? 'grace_period_enabled' then coalesce((p_updates->>'grace_period_enabled')::boolean, grace_period_enabled) else grace_period_enabled end,
    isolated_jury_enabled = case when p_updates ? 'isolated_jury_enabled' then coalesce((p_updates->>'isolated_jury_enabled')::boolean, isolated_jury_enabled) else isolated_jury_enabled end
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

create or replace function public.org_reset_data(
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
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  if exists (select 1 from public.events where upper(org_id) = upper(v_org_id) and is_locked = true) then
    return jsonb_build_object('ok', false, 'error', 'ROSTER_LOCKED', 'message', 'ROSTER_LOCKED: Unlock your events first.');
  end if;

  delete from public.scores where event_id in (select id from public.events where upper(org_id) = upper(v_org_id));
  delete from public.events where upper(org_id) = upper(v_org_id);
  delete from public.participants where upper(org_id) = upper(v_org_id);
  delete from public.judges where upper(org_id) = upper(v_org_id);

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.org_reset_data(text, text) from public;
grant execute on function public.org_reset_data(text, text) to anon, authenticated;

create or replace function public.org_delete(
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
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  if exists (select 1 from public.events where upper(org_id) = upper(v_org_id) and is_locked = true) then
    return jsonb_build_object('ok', false, 'error', 'ROSTER_LOCKED', 'message', 'ROSTER_LOCKED: Unlock your events first.');
  end if;

  delete from public.scores where event_id in (select id from public.events where upper(org_id) = upper(v_org_id));
  delete from public.events where upper(org_id) = upper(v_org_id);
  delete from public.participants where upper(org_id) = upper(v_org_id);
  delete from public.judges where upper(org_id) = upper(v_org_id);
  delete from public.organizations where upper(org_id) = upper(v_org_id);

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.org_delete(text, text) from public;
grant execute on function public.org_delete(text, text) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 2. EVENT WRITES (event_upsert, event_update, event_delete)
-- ─────────────────────────────────────────────────────────────────

create or replace function public.event_upsert(
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
  v_row public.events;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_record->>'org_id');
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  v_id := coalesce(nullif(p_record->>'id', '')::uuid, gen_random_uuid());

  select org_id into v_existing_org from public.events where id = v_id;
  if v_existing_org is not null and upper(v_existing_org) <> upper(v_org_id) then
    return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Cannot overwrite event from another organization.');
  end if;

  insert into public.events (
    id, org_id, name, category, date, status, started_at, elapsed_seconds,
    rubric_schema, assigned_judges, assigned_participants, participant_sl_numbers,
    is_locked, is_archived, created_at, updated_at
  ) values (
    v_id,
    v_org_id,
    coalesce(nullif(btrim(p_record->>'name'), ''), 'Event'),
    coalesce(p_record->>'category', 'General'),
    p_record->>'date',
    coalesce(lower(p_record->>'status'), 'draft'),
    case when nullif(p_record->>'started_at', '') is not null then (p_record->>'started_at')::timestamptz else null end,
    coalesce((p_record->>'elapsed_seconds')::integer, 0),
    coalesce(p_record->'rubric_schema', '[]'::jsonb),
    case when jsonb_typeof(p_record->'assigned_judges') = 'array' then array(select jsonb_array_elements_text(p_record->'assigned_judges')) else '{}'::text[] end,
    case when jsonb_typeof(p_record->'assigned_participants') = 'array' then array(select jsonb_array_elements_text(p_record->'assigned_participants')) else '{}'::text[] end,
    coalesce(p_record->'participant_sl_numbers', '{}'::jsonb),
    coalesce((p_record->>'is_locked')::boolean, false),
    coalesce((p_record->>'is_archived')::boolean, false),
    coalesce(nullif(p_record->>'created_at', '')::timestamptz, now()),
    now()
  )
  on conflict (id) do update set
    name = excluded.name,
    category = excluded.category,
    date = excluded.date,
    status = excluded.status,
    started_at = excluded.started_at,
    elapsed_seconds = excluded.elapsed_seconds,
    rubric_schema = excluded.rubric_schema,
    assigned_judges = excluded.assigned_judges,
    assigned_participants = excluded.assigned_participants,
    participant_sl_numbers = excluded.participant_sl_numbers,
    is_locked = excluded.is_locked,
    is_archived = excluded.is_archived,
    updated_at = now()
  returning * into v_row;

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
end;
$$;

revoke all on function public.event_upsert(text, jsonb) from public;
grant execute on function public.event_upsert(text, jsonb) to anon, authenticated;

create or replace function public.event_update(
  p_token text,
  p_event_id uuid,
  p_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_row public.events;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  update public.events
  set
    name = case when p_updates ? 'name' then coalesce(nullif(btrim(p_updates->>'name'), ''), name) else name end,
    category = case when p_updates ? 'category' then p_updates->>'category' else category end,
    date = case when p_updates ? 'date' then p_updates->>'date' else date end,
    status = case when p_updates ? 'status' then coalesce(lower(p_updates->>'status'), status) else status end,
    started_at = case when p_updates ? 'started_at' then (nullif(p_updates->>'started_at', ''))::timestamptz else started_at end,
    elapsed_seconds = case when p_updates ? 'elapsed_seconds' then coalesce((p_updates->>'elapsed_seconds')::integer, elapsed_seconds) else elapsed_seconds end,
    rubric_schema = case when p_updates ? 'rubric_schema' then coalesce(p_updates->'rubric_schema', rubric_schema) else rubric_schema end,
    assigned_judges = case when p_updates ? 'assigned_judges' then (case when jsonb_typeof(p_updates->'assigned_judges') = 'array' then array(select jsonb_array_elements_text(p_updates->'assigned_judges')) else '{}'::text[] end) else assigned_judges end,
    assigned_participants = case when p_updates ? 'assigned_participants' then (case when jsonb_typeof(p_updates->'assigned_participants') = 'array' then array(select jsonb_array_elements_text(p_updates->'assigned_participants')) else '{}'::text[] end) else assigned_participants end,
    participant_sl_numbers = case when p_updates ? 'participant_sl_numbers' then coalesce(p_updates->'participant_sl_numbers', participant_sl_numbers) else participant_sl_numbers end,
    is_locked = case when p_updates ? 'is_locked' then coalesce((p_updates->>'is_locked')::boolean, is_locked) else is_locked end,
    is_archived = case when p_updates ? 'is_archived' then coalesce((p_updates->>'is_archived')::boolean, is_archived) else is_archived end,
    updated_at = now()
  where id = p_event_id and upper(org_id) = upper(v_org_id)
  returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'Event not found or access denied.');
  end if;

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
end;
$$;

revoke all on function public.event_update(text, uuid, jsonb) from public;
grant execute on function public.event_update(text, uuid, jsonb) to anon, authenticated;

create or replace function public.event_delete(
  p_token text,
  p_event_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_locked boolean;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  select is_locked into v_locked from public.events where id = p_event_id and upper(org_id) = upper(v_org_id);
  if v_locked is true then
    return jsonb_build_object('ok', false, 'error', 'ROSTER_LOCKED', 'message', 'ROSTER_LOCKED: Unlock event before deleting.');
  end if;

  delete from public.events where id = p_event_id and upper(org_id) = upper(v_org_id);
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.event_delete(text, uuid) from public;
grant execute on function public.event_delete(text, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 3. JUDGE WRITES (judge_upsert, judge_update, judge_delete)
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

  insert into public.judges (
    id, org_id, name, judge_id, pin, assigned_events, current_session_token, created_at
  ) values (
    v_id,
    v_org_id,
    coalesce(nullif(btrim(p_record->>'name'), ''), 'Judge'),
    p_record->>'judge_id',
    coalesce(nullif(btrim(p_record->>'pin'), ''), '0000'),
    case when jsonb_typeof(p_record->'assigned_events') = 'array' then array(select jsonb_array_elements_text(p_record->'assigned_events')) else '{}'::text[] end,
    p_record->>'current_session_token',
    coalesce(nullif(p_record->>'created_at', '')::timestamptz, now())
  )
  on conflict (id) do update set
    name = excluded.name,
    judge_id = excluded.judge_id,
    pin = excluded.pin,
    assigned_events = excluded.assigned_events,
    current_session_token = excluded.current_session_token
  returning * into v_row;

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
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
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  update public.judges
  set
    name = case when p_updates ? 'name' then coalesce(nullif(btrim(p_updates->>'name'), ''), name) else name end,
    judge_id = case when p_updates ? 'judge_id' then p_updates->>'judge_id' else judge_id end,
    pin = case when p_updates ? 'pin' then coalesce(nullif(btrim(p_updates->>'pin'), ''), pin) else pin end,
    assigned_events = case when p_updates ? 'assigned_events' then (case when jsonb_typeof(p_updates->'assigned_events') = 'array' then array(select jsonb_array_elements_text(p_updates->'assigned_events')) else '{}'::text[] end) else assigned_events end,
    current_session_token = case when p_updates ? 'current_session_token' then p_updates->>'current_session_token' else current_session_token end
  where id = p_judge_id and upper(org_id) = upper(v_org_id)
  returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'Judge not found or access denied.');
  end if;

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
end;
$$;

revoke all on function public.judge_update(text, uuid, jsonb) from public;
grant execute on function public.judge_update(text, uuid, jsonb) to anon, authenticated;

create or replace function public.judge_delete(
  p_token text,
  p_judge_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  delete from public.judges where id = p_judge_id and upper(org_id) = upper(v_org_id);
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.judge_delete(text, uuid) from public;
grant execute on function public.judge_delete(text, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 4. PARTICIPANT WRITES (participant_upsert_batch, participant_update, participant_delete)
-- ─────────────────────────────────────────────────────────────────

create or replace function public.participant_upsert_batch(
  p_token text,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  rec jsonb;
  v_id uuid;
  v_existing_org text;
  v_row public.participants;
  v_out jsonb := '[]'::jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  for rec in select * from jsonb_array_elements(coalesce(p_records, '[]'::jsonb)) loop
    if rec->>'org_id' is not null and upper(rec->>'org_id') <> upper(v_org_id) then
      return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Cannot insert participants for another organization.');
    end if;

    v_id := coalesce(nullif(rec->>'id', '')::uuid, gen_random_uuid());
    select org_id into v_existing_org from public.participants where id = v_id;
    if v_existing_org is not null and upper(v_existing_org) <> upper(v_org_id) then
      return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Cannot overwrite participant from another organization.');
    end if;

    insert into public.participants (
      id, org_id, identity_id, sl_no, name, school, class_or_age, mobile_number, custom_values, created_at
    ) values (
      v_id,
      v_org_id,
      coalesce(nullif(btrim(rec->>'identity_id'), ''), 'P-' || substring(v_id::text from 1 for 6)),
      rec->>'sl_no',
      coalesce(nullif(btrim(rec->>'name'), ''), 'Participant'),
      rec->>'school',
      rec->>'class_or_age',
      rec->>'mobile_number',
      coalesce(rec->'custom_values', '{}'::jsonb),
      coalesce(nullif(rec->>'created_at', '')::timestamptz, now())
    )
    on conflict (id) do update set
      sl_no = excluded.sl_no,
      name = excluded.name,
      school = excluded.school,
      class_or_age = excluded.class_or_age,
      mobile_number = excluded.mobile_number,
      custom_values = excluded.custom_values
    returning * into v_row;

    v_out := v_out || jsonb_build_array(to_jsonb(v_row));
  end loop;

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.participant_upsert_batch(text, jsonb) from public;
grant execute on function public.participant_upsert_batch(text, jsonb) to anon, authenticated;

create or replace function public.participant_update(
  p_token text,
  p_participant_id uuid,
  p_updates jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_row public.participants;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  update public.participants
  set
    sl_no = case when p_updates ? 'sl_no' then p_updates->>'sl_no' else sl_no end,
    name = case when p_updates ? 'name' then coalesce(nullif(btrim(p_updates->>'name'), ''), name) else name end,
    school = case when p_updates ? 'school' then p_updates->>'school' else school end,
    class_or_age = case when p_updates ? 'class_or_age' then p_updates->>'class_or_age' else class_or_age end,
    mobile_number = case when p_updates ? 'mobile_number' then p_updates->>'mobile_number' else mobile_number end,
    custom_values = case when p_updates ? 'custom_values' then coalesce(p_updates->'custom_values', custom_values) else custom_values end
  where id = p_participant_id and upper(org_id) = upper(v_org_id)
  returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'Participant not found or access denied.');
  end if;

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
end;
$$;

revoke all on function public.participant_update(text, uuid, jsonb) from public;
grant execute on function public.participant_update(text, uuid, jsonb) to anon, authenticated;

create or replace function public.participant_delete(
  p_token text,
  p_participant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  delete from public.participants where id = p_participant_id and upper(org_id) = upper(v_org_id);
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.participant_delete(text, uuid) from public;
grant execute on function public.participant_delete(text, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 5. SCORE WRITES (score_upsert_batch — Judge OR Organiser Token)
-- ─────────────────────────────────────────────────────────────────

create or replace function public.score_upsert_batch(
  p_token text,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_judge_auth jsonb;
  v_judge_id uuid;
  v_judge_org text;
  rec jsonb;
  v_id uuid;
  v_event_id uuid;
  v_rec_judge_id uuid;
  v_participant_id uuid;
  v_event_org text;
  v_event_status text;
  v_assigned_judges text[];
  v_grace_enabled boolean;
  v_existing public.scores;
  v_row public.scores;
  v_out jsonb := '[]'::jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    v_judge_auth := public._fj_verify_judge_token(p_token);
    if not coalesce((v_judge_auth->>'ok')::boolean, false) then
      return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
    end if;
    v_judge_id := (v_judge_auth->>'judge_id')::uuid;
    v_judge_org := v_judge_auth->>'org_id';
  end if;

  for rec in select * from jsonb_array_elements(coalesce(p_records, '[]'::jsonb)) loop
    v_id := coalesce(nullif(rec->>'id', '')::uuid, gen_random_uuid());
    v_event_id := (rec->>'event_id')::uuid;
    v_rec_judge_id := (rec->>'judge_id')::uuid;
    v_participant_id := (rec->>'participant_id')::uuid;

    select e.org_id, lower(coalesce(e.status, '')), coalesce(e.assigned_judges, '{}'::text[])
    into v_event_org, v_event_status, v_assigned_judges
    from public.events e
    where e.id = v_event_id;

    if v_event_org is null then
      return jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'Target event not found.');
    end if;

    if v_org_id is not null then
      if upper(v_event_org) <> upper(v_org_id) then
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Cannot write scores for another organization.');
      end if;
    else
      if upper(v_event_org) <> upper(v_judge_org) or v_rec_judge_id <> v_judge_id then
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Judge token does not match score owner or organization.');
      end if;
      if not (v_judge_id::text = any(v_assigned_judges) or v_event_status = 'active') then
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Judge is not assigned to this event.');
      end if;
    end if;

    -- Check immutability / 5-minute grace period
    select * into v_existing
    from public.scores s
    where s.id = v_id
       or (s.event_id = v_event_id and s.judge_id = v_rec_judge_id and s.participant_id = v_participant_id)
    limit 1;

    if v_existing.id is not null and v_org_id is null then
      select coalesce(o.grace_period_enabled, false) into v_grace_enabled
      from public.organizations o
      where upper(o.org_id) = upper(v_event_org);

      if not coalesce(v_grace_enabled, false) or (now() - v_existing.created_at) > interval '5 minutes' then
        return jsonb_build_object('ok', false, 'error', 'RLS Permission Denied', 'message', 'RLS Permission Denied: Scores are immutable and cannot be updated once inserted.');
      end if;
    end if;

    if v_existing.id is not null then
      update public.scores
      set
        score_payload = coalesce(rec->'score_payload', score_payload),
        total_score = coalesce((rec->>'total_score')::numeric, total_score)
      where id = v_existing.id
      returning * into v_row;
    else
      insert into public.scores (
        id, event_id, judge_id, participant_id, score_payload, total_score, created_at
      ) values (
        v_id,
        v_event_id,
        v_rec_judge_id,
        v_participant_id,
        coalesce(rec->'score_payload', '{}'::jsonb),
        coalesce((rec->>'total_score')::numeric, 0),
        now()
      )
      returning * into v_row;
    end if;

    v_out := v_out || jsonb_build_array(to_jsonb(v_row));
  end loop;

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.score_upsert_batch(text, jsonb) from public;
grant execute on function public.score_upsert_batch(text, jsonb) to anon, authenticated;

create or replace function public.score_delete(
  p_token text,
  p_score_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  delete from public.scores s
  using public.events e
  where s.id = p_score_id
    and s.event_id = e.id
    and upper(e.org_id) = upper(v_org_id);

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.score_delete(text, uuid) from public;
grant execute on function public.score_delete(text, uuid) to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 6. LOCK DOWN DIRECT TABLE WRITES (SELECT-ONLY ON PUBLIC REST API)
-- ─────────────────────────────────────────────────────────────────

-- Organizations: keep SELECT only
drop policy if exists "organizations_update" on public.organizations;
drop policy if exists "organizations_delete" on public.organizations;
revoke insert, update, delete on table public.organizations from anon, authenticated;

-- Events: keep SELECT only
drop policy if exists "Enable read/write for events" on public.events;
drop policy if exists "events_select" on public.events;
create policy "events_select" on public.events for select to public using (true);
revoke insert, update, delete on table public.events from anon, authenticated;

-- Judges: keep SELECT only (Stage D4 will scope PIN reads)
drop policy if exists "Enable read/write for judges" on public.judges;
drop policy if exists "judges_select" on public.judges;
create policy "judges_select" on public.judges for select to public using (true);
revoke insert, update, delete on table public.judges from anon, authenticated;

-- Participants: keep SELECT only
drop policy if exists "Enable read/write for participants" on public.participants;
drop policy if exists "participants_select" on public.participants;
create policy "participants_select" on public.participants for select to public using (true);
revoke insert, update, delete on table public.participants from anon, authenticated;

-- Scores: keep SELECT only
drop policy if exists "Enable insert for scores" on public.scores;
drop policy if exists "Enable update for scores" on public.scores;
drop policy if exists "Enable read for scores" on public.scores;
drop policy if exists "scores_select" on public.scores;
create policy "scores_select" on public.scores for select to public using (true);
revoke insert, update, delete on table public.scores from anon, authenticated;
