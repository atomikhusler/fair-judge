-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 17.7.0 — PART 3b: PUBLISH, REOPEN, LISTS & org_reset_all EXTENSION
-- (WRITE ONLY — DO NOT AUTO-RUN)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Run sql/17.7.0-tie-management-patch-3a.sql BEFORE running the final check
-- query at the end of this file.
-- Each section has its own labelled header and single-cell read-only check.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ===============================================================================
-- PART 3b.1: public.tie_round_publish
--   Closed-only gate (round_not_closed), stale guard (stale_round_present),
--   server-side final ranking (grade sum desc, sealed countback, shared place),
--   one publish_recompete audit row, and conditional event close when
--   p_close_event = true only if remaining_groups is empty and no open/closed
--   rounds remain.
-- ===============================================================================

create or replace function public.tie_round_publish(
  p_token text,
  p_round_id uuid,
  p_close_event boolean default false,
  p_actor_label text default 'Organiser'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_event_id uuid;
  v_event public.events;
  v_round public.tie_rounds;
  v_actor text;
  v_stale_rounds jsonb;
  v_live_group record;
  v_placements jsonb;
  v_still_tied boolean := false;
  v_submitted_judges int := 0;
  v_total_grades int := 0;
  v_result jsonb;
  v_remaining_groups jsonb := '[]'::jsonb;
  v_pending_rounds int := 0;
  v_event_closed boolean := false;
  v_elapsed int;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_actor := left(
    btrim(
      regexp_replace(
        replace(replace(regexp_replace(coalesce(p_actor_label, ''), '<[^>]*>', '', 'g'), '<', ''), '>', ''),
        '[\r\n\t]+', ' ', 'g'
      )
    ),
    80
  );
  if v_actor = '' then
    v_actor := 'Organiser';
  end if;

  select event_id into v_event_id
  from public.tie_rounds
  where id = p_round_id
    and upper(org_id) = upper(v_org_id);

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Tie round not found or access denied.'
    );
  end if;

  -- Consistent lock ordering: parent event row FOR UPDATE first, then round row
  select * into v_event
  from public.events
  where id = v_event_id
    and upper(org_id) = upper(v_org_id)
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Event not found or access denied.'
    );
  end if;

  select * into v_round
  from public.tie_rounds
  where id = p_round_id
    and event_id = v_event.id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Tie round not found.'
    );
  end if;

  -- Closed-only publish gate: never allow open -> published
  if v_round.status <> 'closed' then
    return jsonb_build_object(
      'ok', false,
      'error', 'round_not_closed',
      'status', v_round.status,
      'message', 'A tie round must be closed before it can be published.'
    );
  end if;

  -- Stale guard: refuse publish (and close) if this round or any event round is stale
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'round_id', st.round_id,
        'group_key', st.group_key,
        'status', st.status,
        'reason', st.reason
      )
    ),
    '[]'::jsonb
  )
  into v_stale_rounds
  from public._fj_find_stale_tie_rounds(v_event.id) st;

  if jsonb_array_length(v_stale_rounds) > 0 then
    update public.tie_rounds r
    set is_stale = true,
        updated_at = now()
    where r.event_id = v_event.id
      and r.id in (select st.round_id from public._fj_find_stale_tie_rounds(v_event.id) st)
      and r.is_stale = false;

    return jsonb_build_object(
      'ok', false,
      'error', 'stale_round_present',
      'message', 'A tie round is stale because sealed scores changed. Close it as stale first.',
      'stale_rounds', v_stale_rounds
    );
  end if;

  -- Verify live tie group from server-side sealed scores
  select * into v_live_group
  from public._fj_detect_event_tie_groups(v_event.id)
  where group_key = v_round.group_key
  limit 1;

  if not found then
    update public.tie_rounds
    set is_stale = true,
        updated_at = now()
    where id = v_round.id;

    return jsonb_build_object(
      'ok', false,
      'error', 'stale_round_present',
      'round_id', v_round.id,
      'message', 'This tie no longer exists in sealed scores. Close the round as stale.'
    );
  end if;

  -- Aggregate active-judge submissions (no judge identifiers, PINs, or per-judge ballots exposed)
  select
    count(distinct g.judge_id)::int,
    count(g.id)::int
  into v_submitted_judges, v_total_grades
  from public.tie_round_grades g
  join public.judges j
    on j.id = g.judge_id
   and upper(j.org_id) = upper(v_event.org_id)
   and coalesce(j.is_active, true) = true
  where g.round_id = v_round.id;

  -- Final ranking strictly on server: grade sum desc -> sealed countback -> shared place
  with sealed_members as (
    select
      (m->>'participant_id') as participant_id,
      (m->>'avg_score')::numeric as base_avg,
      array(
        select (x)::numeric
        from jsonb_array_elements_text(m->'scores_desc') as x
      ) as scores_desc
    from jsonb_array_elements(v_live_group.member_scores) as m
  ),
  grade_totals as (
    select
      pid_txt as participant_id,
      coalesce(sum(g.grade), 0)::int as grade_sum,
      count(g.id)::int as grade_count
    from unnest(v_round.tied_participant_ids) as pid_txt
    left join public.tie_round_grades g
      on g.round_id = v_round.id
     and g.participant_id::text = pid_txt
     and exists (
       select 1
       from public.judges j
       where j.id = g.judge_id
         and upper(j.org_id) = upper(v_event.org_id)
         and coalesce(j.is_active, true) = true
     )
    group by pid_txt
  ),
  combined as (
    select
      gt.participant_id,
      gt.grade_sum,
      gt.grade_count,
      coalesce(sm.base_avg, v_live_group.tied_avg) as base_avg,
      coalesce(sm.scores_desc, '{}'::numeric[]) as scores_desc
    from grade_totals gt
    left join sealed_members sm on sm.participant_id = gt.participant_id
  ),
  ranked as (
    select
      c.*,
      (
        v_round.tied_rank - 1
        + rank() over (order by c.grade_sum desc, c.scores_desc desc)::int
      ) as after_rank
    from combined c
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'participant_id', r.participant_id,
          'before_rank', v_round.tied_rank,
          'after_rank', r.after_rank,
          'base_avg', r.base_avg,
          'grade_sum', r.grade_sum,
          'grade_count', r.grade_count,
          'scores_desc', to_jsonb(r.scores_desc)
        )
        order by r.after_rank asc, r.participant_id asc
      ),
      '[]'::jsonb
    ),
    exists (
      select 1
      from ranked r2
      group by r2.after_rank
      having count(*) >= 2
    )
  into v_placements, v_still_tied
  from ranked r;

  v_result := jsonb_build_object(
    'rule', 'recompete',
    'tied_rank', v_round.tied_rank,
    'score_fingerprint', v_live_group.score_fingerprint,
    'submitted_judge_count', v_submitted_judges,
    'total_grades', v_total_grades,
    'resolved', not v_still_tied,
    'still_tied', v_still_tied,
    'placements', v_placements
  );

  update public.tie_rounds
  set
    status = 'published',
    is_stale = false,
    score_fingerprint = v_live_group.score_fingerprint,
    result_payload = v_result,
    published_at = now(),
    updated_at = now()
  where id = v_round.id
  returning * into v_round;

  -- Append exactly one immutable audit row
  insert into public.tie_audit_log (
    org_id,
    event_id,
    event_name,
    round_id,
    group_key,
    action,
    rule,
    actor_label,
    preview_json,
    result_json,
    outcome,
    reason
  )
  values (
    v_event.org_id,
    v_event.id,
    v_event.name,
    v_round.id,
    v_round.group_key,
    'publish_recompete',
    'recompete',
    v_actor,
    v_round.preview_payload,
    v_result,
    case when v_still_tied then 'published_with_shared' else 'published_resolved' end,
    ''
  );

  -- Compute remaining unresolved tied groups and any open/closed rounds on this event
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'group_key', g.group_key,
        'tied_rank', g.tied_rank,
        'tied_participant_ids', to_jsonb(g.tied_participant_ids)
      )
      order by g.tied_rank asc
    ),
    '[]'::jsonb
  )
  into v_remaining_groups
  from public._fj_detect_event_tie_groups(v_event.id) g
  where not exists (
    select 1
    from public.tie_rounds r
    where r.event_id = v_event.id
      and r.group_key = g.group_key
      and r.status = 'published'
      and coalesce(r.is_stale, false) = false
      and coalesce(r.score_fingerprint, '') = coalesce(g.score_fingerprint, '')
  );

  select count(*)::int
  into v_pending_rounds
  from public.tie_rounds
  where event_id = v_event.id
    and status in ('open', 'closed');

  -- Close event ONLY when p_close_event = true AND zero unresolved ties AND zero pending rounds remain
  if coalesce(p_close_event, false) = true
     and jsonb_array_length(v_remaining_groups) = 0
     and v_pending_rounds = 0 then
    if lower(coalesce(v_event.status, '')) not in ('ended', 'archived') then
      v_elapsed := coalesce(v_event.elapsed_seconds, 0)
        + case
            when v_event.started_at is not null then
              greatest(0, floor(extract(epoch from (now() - v_event.started_at)))::int)
            else 0
          end;

      update public.events
      set
        status = 'ended',
        elapsed_seconds = v_elapsed,
        started_at = null,
        updated_at = now()
      where id = v_event.id
      returning * into v_event;
    end if;
    v_event_closed := true;
  end if;

  return jsonb_build_object(
    'ok', true,
    'round', to_jsonb(v_round),
    'event_closed', v_event_closed,
    'remaining_groups', v_remaining_groups,
    'pending_round_count', v_pending_rounds
  );
