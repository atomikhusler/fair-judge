# Fair Judge — Tie Rework Plan

Source spec: `docs/TIE-REWORK.md`
Rules:
- Work one step at a time with owner approval (`PROCEED` / `FIX` / `STOP`).
- Protected files (never touch): `src/components/public/ProjectorScoreboard.tsx`, `src/components/auth/Gateway.tsx`, `src/components/public/PublicLeaderboard.tsx`.
- Never run SQL; for SQL steps, write one small `.sql` file per check and wait for owner to run it and paste the result.
- Do not push to GitHub.
- D5: already deleted; do not restore.

---

## Step 1: Settings Cleanup & Always-On Ties
- **Files**: `src/components/organiser/SettingsDrawer.tsx`, `src/components/organiser/OrganiserDashboard.tsx`, `src/lib/supabaseTypes.ts`, `src/lib/supabase.ts`
- **Change**: Remove the "Tie management" and "Tie-Breaker Engine" switches from Settings so ties always activate in real time without a toggle. Keep Prize places (3 or 5, default 3) and add/keep Score One by One (per event, default OFF) in Settings/event config. (D5: already deleted; do not restore.)
- **Check**: `npm run build` and `npm run lint`; Phone test: open Organiser Settings on mobile, verify "Tie management" and "Tie-Breaker Engine" switches are gone while Prize places (3/5, default 3) and Score One by One (default OFF) remain.
- **Status**: DONE

## Step 2: Absent Status Workflow, Bell Notifications & Tie Detector Zero Fix
- **Files**: `src/components/judge/ScoringPanel.tsx`, `src/components/organiser/OrganiserDashboard.tsx`, `src/components/organiser/tabs/LiveTab.tsx`, `src/lib/tieBreakerEngine.ts`, `src/lib/tieDecisionEngine.ts`, `src/lib/supabase.ts`, `src/lib/supabaseTypes.ts`, `sql/17.8.1-absent-status-workflow.sql`
- **Change**: Add Absent as a separate status: one judge marking Absent triggers a bell notification for the organiser with Confirm or Reject. Confirm marks the participant Absent and sealed (excluded from ranking and ties). Reject returns the participant to the judge's list and notifies the judge immediately. Display "Absent" (never "0"), log every request and decision, and fix the tie detector so it skips Absent instead of treating zero as a mark; write `sql/17.8.1-absent-status-workflow.sql` for owner to run.
- **Check**: `npm run build` and `npm run lint` + owner runs `sql/17.8.1-absent-status-workflow.sql`; Phone test: judge marks a participant Absent, organiser sees bell notification, tests Reject (participant returns & judge notified) and Confirm (shows "Absent", excluded from ties and ranking).
- **Status**: DONE (accepted by owner after phone test)

## Step 3: Tie Status Chip Visibility Gate
- **Files**: `src/components/organiser/TieStatusChip.tsx`, `src/components/organiser/tabs/LiveTab.tsx`, `src/lib/tieBreakerEngine.ts`
- **Change**: Show the tie chip only when every active participant is scored or confirmed Absent, the event has not ended, and a tie actually exists.
- **Check**: `npm run build` and `npm run lint`; Phone test: in Live tab, confirm the tie chip stays hidden while any participant is unscored or after ending an event, and appears only when all active participants are scored/confirmed Absent and a tie exists.
- **Status**: DONE (accepted by owner after phone test)

## Step 4: Tie Methods, Recommendations, Preview & Locked Confirmation
- **Files**: `src/components/organiser/TieManagerScreen.tsx`, `src/lib/tieDecisionEngine.ts`, `src/lib/tieBreakerEngine.ts`, `sql/17.8.3-tie-method-lock-reopen.sql`
- **Change**: Support the 4 tie methods: Countback (recommended for 2 tied for 1st), Olympic trim (warn under 5 judges; recommended only with 5+ judges), Re-compete (recommended for 3+ tied), and Shared places. Make "Recommended" a visual tag only (never forced). Each confirmation dialog must explain what the method does, show ranks before and after, and state "This cannot be changed after you confirm." Lock the method once confirmed, allowing only a logged reopen with a written reason (3–300 chars) for a published round; write `sql/17.8.3-tie-method-lock-reopen.sql` for owner to run.
- **Check**: `npm run build` and `npm run lint` + owner runs `sql/17.8.3-tie-method-lock-reopen.sql`; Phone test: open Tie Manager, check recommendation tags, preview before/after ranks, confirm a method, verify it is locked, and test Reopen requiring a 3–300 char reason.
- **Status**: WAITING FOR OWNER TEST

