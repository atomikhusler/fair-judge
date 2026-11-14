-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.12.1 — PROJECTOR CONTROLS & SERVER-ENFORCED BLIND MODE
-- ═══════════════════════════════════════════════════════════════════
-- Rules respected:
--   - Does NOT modify pairing flow, RLS policies, or table grants.
--   - Enforces Score Secrecy (blind mode) on the server in projector_snapshot.
--   - Adds per-screen blank state, rename/event update RPC, and org broadcast settings.
--   - Deliver as SQL file only (do NOT auto-run).
-- ═══════════════════════════════════════════════════════════════════

-- 1. Organization-level broadcast control columns
alter table public.organizations
  add column if not exists projector_blind_mode boolean not null default false,
  add column if not exists projector_spotlight_mode boolean not null default true,
  add column if not exists projector_ticker_text text not null default '',
  add column if not exists projector_carousel_interval int not null default 60,
  add column if not exists projector_confetti_at timestamptz;

-- 2. Per-screen blank state column on projector_pairings (zero policy/grant changes)
alter table public.projector_pairings
  add column if not exists is_blank boolean not null default false;

-- 3. Update org_update to persist sanitized broadcast controls (same auth & grants)
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
    verification_status = case when p_updates ? 'verification_status' then coalesce(p_updates->>'verification_status', verification_status) else verification_status end,
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

-- 4. Update projector_fingerprint to reflect broadcast controls, label, event scope, and blank toggle
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
    coalesce(o.blind_judging_enabled::text, 'false') || '|' ||
    coalesce(o.projector_blind_mode::text, 'false') || '|' ||
    coalesce(o.projector_spotlight_mode::text, 'true') || '|' ||
    coalesce(o.projector_ticker_text, '') || '|' ||
    coalesce(o.projector_carousel_interval::text, '60') || '|' ||
    coalesce(o.projector_confetti_at::text, '')
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
    coalesce(v_pairing.event_id, '') || '|' ||
    coalesce(v_pairing.label, '') || '|' ||
    coalesce(v_pairing.is_blank::text, 'false')
  );

  return jsonb_build_object(
    'ok', true,
    'version', v_version,
    'org_id', v_pairing.org_id,
    'event_id', v_pairing.event_id,
    'label', v_pairing.label,
    'is_blank', coalesce(v_pairing.is_blank, false)
  );
end;
$$;

revoke all on function public.projector_fingerprint(text) from public;
grant execute on function public.projector_fingerprint(text) to anon, authenticated;

-- 5. Update projector_snapshot: enforce Score Secrecy (Blind Mode) on the server
--    When projector_blind_mode is true:
--      - scores contain ZERO point values (no total_score, no score_payload)
--      - blind_ranks returns server-computed rank + judge_count only (no averages/totals)
create or replace function public.projector_snapshot(p_view_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_pairing public.projector_pairings;
  v_org_rec public.organizations;
  v_org jsonb;
  v_events jsonb;
  v_judges jsonb;
  v_participants jsonb;
  v_scores jsonb;
  v_blind_ranks jsonb := '[]'::jsonb;
  v_scoped_event public.events;
  v_is_blind boolean := false;
  v_tie_enabled boolean := false;
  v_tie_method text := 'olympic';
begin
  v_pairing := public._fj_verify_projector_token(p_view_token);
  if v_pairing.id is null then
    return jsonb_build_object('ok', false, 'error', 'expired_or_revoked');
  end if;

  select * into v_org_rec
  from public.organizations o
  where upper(o.org_id) = upper(v_pairing.org_id)
  limit 1;

  v_is_blind := coalesce(v_org_rec.projector_blind_mode, false);
  v_tie_enabled := coalesce(v_org_rec.tie_breaker_enabled, false);
  v_tie_method := coalesce(v_org_rec.tie_breaker_method, 'olympic');

  v_org := jsonb_build_object(
    'org_id', v_org_rec.org_id,
    'name', v_org_rec.name,
    'tie_breaker_enabled', v_tie_enabled,
    'tie_breaker_method', v_tie_method,
    'blind_judging_enabled', coalesce(v_org_rec.blind_judging_enabled, false),
    'projector_blind_mode', v_is_blind,
    'projector_spotlight_mode', coalesce(v_org_rec.projector_spotlight_mode, true),
    'projector_ticker_text', left(coalesce(v_org_rec.projector_ticker_text, ''), 120),
    'projector_carousel_interval', greatest(15, least(180, coalesce(v_org_rec.projector_carousel_interval, 60))),
    'projector_confetti_at', v_org_rec.projector_confetti_at
  );

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

  if v_is_blind then
    -- Server-enforced Score Secrecy: strip total_score & score_payload completely
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'event_id', s.event_id,
          'judge_id', s.judge_id,
          'participant_id', s.participant_id,
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

    -- Server-computed relative ranks without any numeric point values
    with per_participant as (
      select
        s.event_id,
        s.participant_id,
        count(*)::int as judge_count,
        case
          when v_tie_enabled and v_tie_method = 'olympic' and count(*) >= 3 then
            round(((sum(s.total_score) - max(s.total_score) - min(s.total_score))::numeric / (count(*) - 2)), 2)
          when v_tie_enabled and v_tie_method = 'manual' then
            round(avg(s.total_score)::numeric, 4)
          else
            round(avg(s.total_score)::numeric, 2)
        end as avg_val
      from public.scores s
      join public.events e on e.id = s.event_id
      where upper(e.org_id) = upper(v_pairing.org_id)
        and coalesce(e.is_archived, false) = false
        and lower(coalesce(e.status, '')) <> 'archived'
        and (v_pairing.event_id is null or e.id::text = v_pairing.event_id)
      group by s.event_id, s.participant_id
    ),
    ranked as (
      select
        pp.event_id,
        pp.participant_id,
        pp.judge_count,
        case
          when not v_tie_enabled or v_tie_method = 'shared' then
            rank() over (partition by pp.event_id order by pp.avg_val desc, pp.participant_id asc)
          else
            row_number() over (partition by pp.event_id order by pp.avg_val desc, pp.participant_id asc)
        end as computed_rank
      from per_participant pp
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'event_id', r.event_id,
          'participant_id', r.participant_id,
          'rank', r.computed_rank,
          'judge_count', r.judge_count
        )
        order by r.event_id, r.computed_rank asc
      ),
      '[]'::jsonb
    ) into v_blind_ranks
    from ranked r;
  else
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
  end if;

  return jsonb_build_object(
    'ok', true,
    'org', v_org,
    'events', v_events,
    'judges', v_judges,
    'participants', v_participants,
    'scores', v_scores,
    'blind_ranks', v_blind_ranks,
    'scoped_event_id', v_pairing.event_id,
    'label', v_pairing.label,
    'is_blank', coalesce(v_pairing.is_blank, false)
  );
