-- ============================================================================
-- Fair Judge 17.5.0 — Phase 2: Projector Ranking Fix (Server SQL)
-- ============================================================================
-- Run in Supabase SQL Editor. Idempotent; safe to re-run.
-- Structured as independent labelled parts, each ending with a read-only
-- verification query returning a single jsonb cell.
--
-- Hard privacy guarantees preserved:
--   * Never returns participant mobile_number.
--   * Never returns judge pin, judge_pin, or current_session_token.
--   * When projector_blind_mode is true, strips total_score & score_payload
--     completely and returns only server-computed blind_ranks.
-- ============================================================================

-- ============================================================================
-- PART 1: Replace public.projector_snapshot(text)
--   1) Filter active judges and active participants (coalesce(is_active, true) = true).
--   2) Deduplicate scores to latest row per (event_id, participant_id, judge_id)
--      by (created_at desc, id desc), scoped to active participants, active judges,
--      and event-assigned participants.
--   3) Compute blind_ranks with standard competition ranking:
--        rank() over (partition by pp.event_id order by pp.avg_val desc)
--      (removes both row_number() and participant_id tie-breaking so unresolved
--       ties always share a rank, e.g. 1, 2, 2, 4, matching client tieBreakerEngine).
--   4) Exclude absent (0-ballot) participants from blind_ranks via having count(*) > 0.
-- ============================================================================

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

  -- Safe Active Judge fields only (NO pin, NO session token)
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
    and coalesce(j.is_active, true) = true
    and (
      v_pairing.event_id is null
      or (
        v_scoped_event.id is not null and (
          j.id::text = any(coalesce(v_scoped_event.assigned_judges, '{}'::text[]))
          or v_pairing.event_id = any(coalesce(j.assigned_events, '{}'::text[]))
        )
      )
    );

  -- Safe Active Participant fields only (NO phone number)
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
    and coalesce(p.is_active, true) = true
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
    -- Server-enforced Score Secrecy: deduplicated latest scores per (event, participant, judge)
    -- with total_score & score_payload completely stripped
    with dedup_scores as (
      select distinct on (s.event_id, s.participant_id, s.judge_id)
        s.id,
        s.event_id,
        s.judge_id,
        s.participant_id,
        s.total_score,
        s.created_at
      from public.scores s
      join public.events e on e.id = s.event_id
      join public.participants p on p.id = s.participant_id
      join public.judges j on j.id = s.judge_id
      where upper(e.org_id) = upper(v_pairing.org_id)
        and upper(p.org_id) = upper(v_pairing.org_id)
        and upper(j.org_id) = upper(v_pairing.org_id)
        and coalesce(e.is_archived, false) = false
        and lower(coalesce(e.status, '')) <> 'archived'
        and coalesce(p.is_active, true) = true
        and coalesce(j.is_active, true) = true
        and (
          cardinality(coalesce(e.assigned_participants, '{}'::text[])) = 0
          or p.id::text = any(e.assigned_participants)
        )
        and (v_pairing.event_id is null or e.id::text = v_pairing.event_id)
      order by s.event_id, s.participant_id, s.judge_id, s.created_at desc, s.id desc
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', ds.id,
          'event_id', ds.event_id,
          'judge_id', ds.judge_id,
          'participant_id', ds.participant_id,
          'created_at', ds.created_at
        )
        order by ds.created_at asc
      ),
      '[]'::jsonb
    ) into v_scores
    from dedup_scores ds;

    -- Server-computed relative ranks without any numeric point values.
    -- Matches client tieBreakerEngine: active participants, deduplicated latest scores,
    -- absentees excluded, and standard competition ranking (1, 2, 2, 4) for unresolved ties.
    with dedup_scores as (
      select distinct on (s.event_id, s.participant_id, s.judge_id)
        s.event_id,
        s.judge_id,
        s.participant_id,
        s.total_score,
        s.created_at
      from public.scores s
      join public.events e on e.id = s.event_id
      join public.participants p on p.id = s.participant_id
      join public.judges j on j.id = s.judge_id
      where upper(e.org_id) = upper(v_pairing.org_id)
        and upper(p.org_id) = upper(v_pairing.org_id)
        and upper(j.org_id) = upper(v_pairing.org_id)
        and coalesce(e.is_archived, false) = false
        and lower(coalesce(e.status, '')) <> 'archived'
        and coalesce(p.is_active, true) = true
        and coalesce(j.is_active, true) = true
        and s.total_score is not null
        and (
          cardinality(coalesce(e.assigned_participants, '{}'::text[])) = 0
          or p.id::text = any(e.assigned_participants)
        )
        and (v_pairing.event_id is null or e.id::text = v_pairing.event_id)
      order by s.event_id, s.participant_id, s.judge_id, s.created_at desc, s.id desc
    ),
    per_participant as (
      select
        ds.event_id,
        ds.participant_id,
        count(*)::int as judge_count,
        case
          when v_tie_enabled and v_tie_method = 'olympic' and count(*) >= 3 then
            round(((sum(ds.total_score) - max(ds.total_score) - min(ds.total_score))::numeric / (count(*) - 2)), 2)
          when v_tie_enabled and v_tie_method = 'manual' then
            round(avg(ds.total_score)::numeric, 4)
          else
            round(avg(ds.total_score)::numeric, 2)
        end as avg_val
      from dedup_scores ds
      group by ds.event_id, ds.participant_id
      having count(*) > 0
    ),
    ranked as (
      select
        pp.event_id,
        pp.participant_id,
        pp.judge_count,
        rank() over (partition by pp.event_id order by pp.avg_val desc) as computed_rank
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
        order by r.event_id, r.computed_rank asc, r.participant_id asc
      ),
      '[]'::jsonb
    ) into v_blind_ranks
    from ranked r;
  else
    with dedup_scores as (
      select distinct on (s.event_id, s.participant_id, s.judge_id)
        s.id,
        s.event_id,
        s.judge_id,
        s.participant_id,
        s.score_payload,
        s.total_score,
        s.created_at
      from public.scores s
      join public.events e on e.id = s.event_id
      join public.participants p on p.id = s.participant_id
      join public.judges j on j.id = s.judge_id
      where upper(e.org_id) = upper(v_pairing.org_id)
        and upper(p.org_id) = upper(v_pairing.org_id)
        and upper(j.org_id) = upper(v_pairing.org_id)
        and coalesce(e.is_archived, false) = false
        and lower(coalesce(e.status, '')) <> 'archived'
        and coalesce(p.is_active, true) = true
        and coalesce(j.is_active, true) = true
        and (
          cardinality(coalesce(e.assigned_participants, '{}'::text[])) = 0
          or p.id::text = any(e.assigned_participants)
        )
        and (v_pairing.event_id is null or e.id::text = v_pairing.event_id)
      order by s.event_id, s.participant_id, s.judge_id, s.created_at desc, s.id desc
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', ds.id,
          'event_id', ds.event_id,
          'judge_id', ds.judge_id,
          'participant_id', ds.participant_id,
          'score_payload', ds.score_payload,
          'total_score', ds.total_score,
          'created_at', ds.created_at
        )
        order by ds.created_at asc
      ),
      '[]'::jsonb
    ) into v_scores
    from dedup_scores ds;
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

