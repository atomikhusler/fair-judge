-- ═══════════════════════════════════════════════════════════════════
-- EPIC 16.3.1 VERIFY-FIX — UNLOCK EVENTS BEFORE MASTER RESET & REPLACE
-- ═══════════════════════════════════════════════════════════════════
-- Upgrade safety:
--   - Uses CREATE OR REPLACE FUNCTION only. NO DROP, NO REVOKE statements.
--   - Does NOT modify or drop sql/16.3.0-master-reset-restore.sql or legacy
--     org_reset_data / org_restore functions.
--   - Fixes ROSTER_LOCKED trigger failures on Master Reset (org_reset_all)
--     and Backup v2 Replace Restore (org_restore_v2) by running ONE
--     org-wide unlock (`UPDATE public.events SET is_locked = false ...`)
--     before any DELETE statement.
-- ═══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- 1. MASTER RESET: org_reset_all(p_token, p_org_id, p_password)
-- ─────────────────────────────────────────────────────────────────
create or replace function public.org_reset_all(
  p_token text,
  p_org_id text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_auth jsonb;
  v_reason text;

  c_events int := 0;
  c_locked_events int := 0;
  c_judges int := 0;
  c_participants int := 0;
  c_scores int := 0;
  c_judge_sessions int := 0;
  v_sync_version bigint := 1;
begin
  -- 1. Verify active organiser session token
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  -- 2. Verify organiser master password (shares org_login_throttle 5 strikes / 15m)
  v_auth := public._fj_verify_org(v_org_id, p_password);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    v_reason := coalesce(v_auth->>'error', v_auth->>'reason', 'invalid_credentials');
    return jsonb_build_object(
      'ok', false,
      'error', v_reason,
      'reason', v_reason,
      'message', case
        when v_reason = 'too_many_attempts'
          then 'Too many wrong password attempts. Try again in 15 minutes.'
        else 'Wrong master password. Nothing was deleted.'
      end
    );
  end if;

  -- 3. Pre-count competition data to report accurate deletion summary
  select count(*)::int,
         count(*) filter (where is_locked = true)::int
  into c_events, c_locked_events
  from public.events
  where upper(org_id) = upper(v_org_id);

  select count(*)::int into c_judges
  from public.judges
  where upper(org_id) = upper(v_org_id);

  select count(*)::int into c_participants
  from public.participants
  where upper(org_id) = upper(v_org_id);

  select count(*)::int into c_scores
  from public.scores s
  where upper(coalesce(s.org_id, '')) = upper(v_org_id)
     or s.event_id in (select id from public.events where upper(org_id) = upper(v_org_id));

  select count(*)::int into c_judge_sessions
  from public.judge_sessions js
  where upper(js.org_id) = upper(v_org_id)
     or js.judge_id in (select id from public.judges where upper(org_id) = upper(v_org_id));

  -- 4. Unlock all locked events for this org BEFORE any DELETE so judge/participant delete triggers pass cleanly
  update public.events
  set is_locked = false
  where upper(org_id) = upper(v_org_id)
    and is_locked = true;

  -- 5. Atomic wipe in required order: scores -> judge_sessions -> judge_secrets -> judges -> participants -> events
  delete from public.scores
  where event_id in (select id from public.events where upper(org_id) = upper(v_org_id))
     or upper(coalesce(org_id, '')) = upper(v_org_id);

  delete from public.judge_sessions
  where upper(org_id) = upper(v_org_id)
     or judge_id in (select id from public.judges where upper(org_id) = upper(v_org_id));

  delete from public.judge_secrets
  where upper(org_id) = upper(v_org_id)
     or judge_id in (select id from public.judges where upper(org_id) = upper(v_org_id));

  delete from public.judges
  where upper(org_id) = upper(v_org_id);

  delete from public.participants
  where upper(org_id) = upper(v_org_id);

  delete from public.events
  where upper(org_id) = upper(v_org_id);

  -- Ensure sync_version advances even if competition tables were already empty
  v_sync_version := public._fj_bump_org_sync_version(v_org_id);

  return jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'events', c_events,
      'locked_events', c_locked_events,
      'judges', c_judges,
      'participants', c_participants,
      'scores', c_scores,
      'judge_sessions', c_judge_sessions,
      'sync_version', v_sync_version
    ),
    'events', c_events,
    'locked_events', c_locked_events,
    'judges', c_judges,
    'participants', c_participants,
    'scores', c_scores,
    'judge_sessions', c_judge_sessions,
    'sync_version', v_sync_version
  );
