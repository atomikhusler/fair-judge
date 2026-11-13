-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.7 — Stage D1: Safe SQL Hardening (Phase 1, Zero App Breakage)
-- ═══════════════════════════════════════════════════════════════════
-- Safe immediate hardening before Phase 2 tenant-isolated session tokens:
-- 1. Blocks direct client INSERT on public.organizations (forces org_register RPC).
-- 2. Removes duplicate "Allow authenticated admin full access" policy on organizations.
-- 3. Revokes direct DELETE privilege on public.scores from anon/authenticated
--    (aligns table grants with RLS; org_restore remains SECURITY DEFINER).
-- 4. Revokes PUBLIC/anon/authenticated direct execute grants on trigger functions.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Replace broad ALL policies on organizations with explicit per-command policies
--    (No INSERT policy -> direct anon/authenticated inserts are blocked; org_register still works)
drop policy if exists "Allow authenticated admin full access" on public.organizations;
drop policy if exists "Enable read/write for organizations" on public.organizations;
drop policy if exists "organizations_select" on public.organizations;
drop policy if exists "organizations_update" on public.organizations;
drop policy if exists "organizations_delete" on public.organizations;

create policy "organizations_select"
  on public.organizations
  for select
  to public
  using (true);

create policy "organizations_update"
  on public.organizations
  for update
  to public
  using (true)
  with check (true);

create policy "organizations_delete"
  on public.organizations
  for delete
  to public
  using (true);

-- Tighten table-level INSERT grant on organizations so direct inserts fail immediately
revoke insert on table public.organizations from anon, authenticated;

-- 2. Align scores table grants with scores RLS (no direct DELETE allowed for anon/authenticated)
revoke delete on table public.scores from anon, authenticated;

-- 3. Remove unnecessary PUBLIC/anon/authenticated EXECUTE privileges from trigger functions
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'enforce_event_roster_lock',
        'prevent_locked_judge_delete',
        'prevent_locked_participant_delete'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated;', fn.sig);
  end loop;
end $$;
