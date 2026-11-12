-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.7 — Stage C3: Atomic Organization Backup Restore Engine (Hotfix 15.7.2)
-- ═══════════════════════════════════════════════════════════════════
-- 1. Requires master password verification via _fj_verify_org
-- 2. Refuses Replace mode if any event is locked (is_locked = true)
-- 3. Handles dry-run validation, atomic restoration, locked events immunity
-- ═══════════════════════════════════════════════════════════════════

-- Drop legacy overload if present
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
  
  -- Counters for summary
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

  -- 1. MASTER PASSWORD VERIFICATION (Hotfix 15.7.2 Requirement 1)
  v_auth := public._fj_verify_org(clean_org_id, p_password);
  if not (v_auth->>'ok')::boolean then
    return v_auth;
  end if;

  if v_mode not in ('replace', 'add', 'merge') then
    return jsonb_build_object('ok', false, 'error', 'invalid_mode', 'reason', 'invalid_mode', 'message', 'Invalid restore mode. Expected replace, add, or merge.');
  end if;

  -- Collect locked events for this organization (strictly protected against deletion and overwrite)
  select coalesce(array_agg(id), '{}'::uuid[])
  into locked_event_ids
  from public.events
  where org_id = clean_org_id and is_locked = true;

  -- 2. REPLACE MODE RESTRICTION (Hotfix 15.7.2 Requirement 4)
  -- Replace mode must refuse if any event in the organisation has is_locked = true
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

  -- ─────────────────────────────────────────────────────────────
  -- 3. DRY RUN SIMULATION
  -- ─────────────────────────────────────────────────────────────
  if p_dry_run then
    -- Events simulation
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

    -- Judges simulation
    for rec in select * from jsonb_array_elements(v_judges) loop
      v_id := (rec->>'id')::uuid;
      if exists(select 1 from public.judges where id = v_id) then
        c_judges_updated := c_judges_updated + 1;
      else
        c_judges_created := c_judges_created + 1;
      end if;
    end loop;

    -- Participants simulation
    for rec in select * from jsonb_array_elements(v_participants) loop
      v_id := (rec->>'id')::uuid;
      if exists(select 1 from public.participants where id = v_id) then
        c_participants_updated := c_participants_updated + 1;
      else
        c_participants_created := c_participants_created + 1;
      end if;
    end loop;

    -- Scores simulation
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

  -- ─────────────────────────────────────────────────────────────
  -- 4. ATOMIC EXECUTION
  -- ─────────────────────────────────────────────────────────────

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
