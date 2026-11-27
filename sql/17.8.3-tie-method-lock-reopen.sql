-- ===============================================================================
-- STEP 4: TIE METHOD LOCK, PER-GROUP SHARED PLACES & PUBLISHED-ONLY REOPEN
-- (WRITE ONLY — DO NOT AUTO-RUN; owner runs in Supabase SQL Editor)
-- ===============================================================================
-- Checked against existing live SQL (17.7.0 Part 2, Part 3a, Patch 3a, Part 3b,
-- 17.8.1). tie_round_reopen already exists (Part 3b) with 3-300 char reason
-- validation and immutable audit logging.
--
-- Only what was missing is patched here:
--   1. Add 'apply_shared' to public.tie_audit_log chk_tie_audit_action
--   2. public.tie_round_apply_auto: accept p_rule = 'shared' AND refuse
--      overwriting an already-published fresh round ('method_locked')
--   3. public.tie_round_open: refuse overwriting ANY already-published fresh
--      round ('method_locked')
--   4. public.tie_round_reopen: tighten to published rounds only
--      (status = 'published')
-- Ends with ONE read-only single-cell JSONB verification query.
-- ===============================================================================

-- 1. Extend chk_tie_audit_action with 'apply_shared' (preserves all existing actions)
alter table public.tie_audit_log
  drop constraint if exists chk_tie_audit_action;

alter table public.tie_audit_log
  add constraint chk_tie_audit_action check (
    action in (
      'apply_countback',
      'apply_olympic',
      'apply_shared',
      'open_recompete',
      'close_recompete',
      'publish_recompete',
      'reopen_recompete',
      'close_stale_round',
      'close_event_shared',
      'request_absent',
      'confirm_absent',
      'reject_absent'
    )
  );