end;
$$;

revoke all on function public.tie_round_publish(text, uuid, boolean, text) from public;
grant execute on function public.tie_round_publish(text, uuid, boolean, text) to anon, authenticated;

-- PART 3b.1 VERIFICATION (read-only, returns ONE jsonb cell)
with fn as (
  select p.oid, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def, pg_get_function_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tie_round_publish'
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_3b_1',
  'exists', exists (select 1 from fn),
  'security_definer', coalesce((select prosecdef from fn limit 1), false),
  'closed_only_gate', exists (select 1 from fn where position('round_not_closed' in def) > 0),
  'stale_guard', exists (select 1 from fn where position('stale_round_present' in def) > 0),
  'granted_to_anon', coalesce((select has_function_privilege('anon', oid, 'execute') from fn limit 1), false),
  'granted_to_authenticated', coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn limit 1), false),
  'revoked_from_public', exists (
    select 1 from fn
    where proacl is not null
      and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
  ),
  'zero_p_groups', not exists (select 1 from fn where position('p_groups' in lower(coalesce(args, ''))) > 0)
) as verify_17_7_0_part_3b_1;


-- ===============================================================================
-- PART 3b.2: public.tie_round_reopen
--   Reason trimmed and 3..300 chars after cleanup (else invalid_reason),
--   FOR UPDATE on events, participant overlap check (participant_in_open_round),
--   published/closed -> open, reopen_count + 1, last_reopen_reason saved,
--   one reopen_recompete audit row.
-- ===============================================================================