end;
$$;

-- ─────────────────────────────────────────────────────────────────
-- 2. BACKUP v2 RESTORE: org_restore_v2
-- ─────────────────────────────────────────────────────────────────
create or replace function public.org_restore_v2(
  p_token text,
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
  v_org_id text;
  v_auth jsonb;
  v_reason text;
  v_mode text;
  v_schema_version int := 1;
  v_org_row public.organizations;

  v_events jsonb;
  v_judges jsonb;
  v_participants jsonb;
  v_scores jsonb;
  v_settings jsonb;
  v_has_settings boolean := false;
  v_settings_changed text[] := '{}'::text[];

  c_events_created int := 0;
  c_events_updated int := 0;
  c_events_protected int := 0;
  c_existing_locked_replaced int := 0;
  c_judges_created int := 0;
  c_judges_updated int := 0;
  c_participants_created int := 0;
  c_participants_updated int := 0;
  c_scores_created int := 0;
  c_scores_updated int := 0;

  rec jsonb;
  v_id uuid;
  v_event_id uuid;
  v_pin text;
  v_exists boolean;
  v_existing_org text;
  v_locked boolean;
  locked_event_ids uuid[];

  -- Sanitized whitelisted settings candidates
  v_next_name text;
  v_next_email text;
  v_next_tie_enabled boolean;
  v_next_tie_method text;
  v_next_custom_fields jsonb;
  v_next_blind_judging boolean;
  v_next_auto_advance boolean;
  v_next_grace_period boolean;
  v_next_isolated_jury boolean;
  v_next_proj_blind boolean;
  v_next_proj_spotlight boolean;
  v_next_proj_ticker text;
  v_next_proj_interval int;
  v_sync_version bigint := 1;
begin
  -- 1. Verify active organiser session token
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  -- 2. Verify organiser master password (shares org_login_throttle)
  v_auth := public._fj_verify_org(v_org_id, p_password);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    v_reason := coalesce(v_auth->>'error', v_auth->>'reason', 'invalid_credentials');
    return jsonb_build_object(
      'ok', false,
      'error', v_reason,
      'reason', v_reason,
      'message', case
        when v_reason = 'too_many_attempts'
          then 'Too many wrong password attempts. Try again in 15 minutes.'
        else 'Invalid master password. Please verify credentials.'
      end
    );
  end if;

  v_mode := lower(btrim(coalesce(p_mode, 'merge')));
  if v_mode not in ('replace', 'add', 'merge') then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_mode',
      'reason', 'invalid_mode',
      'message', 'Invalid restore mode. Expected replace, add, or merge.'
    );
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_payload',
      'message', 'Restore payload must be a JSON object.'
    );
  end if;

  -- 3. Reject unknown / future backup schemas cleanly
  if p_payload ? 'schema_version' and nullif(btrim(coalesce(p_payload->>'schema_version', '')), '') is not null then
    begin
      v_schema_version := (p_payload->>'schema_version')::int;
    exception when others then
      return jsonb_build_object(
        'ok', false,
        'error', 'unsupported_backup_version',
        'message', 'Invalid backup schema version.'
      );
    end;
  end if;

  if v_schema_version > 2 then
    return jsonb_build_object(
      'ok', false,
      'error', 'backup_too_new',
      'reason', 'backup_too_new',
      'message', 'This backup was made by a newer version. Update the app first.'
    );
  end if;

  if v_schema_version < 1 then
    return jsonb_build_object(
      'ok', false,
      'error', 'unsupported_backup_version',
      'reason', 'unsupported_backup_version',
      'message', 'This backup version is too old or unsupported.'
    );
  end if;

  select * into v_org_row
  from public.organizations o
  where upper(o.org_id) = upper(v_org_id)
  limit 1;

  if v_org_row.id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'Organization not found.');
  end if;

  v_events := case when jsonb_typeof(p_payload->'events') = 'array' then p_payload->'events' else '[]'::jsonb end;
  v_judges := case when jsonb_typeof(p_payload->'judges') = 'array' then p_payload->'judges' else '[]'::jsonb end;
  v_participants := case when jsonb_typeof(p_payload->'participants') = 'array' then p_payload->'participants' else '[]'::jsonb end;
  v_scores := case when jsonb_typeof(p_payload->'scores') = 'array' then p_payload->'scores' else '[]'::jsonb end;

  -- 4. Prepare & sanitize 13 whitelisted organization settings (if included in backup)
  v_has_settings := (p_payload ? 'settings' and jsonb_typeof(p_payload->'settings') = 'object');
  if v_has_settings then
    v_settings := p_payload->'settings';

    v_next_name := case
      when v_settings ? 'name' then coalesce(nullif(btrim(v_settings->>'name'), ''), v_org_row.name)
      else v_org_row.name
    end;
    v_next_email := case
      when v_settings ? 'email' then nullif(btrim(v_settings->>'email'), '')
      else v_org_row.email
    end;
    v_next_tie_enabled := case
      when v_settings ? 'tie_breaker_enabled' then coalesce((v_settings->>'tie_breaker_enabled')::boolean, false)
      else coalesce(v_org_row.tie_breaker_enabled, false)
    end;
    v_next_tie_method := case
      when v_settings ? 'tie_breaker_method' and lower(coalesce(v_settings->>'tie_breaker_method', '')) in ('olympic', 'shared', 'manual')
        then lower(v_settings->>'tie_breaker_method')
      else coalesce(v_org_row.tie_breaker_method, 'olympic')
    end;
    v_next_custom_fields := case
      when v_settings ? 'custom_participant_fields' and jsonb_typeof(v_settings->'custom_participant_fields') = 'array'
        then v_settings->'custom_participant_fields'
      else coalesce(v_org_row.custom_participant_fields, '[]'::jsonb)
    end;
    v_next_blind_judging := case
      when v_settings ? 'blind_judging_enabled' then coalesce((v_settings->>'blind_judging_enabled')::boolean, false)
      else coalesce(v_org_row.blind_judging_enabled, false)
    end;
    v_next_auto_advance := case
      when v_settings ? 'auto_advance_enabled' then coalesce((v_settings->>'auto_advance_enabled')::boolean, true)
      else coalesce(v_org_row.auto_advance_enabled, true)
    end;
    v_next_grace_period := case
      when v_settings ? 'grace_period_enabled' then coalesce((v_settings->>'grace_period_enabled')::boolean, false)
      else coalesce(v_org_row.grace_period_enabled, false)
    end;
    v_next_isolated_jury := case
      when v_settings ? 'isolated_jury_enabled' then coalesce((v_settings->>'isolated_jury_enabled')::boolean, false)
      else coalesce(v_org_row.isolated_jury_enabled, false)
    end;
    v_next_proj_blind := case
      when v_settings ? 'projector_blind_mode' then coalesce((v_settings->>'projector_blind_mode')::boolean, false)
      else coalesce(v_org_row.projector_blind_mode, false)
    end;
    v_next_proj_spotlight := case
      when v_settings ? 'projector_spotlight_mode' then coalesce((v_settings->>'projector_spotlight_mode')::boolean, true)
      else coalesce(v_org_row.projector_spotlight_mode, true)
    end;
    if v_settings ? 'projector_ticker_text' then
      v_next_proj_ticker := coalesce(v_settings->>'projector_ticker_text', '');
      v_next_proj_ticker := regexp_replace(v_next_proj_ticker, '<[^>]*>', '', 'g');
      v_next_proj_ticker := replace(replace(v_next_proj_ticker, '<', ''), '>', '');
      v_next_proj_ticker := regexp_replace(v_next_proj_ticker, '[\r\n\t]+', ' ', 'g');
      v_next_proj_ticker := left(btrim(v_next_proj_ticker), 120);
    else
      v_next_proj_ticker := coalesce(v_org_row.projector_ticker_text, '');
    end if;
    v_next_proj_interval := case
      when v_settings ? 'projector_carousel_interval'
        then greatest(15, least(180, coalesce((v_settings->>'projector_carousel_interval')::int, 60)))
      else greatest(15, least(180, coalesce(v_org_row.projector_carousel_interval, 60)))
    end;

    if v_next_name is distinct from v_org_row.name then v_settings_changed := array_append(v_settings_changed, 'name'); end if;
    if v_next_email is distinct from v_org_row.email then v_settings_changed := array_append(v_settings_changed, 'email'); end if;
    if v_next_tie_enabled is distinct from coalesce(v_org_row.tie_breaker_enabled, false) then v_settings_changed := array_append(v_settings_changed, 'tie_breaker_enabled'); end if;
    if v_next_tie_method is distinct from coalesce(v_org_row.tie_breaker_method, 'olympic') then v_settings_changed := array_append(v_settings_changed, 'tie_breaker_method'); end if;
    if v_next_custom_fields is distinct from coalesce(v_org_row.custom_participant_fields, '[]'::jsonb) then v_settings_changed := array_append(v_settings_changed, 'custom_participant_fields'); end if;
    if v_next_blind_judging is distinct from coalesce(v_org_row.blind_judging_enabled, false) then v_settings_changed := array_append(v_settings_changed, 'blind_judging_enabled'); end if;
    if v_next_auto_advance is distinct from coalesce(v_org_row.auto_advance_enabled, true) then v_settings_changed := array_append(v_settings_changed, 'auto_advance_enabled'); end if;
    if v_next_grace_period is distinct from coalesce(v_org_row.grace_period_enabled, false) then v_settings_changed := array_append(v_settings_changed, 'grace_period_enabled'); end if;
    if v_next_isolated_jury is distinct from coalesce(v_org_row.isolated_jury_enabled, false) then v_settings_changed := array_append(v_settings_changed, 'isolated_jury_enabled'); end if;
    if v_next_proj_blind is distinct from coalesce(v_org_row.projector_blind_mode, false) then v_settings_changed := array_append(v_settings_changed, 'projector_blind_mode'); end if;
    if v_next_proj_spotlight is distinct from coalesce(v_org_row.projector_spotlight_mode, true) then v_settings_changed := array_append(v_settings_changed, 'projector_spotlight_mode'); end if;
    if v_next_proj_ticker is distinct from coalesce(v_org_row.projector_ticker_text, '') then v_settings_changed := array_append(v_settings_changed, 'projector_ticker_text'); end if;
    if v_next_proj_interval is distinct from greatest(15, least(180, coalesce(v_org_row.projector_carousel_interval, 60))) then v_settings_changed := array_append(v_settings_changed, 'projector_carousel_interval'); end if;
  end if;

  -- Locked events (only protected in add/merge; replace overwrites everything)
  select coalesce(array_agg(id), '{}'::uuid[])
  into locked_event_ids
  from public.events
  where upper(org_id) = upper(v_org_id) and is_locked = true;

  if v_mode = 'replace' then
    c_existing_locked_replaced := cardinality(locked_event_ids);
  end if;

  -- ─────────────────────────────────────────────────────────────
  -- 5. DRY RUN SIMULATION
  -- ─────────────────────────────────────────────────────────────
  if p_dry_run then
    if v_mode = 'replace' then
      c_events_created := jsonb_array_length(v_events);
      c_judges_created := jsonb_array_length(v_judges);
      c_participants_created := jsonb_array_length(v_participants);
      c_scores_created := jsonb_array_length(v_scores);
    else
      for rec in select * from jsonb_array_elements(v_events) loop
        v_id := (rec->>'id')::uuid;
        select exists(select 1 from public.events where id = v_id and upper(org_id) = upper(v_org_id)),
               coalesce((select is_locked from public.events where id = v_id and upper(org_id) = upper(v_org_id)), false)
        into v_exists, v_locked;

        if v_exists and v_locked then
          c_events_protected := c_events_protected + 1;
        elsif v_exists then
          if v_mode = 'merge' then
            c_events_updated := c_events_updated + 1;
          end if;
        else
          c_events_created := c_events_created + 1;
        end if;
      end loop;

      for rec in select * from jsonb_array_elements(v_judges) loop
        v_id := (rec->>'id')::uuid;
        if exists(select 1 from public.judges where id = v_id and upper(org_id) = upper(v_org_id)) then
          if v_mode = 'merge' then
            c_judges_updated := c_judges_updated + 1;
          end if;
        else
          c_judges_created := c_judges_created + 1;
        end if;
      end loop;

      for rec in select * from jsonb_array_elements(v_participants) loop
        v_id := (rec->>'id')::uuid;
        if exists(select 1 from public.participants where id = v_id and upper(org_id) = upper(v_org_id)) then
          if v_mode = 'merge' then
            c_participants_updated := c_participants_updated + 1;
          end if;
        else
          c_participants_created := c_participants_created + 1;
        end if;
      end loop;

      for rec in select * from jsonb_array_elements(v_scores) loop
        v_id := (rec->>'id')::uuid;
        if (rec->>'event_id')::uuid = any(locked_event_ids) then
          continue;
        end if;
        if exists(
          select 1 from public.scores s
          join public.events e on e.id = s.event_id
          where s.id = v_id and upper(e.org_id) = upper(v_org_id)
        ) then
          if v_mode = 'merge' then
            c_scores_updated := c_scores_updated + 1;
          end if;
        else
          c_scores_created := c_scores_created + 1;
        end if;
      end loop;
    end if;

    return jsonb_build_object(
      'ok', true,
      'dry_run', true,
      'mode', v_mode,
      'summary', jsonb_build_object(
        'events_created', c_events_created,
        'events_updated', c_events_updated,
        'events_protected', c_events_protected,
        'existing_locked_replaced', c_existing_locked_replaced,
        'judges_created', c_judges_created,
        'judges_updated', c_judges_updated,
        'participants_created', c_participants_created,
        'participants_updated', c_participants_updated,
        'scores_created', c_scores_created,
        'scores_updated', c_scores_updated,
        'settings_in_backup', v_has_settings,
        'settings_updated', to_jsonb(v_settings_changed)
      )
    );
  end if;

  -- ─────────────────────────────────────────────────────────────
  -- 6. ATOMIC RESTORE EXECUTION
  -- ─────────────────────────────────────────────────────────────
  if v_mode = 'replace' then
    -- Unlock all locked events for this org BEFORE any DELETE so judge/participant delete triggers pass cleanly
    update public.events
    set is_locked = false
    where upper(org_id) = upper(v_org_id)
      and is_locked = true;

    -- Wipe ALL competition data for this org before re-inserting backup rows (preserving backup is_locked values)
    delete from public.scores
    where event_id in (select id from public.events where upper(org_id) = upper(v_org_id))
       or upper(coalesce(org_id, '')) = upper(v_org_id);

    delete from public.judge_sessions
    where upper(org_id) = upper(v_org_id)
       or judge_id in (select id from public.judges where upper(org_id) = upper(v_org_id));

    delete from public.judge_secrets
    where upper(org_id) = upper(v_org_id)
       or judge_id in (select id from public.judges where upper(org_id) = upper(v_org_id));

    delete from public.judges where upper(org_id) = upper(v_org_id);
    delete from public.participants where upper(org_id) = upper(v_org_id);
    delete from public.events where upper(org_id) = upper(v_org_id);

    locked_event_ids := '{}'::uuid[];
  end if;

  -- Judges
  for rec in select * from jsonb_array_elements(v_judges) loop
    v_id := (rec->>'id')::uuid;
    select org_id into v_existing_org from public.judges where id = v_id;
    if v_existing_org is not null and upper(v_existing_org) <> upper(v_org_id) then
      return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Backup contains a judge ID belonging to another organization.');
    end if;
    if v_mode = 'add' and v_existing_org is not null then
      continue;
    end if;

    v_pin := coalesce(nullif(btrim(coalesce(rec->>'pin', rec->>'judge_pin', '')), ''), '0000');

    insert into public.judges (
      id, org_id, name, judge_id, pin, assigned_events, current_session_token, is_active, created_at
    ) values (
      v_id,
      v_org_id,
      coalesce(nullif(btrim(rec->>'name'), ''), 'Judge'),
      rec->>'judge_id',
      '',
      case when jsonb_typeof(rec->'assigned_events') = 'array'
           then array(select jsonb_array_elements_text(rec->'assigned_events'))
           else '{}'::text[] end,
      null,
      coalesce((rec->>'is_active')::boolean, true),
      coalesce((rec->>'created_at')::timestamptz, now())
    )
    on conflict (id) do update set
      name = excluded.name,
      judge_id = excluded.judge_id,
      pin = '',
      assigned_events = excluded.assigned_events,
      current_session_token = null,
      is_active = excluded.is_active;

    perform public._fj_upsert_judge_secret(v_id, v_org_id, v_pin);
    c_judges_created := c_judges_created + 1;
  end loop;

  -- Participants
  for rec in select * from jsonb_array_elements(v_participants) loop
    v_id := (rec->>'id')::uuid;
    select org_id into v_existing_org from public.participants where id = v_id;
    if v_existing_org is not null and upper(v_existing_org) <> upper(v_org_id) then
      return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Backup contains a participant ID belonging to another organization.');
    end if;
    if v_mode = 'add' and v_existing_org is not null then
      continue;
    end if;

    insert into public.participants (
      id, org_id, identity_id, sl_no, name, school, class_or_age, mobile_number, custom_values, is_active, created_at
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
      coalesce((rec->>'is_active')::boolean, true),
      coalesce((rec->>'created_at')::timestamptz, now())
    )
    on conflict (id) do update set
      sl_no = excluded.sl_no,
      name = excluded.name,
      school = excluded.school,
      class_or_age = excluded.class_or_age,
      mobile_number = excluded.mobile_number,
      custom_values = excluded.custom_values,
      is_active = excluded.is_active;
    c_participants_created := c_participants_created + 1;
  end loop;

  -- Events (re-inserted with is_locked from backup)
  for rec in select * from jsonb_array_elements(v_events) loop
    v_id := (rec->>'id')::uuid;
    select org_id into v_existing_org from public.events where id = v_id;
    if v_existing_org is not null and upper(v_existing_org) <> upper(v_org_id) then
      return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Backup contains an event ID belonging to another organization.');
    end if;
    if v_id = any(locked_event_ids) then
      c_events_protected := c_events_protected + 1;
      continue;
    end if;
    if v_mode = 'add' and v_existing_org is not null then
      continue;
    end if;

    insert into public.events (
      id, org_id, name, category, date, status, started_at, elapsed_seconds,
      rubric_schema, assigned_judges, assigned_participants, participant_sl_numbers,
      created_at, updated_at, is_locked, is_archived
    ) values (
      v_id,
      v_org_id,
      coalesce(nullif(btrim(rec->>'name'), ''), 'Event'),
      rec->>'category',
      rec->>'date',
      coalesce(rec->>'status', 'draft'),
      (rec->>'started_at')::timestamptz,
      coalesce((rec->>'elapsed_seconds')::int, 0),
      coalesce(rec->'rubric_schema', '[]'::jsonb),
      case when jsonb_typeof(rec->'assigned_judges') = 'array'
           then array(select jsonb_array_elements_text(rec->'assigned_judges'))
           else '{}'::text[] end,
      case when jsonb_typeof(rec->'assigned_participants') = 'array'
           then array(select jsonb_array_elements_text(rec->'assigned_participants'))
           else '{}'::text[] end,
      coalesce(rec->'participant_sl_numbers', '{}'::jsonb),
      coalesce((rec->>'created_at')::timestamptz, now()),
      now(),
      coalesce((rec->>'is_locked')::boolean, false),
      coalesce((rec->>'is_archived')::boolean, false)
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
      updated_at = now();
    c_events_created := c_events_created + 1;
  end loop;

  -- Scores
  for rec in select * from jsonb_array_elements(v_scores) loop
    v_id := (rec->>'id')::uuid;
    v_event_id := (rec->>'event_id')::uuid;

    if v_event_id = any(locked_event_ids) then
      continue;
    end if;

    select e.org_id into v_existing_org from public.events e where e.id = v_event_id;
    if v_existing_org is null or upper(v_existing_org) <> upper(v_org_id) then
      continue;
    end if;

    select coalesce(nullif(s.org_id, ''), ev.org_id) into v_existing_org
    from public.scores s
    left join public.events ev on ev.id = s.event_id
    where s.id = v_id;
    if v_existing_org is not null and upper(v_existing_org) <> upper(v_org_id) then
      return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Backup contains a score ID belonging to another organization.');
    end if;

    if v_mode = 'add' and v_existing_org is not null then
      continue;
    end if;

    insert into public.scores (
      id, org_id, event_id, judge_id, participant_id, score_payload, total_score, created_at
    ) values (
      v_id,
      v_org_id,
      v_event_id,
      (rec->>'judge_id')::uuid,
      (rec->>'participant_id')::uuid,
      coalesce(rec->'score_payload', '{}'::jsonb),
      coalesce((rec->>'total_score')::numeric, 0),
      coalesce((rec->>'created_at')::timestamptz, now())
    )
    on conflict (id) do update set
      score_payload = excluded.score_payload,
      total_score = excluded.total_score;
    c_scores_created := c_scores_created + 1;
  end loop;

  -- Whitelisted Organization Settings (13 columns only)
  if v_has_settings then
    update public.organizations
    set
      name = v_next_name,
      email = v_next_email,
      tie_breaker_enabled = v_next_tie_enabled,
      tie_breaker_method = v_next_tie_method,
      custom_participant_fields = v_next_custom_fields,
      blind_judging_enabled = v_next_blind_judging,
      auto_advance_enabled = v_next_auto_advance,
      grace_period_enabled = v_next_grace_period,
      isolated_jury_enabled = v_next_isolated_jury,
      projector_blind_mode = v_next_proj_blind,
      projector_spotlight_mode = v_next_proj_spotlight,
      projector_ticker_text = v_next_proj_ticker,
      projector_carousel_interval = v_next_proj_interval
    where upper(org_id) = upper(v_org_id);
  end if;

  -- Advance monotonic sync version so connected devices receive full/delta updates cleanly
  v_sync_version := public._fj_bump_org_sync_version(v_org_id);

  return jsonb_build_object(
    'ok', true,
    'dry_run', false,
    'mode', v_mode,
    'summary', jsonb_build_object(
      'events_restored', c_events_created,
      'events_protected', c_events_protected,
      'existing_locked_replaced', c_existing_locked_replaced,
      'judges_restored', c_judges_created,
      'participants_restored', c_participants_created,
      'scores_restored', c_scores_created,
      'settings_in_backup', v_has_settings,
      'settings_updated', to_jsonb(v_settings_changed),
      'sync_version', v_sync_version
    )
  );
end;
$$;

-- ═══════════════════════════════════════════════════════════════════
-- READ-ONLY VERIFICATION QUERY (returns ONE jsonb cell)
-- ═══════════════════════════════════════════════════════════════════
select jsonb_build_object(
  'migration', '16.3.1-fix-reset-restore-locks',
  'org_reset_all_unlocks_before_delete', coalesce((
    select (
      pg_get_functiondef(p.oid) ilike '%set is_locked = false%'
      and position('is_locked = false' in lower(pg_get_functiondef(p.oid)))
          < position('delete from public.judges' in lower(pg_get_functiondef(p.oid)))
    )
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'org_reset_all'
    limit 1
  ), false),
  'org_restore_v2_unlocks_before_delete', coalesce((
    select (
      pg_get_functiondef(p.oid) ilike '%set is_locked = false%'
      and position('is_locked = false' in lower(pg_get_functiondef(p.oid)))
          < position('delete from public.judges' in lower(pg_get_functiondef(p.oid)))
    )
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'org_restore_v2'
    limit 1
  ), false),
  'legacy_org_reset_data_preserved', exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'org_reset_data'
  ),
  'legacy_org_restore_preserved', exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'org_restore'
  )
) as verification_result;