-- 2. public.tie_round_apply_auto: support 'countback', 'olympic', 'shared' + method_locked guard
create or replace function public.tie_round_apply_auto(
  p_token text,
  p_event_id uuid,
  p_group_key text,
  p_rule text,
  p_actor_label text default 'Organiser',
  p_close_event boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_event public.events;
  v_rule text;
  v_group_key text;
  v_actor text;
  v_stale_rounds jsonb;
  v_existing public.tie_rounds;
  v_group record;
  v_placements jsonb;
  v_before_ranks jsonb;
  v_after_ranks jsonb;
  v_still_tied boolean := false;
  v_low_judge_warning boolean := false;
  v_preview jsonb;
  v_result jsonb;
  v_round public.tie_rounds;
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

  v_rule := lower(btrim(coalesce(p_rule, '')));
  if v_rule not in ('countback', 'olympic', 'shared') then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Tie rule must be countback, olympic, or shared.'
    );
  end if;

  v_group_key := btrim(coalesce(p_group_key, ''));
  if v_group_key = '' then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Tie group key is required.'
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

  -- Lock parent event row to serialize all tie mutations and close checks
  select * into v_event
  from public.events
  where id = p_event_id
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
      'message', 'Cannot apply a tie rule on an ended or archived event.'
    );
  end if;

  -- Stale guard: refuse any apply or close while a stale round exists on this event
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

  -- Server-side tie detection from live sealed scores
  select * into v_group
  from public._fj_detect_event_tie_groups(v_event.id)
  where group_key = v_group_key
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'tie_not_found',
      'message', 'No live tie group matches this selection.'
    );
  end if;

  -- Check active round on this group and enforce method lock after confirmation
  select * into v_existing
  from public.tie_rounds
  where event_id = v_event.id
    and group_key = v_group_key
    and status in ('open', 'closed', 'published')
  for update;

  if found then
    if v_existing.status = 'open' then
      return jsonb_build_object(
        'ok', false,
        'error', 'open_tie_round_exists',
        'round_id', v_existing.id,
        'message', 'An open re-compete round already exists for this tie group.'
      );
    end if;
    if v_existing.status = 'closed' then
      return jsonb_build_object(
        'ok', false,
        'error', 'closed_round_unpublished',
        'round_id', v_existing.id,
        'message', 'A closed re-compete round is awaiting publish for this tie group.'
      );
    end if;
    if v_existing.status = 'published'
       and coalesce(v_existing.is_stale, false) = false
       and coalesce(v_existing.score_fingerprint, '') = coalesce(v_group.score_fingerprint, '') then
      return jsonb_build_object(
        'ok', false,
        'error', 'method_locked',
        'round_id', v_existing.id,
        'rule', v_existing.rule,
        'message', 'Method is locked.'
      );
    end if;
  end if;

  -- Compute deterministic Countback, Olympic trim, or Shared placements strictly on server
  with members as (
    select
      (m->>'participant_id') as participant_id,
      (m->>'avg_score')::numeric as avg_score,
      (m->>'ballot_count')::int as ballot_count,
      array(
        select (x)::numeric
        from jsonb_array_elements_text(m->'scores_desc') as x
      ) as scores_desc,
      (
        select coalesce(sum((x)::numeric), 0)
        from jsonb_array_elements_text(m->'scores_desc') as x
      ) as sum_scores,
      (
        select max((x)::numeric)
        from jsonb_array_elements_text(m->'scores_desc') as x
      ) as max_score,
      (
        select min((x)::numeric)
        from jsonb_array_elements_text(m->'scores_desc') as x
      ) as min_score
    from jsonb_array_elements(v_group.member_scores) as m
  ),
  computed as (
    select
      mb.*,
      case
        when v_rule = 'olympic' and mb.ballot_count >= 3 then
          round((mb.sum_scores - mb.max_score - mb.min_score) / (mb.ballot_count - 2), 2)
        when v_rule = 'olympic' then
          mb.avg_score
        else
          null::numeric
      end as trimmed_avg
    from members mb
  ),
  ranked as (
    select
      c.*,
      case
        when v_rule = 'shared' then
          v_group.tied_rank
        when v_rule = 'countback' then
          v_group.tied_rank - 1 + rank() over (order by c.scores_desc desc)::int
        else
          v_group.tied_rank - 1 + rank() over (order by c.trimmed_avg desc)::int
      end as after_rank
    from computed c
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'participant_id', r.participant_id,
          'before_rank', v_group.tied_rank,
          'after_rank', r.after_rank,
          'base_avg', r.avg_score,
          'ballot_count', r.ballot_count,
          'scores_desc', to_jsonb(r.scores_desc),
          'trimmed_avg', r.trimmed_avg
        )
        order by r.after_rank asc, r.participant_id asc
      ),
      '[]'::jsonb
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'participant_id', r.participant_id,
          'rank', v_group.tied_rank,
          'avg_score', r.avg_score
        )
        order by r.participant_id asc
      ),
      '[]'::jsonb
    ),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'participant_id', r.participant_id,
          'rank', r.after_rank,
          'avg_score', coalesce(r.trimmed_avg, r.avg_score)
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
    ),
    (v_rule = 'olympic' and exists (select 1 from ranked r3 where r3.ballot_count < 5))
  into
    v_placements,
    v_before_ranks,
    v_after_ranks,
    v_still_tied,
    v_low_judge_warning
  from ranked r;

  v_preview := jsonb_build_object(
    'rule', v_rule,
    'tied_rank', v_group.tied_rank,
    'tied_avg', v_group.tied_avg,
    'before_ranks', v_before_ranks,
    'after_ranks', v_after_ranks,
    'low_judge_warning', v_low_judge_warning
  );

  v_result := jsonb_build_object(
    'rule', v_rule,
    'tied_rank', v_group.tied_rank,
    'score_fingerprint', v_group.score_fingerprint,
    'resolved', not v_still_tied,
    'still_tied', v_still_tied,
    'low_judge_warning', v_low_judge_warning,
    'placements', v_placements
  );

  if v_existing.id is not null and v_existing.status = 'published' then
    update public.tie_rounds
    set
      tied_rank = v_group.tied_rank,
      tied_participant_ids = v_group.tied_participant_ids,
      rule = v_rule,
      status = 'published',
      is_stale = false,
      score_fingerprint = v_group.score_fingerprint,
      preview_payload = v_preview,
      result_payload = v_result,
      closed_at = now(),
      published_at = now(),
      updated_at = now()
    where id = v_existing.id
    returning * into v_round;
  else
    insert into public.tie_rounds (
      org_id,
      event_id,
      group_key,
      tied_rank,
      tied_participant_ids,
      rule,
      status,
      is_stale,
      score_fingerprint,
      preview_payload,
      result_payload,
      opened_at,
      closed_at,
      published_at
    )
    values (
      v_event.org_id,
      v_event.id,
      v_group.group_key,
      v_group.tied_rank,
      v_group.tied_participant_ids,
      v_rule,
      'published',
      false,
      v_group.score_fingerprint,
      v_preview,
      v_result,
      now(),
      now(),
      now()
    )
    returning * into v_round;
  end if;

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
    v_group.group_key,
    case
      when v_rule = 'countback' then 'apply_countback'
      when v_rule = 'olympic' then 'apply_olympic'
      else 'apply_shared'
    end,
    v_rule,
    v_actor,
    v_preview,
    v_result,
    case
      when v_rule = 'shared' then 'shared_default'
      when v_still_tied then 'partial_or_shared'
      else 'resolved'
    end,
    ''
  );

  -- Compute remaining unresolved tied groups and any pending rounds
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