create or replace function public.tie_round_reopen(
  p_token text,
  p_round_id uuid,
  p_reason text,
  p_actor_label text default 'Organiser'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_event_id uuid;
  v_event public.events;
  v_round public.tie_rounds;
  v_prev_status text;
  v_clean_reason text;
  v_actor text;
  v_live_group record;
  v_conflict_round_id uuid;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  -- Clean up and validate reason length (3 to 300 characters)
  v_clean_reason := btrim(
    regexp_replace(
      replace(replace(regexp_replace(coalesce(p_reason, ''), '<[^>]*>', '', 'g'), '<', ''), '>', ''),
      '[\r\n\t]+', ' ', 'g'
    )
  );
  if char_length(v_clean_reason) < 3 or char_length(v_clean_reason) > 300 then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_reason',
      'message', 'Reopen reason must be between 3 and 300 characters.'
    );
  end if;

  v_actor := left(
    btrim(
      regexp_replace(
        replace(replace(regexp_replace(coalesce(p_actor_label, ''), '<[^>]*>', '', 'g'), '<', ''), '>', ''),
        '[\r\n\t]+', ' ', 'g'
      )
    ),
    80
  );
  if v_actor = '' then
    v_actor := 'Organiser';
  end if;

  select event_id into v_event_id
  from public.tie_rounds
  where id = p_round_id
    and upper(org_id) = upper(v_org_id);

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Tie round not found or access denied.'
    );
  end if;

  -- Consistent lock ordering: parent event row FOR UPDATE first, then round row
  select * into v_event
  from public.events
  where id = v_event_id
    and upper(org_id) = upper(v_org_id)
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Event not found or access denied.'
    );
  end if;

  if coalesce(v_event.is_archived, false) = true
     or lower(coalesce(v_event.status, '')) in ('ended', 'archived') then
    return jsonb_build_object(
      'ok', false,
      'error', 'event_ended',
      'message', 'Cannot reopen a tie round on an ended or archived event.'
    );
  end if;

  select * into v_round
  from public.tie_rounds
  where id = p_round_id
    and event_id = v_event.id
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Tie round not found.'
    );
  end if;

  if v_round.rule <> 'recompete' then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_state',
      'message', 'Only re-compete tie rounds can be reopened.'
    );
  end if;

  if v_round.status not in ('closed', 'published') then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_state',
      'status', v_round.status,
      'message', 'Only a closed or published tie round can be reopened.'
    );
  end if;

  -- Verify tie still matches live sealed scores before reopening
  select * into v_live_group
  from public._fj_detect_event_tie_groups(v_event.id)
  where group_key = v_round.group_key
  limit 1;

  if not found
     or coalesce(v_round.is_stale, false) = true
     or coalesce(v_round.score_fingerprint, '') <> coalesce(v_live_group.score_fingerprint, '') then
    update public.tie_rounds
    set is_stale = true,
        updated_at = now()
    where id = v_round.id;

    return jsonb_build_object(
      'ok', false,
      'error', 'stale_round_present',
      'round_id', v_round.id,
      'message', 'Sealed scores changed since this round ran. Close it as stale instead.'
    );
  end if;

  -- Overlap check: at most one open round per participant per event
  select r.id into v_conflict_round_id
  from public.tie_rounds r
  where r.event_id = v_event.id
    and r.id <> v_round.id
    and r.status = 'open'
    and r.tied_participant_ids && v_round.tied_participant_ids
  limit 1;

  if v_conflict_round_id is not null then
    return jsonb_build_object(
      'ok', false,
      'error', 'participant_in_open_round',
      'conflict_round_id', v_conflict_round_id,
      'message', 'A participant in this group is already in another open tie round.'
    );
  end if;

  v_prev_status := v_round.status;

  update public.tie_rounds
  set
    status = 'open',
    is_stale = false,
    reopen_count = coalesce(reopen_count, 0) + 1,
    last_reopen_reason = v_clean_reason,
    closed_at = null,
    published_at = null,
    updated_at = now()
  where id = v_round.id
  returning * into v_round;

  -- Append exactly one immutable audit row
  insert into public.tie_audit_log (
    org_id,
    event_id,
    event_name,
    round_id,
    group_key,
    action,
    rule,
    actor_label,
    preview_json,
    result_json,
    outcome,
    reason
  )
  values (
    v_event.org_id,
    v_event.id,
    v_event.name,
    v_round.id,
    v_round.group_key,
    'reopen_recompete',
    'recompete',
    v_actor,
    v_round.preview_payload,
    jsonb_build_object(
      'round_id', v_round.id,
      'previous_status', v_prev_status,
      'new_status', 'open',
      'reopen_count', v_round.reopen_count
    ),
    'round_reopened',
    v_clean_reason
  );

  return jsonb_build_object(
    'ok', true,
    'round', to_jsonb(v_round)
  );