## Step 4A — One device per judge
- **Files**: `src/lib/supabase.ts`, `src/lib/syncEngine.ts`, `src/App.tsx`, `src/components/auth/AuthScreen.tsx`, `src/components/judge/JudgeLobby.tsx`, `src/components/judge/ScoringPanel.tsx`
- **Change**: When any judge RPC call returns `unauthorized` (session replaced on another device), route through one centralized handler that clears the local judge session, returns to the sign-in screen, and shows `"Signed in on another device. Please sign in again."` with no raw error codes shown to the judge. (Database part already applied by owner; no SQL changed or run.)
- **Check**: `npm run build` and `npm run lint`; Phone test: sign in as the same judge on two phones, verify the first phone clears its local session, returns to the sign-in screen, and shows `"Signed in on another device. Please sign in again."` with no raw error code.
- **Status**: WAITING FOR OWNER TEST

## Step 5: End Event Blockers (Client + Server RPC)
- **Files**: `src/components/organiser/tabs/LiveTab.tsx`, `src/components/organiser/OrganiserDashboard.tsx`, `src/lib/supabase.ts`, `src/lib/tieDecisionEngine.ts`, `sql/17.8.2-end-event-blockers.sql`
- **Change**: Block End Event when a tie touches a prize place, an absence request is pending, a tie round is open / closed-not-published / stale, or any participant has neither full marks nor a confirmed absence. Allow ending when ties are below prize places (shared) or participants only have judge-side Not Ready tags. Enforce the same checks on the server RPC and return the list of blockers; write `sql/17.8.2-end-event-blockers.sql` for owner to run.
- **Check**: `npm run build` and `npm run lint` + owner runs `sql/17.8.2-end-event-blockers.sql`; Phone test: tap End Event with a pending absence, unscored participant, or prize-place tie and verify the exact blocker list prevents ending.
- **Status**: TODO

## Step 6: Shared 1st Place Permission & Continuous vs Standard Prompt
- **Files**: `src/components/organiser/TieManagerScreen.tsx`, `src/lib/tieDecisionEngine.ts`, `src/lib/tieBreakerEngine.ts`, `sql/17.8.4-shared-first-mode.sql`
- **Change**: Require explicit organiser permission for Shared 1st, then ask each time whether the next place is 2nd (continuous: two 1sts, one 2nd, one 3rd) or 3rd (standard: two 1sts, no 2nd, one 3rd). Display the resulting rank table and require organiser confirmation; write `sql/17.8.4-shared-first-mode.sql` for owner to run.
- **Check**: `npm run build` and `npm run lint` + owner runs `sql/17.8.4-shared-first-mode.sql`; Phone test: create a tie for 1st, choose Shared places, test choosing "2nd" vs "3rd", verify the preview ranks match, and confirm.
- **Status**: TODO

## Step 7: Ties Below Prize Places (Auto-Share with Warning)
- **Files**: `src/components/organiser/TieManagerScreen.tsx`, `src/components/organiser/tabs/LiveTab.tsx`, `src/lib/tieDecisionEngine.ts`, `src/lib/tieBreakerEngine.ts`
- **Change**: Allow ties strictly below the configured prize places (e.g., 4th+ when Prize places = 3, or 6th+ when Prize places = 5) to share their place automatically while displaying a clear warning notice to the organiser (without blocking End Event).
- **Check**: `npm run build` and `npm run lint`; Phone test: create a tie for 4th place in a 3-prize event, confirm the warning appears and End Event succeeds with shared 4th place.
- **Status**: TODO

