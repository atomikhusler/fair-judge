-- =============================================================================
-- Fair Judge 17.6.2: Old Projector Cleanup (Group B Removal)
-- =============================================================================
-- Run each PART independently in the Supabase SQL Editor, in order (1 -> 2 -> 3).
-- Each part ends with a single-cell jsonb read-only verification query.
--
-- Scope:
--   PART 1: Drop the 8 retired pairing-projector RPCs.
--   PART 2: Drop the 2 retired pairing-projector helper functions
--           (_fj_verify_projector_token first, then _fj_projector_sha256).
--   PART 3: Drop the 2 retired pairing tables (projector_approve_throttle,
--           projector_pairings) and verify the new Projector App objects remain.
--
-- Intentionally UNTOUCHED:
--   - public.projector_token, public.projector_login, public.projector_changes,
--     public.projector_end, public.org_session_terminate,
--     public.org_sessions_terminate_others
--   - public.rls_auto_enable, public.judges_list_with_pins
--   - public.organizations.projector_spotlight_mode, projector_ticker_text
-- =============================================================================


-- =============================================================================
-- PART 1: DROP THE 8 RETIRED PAIRING-PROJECTOR RPCs
-- =============================================================================
drop function if exists public.projector_request_code();
drop function if exists public.projector_approve(text, text, text, text, text);
drop function if exists public.projector_claim(text);
drop function if exists public.projector_fingerprint(text);
drop function if exists public.projector_snapshot(text);
drop function if exists public.projector_list(text, text);
drop function if exists public.projector_update(text, text, uuid, text, text, boolean, boolean);
drop function if exists public.projector_revoke(text, text, uuid);

-- Read-only verification (returns one jsonb cell)
select jsonb_build_object(
  'part', 'verify_17_6_2_part_1',
  'remaining_old_rpcs', (
    select count(*)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'projector_request_code',
        'projector_approve',
        'projector_claim',
        'projector_fingerprint',
        'projector_snapshot',
        'projector_list',
        'projector_update',
        'projector_revoke'
      )
  ),
  'all_8_dropped', not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'projector_request_code',
        'projector_approve',
        'projector_claim',
        'projector_fingerprint',
        'projector_snapshot',
        'projector_list',
        'projector_update',
        'projector_revoke'
      )
  )
) as verify_17_6_2_part_1;


-- =============================================================================
-- PART 2: DROP THE 2 RETIRED PAIRING-PROJECTOR HELPER FUNCTIONS
-- (_fj_verify_projector_token depends on _fj_projector_sha256 & projector_pairings)
-- =============================================================================
drop function if exists public._fj_verify_projector_token(text);
drop function if exists public._fj_projector_sha256(text);

-- Read-only verification (returns one jsonb cell)
select jsonb_build_object(
  'part', 'verify_17_6_2_part_2',
  'verify_token_helper_dropped', not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = '_fj_verify_projector_token'
  ),
  'sha256_helper_dropped', not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = '_fj_projector_sha256'
  ),
  'both_helpers_dropped', not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('_fj_verify_projector_token', '_fj_projector_sha256')
  )
) as verify_17_6_2_part_2;


-- =============================================================================
-- PART 3: DROP THE 2 RETIRED PAIRING TABLES & VERIFY NEW PROJECTOR APP OBJECTS
-- =============================================================================
drop table if exists public.projector_approve_throttle;
drop table if exists public.projector_pairings;

-- Read-only verification (returns one jsonb cell)
select jsonb_build_object(
  'part', 'verify_17_6_2_part_3',
  'projector_approve_throttle_dropped', to_regclass('public.projector_approve_throttle') is null,
  'projector_pairings_dropped', to_regclass('public.projector_pairings') is null,
  'old_tables_dropped', (
    to_regclass('public.projector_approve_throttle') is null
    and to_regclass('public.projector_pairings') is null
  ),
  'new_projector_token_table_kept', to_regclass('public.projector_token') is not null,
  'new_projector_login_kept', exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'projector_login'
  ),
  'new_projector_changes_kept', exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'projector_changes'
  ),
  'new_projector_end_kept', exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'projector_end'
  ),
  'org_session_terminate_kept', exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'org_session_terminate'
  ),
  'org_sessions_terminate_others_kept', exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'org_sessions_terminate_others'
  ),
  'all_6_kept_objects_present', (
    to_regclass('public.projector_token') is not null
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'projector_login')
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'projector_changes')
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'projector_end')
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'org_session_terminate')
    and exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'org_sessions_terminate_others')
  )
) as verify_17_6_2_part_3;
