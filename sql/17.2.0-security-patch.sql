-- ═══════════════════════════════════════════════════════════════════
-- EPIC 17.2.0 — CRITICAL SECURITY PATCH (APP v17.4.2)
-- ═══════════════════════════════════════════════════════════════════
-- Owner SQL file — DO NOT auto-run.
-- Split into three independent parts (Part 1, Part 2, Part 3).
-- Each part can be pasted and executed alone in the Supabase SQL Editor
-- and ends with a read-only verification query returning ONE jsonb cell.
-- ═══════════════════════════════════════════════════════════════════


-- ═══════════════════════════════════════════════════════════════════
-- PART 1: REVOKE & DROP LEGACY org_restore (KEEP org_restore_v2)
-- ═══════════════════════════════════════════════════════════════════

do $$
begin
  if to_regprocedure('public.org_restore(text, text, text, jsonb, boolean)') is not null then
    revoke all on function public.org_restore(text, text, text, jsonb, boolean) from public, anon, authenticated;
  end if;
end;
$$;

drop function if exists public.org_restore(text, text, text, jsonb, boolean);

-- Part 1 Verification (read-only, returns ONE jsonb cell)
select jsonb_build_object(
  'epic_17_2_0_part_1', 'verified',
  'legacy_org_restore_removed', to_regprocedure('public.org_restore(text, text, text, jsonb, boolean)') is null,
  'org_restore_v2_present', to_regprocedure('public.org_restore_v2(text, text, text, text, jsonb, boolean)') is not null
);


-- ═══════════════════════════════════════════════════════════════════
-- PART 2: REMOVE verification_status FROM org_update
-- ═══════════════════════════════════════════════════════════════════
-- Copied verbatim from sql/15.12.1-projector-controls.sql (lines 24-86)
-- with ONLY the verification_status assignment removed so only
-- super-admin RPCs can modify verification_status.

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
  v_clean_ticker text;
  v_interval int;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
  end if;

  if p_updates ? 'projector_ticker_text' then
    v_clean_ticker := coalesce(p_updates->>'projector_ticker_text', '');
    v_clean_ticker := regexp_replace(v_clean_ticker, '<[^>]*>', '', 'g');
    v_clean_ticker := replace(replace(v_clean_ticker, '<', ''), '>', '');
    v_clean_ticker := regexp_replace(v_clean_ticker, '[\r\n\t]+', ' ', 'g');
    v_clean_ticker := left(btrim(v_clean_ticker), 120);
  end if;

  if p_updates ? 'projector_carousel_interval' then
    v_interval := greatest(15, least(180, coalesce((p_updates->>'projector_carousel_interval')::int, 60)));
  end if;

  update public.organizations
  set
    name = case when p_updates ? 'name' then coalesce(nullif(btrim(p_updates->>'name'), ''), name) else name end,
    email = case when p_updates ? 'email' then nullif(btrim(p_updates->>'email'), '') else email end,
    tie_breaker_enabled = case when p_updates ? 'tie_breaker_enabled' then coalesce((p_updates->>'tie_breaker_enabled')::boolean, tie_breaker_enabled) else tie_breaker_enabled end,
    tie_breaker_method = case when p_updates ? 'tie_breaker_method' then coalesce(p_updates->>'tie_breaker_method', tie_breaker_method) else tie_breaker_method end,
    custom_participant_fields = case when p_updates ? 'custom_participant_fields' then coalesce(p_updates->'custom_participant_fields', custom_participant_fields) else custom_participant_fields end,
    blind_judging_enabled = case when p_updates ? 'blind_judging_enabled' then coalesce((p_updates->>'blind_judging_enabled')::boolean, blind_judging_enabled) else blind_judging_enabled end,
    auto_advance_enabled = case when p_updates ? 'auto_advance_enabled' then coalesce((p_updates->>'auto_advance_enabled')::boolean, auto_advance_enabled) else auto_advance_enabled end,
    grace_period_enabled = case when p_updates ? 'grace_period_enabled' then coalesce((p_updates->>'grace_period_enabled')::boolean, grace_period_enabled) else grace_period_enabled end,
    isolated_jury_enabled = case when p_updates ? 'isolated_jury_enabled' then coalesce((p_updates->>'isolated_jury_enabled')::boolean, isolated_jury_enabled) else isolated_jury_enabled end,
    projector_blind_mode = case when p_updates ? 'projector_blind_mode' then coalesce((p_updates->>'projector_blind_mode')::boolean, projector_blind_mode) else projector_blind_mode end,
    projector_spotlight_mode = case when p_updates ? 'projector_spotlight_mode' then coalesce((p_updates->>'projector_spotlight_mode')::boolean, projector_spotlight_mode) else projector_spotlight_mode end,
    projector_ticker_text = case when p_updates ? 'projector_ticker_text' then coalesce(v_clean_ticker, '') else projector_ticker_text end,
    projector_carousel_interval = case when p_updates ? 'projector_carousel_interval' then v_interval else projector_carousel_interval end,
    projector_confetti_at = case when p_updates ? 'projector_confetti_at' then nullif(p_updates->>'projector_confetti_at', '')::timestamptz else projector_confetti_at end
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

-- Part 2 Verification (read-only, returns ONE jsonb cell)
select jsonb_build_object(
  'epic_17_2_0_part_2', 'verified',
  'org_update_exists', to_regprocedure('public.org_update(text, text, jsonb)') is not null,
  'verification_status_removed', position('verification_status' in coalesce(pg_get_functiondef(to_regprocedure('public.org_update(text, text, jsonb)')), '')) = 0
);


-- ═══════════════════════════════════════════════════════════════════
-- PART 3: HARDEN judge_login (REJECT EMPTY ORG/JUDGE ID & '0000' PIN)
-- ═══════════════════════════════════════════════════════════════════
-- Copied verbatim from sql/15.12-phase3-pii-lock.sql (lines 592-743)
-- with an early rejection before throttle and table scan when
-- clean_org_id is empty, clean_judge_id is empty, or clean_pin = '0000'.

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

  if clean_org_id = '' or clean_judge_id = '' or clean_pin = '' or clean_pin = '0000' then
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

-- Part 3 Verification (read-only, returns ONE jsonb cell)
select jsonb_build_object(
  'epic_17_2_0_part_3', 'verified',
  'judge_login_exists', to_regprocedure('public.judge_login(text, text, text, text)') is not null,
  'has_empty_org_and_judge_check',
    position('clean_org_id = ''''' in coalesce(pg_get_functiondef(to_regprocedure('public.judge_login(text, text, text, text)')), '')) > 0
    and position('clean_judge_id = ''''' in coalesce(pg_get_functiondef(to_regprocedure('public.judge_login(text, text, text, text)')), '')) > 0,
  'has_default_0000_pin_rejection',
    position('clean_pin = ''0000''' in coalesce(pg_get_functiondef(to_regprocedure('public.judge_login(text, text, text, text)')), '')) > 0
);
