-- ═══════════════════════════════════════════════════════════════════════════════
-- PHASE 17.7.0 — PARTS 4 AND 5: JUDGE RPCs & SYNC RPCs
-- (WRITE ONLY — DO NOT AUTO-RUN)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Source references copied verbatim before extension:
--   - Judge token helper: public._fj_verify_judge_token(text)
--     (from sql/15.12-phase2b-lockdown.sql, lines 74-115)
--   - read_org_changes: copied from sql/15.12-phase4d-simple-sync.sql (lines 327-563)
--   - projector_changes: copied from sql/17.6.1-projector-changes-fix.sql (lines 15-349)
-- Each part has its own labelled header and single-cell read-only verification query,
-- followed by a combined final verification query at the end of the file.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ===============================================================================
-- PART 4: JUDGE TIE ROUND RPCs
--   - public.judge_tie_round_read(p_token text)
--   - public.judge_tie_grade_upsert(p_token text, p_round_id uuid, p_participant_id uuid, p_grade integer)
-- ===============================================================================

-- 4.1 public.judge_tie_round_read
create or replace function public.judge_tie_round_read(
  p_token text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_auth jsonb;
  v_judge_id uuid;
  v_org_id text;
  v_blind boolean := false;
  v_judge_assigned_events text[] := '{}'::text[];
  v_rounds jsonb := '[]'::jsonb;
begin
  v_auth := public._fj_verify_judge_token(p_token);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Judge session expired or invalid. Please sign in again.'
    );
  end if;

  v_judge_id := (v_auth->>'judge_id')::uuid;
  v_org_id := v_auth->>'org_id';

  select coalesce(o.blind_judging_enabled, false)
  into v_blind
  from public.organizations o
  where upper(o.org_id) = upper(v_org_id)
  limit 1;

  select coalesce(j.assigned_events, '{}'::text[])
  into v_judge_assigned_events
  from public.judges j
  where j.id = v_judge_id
    and upper(j.org_id) = upper(v_org_id)
  limit 1;

  -- Return ONLY open recompete rounds for active non-ended events assigned to this judge,
  -- anonymised participants when blind mode is on, and ONLY this judge's own grades.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'event_id', r.event_id,
        'event_name', e.name,
        'group_key', r.group_key,
        'tied_rank', r.tied_rank,
        'tied_participant_ids', to_jsonb(r.tied_participant_ids),
        'status', r.status,
        'opened_at', r.opened_at,
        'version', r.version,
        'participants', (
          select coalesce(
            jsonb_agg(
              case
                when v_blind then
                  jsonb_build_object(
                    'id', p.id,
                    'identity_id', coalesce(p.identity_id, ''),
                    'sl_no', coalesce(p.sl_no::text, ''),
                    'event_sl_no', coalesce(e.participant_sl_numbers->>p.id::text, p.sl_no::text, ''),
                    'name', 'Anonymous',
                    'school', '',
                    'class_or_age', null,
                    'custom_values', '{}'::jsonb
                  )
                else
                  jsonb_build_object(
                    'id', p.id,
                    'identity_id', coalesce(p.identity_id, ''),
                    'sl_no', coalesce(p.sl_no::text, ''),
                    'event_sl_no', coalesce(e.participant_sl_numbers->>p.id::text, p.sl_no::text, ''),
                    'name', coalesce(p.name, ''),
                    'school', coalesce(p.school, ''),
                    'class_or_age', p.class_or_age,
                    'custom_values', coalesce(p.custom_values, '{}'::jsonb)
                  )
              end
              order by coalesce(e.participant_sl_numbers->>p.id::text, p.sl_no::text, p.id::text) asc, p.id asc
            ),
            '[]'::jsonb
          )
          from public.participants p
          where upper(p.org_id) = upper(v_org_id)
            and coalesce(p.is_active, true) = true
            and p.id::text = any(coalesce(r.tied_participant_ids, '{}'::text[]))
        ),
        'my_grades', (
          select coalesce(
            jsonb_agg(
              jsonb_build_object(
                'id', g.id,
                'round_id', g.round_id,
                'event_id', g.event_id,
                'participant_id', g.participant_id,
                'grade', g.grade,
                'submitted_at', g.submitted_at,
                'version', g.version
              )
              order by g.submitted_at asc, g.id asc
            ),
            '[]'::jsonb
          )
          from public.tie_round_grades g
          where g.round_id = r.id
            and g.judge_id = v_judge_id
        )
      )
      order by r.opened_at asc, r.id asc
    ),
    '[]'::jsonb
  )
  into v_rounds
  from public.tie_rounds r
  join public.events e
    on e.id = r.event_id
   and upper(e.org_id) = upper(v_org_id)
  where upper(r.org_id) = upper(v_org_id)
    and r.rule = 'recompete'
    and r.status = 'open'
    and coalesce(r.is_stale, false) = false
    and coalesce(e.is_archived, false) = false
    and lower(coalesce(e.status, 'draft')) not in ('ended', 'archived')
    and (
      cardinality(coalesce(e.assigned_judges, '{}'::text[])) = 0
      or v_judge_id::text = any(coalesce(e.assigned_judges, '{}'::text[]))
      or e.id::text = any(v_judge_assigned_events)
    );

  return jsonb_build_object(
    'ok', true,
    'blind_judging_enabled', v_blind,
    'rounds', v_rounds
  );