-- Read-only verification for PART 1 (returns 1 jsonb cell)
with fn as (
  select
    p.proname,
    p.prosecdef,
    coalesce(array_to_string(p.proconfig, ','), '') as cfg,
    lower(p.prosrc) as src
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'projector_snapshot'
  limit 1
)
select jsonb_build_object(
  'part', '17.5.0_part1_projector_snapshot',
  'function_exists', exists(select 1 from fn),
  'security_definer', coalesce((select prosecdef from fn), false),
  'has_search_path', coalesce((select cfg like '%search_path=public%' from fn), false),
  'filters_active_participants', coalesce((select src like '%coalesce(p.is_active, true) = true%' from fn), false),
  'filters_active_judges', coalesce((select src like '%coalesce(j.is_active, true) = true%' from fn), false),
  'deduplicates_latest_scores', coalesce((select src like '%distinct on (s.event_id, s.participant_id, s.judge_id)%' from fn), false),
  'uses_shared_competition_rank', coalesce((select src like '%rank() over (partition by pp.event_id order by pp.avg_val desc)%' from fn), false),
  'no_row_number_tiebreak', coalesce((select src not like '%row_number(%' from fn), false),
  'no_participant_id_in_rank_order', coalesce((select src not like '%order by pp.avg_val desc, pp.participant_id%' from fn), false),
  'zero_pii_or_token_fields', coalesce((
    select src not like '%mobile_number%'
       and src not like '%judge_pin%'
       and src not like '%current_session_token%'
    from fn
  ), false),
  'status', case
    when exists(select 1 from fn)
      and coalesce((select prosecdef from fn), false)
      and coalesce((select cfg like '%search_path=public%' from fn), false)
      and coalesce((select src like '%coalesce(p.is_active, true) = true%' from fn), false)
      and coalesce((select src like '%coalesce(j.is_active, true) = true%' from fn), false)
      and coalesce((select src like '%distinct on (s.event_id, s.participant_id, s.judge_id)%' from fn), false)
      and coalesce((select src like '%rank() over (partition by pp.event_id order by pp.avg_val desc)%' from fn), false)
      and coalesce((select src not like '%row_number(%' from fn), false)
      and coalesce((select src not like '%order by pp.avg_val desc, pp.participant_id%' from fn), false)
      and coalesce((
        select src not like '%mobile_number%'
           and src not like '%judge_pin%'
           and src not like '%current_session_token%'
        from fn
      ), false)
    then 'verified'
    else 'check_failed'
  end
) as verify_part_1;