end;
$$;

revoke all on function public.tie_round_reopen(text, uuid, text, text) from public;
grant execute on function public.tie_round_reopen(text, uuid, text, text) to anon, authenticated;

-- PART 3b.2 VERIFICATION (read-only, returns ONE jsonb cell)
with fn as (
  select p.oid, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def, pg_get_function_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tie_round_reopen'
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_3b_2',
  'exists', exists (select 1 from fn),
  'security_definer', coalesce((select prosecdef from fn limit 1), false),
  'has_invalid_reason_guard', exists (select 1 from fn where position('invalid_reason' in def) > 0),
  'has_overlap_guard', exists (select 1 from fn where position('participant_in_open_round' in def) > 0),
  'granted_to_anon', coalesce((select has_function_privilege('anon', oid, 'execute') from fn limit 1), false),
  'granted_to_authenticated', coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn limit 1), false),
  'revoked_from_public', exists (
    select 1 from fn
    where proacl is not null
      and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
  ),
  'zero_p_groups', not exists (select 1 from fn where position('p_groups' in lower(coalesce(args, ''))) > 0)
) as verify_17_7_0_part_3b_2;


-- ===============================================================================
-- PART 3b.3: public.tie_rounds_list_organiser
--   Organiser-only read RPC returning allowlisted tie_rounds rows plus aggregate
--   submission counts and server-detected live tie groups / stale flags.
--   Zero PINs, tokens, phones, or per-judge grade details exposed.
-- ===============================================================================

