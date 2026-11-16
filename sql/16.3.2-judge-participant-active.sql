-- =====================================================================
-- EPIC 16.3.2 — ADDITIVE SCHEMA SYNC: is_active FOR JUDGES & PARTICIPANTS
-- =====================================================================
-- Rules respected:
--   - Create-if-missing only (no DROP, no ALTER COLUMN, no REVOKE).
--   - Records the live DB column requirement for org_restore_v2 in repo.
--   - Safe to re-run; existing rows default to true.
-- =====================================================================

alter table public.judges
  add column if not exists is_active boolean not null default true;

alter table public.participants
  add column if not exists is_active boolean not null default true;

-- One-cell read-only verification query
select jsonb_build_object(
  'migration', '16.3.2-judge-participant-active',
  'judges_is_active_exists', exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'judges'
      and column_name = 'is_active'
  ),
  'participants_is_active_exists', exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'participants'
      and column_name = 'is_active'
  ),
  'both_columns_ready', (
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'judges'
        and column_name = 'is_active'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'participants'
        and column_name = 'is_active'
    )
  )
) as verification_result;