end;
$$;

revoke all on function public.judge_tie_round_read(text) from public;
grant execute on function public.judge_tie_round_read(text) to anon, authenticated;


-- 4.2 public.judge_tie_grade_upsert
create or replace function public.judge_tie_grade_upsert(
  p_token text,
  p_round_id uuid,
  p_participant_id uuid,
  p_grade integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_auth jsonb;
  v_judge_id uuid;
  v_org_id text;
  v_judge_assigned_events text[] := '{}'::text[];
  v_round public.tie_rounds;
  v_event public.events;
  v_grade_row public.tie_round_grades;
begin
  v_auth := public._fj_verify_judge_token(p_token);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Judge session expired or invalid. Please sign in again.'
    );
  end if;

  v_judge_id := (v_auth->>'judge_id')::uuid;
  v_org_id := v_auth->>'org_id';

  if p_grade is null or p_grade < 1 or p_grade > 5 then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_grade',
      'message', 'Grade must be an integer between 1 and 5.'
    );
  end if;

  if p_round_id is null or p_participant_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Round ID and participant ID are required.'
    );
  end if;

  -- Lock the round row FOR UPDATE to prevent race with tie_round_close / tie_round_close_stale
  select * into v_round
  from public.tie_rounds
  where id = p_round_id
    and upper(org_id) = upper(v_org_id)
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Tie round not found.'
    );
  end if;

  -- Strictly reject closed, published, cancelled_stale, or non-recompete rounds
  if v_round.status <> 'open' or v_round.rule <> 'recompete' then
    return jsonb_build_object(
      'ok', false,
      'error', 'round_closed',
      'status', v_round.status,
      'message', 'This tie round is closed and no longer accepts grades.'
    );
  end if;

  select * into v_event
  from public.events
  where id = v_round.event_id
    and upper(org_id) = upper(v_org_id);

  if not found
     or coalesce(v_event.is_archived, false) = true
     or lower(coalesce(v_event.status, 'draft')) in ('ended', 'archived') then
    return jsonb_build_object(
      'ok', false,
      'error', 'round_closed',
      'message', 'This event has ended and no longer accepts grades.'
    );
  end if;

  select coalesce(j.assigned_events, '{}'::text[])
  into v_judge_assigned_events
  from public.judges j
  where j.id = v_judge_id
    and upper(j.org_id) = upper(v_org_id)
  limit 1;

  -- Confirm this judge is assigned to the event
  if not (
    cardinality(coalesce(v_event.assigned_judges, '{}'::text[])) = 0
    or v_judge_id::text = any(coalesce(v_event.assigned_judges, '{}'::text[]))
    or v_event.id::text = any(v_judge_assigned_events)
  ) then
    return jsonb_build_object(
      'ok', false,
      'error', 'forbidden',
      'message', 'You are not assigned to this event.'
    );
  end if;

  -- Confirm participant belongs to this tie round
  if not (p_participant_id::text = any(coalesce(v_round.tied_participant_ids, '{}'::text[]))) then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_participant',
      'message', 'Participant is not in this tie round.'
    );
  end if;

  -- Idempotent upsert on (round_id, judge_id, participant_id); no audit row written
  insert into public.tie_round_grades (
    org_id,
    round_id,
    event_id,
    judge_id,
    participant_id,
    grade,
    submitted_at
  )
  values (
    v_round.org_id,
    v_round.id,
    v_round.event_id,
    v_judge_id,
    p_participant_id,
    p_grade::smallint,
    now()
  )
  on conflict (round_id, judge_id, participant_id)
  do update set
    grade = excluded.grade,
    submitted_at = now()
  returning * into v_grade_row;

  return jsonb_build_object(
    'ok', true,
    'grade', jsonb_build_object(
      'id', v_grade_row.id,
      'round_id', v_grade_row.round_id,
      'event_id', v_grade_row.event_id,
      'judge_id', v_grade_row.judge_id,
      'participant_id', v_grade_row.participant_id,
      'grade', v_grade_row.grade,
      'submitted_at', v_grade_row.submitted_at,
      'version', v_grade_row.version,
      'updated_at', v_grade_row.updated_at
    )
  );
end;
$$;

revoke all on function public.judge_tie_grade_upsert(text, uuid, uuid, integer) from public;
grant execute on function public.judge_tie_grade_upsert(text, uuid, uuid, integer) to anon, authenticated;

