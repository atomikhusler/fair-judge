-- ═════════════════════════════════════════════════════════════════════════════
-- PHASE 17.6.1 — PROJECTOR_CHANGES TYPE FIX (text[] COALESCE + sl_no::text)
-- ═════════════════════════════════════════════════════════════════════════════
-- WRITE ONLY — Run in Supabase SQL Editor. Idempotent; safe to re-run.
-- Fixes PostgreSQL runtime error 42804 (COALESCE types text[] and uuid[] cannot
-- be matched) on judges.assigned_events, events.assigned_judges, and
-- events.assigned_participants, plus defensive sl_no::text cast.
-- ═════════════════════════════════════════════════════════════════════════════


-- =============================================================================
-- PART 1 OF 1: Replace public.projector_changes(text, bigint)
-- =============================================================================

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
  v_deletions jsonb := '[]'::jsonb;
begin
  v_hash := public._fj_hash_org_token(p_token);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'revoked', 'message', 'Missing projector token.');
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

  -- Load org (non-PII columns only) and ensure org is active
  select
    o.org_id,
    o.name,
    o.tie_breaker_enabled,
    o.tie_breaker_method,
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

  -- Changed rows only (version > v_since). ZERO ranking maths, ZERO mobile_number / PINs / tokens.
  -- Participant names always returned even when blind_judging_enabled = true on the org.
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
      and d.table_name in ('participants', 'judges', 'scores');
  end if;

  -- On event end: deliver this final delta AND immediately revoke token + free org_sessions slot
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
    'deletions', v_deletions
  );
end;
$$;

revoke all on function public.projector_changes(text, bigint) from public;
grant execute on function public.projector_changes(text, bigint) to anon, authenticated;

-- PART 1 VERIFICATION (single JSONB cell)
with fn as (
  select p.oid, p.prosecdef, pg_get_functiondef(p.oid) as def
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'projector_changes'
    and pg_get_function_identity_arguments(p.oid) = 'p_token text, p_since bigint'
  limit 1
)
select jsonb_build_object(
  'part', 'verify_17_6_1_part_1',
  'projector_changes_exists', exists(select 1 from fn where prosecdef = true),
  'anon_can_execute', has_function_privilege(
    'anon',
    'public.projector_changes(text, bigint)',
    'execute'
  ),
  'no_uuid_array_cast', coalesce((select def not ilike '%array[]::uuid[]%' from fn), false)
) as verify_17_6_1_part_1;