## Step 8: Standard vs Continuous Ranking Rules
- **Files**: `src/lib/tieBreakerEngine.ts`, `src/lib/tieBreakerEngine.worker.ts`, `src/lib/tieDecisionEngine.ts`, `src/lib/projector/projectorRanking.ts`
- **Change**: Enforce standard competition ranking (`1, 2, 2, 4`) everywhere by default, and switch to continuous ranking (`1, 1, 2, 3`) only when a Shared 1st decision chose 2nd as the next place.
- **Check**: `npm run build` and `npm run lint`; Phone test: verify a tie at 2nd place ranks `1, 2, 2, 4` by default, and a Shared 1st with "next place 2nd" ranks `1, 1, 2, 3`.
- **Status**: TODO

## Step 9: D2 — Legacy Ended Events with Unresolved Tie
- **Files**: `src/components/organiser/TieManagerScreen.tsx`, `src/components/organiser/tabs/LiveTab.tsx`, `src/components/organiser/tabs/InsightsTab.tsx`, `src/lib/tieDecisionEngine.ts`, `src/lib/supabase.ts`
- **Change**: Handle legacy already-ended events that have an unresolved tie using Option A: allow the organiser to resolve the tie after event end by entering a written reason, display a clear warning that the event already ended, and log the action as "resolved after event end".
- **Check**: `npm run build` and `npm run lint`; Phone test: open an already-ended legacy event with an unresolved tie, verify the warning appears, resolve with a written reason, and confirm it logs as "resolved after event end".
- **Status**: TODO

## Step 10: Not Ready Tag (Judge-Side Only)
- **Files**: `src/components/judge/ScoringPanel.tsx`, `src/lib/offlineQueue.ts`
- **Change**: Add judge-local "Not Ready" action that moves the participant to the bottom of that judge's list with a "Not Ready" badge while keeping the organiser's original position number. One tap unmarks it, and no server write is made.
- **Check**: `npm run build` and `npm run lint`; Phone test: on judge screen, mark participant #2 Not Ready, confirm they move to the bottom keeping `#2` with a "Not Ready" tag, tap once to unmark, and confirm zero network/server requests occur.
- **Status**: TODO

## Step 11: Score One by One Mode (Per Event, Server Enforced)
- **Files**: `src/components/organiser/tabs/EventsTab.tsx`, `src/components/organiser/tabs/LiveTab.tsx`, `src/components/judge/ScoringPanel.tsx`, `src/lib/supabase.ts`, `src/lib/supabaseTypes.ts`, `sql/17.8.5-score-one-by-one.sql`
- **Change**: Add per-event "Score One by One" toggle (default OFF). When ON, judges see only the current active participant, the organiser advances to the next participant, and the server RPC refuses marks for anyone who is not the current participant; write `sql/17.8.5-score-one-by-one.sql` for owner to run.
- **Check**: `npm run build` and `npm run lint` + owner runs `sql/17.8.5-score-one-by-one.sql`; Phone test: enable Score One by One on an event, verify judge sees only 1 participant, advance from organiser screen, and verify judge screen updates to the next participant.
- **Status**: TODO

## Step 12: Change Order in Events Tab (Drag, Auto-Scroll, Undo, Running Lock)
- **Files**: `src/components/organiser/tabs/EventsTab.tsx`, `src/lib/supabase.ts`
- **Change**: Add "Change order" button in Events tab. While active: hide Delete buttons, dim participant boxes, allow press-and-hold drag to reorder with automatic scrolling when dragging near the top or bottom edges, and show "Done" and "Undo" buttons. Enable only before event start or while paused; grey it out while running, and warn if judges have already started scoring.
- **Check**: `npm run build` and `npm run lint`; Phone test: on a paused/not-started event with a long participant list, tap "Change order", press-and-hold drag near top and bottom edges to verify auto-scroll, tap Undo, reorder again, tap Done; verify button is greyed out while running.
- **Status**: TODO