-- PART 4 VERIFICATION (read-only, returns ONE jsonb cell)
with judge_rpcs as (
  select
    p.oid,
    p.proname,
    p.prosecdef,
    p.proacl,
    pg_get_functiondef(p.oid) as def,
    pg_get_function_arguments(p.oid) as args
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('judge_tie_round_read', 'judge_tie_grade_upsert')
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_4',
  'rpc_count', (select count(*)::int from judge_rpcs),
  'both_exist', ((select count(distinct proname)::int from judge_rpcs) = 2),
  'both_security_definer', ((select count(*)::int from judge_rpcs where prosecdef = true) = 2),
  'both_granted_to_anon', ((select count(*)::int from judge_rpcs where has_function_privilege('anon', oid, 'execute')) = 2),
  'both_granted_to_authenticated', ((select count(*)::int from judge_rpcs where has_function_privilege('authenticated', oid, 'execute')) = 2),
  'both_revoked_from_public', (
    (
      select count(*)::int
      from judge_rpcs
      where proacl is not null
        and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
    ) = 2
  ),
  'read_filters_own_judge_id', exists (
    select 1 from judge_rpcs
    where proname = 'judge_tie_round_read'
      and position('g.judge_id = v_judge_id' in def) > 0
      and position('preview_payload' in def) = 0
      and position('result_payload' in def) = 0
      and position('actor_label' in def) = 0
      and position('last_reopen_reason' in def) = 0
  ),
  'upsert_locks_and_validates', exists (
    select 1 from judge_rpcs
    where proname = 'judge_tie_grade_upsert'
      and position('for update' in lower(def)) > 0
      and position('round_closed' in def) > 0
      and position('invalid_grade' in def) > 0
      and position('on conflict (round_id, judge_id, participant_id)' in lower(def)) > 0
      and position('tie_audit_log' in lower(def)) = 0
  )
) as verify_17_7_0_part_4;


-- ===============================================================================
-- PART 5: SYNC RPCs
--   - public.read_org_changes(p_token text, p_since bigint default 0)
--     (copied from sql/15.12-phase4d-simple-sync.sql and extended)
--   - public.projector_changes(p_token text, p_since bigint default 0)
--     (copied from sql/17.6.1-projector-changes-fix.sql and extended)
-- ===============================================================================

