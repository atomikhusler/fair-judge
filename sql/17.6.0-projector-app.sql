-- ═════════════════════════════════════════════════════════════════════════════
-- PHASE P2 (17.6.0) — STANDALONE PROJECTOR APP
-- ═════════════════════════════════════════════════════════════════════════════
-- WRITE ONLY — Run each labelled PART independently in Supabase SQL Editor.
-- Every PART is idempotent and ends with a single-cell JSONB verification query.
--
-- Locked rules:
-- - Projector-only token scoped to ONE event (never returns an organiser token).
-- - Session limit: 8 hours, or until the event ends, whichever comes first.
-- - Only ONE active projector per organisation (a new login revokes the old one).
-- - Consumes 1 of the organisation's 3 active org_sessions slots so the
--   organiser can see and end it from the existing Organiser session list.
-- - Cursor-based delta reads (projector_changes) return raw rows ONLY:
--   ZERO ranking maths in SQL, ZERO mobile numbers / PINs / password hashes.
-- - On event end, projector_changes delivers the final delta with
--   event_ended = true, immediately revokes projector_token, and frees the
--   org_sessions slot.
-- ═════════════════════════════════════════════════════════════════════════════


-- =============================================================================
-- PART 1 OF 4: public.projector_token table, indexes, RLS lockdown
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.projector_token (
  id uuid primary key default gen_random_uuid(),
  org_id text not null,
  org_session_id uuid references public.org_sessions(id) on delete cascade,
  event_id uuid not null,
  token_hash text not null,
  device_label text not null default 'Projector Display',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '8 hours'),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text
);

create unique index if not exists idx_projector_token_hash
  on public.projector_token(token_hash);

-- Enforce strictly ONE active projector per organisation at the database level
create unique index if not exists idx_projector_token_one_active_per_org
  on public.projector_token(upper(org_id))
  where revoked_at is null;

create index if not exists idx_projector_token_org_session
  on public.projector_token(org_session_id)
  where org_session_id is not null;

create index if not exists idx_projector_token_expires_at
  on public.projector_token(expires_at);

-- Fast delta score reads scoped by (event_id, version)
create index if not exists idx_scores_event_version
  on public.scores(event_id, version);

alter table public.projector_token enable row level security;
revoke all on table public.projector_token from public, anon, authenticated;

-- PART 1 VERIFICATION (single JSONB cell)
select jsonb_build_object(
  'part', 'verify_part_1',
  'table_exists', to_regclass('public.projector_token') is not null,
  'rls_enabled', coalesce((
    select c.relrowsecurity
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'projector_token'
  ), false),
  'direct_table_grants', coalesce((
    select count(*)
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'projector_token'
      and grantee in ('anon', 'authenticated', 'PUBLIC')
  ), 0),
  'one_active_per_org_index', exists(
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'projector_token'
      and indexname = 'idx_projector_token_one_active_per_org'
  ),
  'scores_event_version_index', exists(
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'scores'
      and indexname = 'idx_scores_event_version'
  )
) as verify_part_1;


-- =============================================================================
-- PART 2 OF 4: public.projector_login RPC (8-hour single-event token)
-- =============================================================================

