-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 17.7.0 — PATCH 3a (WRITE ONLY — DO NOT AUTO-RUN)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Patches two Part 3a RPCs already live in Supabase without editing
-- sql/17.7.0-tie-management.sql:
--   1) public.tie_round_apply_auto: refuse ended or archived events (event_ended)
--   2) public.tie_event_close_shared: refuse already ended/archived events before
--      any writes (event_already_ended) so no second close audit row is written.
-- Each patch block ends with a read-only single-cell JSONB verification query.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ===============================================================================
-- PATCH 3a.1: public.tie_round_apply_auto (add event_ended refusal)
-- ===============================================================================

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
  if v_rule not in ('countback', 'olympic') then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Automatic tie rule must be countback or olympic.'
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

  -- Check active round on this group
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

  -- Compute deterministic Countback or Olympic trim placements strictly on server
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
      (
        v_group.tied_rank - 1 +
        case
          when v_rule = 'countback' then
            rank() over (order by c.scores_desc desc)::int
          else
            rank() over (order by c.trimmed_avg desc)::int
        end
      ) as after_rank
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
    case when v_rule = 'countback' then 'apply_countback' else 'apply_olympic' end,
    v_rule,
    v_actor,
    v_preview,
    v_result,
    case when v_still_tied then 'partial_or_shared' else 'resolved' end,
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

-- PATCH 3a.1 VERIFICATION (read-only, returns ONE jsonb cell)
with fn as (
  select p.oid, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def, pg_get_function_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'tie_round_apply_auto'
)
select jsonb_build_object(
  'part', 'verify_17_7_0_patch_3a_1',
  'exists', exists (select 1 from fn),
  'security_definer', coalesce((select prosecdef from fn limit 1), false),
  'has_event_ended_guard', exists (select 1 from fn where position('event_ended' in def) > 0),
  'granted_to_anon', coalesce((select has_function_privilege('anon', oid, 'execute') from fn limit 1), false),
  'granted_to_authenticated', coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn limit 1), false),
  'revoked_from_public', exists (
    select 1 from fn
    where proacl is not null
      and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
  ),
  'zero_p_groups', not exists (select 1 from fn where position('p_groups' in lower(coalesce(args, ''))) > 0)
) as verify_17_7_0_patch_3a_1;


-- ===============================================================================
-- PATCH 3a.2: public.tie_event_close_shared (add event_already_ended refusal)
-- ===============================================================================