revoke all on function public.tie_round_apply_auto(text, uuid, text, text, text, boolean) from public;
grant execute on function public.tie_round_apply_auto(text, uuid, text, text, text, boolean) to anon, authenticated;

-- 3. public.tie_round_open: enforce method_locked for ANY fresh published round
create or replace function public.tie_round_open(
  p_token text,
  p_event_id uuid,
  p_group_key text,
  p_actor_label text default 'Organiser'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_event public.events;
  v_group_key text;
  v_actor text;
  v_stale_rounds jsonb;
  v_group record;
  v_existing public.tie_rounds;
  v_conflict_round_id uuid;
  v_preview jsonb;
  v_round public.tie_rounds;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_group_key := btrim(coalesce(p_group_key, ''));
  if v_group_key = '' then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Tie group key is required.'
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

  -- Lock parent event row to serialize participant overlap and state transitions
  select * into v_event
  from public.events
  where id = p_event_id
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
      'message', 'Cannot open a re-compete round on an ended or archived event.'
    );
  end if;

  -- Stale guard
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

  -- Server-side tie detection
  select * into v_group
  from public._fj_detect_event_tie_groups(v_event.id)
  where group_key = v_group_key
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'tie_not_found',
      'message', 'No live tie group matches this selection.'
    );
  end if;

  -- Check existing active round for this group (lock any fresh published decision)
  select * into v_existing
  from public.tie_rounds
  where event_id = v_event.id
    and group_key = v_group.group_key
    and status in ('open', 'closed', 'published')
  for update;

  if found then
    if v_existing.status = 'open' then
      return jsonb_build_object(
        'ok', false,
        'error', 'open_tie_round_exists',
        'round_id', v_existing.id,
        'message', 'A tie round is already open for this group.'
      );
    end if;
    if v_existing.status = 'closed' then
      return jsonb_build_object(
        'ok', false,
        'error', 'closed_round_unpublished',
        'round_id', v_existing.id,
        'message', 'A closed tie round already exists for this group.'
      );
    end if;
    if v_existing.status = 'published'
       and coalesce(v_existing.is_stale, false) = false
       and coalesce(v_existing.score_fingerprint, '') = coalesce(v_group.score_fingerprint, '') then
      return jsonb_build_object(
        'ok', false,
        'error', 'method_locked',
        'round_id', v_existing.id,
        'rule', v_existing.rule,
        'message', 'Method is locked.'
      );
    end if;
  end if;

  -- Enforce at most ONE open round per participant per event
  select r.id into v_conflict_round_id
  from public.tie_rounds r
  where r.event_id = v_event.id
    and r.status = 'open'
    and r.tied_participant_ids && v_group.tied_participant_ids
  limit 1;

  if v_conflict_round_id is not null then
    return jsonb_build_object(
      'ok', false,
      'error', 'participant_in_open_round',
      'conflict_round_id', v_conflict_round_id,
      'message', 'A participant in this group is already in an open tie round.'
    );
  end if;

  v_preview := jsonb_build_object(
    'rule', 'recompete',
    'tied_rank', v_group.tied_rank,
    'tied_avg', v_group.tied_avg,
    'tied_participant_ids', to_jsonb(v_group.tied_participant_ids)
  );

  if v_existing.id is not null and v_existing.status = 'published' then
    delete from public.tie_round_grades where round_id = v_existing.id;

    update public.tie_rounds
    set
      tied_rank = v_group.tied_rank,
      tied_participant_ids = v_group.tied_participant_ids,
      rule = 'recompete',
      status = 'open',
      is_stale = false,
      score_fingerprint = v_group.score_fingerprint,
      preview_payload = v_preview,
      result_payload = '{}'::jsonb,
      opened_at = now(),
      closed_at = null,
      published_at = null,
      updated_at = now()
    where id = v_existing.id
    returning * into v_round;
  else
    insert into public.tie_rounds (
      org_id,
      event_id,
      group_key,
      tied_rank,
      tied_participant_ids,
      rule,
      status,
      is_stale,
      score_fingerprint,
      preview_payload,
      result_payload,
      opened_at
    )
    values (
      v_event.org_id,
      v_event.id,
      v_group.group_key,
      v_group.tied_rank,
      v_group.tied_participant_ids,
      'recompete',
      'open',
      false,
      v_group.score_fingerprint,
      v_preview,
      '{}'::jsonb,
      now()
    )
    returning * into v_round;
  end if;

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
    'open_recompete',
    'recompete',
    v_actor,
    v_preview,
    jsonb_build_object(
      'round_id', v_round.id,
      'status', v_round.status,
      'tied_rank', v_round.tied_rank,
      'tied_participant_ids', to_jsonb(v_round.tied_participant_ids)
    ),
    'round_opened',
    ''
  );

  return jsonb_build_object(
    'ok', true,
    'round', to_jsonb(v_round)
  );