create or replace function public.projector_login(
  p_identifier text,
  p_password text,
  p_event_id uuid default null,
  p_device_label text default 'Projector Display',
  p_revoke_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_verify jsonb;
  v_org_id text;
  v_org record;
  v_events jsonb;
  v_event record;
  v_prev_session_ids uuid[];
  v_active_count int := 0;
  v_sessions jsonb;
  v_org_session_id uuid;
  v_raw_token text;
  v_token_hash text;
  v_expires_at timestamptz := now() + interval '8 hours';
  v_label text;
begin
  -- 1. Verify organiser credentials through existing throttled bcrypt verifier
  v_verify := public._fj_verify_org(p_identifier, p_password);
  if not coalesce((v_verify->>'ok')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'error', coalesce(v_verify->>'error', v_verify->>'reason', 'invalid_credentials'),
      'message', coalesce(v_verify->>'message', 'Invalid organisation ID or password.')
    );
  end if;

  v_org_id := v_verify->>'org_id';

  select o.org_id, o.name, o.suspended, o.deleted_at
  into v_org
  from public.organizations o
  where upper(o.org_id) = upper(v_org_id)
  limit 1;

  if not found or coalesce(v_org.suspended, false) or v_org.deleted_at is not null then
    return jsonb_build_object(
      'ok', false,
      'error', 'org_unavailable',
      'message', 'This organisation account is not active.'
    );
  end if;

  -- 2. Step 1: No event selected yet -> return non-ended, non-archived events
  if p_event_id is null then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', e.id,
          'name', e.name,
          'category', coalesce(e.category, ''),
          'status', lower(coalesce(e.status, 'draft')),
          'date', e.date
        )
        order by
          case when lower(coalesce(e.status, 'draft')) = 'active' then 0 else 1 end,
          e.created_at desc
      ),
      '[]'::jsonb
    )
    into v_events
    from public.events e
    where upper(e.org_id) = upper(v_org.org_id)
      and coalesce(e.is_archived, false) = false
      and lower(coalesce(e.status, 'draft')) not in ('ended', 'archived');

    return jsonb_build_object(
      'ok', true,
      'needs_event_selection', true,
      'org', jsonb_build_object(
        'org_id', v_org.org_id,
        'name', v_org.name
      ),
      'events', v_events
    );
  end if;

  -- 3. Step 2: Validate scoped event belongs to org and is not ended/archived
  select e.id, e.name, e.category, e.status, e.is_archived
  into v_event
  from public.events e
  where e.id = p_event_id
    and upper(e.org_id) = upper(v_org.org_id)
  limit 1;

  if not found then
    return jsonb_build_object(
      'ok', false,
      'error', 'event_not_found',
      'message', 'Selected event was not found for this organisation.'
    );
  end if;

  if coalesce(v_event.is_archived, false)
     or lower(coalesce(v_event.status, 'draft')) in ('ended', 'archived') then
    return jsonb_build_object(
      'ok', false,
      'error', 'event_ended',
      'message', 'This event has already ended. Choose an active or upcoming event.'
    );
  end if;

  -- Serialize per-org projector + session slot operations
  perform pg_advisory_xact_lock(hashtext('fj_projector_org:' || upper(v_org.org_id)));

  -- 4. Expire stale projector tokens and revoke any existing active projector for this org
  --    (Rule: strictly ONE active projector per org; new login replaces the old one and reuses its slot)
  select array_agg(pt.org_session_id)
  into v_prev_session_ids
  from public.projector_token pt
  where upper(pt.org_id) = upper(v_org.org_id)
    and pt.revoked_at is null
    and pt.org_session_id is not null;

  update public.projector_token
  set revoked_at = now(),
      revoked_reason = case
        when expires_at <= now() then 'expired'
        else 'replaced'
      end
  where upper(org_id) = upper(v_org.org_id)
    and revoked_at is null;

  if v_prev_session_ids is not null and array_length(v_prev_session_ids, 1) > 0 then
    update public.org_sessions
    set revoked_at = now()
    where id = any(v_prev_session_ids)
      and revoked_at is null;
  end if;

  -- 5. Optional eviction if user chose a device to log out from SessionLimitSheet
  if p_revoke_session_id is not null then
    update public.org_sessions
    set revoked_at = now()
    where id = p_revoke_session_id
      and upper(org_id) = upper(v_org.org_id)
      and revoked_at is null;

    update public.projector_token
    set revoked_at = now(),
        revoked_reason = 'organiser_ended'
    where org_session_id = p_revoke_session_id
      and upper(org_id) = upper(v_org.org_id)
      and revoked_at is null;
  end if;

  -- 6. Enforce organisation's 3 active org_sessions limit
  select count(*)
  into v_active_count
  from public.org_sessions s
  where upper(s.org_id) = upper(v_org.org_id)
    and s.revoked_at is null
    and s.expires_at > now();

  if v_active_count >= 3 then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'id', s.id,
          'device_label', coalesce(nullif(btrim(s.device_label), ''), 'Unknown device'),
          'created_at', s.created_at,
          'last_seen_at', s.last_seen_at,
          'expires_at', s.expires_at,
          'is_same_device', false
        )
        order by s.created_at asc
      ),
      '[]'::jsonb
    )
    into v_sessions
    from public.org_sessions s
    where upper(s.org_id) = upper(v_org.org_id)
      and s.revoked_at is null
      and s.expires_at > now();

    return jsonb_build_object(
      'ok', false,
      'error', 'session_limit_reached',
      'message', 'All 3 active organisation session slots are in use. Log out one device to start the projector.',
      'sessions', v_sessions
    );
  end if;

  -- 7. Consume 1 org_sessions slot with a non-callable sentinel token_hash
  --    (Visible & terminable in Organiser AccountModal; NEVER usable as an organiser token)
  v_label := 'Projector — ' || left(coalesce(nullif(btrim(v_event.name), ''), 'Event'), 40);

  insert into public.org_sessions (
    org_id,
    token_hash,
    device_id,
    device_label,
    created_at,
    last_seen_at,
    expires_at
  )
  values (
    v_org.org_id,
    'projector_slot:' || encode(extensions.gen_random_bytes(32), 'hex'),
    'projector',
    v_label,
    now(),
    now(),
    v_expires_at
  )
  returning id into v_org_session_id;

  -- 8. Mint 256-bit single-event projector_token (8-hour expiry)
  v_raw_token := 'pjt_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := public._fj_hash_org_token(v_raw_token);

  insert into public.projector_token (
    org_id,
    org_session_id,
    event_id,
    token_hash,
    device_label,
    created_at,
    expires_at,
    last_seen_at
  )
  values (
    v_org.org_id,
    v_org_session_id,
    v_event.id,
    v_token_hash,
    left(coalesce(nullif(btrim(p_device_label), ''), v_label), 64),
    now(),
    v_expires_at,
    now()
  );

  return jsonb_build_object(
    'ok', true,
    'projector_token', v_raw_token,
    'expires_at', v_expires_at,
    'org', jsonb_build_object(
      'org_id', v_org.org_id,
      'name', v_org.name
    ),
    'event', jsonb_build_object(
      'id', v_event.id,
      'name', v_event.name,
      'category', coalesce(v_event.category, ''),
      'status', lower(coalesce(v_event.status, 'active'))
    )
  );