-- 5.1 public.read_org_changes
create or replace function public.read_org_changes(
  p_token text,
  p_since bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_auth jsonb;
  v_org_id text;
  v_role text;
  v_judge_id uuid;
  v_judge_assigned_events text[] := '{}'::text[];
  v_org public.organizations;
  v_cur_ver bigint;
  v_req_since bigint;
  v_effective_since bigint;
  v_full_resync boolean := false;
  v_blind boolean := false;
  v_isolated boolean := false;
  v_org_json jsonb := null;
  v_events jsonb := '[]'::jsonb;
  v_judges jsonb := '[]'::jsonb;
  v_participants jsonb := '[]'::jsonb;
  v_scores jsonb := '[]'::jsonb;
  v_tie_rounds jsonb := '[]'::jsonb;
  v_tie_round_grades jsonb := '[]'::jsonb;
  v_tie_audit_log jsonb := '[]'::jsonb;
  v_deletions jsonb := '[]'::jsonb;
begin
  v_auth := public._fj_verify_read_token(p_token, null);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_org_id := v_auth->>'org_id';
  v_role := v_auth->>'role';
  if v_role = 'judge' and nullif(v_auth->>'judge_id', '') is not null then
    v_judge_id := (v_auth->>'judge_id')::uuid;
  end if;

  select * into v_org
  from public.organizations o
  where upper(o.org_id) = upper(v_org_id)
  limit 1;

  if v_org.id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Organization not found or unavailable.'
    );
  end if;

  v_cur_ver := greatest(coalesce(v_org.sync_version, 1), 1);
  v_req_since := greatest(coalesce(p_since, 0), 0);

  -- Fast unchanged short-circuit when client is already at the latest version
  if v_req_since = v_cur_ver then
    return jsonb_build_object(
      'ok', true,
      'org_id', v_org.org_id,
      'version', v_cur_ver,
      'since', v_req_since,
      'unchanged', true,
      'full_resync', false,
      'organization', null,
      'events', '[]'::jsonb,
      'judges', '[]'::jsonb,
      'participants', '[]'::jsonb,
      'scores', '[]'::jsonb,
      'tie_rounds', '[]'::jsonb,
      'tie_round_grades', '[]'::jsonb,
      'tie_audit_log', '[]'::jsonb,
      'deletions', '[]'::jsonb
    );
  end if;

  if v_req_since = 0 or v_req_since > v_cur_ver then
    v_effective_since := 0;
    v_full_resync := true;
  else
    v_effective_since := v_req_since;
  end if;

  -- If organization row changed for a judge session (e.g. blind_judging_enabled or
  -- isolated_jury_enabled toggled), force full_resync so cached names/scores mask immediately.
  if v_role = 'judge' and v_effective_since > 0 and coalesce(v_org.version, 1) > v_effective_since then
    v_effective_since := 0;
    v_full_resync := true;
  end if;

  if v_role = 'judge' then
    v_blind := coalesce(v_org.blind_judging_enabled, false);
    v_isolated := coalesce(v_org.isolated_jury_enabled, false);

    select coalesce(j.assigned_events, '{}'::text[])
    into v_judge_assigned_events
    from public.judges j
    where j.id = v_judge_id
      and upper(j.org_id) = upper(v_org_id)
    limit 1;
  end if;

  -- 1. Organization delta (never expose password; strip organiser email for judges)
  if v_effective_since = 0 or coalesce(v_org.version, 1) > v_effective_since then
    v_org_json := to_jsonb(v_org) - 'password';
    if v_role = 'judge' then
      v_org_json := v_org_json - 'email';
    end if;
  end if;

  -- 2. Events delta
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc), '[]'::jsonb)
  into v_events
  from public.events e
  where upper(e.org_id) = upper(v_org_id)
    and (v_effective_since = 0 or coalesce(e.version, 1) > v_effective_since);

  -- 3. Judges delta (explicit safe columns only)
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', j.id,
        'org_id', j.org_id,
        'name', j.name,
        'judge_id', j.judge_id,
        'assigned_events', coalesce(j.assigned_events, '{}'::text[]),
        'created_at', j.created_at,
        'version', j.version,
        'updated_at', j.updated_at
      )
      || case
           when to_jsonb(j) ? 'is_active' then jsonb_build_object('is_active', to_jsonb(j)->'is_active')
           else '{}'::jsonb
         end
      order by j.created_at desc
    ),
    '[]'::jsonb
  )
  into v_judges
  from public.judges j
  where upper(j.org_id) = upper(v_org_id)
    and (v_effective_since = 0 or coalesce(j.version, 1) > v_effective_since);

  -- 4. Participants delta (explicit safe columns only; masks identity in blind mode for judges)
  select coalesce(
    jsonb_agg(
      (
        case
          when v_role = 'judge' and v_blind then
            jsonb_build_object(
              'id', p.id,
              'org_id', p.org_id,
              'identity_id', p.identity_id,
              'sl_no', p.sl_no,
              'name', 'Anonymous',
              'school', '',
              'class_or_age', null,
              'custom_values', '{}'::jsonb,
              'created_at', p.created_at,
              'version', p.version,
              'updated_at', p.updated_at
            )
          else
            jsonb_build_object(
              'id', p.id,
              'org_id', p.org_id,
              'identity_id', p.identity_id,
              'sl_no', p.sl_no,
              'name', p.name,
              'school', p.school,
              'class_or_age', p.class_or_age,
              'custom_values', coalesce(p.custom_values, '{}'::jsonb),
              'created_at', p.created_at,
              'version', p.version,
              'updated_at', p.updated_at
            )
        end
      )
      || case
           when to_jsonb(p) ? 'is_active' then jsonb_build_object('is_active', to_jsonb(p)->'is_active')
           else '{}'::jsonb
         end
      order by p.created_at asc
    ),
    '[]'::jsonb
  )
  into v_participants
  from public.participants p
  where upper(p.org_id) = upper(v_org_id)
    and (v_effective_since = 0 or coalesce(p.version, 1) > v_effective_since);

  -- 5. Scores delta (organiser sees all org scores; judge sees own scores when blind or isolated)
  select coalesce(jsonb_agg(to_jsonb(s) order by s.created_at asc), '[]'::jsonb)
  into v_scores
  from public.scores s
  where upper(s.org_id) = upper(v_org_id)
    and (v_effective_since = 0 or coalesce(s.version, 1) > v_effective_since)
    and (
      v_role = 'organiser'
      or (not v_blind and not v_isolated)
      or s.judge_id = v_judge_id
    );

  -- 6. Tie rounds delta (organiser: full org rows; judge: open assigned rounds with narrow fields only)
  if v_role = 'organiser' then
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
          'is_stale', r.is_stale,
          'score_fingerprint', r.score_fingerprint,
          'preview_payload', r.preview_payload,
          'result_payload', r.result_payload,
          'reopen_count', r.reopen_count,
          'last_reopen_reason', r.last_reopen_reason,
          'opened_at', r.opened_at,
          'closed_at', r.closed_at,
          'published_at', r.published_at,
          'version', r.version,
          'updated_at', r.updated_at
        )
        order by r.opened_at desc, r.id desc
      ),
      '[]'::jsonb
    )
    into v_tie_rounds
    from public.tie_rounds r
    where upper(r.org_id) = upper(v_org_id)
      and (v_effective_since = 0 or coalesce(r.version, 1) > v_effective_since);
  else
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', r.id,
          'event_id', r.event_id,
          'group_key', r.group_key,
          'tied_rank', r.tied_rank,
          'tied_participant_ids', to_jsonb(r.tied_participant_ids),
          'status', r.status,
          'opened_at', r.opened_at,
          'version', r.version
        )
        order by r.opened_at asc, r.id asc
      ),
      '[]'::jsonb
    )
    into v_tie_rounds
    from public.tie_rounds r
    join public.events e
      on e.id = r.event_id
     and upper(e.org_id) = upper(v_org_id)
    where upper(r.org_id) = upper(v_org_id)
      and r.rule = 'recompete'
      and r.status = 'open'
      and coalesce(r.is_stale, false) = false
      and coalesce(e.is_archived, false) = false
      and lower(coalesce(e.status, 'draft')) not in ('ended', 'archived')
      and (
        cardinality(coalesce(e.assigned_judges, '{}'::text[])) = 0
        or v_judge_id::text = any(coalesce(e.assigned_judges, '{}'::text[]))
        or e.id::text = any(v_judge_assigned_events)
      );
  end if;

  -- 7. Tie round grades delta (organiser: org grades; judge: strictly judge_id = v_judge_id)
  if v_role = 'organiser' then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', g.id,
          'org_id', g.org_id,
          'round_id', g.round_id,
          'event_id', g.event_id,
          'judge_id', g.judge_id,
          'participant_id', g.participant_id,
          'grade', g.grade,
          'submitted_at', g.submitted_at,
          'version', g.version,
          'updated_at', g.updated_at
        )
        order by g.submitted_at asc, g.id asc
      ),
      '[]'::jsonb
    )
    into v_tie_round_grades
    from public.tie_round_grades g
    where upper(g.org_id) = upper(v_org_id)
      and (v_effective_since = 0 or coalesce(g.version, 1) > v_effective_since);
  else
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', g.id,
          'round_id', g.round_id,
          'event_id', g.event_id,
          'judge_id', g.judge_id,
          'participant_id', g.participant_id,
          'grade', g.grade,
          'submitted_at', g.submitted_at,
          'version', g.version,
          'updated_at', g.updated_at
        )
        order by g.submitted_at asc, g.id asc
      ),
      '[]'::jsonb
    )
    into v_tie_round_grades
    from public.tie_round_grades g
    where upper(g.org_id) = upper(v_org_id)
      and g.judge_id = v_judge_id
      and (v_effective_since = 0 or coalesce(g.version, 1) > v_effective_since);
  end if;

  -- 8. Tie audit log (organiser only; always empty array for judges)
  if v_role = 'organiser' then
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
    into v_tie_audit_log
    from (
      select *
      from public.tie_audit_log
      where upper(org_id) = upper(v_org_id)
      order by created_at desc, id desc
      limit 500
    ) a;
  else
    v_tie_audit_log := '[]'::jsonb;
  end if;

  -- 9. Deletions delta (omitted on full_resync; judges exclude audit and grade tombstones)
  if not v_full_resync and v_effective_since > 0 then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'table_name', d.table_name,
          'record_id', d.record_id,
          'version', d.version,
          'deleted_at', d.deleted_at
        )
        order by d.version asc, d.id asc
      ),
      '[]'::jsonb
    )
    into v_deletions
    from public.sync_deletions d
    where upper(d.org_id) = upper(v_org_id)
      and d.version > v_effective_since
      and (
        (
          v_role = 'organiser'
          and d.table_name in ('events', 'judges', 'participants', 'scores', 'tie_rounds', 'tie_round_grades')
        )
        or (
          v_role = 'judge'
          and d.table_name in ('events', 'judges', 'participants', 'scores', 'tie_rounds')
        )
      );
  end if;

  return jsonb_build_object(
    'ok', true,
    'org_id', v_org.org_id,
    'version', v_cur_ver,
    'since', v_req_since,
    'unchanged', false,
    'full_resync', v_full_resync,
    'organization', v_org_json,
    'events', v_events,
    'judges', v_judges,
    'participants', v_participants,
    'scores', v_scores,
    'tie_rounds', v_tie_rounds,
    'tie_round_grades', v_tie_round_grades,
    'tie_audit_log', v_tie_audit_log,
    'deletions', v_deletions
  );
