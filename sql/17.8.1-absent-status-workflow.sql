-- ===============================================================================
-- STEP 2: ABSENT STATUS WORKFLOW & TIE DETECTOR ZERO FIX
-- (WRITE ONLY — DO NOT AUTO-RUN; owner runs in Supabase SQL Editor)
-- ===============================================================================
-- Adds:
--   1. public.participant_absences table (separate Absent status, RLS + triggers)
--   2. public.tie_audit_log constraint extension for request_absent / confirm_absent / reject_absent
--   3. RPCs: absence_request, absence_resolve, absences_list
--   4. Updated public._fj_detect_event_tie_groups (skips confirmed Absent & is_absent)
--   5. Updated public.score_upsert_batch (blocks marks for confirmed Absent participants)
-- Ends with ONE read-only single-cell JSONB verification query.
-- ===============================================================================

-- 1. Separate Absent status table
create table if not exists public.participant_absences (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  event_id uuid not null references public.events(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  requested_by_judge_id uuid null references public.judges(id) on delete set null,
  status text not null constraint chk_participant_absences_status check (
    status in ('pending', 'confirmed', 'rejected')
  ),
  is_sealed boolean not null default false,
  resolved_by text not null default '',
  requested_at timestamptz not null default now(),
  resolved_at timestamptz null,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  constraint uq_participant_absences_event_participant unique (event_id, participant_id)
);

create index if not exists idx_participant_absences_org_ver
  on public.participant_absences (upper(org_id), version);

create index if not exists idx_participant_absences_event_status
  on public.participant_absences (event_id, status);

alter table public.participant_absences enable row level security;
revoke all on table public.participant_absences from public, anon, authenticated;

drop trigger if exists trg_fj_sync_participant_absences_version on public.participant_absences;
create trigger trg_fj_sync_participant_absences_version
  before insert or update on public.participant_absences
  for each row
  execute function public._fj_trg_sync_child_upsert();

drop trigger if exists trg_fj_sync_participant_absences_delete on public.participant_absences;
create trigger trg_fj_sync_participant_absences_delete
  after delete on public.participant_absences
  for each row
  execute function public._fj_trg_sync_child_delete();

-- 2. Extend tie_audit_log check constraints so every absence request & decision logs append-only
alter table public.tie_audit_log
  drop constraint if exists chk_tie_audit_action;

alter table public.tie_audit_log
  add constraint chk_tie_audit_action check (
    action in (
      'apply_countback',
      'apply_olympic',
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

alter table public.tie_audit_log
  drop constraint if exists chk_tie_audit_rule;

alter table public.tie_audit_log
  add constraint chk_tie_audit_rule check (
    rule in ('countback', 'olympic', 'recompete', 'shared', 'absent')
  );

-- 3. Judge RPC: request Absent (one judge is enough; creates/re-opens pending request and logs)
create or replace function public.absence_request(
  p_token text,
  p_event_id uuid,
  p_participant_id uuid
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
  v_judge_name text := 'Judge';
  v_judge_assigned_events text[] := '{}'::text[];
  v_event public.events;
  v_participant public.participants;
  v_existing public.participant_absences;
  v_row public.participant_absences;
begin
  v_auth := public._fj_verify_judge_token(p_token);
  if not coalesce((v_auth->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_auth->>'error', 'unauthorized'),
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_judge_id := (v_auth->>'judge_id')::uuid;
  v_org_id := v_auth->>'org_id';

  if p_event_id is null or p_participant_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_input',
      'message', 'Event ID and participant ID are required.'
    );
  end if;

  select * into v_event
  from public.events e
  where e.id = p_event_id
    and upper(e.org_id) = upper(v_org_id)
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Target event not found.'
    );
  end if;

  if coalesce(v_event.is_archived, false) = true
     or lower(coalesce(v_event.status, 'draft')) in ('ended', 'archived') then
    return jsonb_build_object(
      'ok', false,
      'error', 'event_ended',
      'message', 'Event has ended.'
    );
  end if;

  select coalesce(nullif(btrim(j.name), ''), 'Judge'), coalesce(j.assigned_events, '{}'::text[])
  into v_judge_name, v_judge_assigned_events
  from public.judges j
  where j.id = v_judge_id
    and upper(j.org_id) = upper(v_org_id)
    and coalesce(j.is_active, true) = true
  limit 1;

  if not (
    coalesce(lower(v_event.status), '') = 'active'
    or cardinality(coalesce(v_event.assigned_judges, '{}'::text[])) = 0
    or v_judge_id::text = any(coalesce(v_event.assigned_judges, '{}'::text[]))
    or v_event.id::text = any(v_judge_assigned_events)
  ) then
    return jsonb_build_object(
      'ok', false,
      'error', 'forbidden',
      'message', 'Judge is not assigned to this event.'
    );
  end if;

  select * into v_participant
  from public.participants p
  where p.id = p_participant_id
    and upper(p.org_id) = upper(v_org_id)
    and coalesce(p.is_active, true) = true
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Participant not found.'
    );
  end if;

  if cardinality(coalesce(v_event.assigned_participants, '{}'::text[])) > 0
     and not (p_participant_id::text = any(coalesce(v_event.assigned_participants, '{}'::text[]))) then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_participant',
      'message', 'Participant is not assigned to this event.'
    );
  end if;

  select * into v_existing
  from public.participant_absences pa
  where pa.event_id = p_event_id
    and pa.participant_id = p_participant_id
  for update;

  if found then
    if v_existing.status = 'confirmed' or v_existing.is_sealed = true then
      return jsonb_build_object(
        'ok', false,
        'error', 'already_confirmed',
        'message', 'Absent is already confirmed and sealed.'
      );
    end if;

    if v_existing.status = 'pending' then
      return jsonb_build_object('ok', true, 'data', to_jsonb(v_existing));
    end if;

    update public.participant_absences
    set
      requested_by_judge_id = v_judge_id,
      status = 'pending',
      is_sealed = false,
      resolved_by = '',
      requested_at = now(),
      resolved_at = null,
      updated_at = now()
    where id = v_existing.id
    returning * into v_row;
  else
    insert into public.participant_absences (
      org_id,
      event_id,
      participant_id,
      requested_by_judge_id,
      status,
      is_sealed,
      resolved_by,
      requested_at,
      resolved_at
    )
    values (
      v_event.org_id,
      v_event.id,
      p_participant_id,
      v_judge_id,
      'pending',
      false,
      '',
      now(),
      null
    )
    returning * into v_row;
  end if;

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
    'absent:' || p_participant_id::text,
    'request_absent',
    'absent',
    left(v_judge_name, 80),
    jsonb_build_object('participant_id', p_participant_id, 'judge_id', v_judge_id),
    jsonb_build_object('absence_id', v_row.id, 'participant_id', p_participant_id, 'status', 'pending'),
    'pending',
    ''
  );

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
end;
$$;