end;
$$;

revoke all on function public.projector_login(text, text, uuid, text, uuid) from public;
grant execute on function public.projector_login(text, text, uuid, text, uuid) to anon, authenticated;

-- PART 2 VERIFICATION (single JSONB cell)
select jsonb_build_object(
  'part', 'verify_part_2',
  'projector_login_exists', exists(
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'projector_login'
      and p.prosecdef = true
  ),
  'anon_can_execute', has_function_privilege(
    'anon',
    'public.projector_login(text, text, uuid, text, uuid)',
    'execute'
  )
) as verify_part_2;


-- =============================================================================
-- PART 3 OF 4: public.projector_changes RPC (cursor delta, raw rows only)
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
        'sl_no', coalesce(p.sl_no, ''),
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
        'assigned_events', coalesce(j.assigned_events, array[]::uuid[]),
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
      'assigned_judges', coalesce(v_event.assigned_judges, array[]::uuid[]),
      'assigned_participants', coalesce(v_event.assigned_participants, array[]::uuid[]),
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

-- PART 3 VERIFICATION (single JSONB cell)
select jsonb_build_object(
  'part', 'verify_part_3',
  'projector_changes_exists', exists(
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'projector_changes'
      and p.prosecdef = true
  ),
  'anon_can_execute', has_function_privilege(
    'anon',
    'public.projector_changes(text, bigint)',
    'execute'
  )
) as verify_part_3;


-- =============================================================================
-- PART 4 OF 4: public.projector_end RPC + org_session_terminate cascade
-- =============================================================================