end;
$$;

revoke all on function public.read_org_changes(text, bigint) from public;
grant execute on function public.read_org_changes(text, bigint) to anon, authenticated;


-- 5.2 public.projector_changes
create or replace function public.projector_changes(
  p_token text,
  p_since bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_pt record;
  v_org_sess record;
  v_org record;
  v_event record;
  v_since bigint := greatest(coalesce(p_since, 0), 0);
  v_cursor bigint := 0;
  v_event_ended boolean := false;
  v_participants jsonb := '[]'::jsonb;
  v_judges jsonb := '[]'::jsonb;
  v_scores jsonb := '[]'::jsonb;
  v_tie_rounds jsonb := '[]'::jsonb;
  v_deletions jsonb := '[]'::jsonb;
begin
  v_hash := public._fj_hash_org_token(p_token);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'revoked', 'message', 'Missing projector session.');
  end if;

  select *
  into v_pt
  from public.projector_token pt
  where pt.token_hash = v_hash
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'revoked', 'message', 'Projector session not found.');
  end if;

  -- Already revoked -> report exact reason
  if v_pt.revoked_at is not null then
    return jsonb_build_object(
      'ok', false,
      'error', case coalesce(v_pt.revoked_reason, 'revoked')
        when 'replaced' then 'replaced'
        when 'expired' then 'expired'
        when 'event_ended' then 'event_ended'
        else 'revoked'
      end,
      'message', case coalesce(v_pt.revoked_reason, 'revoked')
        when 'replaced' then 'Another projector signed in for this organisation.'
        when 'expired' then 'Projector session expired (8-hour limit).'
        when 'event_ended' then 'This event has ended.'
        else 'Projector session was ended by the organiser.'
      end
    );
  end if;

  -- Check 8-hour expiry
  if v_pt.expires_at <= now() then
    update public.projector_token
    set revoked_at = now(), revoked_reason = 'expired'
    where id = v_pt.id and revoked_at is null;

    if v_pt.org_session_id is not null then
      update public.org_sessions
      set revoked_at = now()
      where id = v_pt.org_session_id and revoked_at is null;
    end if;

    return jsonb_build_object(
      'ok', false,
      'error', 'expired',
      'message', 'Projector session expired (8-hour limit).'
    );
  end if;

  -- Defense-in-depth: confirm linked org_sessions slot is still active
  if v_pt.org_session_id is not null then
    select s.id, s.revoked_at, s.expires_at
    into v_org_sess
    from public.org_sessions s
    where s.id = v_pt.org_session_id
    limit 1;

    if not found or v_org_sess.revoked_at is not null or v_org_sess.expires_at <= now() then
      update public.projector_token
      set revoked_at = now(),
          revoked_reason = case
            when found and v_org_sess.revoked_at is null and v_org_sess.expires_at <= now() then 'expired'
            else 'organiser_ended'
          end
      where id = v_pt.id and revoked_at is null;

      return jsonb_build_object(
        'ok', false,
        'error', case
          when found and v_org_sess.revoked_at is null and v_org_sess.expires_at <= now() then 'expired'
          else 'revoked'
        end,
        'message', 'Projector session was ended.'
      );
    end if;
  end if;

  -- Load org (allowlisted non-PII columns only) and ensure org is active
  select
    o.org_id,
    o.name,
    o.tie_breaker_enabled,
    o.tie_breaker_method,
    o.tie_management_enabled,
    o.tie_rule,
    o.projector_spotlight_mode,
    o.projector_ticker_text,
    o.sync_version,
    o.created_at,
    o.suspended,
    o.deleted_at
  into v_org
  from public.organizations o
  where upper(o.org_id) = upper(v_pt.org_id)
  limit 1;

  if not found or coalesce(v_org.suspended, false) or v_org.deleted_at is not null then
    update public.projector_token
    set revoked_at = now(), revoked_reason = 'organiser_ended'
    where id = v_pt.id and revoked_at is null;

    if v_pt.org_session_id is not null then
      update public.org_sessions
      set revoked_at = now()
      where id = v_pt.org_session_id and revoked_at is null;
    end if;

    return jsonb_build_object('ok', false, 'error', 'revoked', 'message', 'Organisation is not active.');
  end if;

  v_cursor := coalesce(v_org.sync_version, 1);

  -- Load single scoped event
  select
    e.id,
    e.org_id,
    e.name,
    e.category,
    e.status,
    e.is_locked,
    e.is_archived,
    e.rubric_schema,
    e.assigned_judges,
    e.assigned_participants,
    e.participant_sl_numbers,
    e.date,
    e.created_at,
    e.version
  into v_event
  from public.events e
  where e.id = v_pt.event_id
    and upper(e.org_id) = upper(v_pt.org_id)
  limit 1;

  if not found then
    update public.projector_token
    set revoked_at = now(), revoked_reason = 'event_ended'
    where id = v_pt.id and revoked_at is null;

    if v_pt.org_session_id is not null then
      update public.org_sessions
      set revoked_at = now()
      where id = v_pt.org_session_id and revoked_at is null;
    end if;

    return jsonb_build_object('ok', false, 'error', 'event_ended', 'message', 'This event is no longer available.');
  end if;

  v_event_ended := coalesce(v_event.is_archived, false)
    or lower(coalesce(v_event.status, 'draft')) in ('ended', 'archived');

  -- Fast no-op path when nothing changed and event is still running
  if not v_event_ended and v_since > 0 and v_since >= v_cursor then
    if v_pt.last_seen_at is null or v_pt.last_seen_at < now() - interval '10 minutes' then
      update public.projector_token set last_seen_at = now() where id = v_pt.id;
      if v_pt.org_session_id is not null then
        update public.org_sessions set last_seen_at = now() where id = v_pt.org_session_id;
      end if;
    end if;

    return jsonb_build_object(
      'ok', true,
      'changed', false,
      'cursor', v_cursor,
      'expires_at', v_pt.expires_at,
      'event_ended', false
    );
  end if;

  -- Changed rows only (version > v_since). Raw allowlisted fields only; zero ranking maths.
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', p.id,
        'org_id', p.org_id,
        'identity_id', coalesce(p.identity_id, ''),
        'sl_no', coalesce(p.sl_no::text, ''),
        'name', coalesce(p.name, ''),
        'school', coalesce(p.school, ''),
        'class_or_age', p.class_or_age,
        'custom_values', coalesce(p.custom_values, '{}'::jsonb),
        'is_active', coalesce(p.is_active, true),
        'created_at', p.created_at
      )
    ),
    '[]'::jsonb
  )
  into v_participants
  from public.participants p
  where upper(p.org_id) = upper(v_pt.org_id)
    and coalesce(p.version, 1) > v_since;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', j.id,
        'org_id', j.org_id,
        'name', coalesce(j.name, ''),
        'judge_id', coalesce(j.judge_id, ''),
        'assigned_events', coalesce(j.assigned_events, '{}'::text[]),
        'is_active', coalesce(j.is_active, true),
        'created_at', j.created_at
      )
    ),
    '[]'::jsonb
  )
  into v_judges
  from public.judges j
  where upper(j.org_id) = upper(v_pt.org_id)
    and coalesce(j.version, 1) > v_since;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'event_id', s.event_id,
        'judge_id', s.judge_id,
        'participant_id', s.participant_id,
        'total_score', s.total_score,
        'created_at', s.created_at
      )
    ),
    '[]'::jsonb
  )
  into v_scores
  from public.scores s
  where s.event_id = v_pt.event_id
    and coalesce(s.version, 1) > v_since;

  -- Scoped event tie rounds (allowlisted 12 fields only, including 'shared' rules)
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'event_id', r.event_id,
        'group_key', r.group_key,
        'tied_rank', r.tied_rank,
        'tied_participant_ids', to_jsonb(r.tied_participant_ids),
        'rule', r.rule,
        'status', r.status,
        'is_stale', r.is_stale,
        'score_fingerprint', r.score_fingerprint,
        'result_payload', r.result_payload,
        'published_at', r.published_at,
        'version', r.version
      )
      order by r.tied_rank asc, r.id asc
    ),
    '[]'::jsonb
  )
  into v_tie_rounds
  from public.tie_rounds r
  where r.event_id = v_pt.event_id
    and upper(r.org_id) = upper(v_pt.org_id)
    and coalesce(r.version, 1) > v_since;

  if v_since > 0 then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'table_name', d.table_name,
          'record_id', d.record_id,
          'version', d.version
        )
        order by d.version asc
      ),
      '[]'::jsonb
    )
    into v_deletions
    from public.sync_deletions d
    where upper(d.org_id) = upper(v_pt.org_id)
      and d.version > v_since
      and d.table_name in ('participants', 'judges', 'scores', 'tie_rounds');
  end if;

  -- On event end: deliver this final delta AND immediately revoke session + free org_sessions slot
  if v_event_ended then
    update public.projector_token
    set revoked_at = now(),
        revoked_reason = 'event_ended',
        last_seen_at = now()
    where id = v_pt.id and revoked_at is null;

    if v_pt.org_session_id is not null then
      update public.org_sessions
      set revoked_at = now(),
          last_seen_at = now()
      where id = v_pt.org_session_id and revoked_at is null;
    end if;
  elsif v_pt.last_seen_at is null or v_pt.last_seen_at < now() - interval '10 minutes' then
    update public.projector_token set last_seen_at = now() where id = v_pt.id;
    if v_pt.org_session_id is not null then
      update public.org_sessions set last_seen_at = now() where id = v_pt.org_session_id;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'changed', true,
    'cursor', v_cursor,
    'expires_at', v_pt.expires_at,
    'event_ended', v_event_ended,
    'org', jsonb_build_object(
      'org_id', v_org.org_id,
      'name', v_org.name,
      'tie_breaker_enabled', coalesce(v_org.tie_breaker_enabled, false),
      'tie_breaker_method', coalesce(v_org.tie_breaker_method, 'olympic'),
      'tie_management_enabled', coalesce(v_org.tie_management_enabled, false),
      'tie_rule', coalesce(v_org.tie_rule, 'countback'),
      'projector_spotlight_mode', coalesce(v_org.projector_spotlight_mode, true),
      'projector_ticker_text', coalesce(v_org.projector_ticker_text, ''),
      'created_at', v_org.created_at
    ),
    'event', jsonb_build_object(
      'id', v_event.id,
      'org_id', v_event.org_id,
      'name', v_event.name,
      'category', coalesce(v_event.category, ''),
      'status', lower(coalesce(v_event.status, 'draft')),
      'is_locked', coalesce(v_event.is_locked, false),
      'is_archived', coalesce(v_event.is_archived, false),
      'rubric_schema', coalesce(v_event.rubric_schema, '[]'::jsonb),
      'assigned_judges', coalesce(v_event.assigned_judges, '{}'::text[]),
      'assigned_participants', coalesce(v_event.assigned_participants, '{}'::text[]),
      'participant_sl_numbers', coalesce(v_event.participant_sl_numbers, '{}'::jsonb),
      'date', v_event.date,
      'created_at', v_event.created_at
    ),
    'participants', v_participants,
    'judges', v_judges,
    'scores', v_scores,
    'tie_rounds', v_tie_rounds,
    'deletions', v_deletions
  );