## Step 13: Re-Compete Judge Screen (A–E Grades, Sealed Marks, Offline Drop, Close Flag)
- **Files**: `src/components/judge/ScoringPanel.tsx`, `src/components/organiser/TieManagerScreen.tsx`, `src/lib/offlineQueue.ts`, `src/lib/tieDecisionEngine.ts`, `src/lib/supabase.ts`, `sql/17.8.6-recompete-grades.sql`
- **Change**: Build the Re-compete judge UI with five grade buttons (`A=5, B=4, C=3, D=2, E=1`). Judges see only their own grades in an open round; original sealed marks never change. Keep the event open until the round is published with the close flag set. If an offline grade syncs after the round closes, drop it with a clear message to the judge. Compute final order by grade total, then countback on sealed marks, then shared place; write `sql/17.8.6-recompete-grades.sql` for owner to run.
- **Check**: `npm run build` and `npm run lint` + owner runs `sql/17.8.6-recompete-grades.sql`; Phone test: start a Re-compete round, confirm the event cannot finish until published with the close flag set, submit A–E grades on judge phone, test offline grade submission after closing the round to verify it drops with a message, and check final ordering.
- **Status**: TODO

## Step 14: Projector App Tie Round State & Final Ranks
- **Files**: `src/components/projector/ProjectorLiveSection.tsx`, `src/components/projector/ProjectorOverviewSection.tsx`, `src/lib/projector/projectorAppService.ts`, `src/lib/projector/projectorRanking.ts`, `sql/17.8.7-projector-tie-state.sql`
- **Change**: Show "Tie round in progress" on the Projector App while a tie round is open, and display final resolved ranks once published (never touching protected `ProjectorScoreboard.tsx`); write `sql/17.8.7-projector-tie-state.sql` for owner to run.
- **Check**: `npm run build` and `npm run lint` + owner runs `sql/17.8.7-projector-tie-state.sql`; Phone test: open `#/projector-app`, start a tie round and confirm "Tie round in progress" shows, publish the tie round and confirm final ranks update.
- **Status**: TODO

## Step 15: Insights Audit Section & PDF Reports
- **Files**: `src/components/organiser/tabs/InsightsTab.tsx`, `src/lib/downloadUtils.ts`, `src/lib/backup/backupPdf.ts`, `src/lib/tieDecisionEngine.ts`
- **Change**: Add a tie & absence audit section in Insights. Include the full audit table in the Results PDF, and include a one-line tie audit summary in the Logs PDF.
- **Check**: `npm run build` and `npm run lint`; Phone test: open Insights tab after resolving a tie/absence, inspect the audit section, export Results PDF (verify full audit table) and Logs PDF (verify one summary line).
- **Status**: TODO

## Step 16: Tie Audit Log (Read-Only Check)
- **Files**: `src/lib/tieDecisionEngine.ts`, `src/lib/supabase.ts`, `src/lib/supabaseTypes.ts`
- **Change**: Read-only verification that every tie action (who, when, event, rule, result, reason) is recorded and read properly against the existing Part 2 audit table and its append-only trigger. No new SQL, no schema or trigger changes.
- **Check**: `npm run build` and `npm run lint`; Phone test: perform tie actions (confirm, reopen, absence confirm/reject, legacy post-end resolve) and verify every entry appears in the audit feed with who/when/event/rule/result/reason.
- **Status**: TODO

## Step 17: Load Reduction & 8-Second Re-Compete Polling
- **Files**: `src/components/organiser/tabs/LiveTab.tsx`, `src/components/organiser/TieManagerScreen.tsx`, `src/components/judge/ScoringPanel.tsx`, `src/lib/tieBreakerEngine.ts`
- **Change**: Ensure heavy tie/ranking/blocker checks run only on End Event, Preview, and Confirm (not on every incoming score). Poll Re-compete round status/grades every 8 seconds strictly while a Re-compete round is open, stopping immediately when closed/published.
- **Check**: `npm run build` and `npm run lint`; Phone test: score multiple participants rapidly and confirm no heavy recalculation lag on each mark; open a Re-compete round and verify 8s refresh runs only while open.
- **Status**: TODO

## Step 18: SQL Verification & Small-File Check Scripts
- **Files**: `sql/17.8.8-verify-tie-rework-schema.sql`, `sql/RUN-LOG.md`
- **Change**: Provide small, single-check SQL verification scripts for the new tie-rework RPCs/columns only (excluding the existing Part 2 audit log table and append-only trigger) and update `sql/RUN-LOG.md` entries for the owner to run manually. Never run SQL automatically.
- **Check**: `npm run build` and `npm run lint`; Owner runs `sql/17.8.8-verify-tie-rework-schema.sql` in Supabase SQL Editor and pastes the result.
- **Status**: TODO