create or replace function public.projector_end(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash text;
  v_pt record;
  v_ctx jsonb;
  v_org_id text;
  v_ended_count int := 0;
  v_session_ids uuid[];
begin
  v_hash := public._fj_hash_org_token(p_token);
  if v_hash is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_token');
  end if;

  -- Path A: Called by the Projector App using its own projector_token
  select pt.id, pt.org_session_id
  into v_pt
  from public.projector_token pt
  where pt.token_hash = v_hash
  limit 1;

  if found then
    update public.projector_token
    set revoked_at = coalesce(revoked_at, now()),
        revoked_reason = coalesce(revoked_reason, 'projector_ended')
    where id = v_pt.id;

    if v_pt.org_session_id is not null then
      update public.org_sessions
      set revoked_at = coalesce(revoked_at, now())
      where id = v_pt.org_session_id;
    end if;

    return jsonb_build_object('ok', true, 'ended_by', 'projector', 'ended_count', 1);
  end if;

  -- Path B: Called by an Organiser session token to end the org's active projector
  v_ctx := public._fj_org_session_context(p_token);
  if not coalesce((v_ctx->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  v_org_id := v_ctx->>'org_id';

  select array_agg(pt.org_session_id)
  into v_session_ids
  from public.projector_token pt
  where upper(pt.org_id) = upper(v_org_id)
    and pt.revoked_at is null
    and pt.org_session_id is not null;

  update public.projector_token
  set revoked_at = now(),
      revoked_reason = 'organiser_ended'
  where upper(org_id) = upper(v_org_id)
    and revoked_at is null;

  get diagnostics v_ended_count = row_count;

  if v_session_ids is not null and array_length(v_session_ids, 1) > 0 then
    update public.org_sessions
    set revoked_at = now()
    where id = any(v_session_ids)
      and revoked_at is null;
  end if;

  return jsonb_build_object('ok', true, 'ended_by', 'organiser', 'ended_count', v_ended_count);
end;
$$;

revoke all on function public.projector_end(text) from public;
grant execute on function public.projector_end(text) to anon, authenticated;

-- Update existing organiser session termination RPCs so revoking a projector's
-- org_sessions row from the Organiser AccountModal also marks projector_token revoked immediately
create or replace function public.org_session_terminate(p_token text, p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ctx jsonb;
  v_org_id text;
  v_cur_id uuid;
  v_terminated_id uuid;
begin
  v_ctx := public._fj_org_session_context(p_token);
  if not coalesce((v_ctx->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  if p_session_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_input');
  end if;

  v_org_id := v_ctx->>'org_id';
  v_cur_id := (v_ctx->>'session_id')::uuid;

  if p_session_id = v_cur_id then
    return jsonb_build_object('ok', false, 'error', 'cannot_terminate_current');
  end if;

  update public.org_sessions
  set revoked_at = now()
  where id = p_session_id
    and upper(org_id) = upper(v_org_id)
    and id <> v_cur_id
    and revoked_at is null
  returning id into v_terminated_id;

  if v_terminated_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  update public.projector_token
  set revoked_at = now(),
      revoked_reason = 'organiser_ended'
  where org_session_id = v_terminated_id
    and upper(org_id) = upper(v_org_id)
    and revoked_at is null;

  return jsonb_build_object('ok', true, 'terminated_id', v_terminated_id);
end;
$$;

revoke all on function public.org_session_terminate(text, uuid) from public;
grant execute on function public.org_session_terminate(text, uuid) to anon, authenticated;

create or replace function public.org_sessions_terminate_others(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ctx jsonb;
  v_org_id text;
  v_cur_id uuid;
  v_count int := 0;
begin
  v_ctx := public._fj_org_session_context(p_token);
  if not coalesce((v_ctx->>'ok')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'unauthorized');
  end if;

  v_org_id := v_ctx->>'org_id';
  v_cur_id := (v_ctx->>'session_id')::uuid;

  update public.org_sessions
  set revoked_at = now()
  where upper(org_id) = upper(v_org_id)
    and id <> v_cur_id
    and revoked_at is null;

  get diagnostics v_count = row_count;

  update public.projector_token
  set revoked_at = now(),
      revoked_reason = 'organiser_ended'
  where upper(org_id) = upper(v_org_id)
    and revoked_at is null
    and (org_session_id is null or org_session_id <> v_cur_id);

  return jsonb_build_object('ok', true, 'terminated_count', v_count);
end;
$$;

revoke all on function public.org_sessions_terminate_others(text) from public;
grant execute on function public.org_sessions_terminate_others(text) to anon, authenticated;

-- PART 4 VERIFICATION (single JSONB cell)
select jsonb_build_object(
  'part', 'verify_part_4',
  'projector_end_exists', exists(
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'projector_end'
      and p.prosecdef = true
  ),
  'anon_can_execute_projector_end', has_function_privilege(
    'anon',
    'public.projector_end(text)',
    'execute'
  ),
  'org_session_terminate_exists', exists(
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'org_session_terminate'
      and p.prosecdef = true
  ),
  'org_sessions_terminate_others_exists', exists(
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'org_sessions_terminate_others'
      and p.prosecdef = true
  )
) as verify_part_4;