create or replace function public.tie_rounds_list_organiser(
  p_token text,
  p_event_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_rounds jsonb := '[]'::jsonb;
  v_live_groups jsonb := '[]'::jsonb;
  v_stale_rounds jsonb := '[]'::jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  if p_event_id is not null then
    if not exists (
      select 1
      from public.events e
      where e.id = p_event_id
        and upper(e.org_id) = upper(v_org_id)
    ) then
      return jsonb_build_object(
        'ok', false,
        'error', 'not_found',
        'message', 'Event not found or access denied.'
      );
    end if;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'group_key', g.group_key,
          'tied_rank', g.tied_rank,
          'tied_avg', g.tied_avg,
          'tied_participant_ids', to_jsonb(g.tied_participant_ids),
          'score_fingerprint', g.score_fingerprint
        )
        order by g.tied_rank asc
      ),
      '[]'::jsonb
    )
    into v_live_groups
    from public._fj_detect_event_tie_groups(p_event_id) g;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'round_id', st.round_id,
          'group_key', st.group_key,
          'status', st.status,
          'reason', st.reason
        )
      ),
      '[]'::jsonb
    )
    into v_stale_rounds
    from public._fj_find_stale_tie_rounds(p_event_id) st;
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'org_id', r.org_id,
        'event_id', r.event_id,
        'group_key', r.group_key,
        'tied_rank', r.tied_rank,
        'tied_participant_ids', to_jsonb(r.tied_participant_ids),
        'rule', r.rule,
        'status', r.status,
        'is_stale', (
          r.is_stale
          or (
            r.status in ('open', 'closed')
            and exists (
              select 1
              from public._fj_find_stale_tie_rounds(r.event_id) st
              where st.round_id = r.id
            )
          )
        ),
        'score_fingerprint', r.score_fingerprint,
        'preview_payload', r.preview_payload,
        'result_payload', r.result_payload,
        'reopen_count', r.reopen_count,
        'last_reopen_reason', r.last_reopen_reason,
        'opened_at', r.opened_at,
        'closed_at', r.closed_at,
        'published_at', r.published_at,
        'version', r.version,
        'updated_at', r.updated_at,
        'submitted_judge_count', (
          select count(distinct g.judge_id)::int
          from public.tie_round_grades g
          join public.judges j
            on j.id = g.judge_id
           and upper(j.org_id) = upper(r.org_id)
           and coalesce(j.is_active, true) = true
          where g.round_id = r.id
        ),
        'completed_judge_count', (
          select count(*)::int
          from (
            select g.judge_id
            from public.tie_round_grades g
            join public.judges j
              on j.id = g.judge_id
             and upper(j.org_id) = upper(r.org_id)
             and coalesce(j.is_active, true) = true
            where g.round_id = r.id
              and g.participant_id::text = any(r.tied_participant_ids)
            group by g.judge_id
            having count(distinct g.participant_id) >= greatest(1, cardinality(r.tied_participant_ids))
          ) cj
        ),
        'expected_judge_count', (
          select count(*)::int
          from public.judges j
          join public.events e on e.id = r.event_id
          where upper(j.org_id) = upper(r.org_id)
            and coalesce(j.is_active, true) = true
            and (
              cardinality(coalesce(e.assigned_judges, '{}'::text[])) = 0
              or j.id::text = any(coalesce(e.assigned_judges, '{}'::text[]))
              or e.id::text = any(coalesce(j.assigned_events, '{}'::text[]))
            )
        )
      )
      order by r.opened_at desc, r.id desc
    ),
    '[]'::jsonb
  )
  into v_rounds
  from public.tie_rounds r
  where upper(r.org_id) = upper(v_org_id)
    and (p_event_id is null or r.event_id = p_event_id);

  return jsonb_build_object(
    'ok', true,
    'rounds', v_rounds,
    'live_tie_groups', v_live_groups,
    'stale_rounds', v_stale_rounds
  );
