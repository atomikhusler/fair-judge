-- ═══════════════════════════════════════════════════════════════════
-- EPIC 15.10 — Stage 1: Security Lock ROLLBACK (Emergency Only)
-- ═══════════════════════════════════════════════════════════════════
-- Restores direct INSERT / UPDATE / DELETE privileges and permissive
-- REST policies on the 5 core tables in case a client rollback requires
-- direct writes before token-RPC deployment is verified.
-- Does NOT drop org_sessions, judge_sessions, or write RPCs.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Restore direct table privileges to anon and authenticated
grant select, insert, update, delete on table public.organizations to anon, authenticated;
grant select, insert, update, delete on table public.events to anon, authenticated;
grant select, insert, update, delete on table public.judges to anon, authenticated;
grant select, insert, update, delete on table public.participants to anon, authenticated;
grant select, insert, update on table public.scores to anon, authenticated;
grant delete on table public.scores to anon, authenticated;

-- 2. Restore fallback RLS policies for the 5 core tables
drop policy if exists "organizations_update" on public.organizations;
create policy "organizations_update"
  on public.organizations
  for update
  to public
  using (true)
  with check (true);

drop policy if exists "organizations_delete" on public.organizations;
create policy "organizations_delete"
  on public.organizations
  for delete
  to public
  using (true);

drop policy if exists "events_select" on public.events;
drop policy if exists "Enable read/write for events" on public.events;
create policy "Enable read/write for events"
  on public.events
  for all
  to public
  using (true)
  with check (true);

drop policy if exists "judges_select" on public.judges;
drop policy if exists "Enable read/write for judges" on public.judges;
create policy "Enable read/write for judges"
  on public.judges
  for all
  to public
  using (true)
  with check (true);

drop policy if exists "participants_select" on public.participants;
drop policy if exists "Enable read/write for participants" on public.participants;
create policy "Enable read/write for participants"
  on public.participants
  for all
  to public
  using (true)
  with check (true);

drop policy if exists "scores_select" on public.scores;
drop policy if exists "Enable read for scores" on public.scores;
drop policy if exists "Enable insert for scores" on public.scores;
drop policy if exists "Enable update for scores" on public.scores;

create policy "Enable read for scores"
  on public.scores
  for select
  to public
  using (true);

create policy "Enable insert for scores"
  on public.scores
  for insert
  to public
  with check (true);

create policy "Enable update for scores"
  on public.scores
  for update
  to public
  using (true)
  with check (true);