end;
$$;

revoke all on function public.projector_snapshot(text) from public;
grant execute on function public.projector_snapshot(text) to anon, authenticated;

-- 6. Update projector_list to include is_blank, 60-second online flag, and live_count
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
  v_live_count int := 0;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  update public.projector_pairings
  set status = 'expired'
  where upper(org_id) = upper(v_org_id)
    and status = 'approved'
    and coalesce(last_seen_at, approved_at, created_at) < (now() - interval '24 hours');

  select count(*)::int into v_live_count
  from public.projector_pairings p
  where upper(p.org_id) = upper(v_org_id)
    and p.status = 'approved'
    and p.last_seen_at is not null
    and p.last_seen_at >= (now() - interval '60 seconds');

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'label', coalesce(p.label, 'Projector Screen'),
        'event_id', p.event_id,
        'event_name', e.name,
        'is_blank', coalesce(p.is_blank, false),
        'is_online', (p.last_seen_at is not null and p.last_seen_at >= (now() - interval '60 seconds')),
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

  return jsonb_build_object('ok', true, 'pairings', v_list, 'live_count', v_live_count);
end;
$$;

revoke all on function public.projector_list(text, text) from public;
grant execute on function public.projector_list(text, text) to anon, authenticated;

-- 7. New RPC: projector_update (rename screen, change event scope, toggle blank screen)
create or replace function public.projector_update(
  p_token text,
  p_org_id text,
  p_pairing_id uuid,
  p_label text default null,
  p_event_id text default null,
  p_set_event boolean default false,
  p_is_blank boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_clean_event_id text;
  v_clean_label text;
  v_row public.projector_pairings;
begin
  v_org_id := public._fj_verify_org_token(p_token, p_org_id);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  if p_set_event then
    v_clean_event_id := nullif(btrim(coalesce(p_event_id, '')), '');
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
  end if;

  if p_label is not null then
    v_clean_label := regexp_replace(coalesce(p_label, ''), '<[^>]*>', '', 'g');
    v_clean_label := left(coalesce(nullif(btrim(v_clean_label), ''), 'Projector Screen'), 60);
  end if;

  update public.projector_pairings
  set
    label = case when p_label is not null then v_clean_label else label end,
    event_id = case when p_set_event then v_clean_event_id else event_id end,
    is_blank = case when p_is_blank is not null then p_is_blank else is_blank end
  where id = p_pairing_id
    and upper(org_id) = upper(v_org_id)
    and status = 'approved'
  returning * into v_row;

  if v_row.id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Paired screen not found.'
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'pairing_id', v_row.id,
    'label', coalesce(v_row.label, 'Projector Screen'),
    'event_id', v_row.event_id,
    'is_blank', coalesce(v_row.is_blank, false)
  );
end;
$$;

revoke all on function public.projector_update(text, text, uuid, text, text, boolean, boolean) from public;
grant execute on function public.projector_update(text, text, uuid, text, text, boolean, boolean) to anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════
-- READ-ONLY VERIFICATION QUERY (returns one jsonb cell)
-- ═══════════════════════════════════════════════════════════════════
select jsonb_build_object(
  'migration', '15.12.1-projector-controls',
  'org_columns', (
    select jsonb_agg(column_name order by column_name)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'organizations'
      and column_name in (
        'projector_blind_mode',
        'projector_spotlight_mode',
        'projector_ticker_text',
        'projector_carousel_interval',
        'projector_confetti_at'
      )
  ),
  'pairing_is_blank_exists', exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'projector_pairings'
      and column_name = 'is_blank'
  ),
  'projector_update_ready', exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'projector_update'
      and p.prosecdef = true
  )
) as verification_result;