end;
$$;

revoke all on function public.tie_rounds_list_organiser(text, uuid) from public;
grant execute on function public.tie_rounds_list_organiser(text, uuid) to anon, authenticated;

-- PART 3b.3 VERIFICATION (read-only, returns ONE jsonb cell)
with fn as (
  select p.oid, p.prosecdef, p.proacl, pg_get_function_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tie_rounds_list_organiser'
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_3b_3',
  'exists', exists (select 1 from fn),
  'security_definer', coalesce((select prosecdef from fn limit 1), false),
  'granted_to_anon', coalesce((select has_function_privilege('anon', oid, 'execute') from fn limit 1), false),
  'granted_to_authenticated', coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn limit 1), false),
  'revoked_from_public', exists (
    select 1 from fn
    where proacl is not null
      and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
  ),
  'zero_p_groups', not exists (select 1 from fn where position('p_groups' in lower(coalesce(args, ''))) > 0)
) as verify_17_7_0_part_3b_3;


-- ===============================================================================
-- PART 3b.4: public.tie_audit_list
--   Organiser-only read-only list of immutable tie_audit_log rows.
-- ===============================================================================

create or replace function public.tie_audit_list(
  p_token text,
  p_event_id uuid default null,
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_limit int;
  v_rows jsonb := '[]'::jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_limit := greatest(1, least(1000, coalesce(p_limit, 500)));

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'org_id', a.org_id,
        'event_id', a.event_id,
        'event_name', a.event_name,
        'round_id', a.round_id,
        'group_key', a.group_key,
        'action', a.action,
        'rule', a.rule,
        'actor_label', a.actor_label,
        'preview_json', a.preview_json,
        'result_json', a.result_json,
        'outcome', a.outcome,
        'reason', a.reason,
        'created_at', a.created_at
      )
      order by a.created_at desc, a.id desc
    ),
    '[]'::jsonb
  )
  into v_rows
  from (
    select *
    from public.tie_audit_log
    where upper(org_id) = upper(v_org_id)
      and (p_event_id is null or event_id = p_event_id)
    order by created_at desc, id desc
    limit v_limit
  ) a;

  return jsonb_build_object(
    'ok', true,
    'entries', v_rows
  );