revoke all on function public.absence_request(text, uuid, uuid) from public;
grant execute on function public.absence_request(text, uuid, uuid) to anon, authenticated;

-- 4. Organiser RPC: Confirm or Reject an Absent request (logs decision)
create or replace function public.absence_resolve(
  p_token text,
  p_absence_id uuid,
  p_decision text,
  p_actor_label text default 'Organiser'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_decision text;
  v_actor text;
  v_existing public.participant_absences;
  v_event public.events;
  v_row public.participant_absences;
  v_next_status text;
  v_next_sealed boolean;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    return jsonb_build_object(
      'ok', false,
      'error', 'unauthorized',
      'message', 'Session expired or invalid. Please sign in again.'
    );
  end if;

  v_decision := lower(btrim(coalesce(p_decision, '')));
  if v_decision not in ('confirm', 'reject') then
    return jsonb_build_object(
      'ok', false,
      'error', 'invalid_decision',
      'message', 'Decision must be confirm or reject.'
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

  select * into v_existing
  from public.participant_absences pa
  where pa.id = p_absence_id
    and upper(pa.org_id) = upper(v_org_id)
  for update;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'not_found',
      'message', 'Absence request not found.'
    );
  end if;

  select * into v_event
  from public.events e
  where e.id = v_existing.event_id
    and upper(e.org_id) = upper(v_org_id)
  for update;

  if v_existing.status = 'confirmed' or v_existing.is_sealed = true then
    return jsonb_build_object(
      'ok', false,
      'error', 'already_sealed',
      'message', 'Absent is already confirmed and sealed.'
    );
  end if;

  if v_decision = 'confirm' then
    v_next_status := 'confirmed';
    v_next_sealed := true;
  else
    v_next_status := 'rejected';
    v_next_sealed := false;
  end if;

  update public.participant_absences
  set
    status = v_next_status,
    is_sealed = v_next_sealed,
    resolved_by = v_actor,
    resolved_at = now(),
    updated_at = now()
  where id = v_existing.id
  returning * into v_row;

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
    v_existing.org_id,
    v_existing.event_id,
    coalesce(v_event.name, ''),
    null,
    'absent:' || v_existing.participant_id::text,
    case when v_decision = 'confirm' then 'confirm_absent' else 'reject_absent' end,
    'absent',
    v_actor,
    jsonb_build_object(
      'absence_id', v_existing.id,
      'participant_id', v_existing.participant_id,
      'previous_status', v_existing.status
    ),
    jsonb_build_object(
      'absence_id', v_row.id,
      'participant_id', v_row.participant_id,
      'status', v_row.status,
      'is_sealed', v_row.is_sealed
    ),
    v_row.status,
    ''
  );

  return jsonb_build_object('ok', true, 'data', to_jsonb(v_row));
