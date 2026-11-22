-- ============================================================================
-- Fair Judge 17.5.1 — Supabase Cleanup (Part B)
-- ============================================================================
-- Run in Supabase SQL Editor. Idempotent; safe to re-run.
-- Each part runs independently and ends with a read-only verification query
-- returning a single jsonb cell.
--
-- Scope (per owner approvals):
--   * PART 1: Drop Group A unused legacy RPCs:
--       - public.org_change_password(text, text, text)
--       - public.org_reset_data(text, text)
--       - public.org_login(text, text)
--       - public.read_org_sync_stamp(text)
--   * PART 2: Drop retired fallback RPC:
--       - public.read_org_roster_credentials(text)
--   * PART 3: Revoke EXECUTE on public.fj_org_can_run(text) from PUBLIC,
--     anon, and authenticated (trigger enforcement remains active).
--
-- Explicitly untouched:
--   * public.rls_auto_enable (left untouched)
--   * public.org_verify_password (kept for now)
--   * Group B projector pairing/snapshot objects (deferred until new
--     projector app is deployed)
-- ============================================================================

-- ============================================================================
-- PART 1: Drop Group A Unused Legacy RPCs
--   Confirmed zero live app callers in src/ and scripts/ before drop.
-- ============================================================================

drop function if exists public.org_change_password(text, text, text);
drop function if exists public.org_reset_data(text, text);
drop function if exists public.org_login(text, text);
drop function if exists public.read_org_sync_stamp(text);

-- Read-only verification for PART 1 (returns 1 jsonb cell)
with remaining as (
  select coalesce(array_agg(p.proname order by p.proname), '{}'::text[]) as names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'org_change_password',
      'org_reset_data',
      'org_login',
      'read_org_sync_stamp'
    )
),
kept as (
  select coalesce(array_agg(distinct p.proname order by p.proname), '{}'::text[]) as names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'org_change_password_v2',
      'org_reset_all',
      'org_login_v2',
      'org_logout',
      'read_org_changes'
    )
)
select jsonb_build_object(
  'part', '17.5.1_part1_drop_group_a_legacy_rpcs',
  'remaining_dropped_rpcs', (select names from remaining),
  'replacements_present', (select names from kept),
  'status', case
    when coalesce(array_length((select names from remaining), 1), 0) = 0
      and coalesce(array_length((select names from kept), 1), 0) = 5
    then 'verified'
    else 'check_failed'
  end
) as verify_part_1;

-- ============================================================================
-- PART 2: Drop Retired Fallback RPC read_org_roster_credentials
--   Dead fallback removed from src/lib/supabase.ts before drop.
-- ============================================================================

drop function if exists public.read_org_roster_credentials(text);

-- Read-only verification for PART 2 (returns 1 jsonb cell)
with state as (
  select
    exists(
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'read_org_roster_credentials'
    ) as fallback_exists,
    exists(
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'judges_list_with_pins'
    ) as judges_list_exists,
    exists(
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'participants_list'
    ) as participants_list_exists
)
select jsonb_build_object(
  'part', '17.5.1_part2_drop_read_org_roster_credentials',
  'read_org_roster_credentials_exists', fallback_exists,
  'judges_list_with_pins_exists', judges_list_exists,
  'participants_list_exists', participants_list_exists,
  'status', case
    when not fallback_exists
      and judges_list_exists
      and participants_list_exists
    then 'verified'
    else 'check_failed'
  end
) as verify_part_2
from state;

-- ============================================================================
-- PART 3: Revoke Execute on public.fj_org_can_run(text) from anon & authenticated
--   Internal database triggers continue to execute fj_org_can_run as owner.
-- ============================================================================

revoke execute on function public.fj_org_can_run(text) from public, anon, authenticated;

-- Read-only verification for PART 3 (returns 1 jsonb cell)
with fn as (
  select
    to_regprocedure('public.fj_org_can_run(text)') is not null as fn_exists,
    case
      when to_regprocedure('public.fj_org_can_run(text)') is not null
      then has_function_privilege('anon', 'public.fj_org_can_run(text)', 'EXECUTE')
      else null
    end as anon_can_execute,
    case
      when to_regprocedure('public.fj_org_can_run(text)') is not null
      then has_function_privilege('authenticated', 'public.fj_org_can_run(text)', 'EXECUTE')
      else null
    end as authenticated_can_execute
),
enforcing_triggers as (
  select count(*)::int as trigger_count
  from pg_trigger t
  join pg_proc p on p.oid = t.tgfoid
  join pg_namespace n on n.oid = p.pronamespace
  where not t.tgisinternal
    and t.tgenabled <> 'D'
    and n.nspname = 'public'
    and lower(p.prosrc) like '%fj_org_can_run%'
)
select jsonb_build_object(
  'part', '17.5.1_part3_revoke_fj_org_can_run',
  'fj_org_can_run_exists', fn.fn_exists,
  'anon_can_execute', fn.anon_can_execute,
  'authenticated_can_execute', fn.authenticated_can_execute,
  'enabled_enforcing_triggers', et.trigger_count,
  'status', case
    when fn.fn_exists
      and fn.anon_can_execute = false
      and fn.authenticated_can_execute = false
      and et.trigger_count > 0
    then 'verified'
    else 'check_failed'
  end
) as verify_part_3
from fn, enforcing_triggers et;