end;
$$;

revoke all on function public.tie_round_open(text, uuid, text, text) from public;
grant execute on function public.tie_round_open(text, uuid, text, text) to anon, authenticated;

-- 4. public.tie_round_reopen: enforce published rounds only (keeps 3-300 char reason & audit log)
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

  if v_round.status <> 'published' then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_state',
      'status', v_round.status,
      'message', 'Only a published tie round can be reopened.'
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

-- VERIFICATION (read-only, returns ONE jsonb cell)
with apply_fn as (
  select p.oid, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tie_round_apply_auto'
),
open_fn as (
  select p.oid, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tie_round_open'
),
reopen_fn as (
  select p.oid, pg_get_functiondef(p.oid) as def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'tie_round_reopen'
),
audit_chk as (
  select pg_get_constraintdef(c.oid) as def
  from pg_constraint c
  where c.conrelid = to_regclass('public.tie_audit_log')
    and c.conname = 'chk_tie_audit_action'
)
select jsonb_build_object(
  'part', 'verify_17_8_3',
  'audit_action_has_apply_shared', exists (select 1 from audit_chk where def ilike '%apply_shared%'),
  'apply_auto_supports_shared', exists (select 1 from apply_fn where def ilike '%''shared''%'),
  'apply_auto_locks_published', exists (select 1 from apply_fn where def ilike '%method_locked%'),
  'open_locks_published', exists (select 1 from open_fn where def ilike '%method_locked%'),
  'reopen_published_only', exists (select 1 from reopen_fn where def ilike '%v_round.status <> ''published''%')
) as verify_17_8_3;