end;
$$;

revoke all on function public.absence_resolve(text, uuid, text, text) from public;
grant execute on function public.absence_resolve(text, uuid, text, text) to anon, authenticated;

-- 5. Shared read RPC: list absences for organiser or judge
create or replace function public.absences_list(
  p_token text,
  p_event_id uuid default null
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
  v_rows jsonb := '[]'::jsonb;
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
  v_role := coalesce(v_auth->>'role', 'judge');

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', pa.id,
        'org_id', pa.org_id,
        'event_id', pa.event_id,
        'participant_id', pa.participant_id,
        'requested_by_judge_id', pa.requested_by_judge_id,
        'status', pa.status,
        'is_sealed', pa.is_sealed,
        'resolved_by', case when v_role = 'organiser' then pa.resolved_by else '' end,
        'requested_at', pa.requested_at,
        'resolved_at', pa.resolved_at,
        'version', pa.version,
        'updated_at', pa.updated_at
      )
      order by pa.requested_at desc, pa.id desc
    ),
    '[]'::jsonb
  )
  into v_rows
  from public.participant_absences pa
  where upper(pa.org_id) = upper(v_org_id)
    and (p_event_id is null or pa.event_id = p_event_id);

  return jsonb_build_object('ok', true, 'data', v_rows);
end;
$$;

revoke all on function public.absences_list(text, uuid) from public;
grant execute on function public.absences_list(text, uuid) to anon, authenticated;

