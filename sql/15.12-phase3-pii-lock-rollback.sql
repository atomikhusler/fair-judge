-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.12 — PHASE 3: PII LOCK ROLLBACK (Emergency Only)
-- ═══════════════════════════════════════════════════════════════════
-- Safely restores plaintext judge PINs from judge_secrets.pin_encrypted
-- back onto public.judges and restores pre-Phase-3 judge_login /
-- judge_upsert / judge_update / org_restore / read_org_roster_credentials
-- while preserving Phase 2B table-level RLS lockdown.
--
-- Ends with a single read-only verification query returning ONE jsonb cell.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Restore plaintext PINs on public.judges from judge_secrets.pin_encrypted
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'judge_secrets'
  ) then
    update public.judges j
    set pin = coalesce(
      nullif(btrim(public._fj_decrypt_judge_pin(js.pin_encrypted)), ''),
      nullif(btrim(j.pin), ''),
      '0000'
    )
    from public.judge_secrets js
    where js.judge_id = j.id;
  end if;
end $$;

-- 2. Restore pre-Phase-3 judge_login (plaintext pin match)
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

-- 3. Restore pre-Phase-3 judge_upsert & judge_update
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

-- 4. Restore read_org_roster_credentials to read directly from public.judges
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
    jsonb_agg((to_jsonb(j) - 'current_session_token') order by j.created_at desc),
    '[]'::jsonb
  )
  into v_judges
  from public.judges j
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

-- 5. Restore pre-Phase-3 org_restore (writes judges.pin directly)
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

    insert into public.judges (
      id, org_id, name, judge_id, pin, assigned_events, created_at
    ) values (
      v_id, clean_org_id, coalesce(rec->>'name', 'Judge'), rec->>'judge_id',
      coalesce(rec->>'pin', '0000'),
      case when jsonb_typeof(rec->'assigned_events') = 'array'
           then array(select jsonb_array_elements_text(rec->'assigned_events'))
           else '{}'::text[] end,
      coalesce((rec->>'created_at')::timestamptz, now())
    )
    on conflict (id) do update set
      name = excluded.name, judge_id = excluded.judge_id,
      pin = excluded.pin, assigned_events = excluded.assigned_events;
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

-- ═══════════════════════════════════════════════════════════════════
-- VERIFICATION QUERY (Read-only, returns ONE jsonb cell)
-- ═══════════════════════════════════════════════════════════════════
select jsonb_build_object(
  'phase3_rollback', 'complete',
  'judges_total', (select count(*) from public.judges),
  'judges_with_restored_pin', (select count(*) from public.judges where coalesce(btrim(pin), '') <> '')
) as phase3_rollback_verification;