end;
$$;

revoke all on function public.tie_audit_list(text, uuid, integer) from public;
grant execute on function public.tie_audit_list(text, uuid, integer) to anon, authenticated;

-- PART 3b.4 VERIFICATION (read-only, returns ONE jsonb cell)
with fn as (
  select p.oid, p.prosecdef, p.proacl, pg_get_function_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tie_audit_list'
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_3b_4',
  'exists', exists (select 1 from fn),
  'security_definer', coalesce((select prosecdef from fn limit 1), false),
  'granted_to_anon', coalesce((select has_function_privilege('anon', oid, 'execute') from fn limit 1), false),
  'granted_to_authenticated', coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn limit 1), false),
  'revoked_from_public', exists (
    select 1 from fn
    where proacl is not null
      and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
  ),
  'zero_p_groups', not exists (select 1 from fn where position('p_groups' in lower(coalesce(args, ''))) > 0)
) as verify_17_7_0_part_3b_4;


-- ===============================================================================
-- PART 3b.5: public.org_reset_all (extended from sql/16.3.1-fix-reset-restore-locks.sql)
--   Keeps every existing check, unlock, deletion, and response key.
--   Adds cleanup of tie_round_grades and tie_rounds for the org.
--   Preserves append-only tie audit history intact.
-- ===============================================================================

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
  c_tie_rounds int := 0;
  c_tie_round_grades int := 0;
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

  select count(*)::int into c_tie_round_grades
  from public.tie_round_grades trg
  where upper(trg.org_id) = upper(v_org_id)
     or trg.event_id in (select id from public.events where upper(org_id) = upper(v_org_id));

  select count(*)::int into c_tie_rounds
  from public.tie_rounds tr
  where upper(tr.org_id) = upper(v_org_id)
     or tr.event_id in (select id from public.events where upper(org_id) = upper(v_org_id));

  -- 4. Unlock all locked events for this org BEFORE any DELETE so judge/participant delete triggers pass cleanly
  update public.events
  set is_locked = false
  where upper(org_id) = upper(v_org_id)
    and is_locked = true;

  -- 5. Atomic wipe in required order: tie_round_grades -> tie_rounds -> scores -> judge_sessions -> judge_secrets -> judges -> participants -> events
  --    Append-only tie audit history is intentionally preserved.
  delete from public.tie_round_grades
  where upper(org_id) = upper(v_org_id)
     or event_id in (select id from public.events where upper(org_id) = upper(v_org_id));

  delete from public.tie_rounds
  where upper(org_id) = upper(v_org_id)
     or event_id in (select id from public.events where upper(org_id) = upper(v_org_id));

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
      'tie_rounds', c_tie_rounds,
      'tie_round_grades', c_tie_round_grades,
      'sync_version', v_sync_version
    ),
    'events', c_events,
    'locked_events', c_locked_events,
    'judges', c_judges,
    'participants', c_participants,
    'scores', c_scores,
    'judge_sessions', c_judge_sessions,
    'tie_rounds', c_tie_rounds,
    'tie_round_grades', c_tie_round_grades,
    'sync_version', v_sync_version
  );
end;
$$;

revoke all on function public.org_reset_all(text, text, text) from public;
grant execute on function public.org_reset_all(text, text, text) to anon, authenticated;