-- 6. Tie detector zero/Absent fix: skip confirmed Absent participants & is_absent score markers
create or replace function public._fj_detect_event_tie_groups(
  p_event_id uuid
)
returns table (
  group_key text,
  tied_rank integer,
  tied_avg numeric,
  tied_participant_ids text[],
  score_fingerprint text,
  member_scores jsonb
)
language sql
security definer
set search_path = public, extensions
as $$
  with latest_scores as (
    select distinct on (s.participant_id, s.judge_id)
      s.participant_id,
      s.judge_id,
      s.total_score::numeric as score_val
    from public.scores s
    join public.events e on e.id = s.event_id
    join public.participants p
      on p.id = s.participant_id
     and upper(p.org_id) = upper(e.org_id)
    join public.judges j
      on j.id = s.judge_id
     and upper(j.org_id) = upper(e.org_id)
    where s.event_id = p_event_id
      and s.total_score is not null
      and coalesce((s.score_payload->>'is_absent')::boolean, false) = false
      and coalesce(p.is_active, true) = true
      and coalesce(j.is_active, true) = true
      and not exists (
        select 1
        from public.participant_absences pa
        where pa.event_id = p_event_id
          and pa.participant_id = p.id
          and pa.status = 'confirmed'
      )
      and (
        cardinality(coalesce(e.assigned_participants, '{}'::text[])) = 0
        or p.id::text = any(coalesce(e.assigned_participants, '{}'::text[]))
      )
      and (
        cardinality(coalesce(e.assigned_judges, '{}'::text[])) = 0
        or j.id::text = any(coalesce(e.assigned_judges, '{}'::text[]))
        or e.id::text = any(coalesce(j.assigned_events, '{}'::text[]))
      )
    order by s.participant_id, s.judge_id, s.created_at desc, s.id desc
  ),
  per_participant as (
    select
      ls.participant_id,
      round(avg(ls.score_val), 2) as avg_val,
      count(*)::int as ballot_count,
      array_agg(ls.score_val order by ls.score_val desc) as scores_desc,
      string_agg(
        ls.judge_id::text || '=' || to_char(ls.score_val, 'FM999999990.0000'),
        ',' order by ls.judge_id::text
      ) as ballots_canon,
      jsonb_agg(
        jsonb_build_object('judge_id', ls.judge_id, 'score', ls.score_val)
        order by ls.judge_id::text
      ) as judge_scores
    from latest_scores ls
    group by ls.participant_id
  ),
  ranked as (
    select
      pp.*,
      rank() over (order by pp.avg_val desc)::int as comp_rank
    from per_participant pp
  ),
  grouped as (
    select
      r.comp_rank as tied_rank,
      min(r.avg_val) as tied_avg,
      string_agg(r.participant_id::text, ',' order by r.participant_id::text) as group_key,
      array_agg(r.participant_id::text order by r.participant_id::text) as tied_participant_ids,
      's1:' || md5(
        string_agg(
          r.participant_id::text || '[' || r.ballots_canon || ']',
          '|' order by r.participant_id::text
        )
      ) as score_fingerprint,
      jsonb_agg(
        jsonb_build_object(
          'participant_id', r.participant_id,
          'avg_score', r.avg_val,
          'ballot_count', r.ballot_count,
          'scores_desc', to_jsonb(r.scores_desc),
          'judge_scores', r.judge_scores
        )
        order by r.participant_id::text
      ) as member_scores,
      count(*)::int as member_count
    from ranked r
    group by r.comp_rank
    having count(*) >= 2
  )
  select
    g.group_key,
    g.tied_rank,
    g.tied_avg,
    g.tied_participant_ids,
    g.score_fingerprint,
    g.member_scores
  from grouped g
  order by g.tied_rank asc;
$$;

revoke all on function public._fj_detect_event_tie_groups(uuid) from public, anon, authenticated;

-- 7. Block score writes for confirmed Absent participants
create or replace function public.score_upsert_batch(
  p_token text,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_org_id text;
  v_judge_auth jsonb;
  v_judge_id uuid;
  v_judge_org text;
  rec jsonb;
  v_id uuid;
  v_event_id uuid;
  v_rec_judge_id uuid;
  v_participant_id uuid;
  v_event_org text;
  v_event_status text;
  v_assigned_judges text[];
  v_grace_enabled boolean;
  v_existing public.scores;
  v_row public.scores;
  v_out jsonb := '[]'::jsonb;
begin
  v_org_id := public._fj_verify_org_token(p_token, null);
  if v_org_id is null then
    v_judge_auth := public._fj_verify_judge_token(p_token);
    if not coalesce((v_judge_auth->>'ok')::boolean, false) then
      return jsonb_build_object('ok', false, 'error', 'unauthorized', 'message', 'Session expired or invalid. Please sign in again.');
    end if;
    v_judge_id := (v_judge_auth->>'judge_id')::uuid;
    v_judge_org := v_judge_auth->>'org_id';
  end if;

  for rec in select * from jsonb_array_elements(coalesce(p_records, '[]'::jsonb)) loop
    v_id := coalesce(nullif(rec->>'id', '')::uuid, gen_random_uuid());
    v_event_id := (rec->>'event_id')::uuid;
    v_rec_judge_id := (rec->>'judge_id')::uuid;
    v_participant_id := (rec->>'participant_id')::uuid;

    select e.org_id, lower(coalesce(e.status, '')), coalesce(e.assigned_judges, '{}'::text[])
    into v_event_org, v_event_status, v_assigned_judges
    from public.events e
    where e.id = v_event_id;

    if v_event_org is null then
      return jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'Target event not found.');
    end if;

    if v_org_id is not null then
      if upper(v_event_org) <> upper(v_org_id) then
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Cannot write scores for another organization.');
      end if;
    else
      if upper(v_event_org) <> upper(v_judge_org) or v_rec_judge_id <> v_judge_id then
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Judge token does not match score owner or organization.');
      end if;
      if not (v_judge_id::text = any(v_assigned_judges) or v_event_status = 'active') then
        return jsonb_build_object('ok', false, 'error', 'forbidden', 'message', 'Judge is not assigned to this event.');
      end if;
    end if;

    if exists (
      select 1
      from public.participant_absences pa
      where pa.event_id = v_event_id
        and pa.participant_id = v_participant_id
        and pa.status = 'confirmed'
    ) then
      return jsonb_build_object(
        'ok', false,
        'error', 'participant_absent',
        'message', 'Participant is confirmed Absent and sealed.'
      );
    end if;

    select * into v_existing
    from public.scores s
    where s.id = v_id
       or (s.event_id = v_event_id and s.judge_id = v_rec_judge_id and s.participant_id = v_participant_id)
    limit 1;

    if v_existing.id is not null and v_org_id is null then
      select coalesce(o.grace_period_enabled, false) into v_grace_enabled
      from public.organizations o
      where upper(o.org_id) = upper(v_event_org);

      if not coalesce(v_grace_enabled, false) or (now() - v_existing.created_at) > interval '5 minutes' then
        return jsonb_build_object('ok', false, 'error', 'RLS Permission Denied', 'message', 'RLS Permission Denied: Scores are immutable and cannot be updated once inserted.');
      end if;
    end if;

    if v_existing.id is not null then
      update public.scores
      set
        score_payload = coalesce(rec->'score_payload', score_payload),
        total_score = coalesce((rec->>'total_score')::numeric, total_score)
      where id = v_existing.id
      returning * into v_row;
    else
      insert into public.scores (
        id, event_id, judge_id, participant_id, score_payload, total_score, created_at
      ) values (
        v_id,
        v_event_id,
        v_rec_judge_id,
        v_participant_id,
        coalesce(rec->'score_payload', '{}'::jsonb),
        coalesce((rec->>'total_score')::numeric, 0),
        now()
      )
      returning * into v_row;
    end if;

    v_out := v_out || jsonb_build_array(to_jsonb(v_row));
  end loop;

  return jsonb_build_object('ok', true, 'data', v_out);