create or replace function public.tie_event_close_shared(
  p_token text,
  p_event_id uuid,
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
  v_actor text;
  v_stale_rounds jsonb;
  v_group record;
  v_existing public.tie_rounds;
  v_round public.tie_rounds;
  v_placements jsonb;
  v_before_ranks jsonb;
  v_preview jsonb;
  v_result jsonb;
  v_shared_rounds jsonb := '[]'::jsonb;
  v_shared_keys text[] := '{}'::text[];
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

  -- Lock parent event row
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

  -- Refuse before any writes if event is already ended or archived (prevents duplicate close audit row)
  if coalesce(v_event.is_archived, false) = true
     or lower(coalesce(v_event.status, '')) in ('ended', 'archived') then
    return jsonb_build_object(
      'ok', false,
      'error', 'event_already_ended',
      'message', 'This event has already ended.'
    );
  end if;

  -- Guard 1: Stale rounds must be cancelled first
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

  -- Guard 2: Refuse if any open tie round exists
  if exists (
    select 1
    from public.tie_rounds
    where event_id = v_event.id
      and status = 'open'
  ) then
    return jsonb_build_object(
      'ok', false,
      'error', 'open_tie_round_exists',
      'message', 'Close and publish open tie rounds before closing the event.'
    );
  end if;

  -- Guard 3: Refuse if any closed-but-unpublished tie round exists
  if exists (
    select 1
    from public.tie_rounds
    where event_id = v_event.id
      and status = 'closed'
  ) then
    return jsonb_build_object(
      'ok', false,
      'error', 'closed_round_unpublished',
      'message', 'Publish closed tie rounds before closing the event.'
    );
  end if;

  -- Server-side tie detection: store published shared tie rounds for all unresolved live ties
  for v_group in
    select *
    from public._fj_detect_event_tie_groups(v_event.id)
    order by tied_rank asc
  loop
    select * into v_existing
    from public.tie_rounds
    where event_id = v_event.id
      and group_key = v_group.group_key
      and status = 'published'
    for update;

    if found
       and coalesce(v_existing.is_stale, false) = false
       and coalesce(v_existing.score_fingerprint, '') = coalesce(v_group.score_fingerprint, '') then
      -- Already has a fresh published decision for this exact group and sealed scores
      continue;
    end if;

    select
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'participant_id', (m->>'participant_id'),
            'before_rank', v_group.tied_rank,
            'after_rank', v_group.tied_rank,
            'base_avg', (m->>'avg_score')::numeric,
            'ballot_count', (m->>'ballot_count')::int
          )
          order by (m->>'participant_id') asc
        ),
        '[]'::jsonb
      ),
      coalesce(
        jsonb_agg(
          jsonb_build_object(
            'participant_id', (m->>'participant_id'),
            'rank', v_group.tied_rank,
            'avg_score', (m->>'avg_score')::numeric
          )
          order by (m->>'participant_id') asc
        ),
        '[]'::jsonb
      )
    into v_placements, v_before_ranks
    from jsonb_array_elements(v_group.member_scores) as m;

    v_preview := jsonb_build_object(
      'rule', 'shared',
      'tied_rank', v_group.tied_rank,
      'tied_avg', v_group.tied_avg,
      'before_ranks', v_before_ranks,
      'after_ranks', v_before_ranks
    );

    v_result := jsonb_build_object(
      'rule', 'shared',
      'tied_rank', v_group.tied_rank,
      'score_fingerprint', v_group.score_fingerprint,
      'resolved', false,
      'still_tied', true,
      'placements', v_placements
    );

    if v_existing.id is not null then
      update public.tie_rounds
      set
        tied_rank = v_group.tied_rank,
        tied_participant_ids = v_group.tied_participant_ids,
        rule = 'shared',
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
        'shared',
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

    v_shared_keys := array_append(v_shared_keys, v_group.group_key);
    v_shared_rounds := v_shared_rounds || jsonb_build_array(
      jsonb_build_object(
        'round_id', v_round.id,
        'group_key', v_round.group_key,
        'tied_rank', v_round.tied_rank,
        'tied_participant_ids', to_jsonb(v_round.tied_participant_ids)
      )
    );
  end loop;

  -- Close the event
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
    null,
    case
      when cardinality(v_shared_keys) = 0 then 'none'
      when cardinality(v_shared_keys) = 1 then v_shared_keys[1]
      else 'multiple:' || cardinality(v_shared_keys)::text
    end,
    'close_event_shared',
    'shared',
    v_actor,
    jsonb_build_object('shared_rounds', v_shared_rounds),
    jsonb_build_object(
      'event_status', v_event.status,
      'shared_group_count', cardinality(v_shared_keys),
      'shared_rounds', v_shared_rounds
    ),
    case
      when cardinality(v_shared_keys) > 0 then 'closed_with_shared_places'
      else 'closed_no_unresolved_ties'
    end,
    ''
  );

  return jsonb_build_object(
    'ok', true,
    'event', to_jsonb(v_event),
    'event_closed', true,
    'shared_group_count', cardinality(v_shared_keys),
    'shared_rounds', v_shared_rounds
  );
end;
$$;

revoke all on function public.tie_event_close_shared(text, uuid, text) from public;
grant execute on function public.tie_event_close_shared(text, uuid, text) to anon, authenticated;

-- PATCH 3a.2 VERIFICATION (read-only, returns ONE jsonb cell)
with fn as (
  select p.oid, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def, pg_get_function_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'tie_event_close_shared'
)
select jsonb_build_object(
  'part', 'verify_17_7_0_patch_3a_2',
  'exists', exists (select 1 from fn),
  'security_definer', coalesce((select prosecdef from fn limit 1), false),
  'has_event_already_ended_guard', exists (select 1 from fn where position('event_already_ended' in def) > 0),
  'granted_to_anon', coalesce((select has_function_privilege('anon', oid, 'execute') from fn limit 1), false),
  'granted_to_authenticated', coalesce((select has_function_privilege('authenticated', oid, 'execute') from fn limit 1), false),
  'revoked_from_public', exists (
    select 1 from fn
    where proacl is not null
      and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
  ),
  'zero_p_groups', not exists (select 1 from fn where position('p_groups' in lower(coalesce(args, ''))) > 0)
) as verify_17_7_0_patch_3a_2;