end;
$$;

revoke all on function public.projector_changes(text, bigint) from public;
grant execute on function public.projector_changes(text, bigint) to anon, authenticated;

-- PART 5 VERIFICATION (read-only, returns ONE jsonb cell)
with roc as (
  select p.oid, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'read_org_changes'
    and pg_get_function_identity_arguments(p.oid) = 'p_token text, p_since bigint'
  limit 1
),
prj as (
  select p.oid, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'projector_changes'
    and pg_get_function_identity_arguments(p.oid) = 'p_token text, p_since bigint'
  limit 1
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_5',
  'read_org_changes_exists', exists (select 1 from roc where prosecdef = true),
  'read_org_changes_grants_ok', (
    coalesce((select has_function_privilege('anon', oid, 'execute') from roc), false)
    and coalesce((select has_function_privilege('authenticated', oid, 'execute') from roc), false)
    and exists (
      select 1 from roc
      where proacl is not null
        and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
    )
  ),
  'read_org_changes_has_tie_fields', exists (
    select 1 from roc
    where position('''tie_rounds''' in def) > 0
      and position('''tie_round_grades''' in def) > 0
      and position('''tie_audit_log''' in def) > 0
      and position('g.judge_id = v_judge_id' in def) > 0
      and position('v_tie_audit_log := ''[]''::jsonb' in def) > 0
  ),
  'read_org_changes_no_pii_or_secrets', exists (
    select 1 from roc
    where position('mobile_number' in lower(def)) = 0
      and position('pin_hash' in lower(def)) = 0
      and position('pin_encrypted' in lower(def)) = 0
      and position('current_session_token' in lower(def)) = 0
  ),
  'projector_changes_exists', exists (select 1 from prj where prosecdef = true),
  'projector_changes_grants_ok', (
    coalesce((select has_function_privilege('anon', oid, 'execute') from prj), false)
    and coalesce((select has_function_privilege('authenticated', oid, 'execute') from prj), false)
    and exists (
      select 1 from prj
      where proacl is not null
        and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
    )
  ),
  'projector_changes_has_tie_rounds', exists (
    select 1 from prj
    where position('''tie_rounds''' in def) > 0
      and position('''tie_management_enabled''' in def) > 0
      and position('''tie_rule''' in def) > 0
      and position('''result_payload''' in def) > 0
  ),
  'projector_changes_clean_allowlist', exists (
    select 1 from prj
    where position('tie_audit_log' in lower(def)) = 0
      and position('tie_round_grades' in lower(def)) = 0
      and position('actor_label' in lower(def)) = 0
      and position('last_reopen_reason' in lower(def)) = 0
      and position('decided_by' in lower(def)) = 0
      and position('mobile_number' in lower(def)) = 0
      and position('pin_hash' in lower(def)) = 0
      and position('pin_encrypted' in lower(def)) = 0
      and position('current_session_token' in lower(def)) = 0
      and position('array[]::uuid[]' in lower(def)) = 0
  )
) as verify_17_7_0_part_5;