end;
$$;

revoke all on function public.score_upsert_batch(text, jsonb) from public;
grant execute on function public.score_upsert_batch(text, jsonb) to anon, authenticated;

-- STEP 2 VERIFICATION (read-only, returns ONE jsonb cell)
with absence_rpcs as (
  select
    p.oid,
    p.proname,
    p.prosecdef,
    p.proacl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('absence_request', 'absence_resolve', 'absences_list')
)
select jsonb_build_object(
  'step', 'verify_17_8_1_absent_status_workflow',
  'table_exists', to_regclass('public.participant_absences') is not null,
  'rls_enabled', coalesce((
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'participant_absences'
  ), false),
  'direct_grants_revoked', (
    not has_table_privilege('anon', 'public.participant_absences', 'select,insert,update,delete')
    and not has_table_privilege('authenticated', 'public.participant_absences', 'select,insert,update,delete')
  ),
  'rpcs_ready', (
    (select count(distinct proname)::int from absence_rpcs where prosecdef = true) = 3
    and (select count(*)::int from absence_rpcs where has_function_privilege('anon', oid, 'execute')) = 3
    and (select count(*)::int from absence_rpcs where has_function_privilege('authenticated', oid, 'execute')) = 3
    and (
      select count(*)::int
      from absence_rpcs
      where proacl is not null
        and not exists (select 1 from unnest(proacl) a where a::text like '=X/%')
    ) = 3
  ),
  'audit_constraints_updated', (
    position('request_absent' in coalesce(pg_get_constraintdef((
      select oid from pg_constraint
      where conrelid = to_regclass('public.tie_audit_log') and conname = 'chk_tie_audit_action'
    )), '')) > 0
    and position('absent' in coalesce(pg_get_constraintdef((
      select oid from pg_constraint
      where conrelid = to_regclass('public.tie_audit_log') and conname = 'chk_tie_audit_rule'
    )), '')) > 0
  ),
  'tie_detector_skips_absent', position(
    'participant_absences' in coalesce(pg_get_functiondef(to_regprocedure('public._fj_detect_event_tie_groups(uuid)')), '')
  ) > 0,
  'score_upsert_blocks_absent', position(
    'participant_absent' in coalesce(pg_get_functiondef(to_regprocedure('public.score_upsert_batch(text, jsonb)')), '')
  ) > 0
) as verify_17_8_1_absent_status_workflow;