-- PART 3b.5 VERIFICATION (read-only, returns ONE jsonb cell)
with fn as (
  select p.oid, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'org_reset_all'
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_3b_5',
  'exists', exists (select 1 from fn),
  'security_definer', coalesce((select prosecdef from fn limit 1), false),
  'deletes_tie_round_grades', exists (select 1 from fn where position('delete from public.tie_round_grades' in lower(def)) > 0),
  'deletes_tie_rounds', exists (select 1 from fn where position('delete from public.tie_rounds' in lower(def)) > 0),
  'never_deletes_tie_audit_log', not exists (select 1 from fn where position('delete from public.tie_audit_log' in lower(def)) > 0),
  'granted_to_anon', coalesce((select has_function_privilege('anon', oid, 'execute') from fn limit 1), false),
  'granted_to_authenticated', coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn limit 1), false),
  'revoked_from_public', exists (
    select 1 from fn
    where proacl is not null
      and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
  )
) as verify_17_7_0_part_3b_5;


-- ===============================================================================
-- COMBINED FINAL VERIFICATION FOR PATCH 3a + PART 3b (read-only, ONE jsonb cell)
-- ===============================================================================

with part3b_rpcs as (
  select
    p.oid,
    p.proname,
    p.prosecdef,
    p.proacl,
    pg_get_function_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'tie_round_publish',
      'tie_round_reopen',
      'tie_rounds_list_organiser',
      'tie_audit_list'
    )
),
patch_apply as (
  select pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tie_round_apply_auto'
),
patch_shared as (
  select pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tie_event_close_shared'
),
reset_fn as (
  select p.oid, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'org_reset_all'
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_3b_all',
  'part3b_rpc_count', (select count(*)::int from part3b_rpcs),
  'all_four_exist', ((select count(distinct proname)::int from part3b_rpcs) = 4),
  'all_four_security_definer', ((select count(*)::int from part3b_rpcs where prosecdef = true) = 4),
  'all_four_granted_to_anon', ((select count(*)::int from part3b_rpcs where has_function_privilege('anon', oid, 'execute')) = 4),
  'all_four_granted_to_authenticated', ((select count(*)::int from part3b_rpcs where has_function_privilege('authenticated', oid, 'execute')) = 4),
  'all_four_revoked_from_public', (
    (
      select count(*)::int
      from part3b_rpcs
      where proacl is not null
        and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
    ) = 4
  ),
  'all_four_zero_p_groups', (
    (
      select count(*)::int
      from part3b_rpcs
      where position('p_groups' in lower(coalesce(args, ''))) > 0
    ) = 0
  ),
  'patch_3a_event_ended_present', exists (
    select 1 from patch_apply where position('event_ended' in def) > 0
  ),
  'patch_3a_event_already_ended_present', exists (
    select 1 from patch_shared where position('event_already_ended' in def) > 0
  ),
  'org_reset_all_security_definer', coalesce((select prosecdef from reset_fn limit 1), false),
  'org_reset_all_grants_valid', (
    coalesce((select has_function_privilege('anon', oid, 'execute') from reset_fn limit 1), false)
    and coalesce((select has_function_privilege('authenticated', oid, 'execute') from reset_fn limit 1), false)
    and exists (
      select 1 from reset_fn
      where proacl is not null
        and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
    )
  ),
  'org_reset_all_deletes_tie_tables', (
    exists (select 1 from reset_fn where position('delete from public.tie_round_grades' in lower(def)) > 0)
    and exists (select 1 from reset_fn where position('delete from public.tie_rounds' in lower(def)) > 0)
  ),
  'org_reset_all_no_tie_audit_delete', (
    not exists (select 1 from reset_fn where position('delete from public.tie_audit_log' in lower(def)) > 0)
  ),
  'rpcs', (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'name', proname,
          'security_definer', prosecdef,
          'args', args
        )
        order by proname
      ),
      '[]'::jsonb
    )
    from part3b_rpcs
  )
) as verify_17_7_0_part_3b_all;