-- ===============================================================================
-- COMBINED FINAL VERIFICATION FOR PARTS 4 & 5 (read-only, ONE jsonb cell)
-- ===============================================================================

with judge_rpcs as (
  select p.oid, p.proname, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('judge_tie_round_read', 'judge_tie_grade_upsert')
),
roc as (
  select p.oid, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'read_org_changes'
    and pg_get_function_identity_arguments(p.oid) = 'p_token text, p_since bigint'
  limit 1
),
prj as (
  select p.oid, p.prosecdef, p.proacl, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'projector_changes'
    and pg_get_function_identity_arguments(p.oid) = 'p_token text, p_since bigint'
  limit 1
)
select jsonb_build_object(
  'part', 'verify_17_7_0_part_4_5_all',
  'judge_rpcs_exist_and_secdef', (
    (select count(distinct proname)::int from judge_rpcs where prosecdef = true) = 2
  ),
  'judge_rpcs_grants_ok', (
    (select count(*)::int from judge_rpcs where has_function_privilege('anon', oid, 'execute')) = 2
    and (select count(*)::int from judge_rpcs where has_function_privilege('authenticated', oid, 'execute')) = 2
    and (
      select count(*)::int
      from judge_rpcs
      where proacl is not null
        and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
    ) = 2
  ),
  'judge_rpcs_filter_own_judge_id', (
    exists (select 1 from judge_rpcs where proname = 'judge_tie_round_read' and position('g.judge_id = v_judge_id' in def) > 0)
    and exists (select 1 from judge_rpcs where proname = 'judge_tie_grade_upsert' and position('v_judge_id' in def) > 0)
  ),
  'read_org_changes_ok', (
    exists (select 1 from roc where prosecdef = true)
    and exists (
      select 1 from roc
      where position('''tie_rounds''' in def) > 0
        and position('''tie_round_grades''' in def) > 0
        and position('''tie_audit_log''' in def) > 0
        and position('g.judge_id = v_judge_id' in def) > 0
        and position('v_tie_audit_log := ''[]''::jsonb' in def) > 0
        and position('mobile_number' in lower(def)) = 0
        and position('pin_hash' in lower(def)) = 0
        and position('pin_encrypted' in lower(def)) = 0
        and position('current_session_token' in lower(def)) = 0
    )
  ),
  'projector_changes_ok', (
    exists (select 1 from prj where prosecdef = true)
    and exists (
      select 1 from prj
      where position('''tie_rounds''' in def) > 0
        and position('''tie_management_enabled''' in def) > 0
        and position('''tie_rule''' in def) > 0
        and position('tie_audit_log' in lower(def)) = 0
        and position('tie_round_grades' in lower(def)) = 0
        and position('actor_label' in lower(def)) = 0
        and position('last_reopen_reason' in lower(def)) = 0
        and position('decided_by' in lower(def)) = 0
        and position('mobile_number' in lower(def)) = 0
        and position('pin_hash' in lower(def)) = 0
        and position('pin_encrypted' in lower(def)) = 0
        and position('current_session_token' in lower(def)) = 0
        and position('array[]::uuid[]' in lower(def)) = 0
    )
  )
) as verify_17_7_0_part_4_5_all;
