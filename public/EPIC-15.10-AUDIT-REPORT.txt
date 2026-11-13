# EPIC 15.10 — Phase 0 Audit Report (Read-Only)

**Status:** Audit complete (no application source files modified).  
**Target Version:** `15.10.0` (`src/config/version.ts`, currently `15.9.0`).

---

## 0.1 Security Lock Audit

### a) Every Direct Table Write in `src/` (32 Total Calls)

Every `.from(...).insert / update / upsert / delete` call currently lives inside `if (!rpcRes.usedRpc)` fallback blocks in two files: **`src/lib/supabase.ts` (19 calls)** and **`src/lib/offlineQueue.ts` (13 calls)**. No direct table writes exist in `EventsTab.tsx`, judge screens, roster/participant components, backup/restore sheets, or `src/admin/`.

#### `src/lib/supabase.ts` (19 calls)
| Line(s) | Table | Operation | Replacement Token RPC |
| :--- | :--- | :--- | :--- |
| 641–645 | `organizations` | `.update()` | `org_update` |
| 678 | `events` | `.delete()` | `org_reset_data` |
| 691 | `participants` | `.delete()` | `org_reset_data` |
| 704 | `judges` | `.delete()` | `org_reset_data` |
| 763–765 | `organizations` | `.delete()` | `org_delete` |
| 952–955 | `events` | `.insert()` | `event_upsert` |
| 1045–1049 | `events` | `.update()` | `event_update` |
| 1055–1059 | `events` | `.update()` (fallback omit `is_archived`) | `event_update` |
| 1164 | `events` | `.delete()` | `event_delete` |
| 1297–1300 | `judges` | `.insert()` | `judge_upsert` |
| 1362–1366 | `judges` | `.update()` | `judge_update` |
| 1415 | `judges` | `.delete()` | `judge_delete` |
| 1614–1617 | `participants` | `.insert()` (single) | `participant_upsert_batch` |
| 1707–1709 | `participants` | `.insert()` (bulk) | `participant_upsert_batch` |
| 1771–1775 | `participants` | `.update()` | `participant_update` |
| 1902 | `participants` | `.delete()` | `participant_delete` |
| 2139–2146 | `scores` | `.update()` | `score_upsert_batch` |
| 2161–2173 | `scores` | `.insert()` | `score_upsert_batch` |
| 2218 | `scores` | `.delete()` | `score_delete` |

#### `src/lib/offlineQueue.ts` (13 calls)
| Line(s) | Table | Operation | Replacement Token RPC |
| :--- | :--- | :--- | :--- |
| 234 | `events` | `.upsert()` | `event_upsert` |
| 243 | `events` | `.update()` | `event_update` |
| 249 | `events` | `.delete()` | `event_delete` |
| 258 | `participants` | `.upsert()` | `participant_upsert_batch` |
| 267 | `participants` | `.update()` | `participant_update` |
| 273 | `participants` | `.delete()` | `participant_delete` |
| 281 | `judges` | `.upsert()` | `judge_upsert` |
| 290 | `judges` | `.update()` | `judge_update` |
| 296 | `judges` | `.delete()` | `judge_delete` |
| 307 | `organizations` | `.update()` | `org_update` |
| 313 | `organizations` | `.delete()` | `org_delete` |
| 618 | `scores` | `.upsert()` (batched) | `score_upsert_batch` |
| 650 | `scores` | `.upsert()` (granular fallback) | `score_upsert_batch` |

> **Rule note:** Once Stage D3 RPCs are verified live in Supabase, these direct-write fallbacks should be removed so the client never falls back to direct table writes.

---

### b) Session Token Lifecycle & Expiry/Invalid Behaviour

1. **Creation at Login (`src/lib/authService.ts`, `sql/15.7-stage-d2-sessions.sql`)**
   - Organisers (`org_login` / `org_register`) and Judges (`judge_login`) receive a 64-char hex session token generated server-side and stored in `org_sessions` / `judge_sessions`.
   - **Gap:** Offline Judge login (`authService.ts:197–229`) succeeds locally with `sessionToken = undefined`. When connectivity returns, `score_upsert_batch` receives `p_token: ''` and fails with `'unauthorized'`.
2. **Storage (`src/lib/supabase.ts:252–264`)**
   - Stored in `localStorage['fairjudge_active_session']` as `StoredUserSession.sessionToken`.
   - `getStoredSessionToken()` reads the token on every write.
3. **Transmission (`src/lib/supabase.ts:222–250`)**
   - `callSecuredWriteRpc(rpcName, params)` injects `p_token: token`.
   - If the DB RPC returns `{ ok: false, error: 'unauthorized' | 'forbidden' | ... }`, `callSecuredWriteRpc` throws an `Error` with `err.code = res.error`.
4. **Current Expiry / Invalid Gaps**
   - **Cache Rollback Missing on Auth Failure:** Only `updateEvent` (`supabase.ts:1091–1103`) rolls back optimistic local cache edits when the server rejects a write. `createEvent`, `deleteEvent`, `createJudge`, `updateJudge`, `deleteJudge`, `createParticipant`, `bulkCreateParticipants`, `updateParticipant`, `deleteParticipant`, and `updateOrganization` mutate the local cache optimistically and rethrow `unauthorized`/`forbidden` without rolling back cache. `deleteScore` (`supabase.ts:2223`) catches and swallows errors without rollback or rethrow.
   - **`submitScore` (`supabase.ts:2189–2199`):** Catches `unauthorized` just like a network outage, queues the ballot into `pending_scores`, and emits `"Saved locally"` without prompting re-authentication.
   - **Sign-out / Cleanup:** Only explicit sign-out revokes sessions via `org_logout` / `judge_logout`. No global handler prompts the user when `unauthorized` occurs mid-session.

---

### c) Offline Queue Behaviour on Expired / Missing Token

#### Current Defect (`src/lib/offlineQueue.ts`)
- **Mutations (`offlineQueue.ts:345, 393–405`):** `err?.code === 'unauthorized'` satisfies `isServerReturned = Boolean(err?.code || isRosterLocked || isRls)`. Each flush increments `retryCount`, and after **3 flushes** sets `item.syncStatus = 'failed'`. Line `177` excludes `syncStatus === 'failed'`, silently trapping valid offline edits.
- **Scores (`offlineQueue.ts:627–679`):** When the batch `score_upsert_batch` call throws `unauthorized`, execution falls through to a per-score loop that hammers `score_upsert_batch` N times with the same invalid token, leaving scores stuck with `scoreFailed > 0` and no auth prompt.

#### Proposed Safe Behaviour (Never Drop Mutations)
1. **Detect `AUTH_REQUIRED` explicitly:** Treat `err?.code === 'unauthorized'` (and expired/invalid session RPC errors) as `AUTH_REQUIRED`, **distinct** from permanent server/constraint errors (`ROSTER_LOCKED`, `42501`, `SUSPENDED`, `DELETED`).
2. **Zero Strikes, Keep Pending:** Do **not** increment `retryCount` and do **not** mark `syncStatus = 'failed'`. Keep all items in `pending_mutations` and `pending_scores` untouched (`syncStatus: 'pending'`), plus all `fj_draft_*` localStorage score drafts intact.
3. **Short-Circuit & Pause Flush:** Immediately break out of both the mutations loop and batched/granular scores flush on the first `unauthorized` response.
4. **Emit `session_expired` & Show In-App Re-Verify Modal:** Prompt the active Organiser (password) or Judge (PIN) to re-authenticate in place without clearing IndexedDB or navigating away from active work.
5. **Resume Immediately:** On successful re-login, update `StoredUserSession.sessionToken` in `localStorage` and immediately call `flushOfflineQueueToSupabase()`.

---

### d) Read-Only SQL Check Queries (Run in Supabase SQL Editor)

> **Important:** `sql/RUN-LOG.md` is known to be stale/inaccurate for `d1`, `d2`, `d3`, and the 15.8 admin insert. Please run the 6 read-only `SELECT` queries below in the Supabase SQL Editor and paste the results before running any migrations or Stage 1 fixes.

```sql
-- 1. Verify session & admin tables exist
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('org_sessions', 'judge_sessions', 'platform_admins', 'platform_announcements')
ORDER BY table_name;

-- 2. Verify auth & Stage D3 write RPC signatures live in DB
SELECT p.proname,
       pg_get_function_identity_arguments(p.oid) AS args,
       p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'org_login', 'org_register', 'org_logout',
    'judge_login', 'judge_logout',
    'org_update', 'org_delete', 'org_reset_data',
    'event_upsert', 'event_update', 'event_delete',
    'judge_upsert', 'judge_update', 'judge_delete',
    'participant_upsert_batch', 'participant_update', 'participant_delete',
    'score_upsert_batch', 'score_delete',
    'is_platform_admin', 'get_active_announcements'
  )
ORDER BY p.proname;

-- 3. Verify live RLS status on core tables
SELECT relname AS table_name,
       relrowsecurity AS rls_enabled,
       relforcerowsecurity AS force_rls
FROM pg_class
WHERE relnamespace = 'public'::regnamespace
  AND relname IN ('organizations', 'events', 'judges', 'participants', 'scores', 'org_sessions', 'judge_sessions')
ORDER BY relname;

-- 4. Verify table privileges (grants) for anon and authenticated
SELECT table_name, grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee IN ('anon', 'authenticated')
  AND table_name IN ('organizations', 'events', 'judges', 'participants', 'scores', 'org_sessions', 'judge_sessions')
ORDER BY table_name, grantee, privilege_type;

-- 5. Verify active RLS policies on core tables
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('organizations', 'events', 'judges', 'participants', 'scores', 'org_sessions', 'judge_sessions')
ORDER BY tablename, policyname;

-- 6. Verify foreign keys & DELETE rules (checks score -> event FK cascade vs restrict)
SELECT tc.table_name,
       tc.constraint_name,
       kcu.column_name,
       ccu.table_name AS foreign_table_name,
       rc.delete_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints AS rc
  ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.constraint_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
  AND tc.table_name IN ('events', 'judges', 'participants', 'scores')
ORDER BY tc.table_name, tc.constraint_name;
```

---

### e) Functions / Tables Flagged That Stage D3 Would Break

1. **`event_delete` FK Failure (`sql/15.7-stage-d3-write-rls.sql:273`):** `DELETE FROM events WHERE id = p_event_id` does not delete child rows in `scores` first. If `scores.event_id` uses `ON DELETE RESTRICT` / `NO ACTION` instead of `CASCADE`, deleting an event that has scores will throw FK violation `23503`.
2. **`organizations` SELECT Policy (`sql/15.8-stage-a.sql:59–69`):** Restricts `SELECT` on `organizations` to `anon` or `is_platform_admin()`. If a signed-in admin opens the organiser view in the same browser session (JWT `authenticated` without an `anon` role), or if client reads rely on `anon`, verify how `organizations` reads behave against live policies.
3. **`dbService.verifyJudgeCredentials` (`src/lib/supabase.ts:1426–1516`):** Legacy direct read + `updateJudge` call that has no organiser session token when invoked from a judge flow; fails once `judge_update` enforces organiser token authorization.
4. **Judge `scoring_status` Update & Offline Judge Login (`authService.ts:197–229`):** Offline judge login has no token; any later `score_upsert_batch` requires re-issuing a `judge_login` token before sync.

---

## 0.2 Events Tab Audit

### a) Full Path Trace (Fetch -> Cache -> Offline Copy -> Filter -> Render & Chunks)

1. **Silent Cache Suppression (`src/lib/supabase.ts:858` & `src/components/organiser/tabs/EventsTab.tsx:266–310`)**
   - `dbService.getEvents` calls `saveCache(STORAGE_KEYS.EVENTS, normalized, true)` (`silent = true`).
   - Passing `silent = true` suppresses `notifyDatabaseChange(STORAGE_KEYS.EVENTS)` / `eventBus.emit('cache_updated')`.
   - Meanwhile, `EventsTab.tsx:305` fires `dbService.getEvents(organization.org_id)` without `await` or calling `setEvents(...)`, relying exclusively on the `cache_updated` subscription at lines `266–271`.
   - **Result:** Existing DB events fetched from Supabase are written to IndexedDB silently, so `EventsTab` (and `LiveTab.tsx:815`, `InsightsTab.tsx:107`) never re-renders with newly fetched DB events until an unrelated local mutation happens.
2. **Broken SWR Throttle & Cross-Org Cache Overwrite (`src/lib/supabase.ts:274, 839–845, 858`)**
   - `updateCacheTimestamp(cacheKey)` (`supabase.ts:274`) is an empty no-op stub, and `isCacheValid("${STORAGE_KEYS.EVENTS}_${cleanOrgId}")` checks a per-org timestamp key that is never recorded in `hotMemoryCache`. Therefore `!force && isCacheValid(cacheKey)` is always `false`, bypassing SWR throttling and hitting the network on every mount.
   - `saveCache(STORAGE_KEYS.EVENTS, normalized, true)` overwrites the shared `STORAGE_KEYS.EVENTS` store with only the active org's array rather than merging by `org_id`.
3. **Dual Archive Representation (`EventsTab.tsx` vs `src/lib/supabase.ts:1052, 1069, 1187`)**
   - `EventsTab` archives/unarchives via `is_archived: boolean`.
   - `dbService.deleteOrArchiveEvent` (`supabase.ts:1187`) archives via `status: 'archived'`.
   - `updateEvent` (`supabase.ts:1069`) forces `{ ...syncedRow, is_archived: updated.is_archived }`, masking whether the `is_archived` column actually persisted on the server when `PGRST204` occurs (`:1052`).
4. **Stale Lazy-Loaded Chunks (`public/sw.js:76–90` & `src/lib/lazyWithRetry.ts:28–36`)**
   - `sw.js` serves JS/CSS static assets with Stale-While-Revalidate / cache-first matching; after a deploy changes chunk hashes, cached `index.html` or an old bundle requests missing chunks (`Failed to fetch dynamically imported module`).
   - `lazyWithRetry.ts:29–35` sets `sessionStorage['fj_reload_<chunkKey>'] = 'true'` once per browser tab session and never clears it on successful chunk load, so a second deploy in the same tab session permanently fails with a chunk load error instead of recovering.

---

### b) Filter Matrix (`src/components/organiser/tabs/EventsTab.tsx:1012–1064, 1114–1122`)

The segmented filter bar currently has 5 tabs: `all`, `active`, `upcoming`, `draft`, `ended` (no `archived` tab exists).

| Filter Tab | Events Included (`filteredEvents`, `:1035–1063`) | Badge Count (`statusCounts`, `:1012–1029`) | Defect |
| :--- | :--- | :--- | :--- |
| **`all`** | Non-archived events (`!e.is_archived`) regardless of `status` (archived events show only when `searchQuery !== ''`). | Counts `!e.is_archived`. | Archived events disappear when search is empty unless they happen to match another status tab. |
| **`active`** | `st === 'active'` **including `is_archived === true`**. | Counts `st === 'active'` **including `is_archived === true`**. | Archived active events appear in **Active** even though they are archived. |
| **`upcoming`** | `st === 'ready' \|\| st === 'upcoming' \|\| (st === 'draft' && hasBoth)` **including `is_archived === true`**. | Counts `ready`, `upcoming`, or `hasBoth`. | Archived ready/upcoming events show in **Upcoming**; archived events inflate badge count. |
| **`draft`** | `st === 'draft' && !hasBoth` **including `is_archived === true`**. | `else counts.draft++` (catches `draft` without `hasBoth` **AND `paused`**). | **Counts `paused` events under Draft**, yet **Draft filter excludes `paused`** (`isDraftOnly` requires `st === 'draft'`). |
| **`ended`** | `st === 'ended' \|\| st === 'archived'` **including `is_archived === true`**. | Counts `st === 'ended' \|\| st === 'archived'`. | Mixes `ended` and `status === 'archived'`, while missing `is_archived === true` events unless their status happens to be `ended`. |
| **Search (`query !== ''`)** | Any event matching `name` or `category` **AND matching selected `filterStatus`**. | Static `statusCounts`. | Because `filterStatus` still runs after `isGlobalSearch` (`:1057–1062`), `paused` events still fail `active`/`upcoming`/`draft`/`ended` tabs even during search if a non-`all` tab is selected. |

#### Event States Appearing in NO Filter (when search is empty)
1. **Any `status === 'paused'` event when viewing status tabs (`active`, `upcoming`, `draft`, `ended`)** — matches none of the 4 status branches at `:1058–1061`, and is miscounted under `counts.draft` at `:1026`.
2. **`is_archived: true` + `status === 'paused'`** — hidden from `'all'` (`:1046`), matches none of `active`/`upcoming`/`draft`/`ended` (`:1058–1061`). **Appears in ZERO tabs.**
3. **Archived events (`is_archived: true`) in general** — there is no dedicated **Archived** filter; archived events either leak into `Active`/`Upcoming`/`Draft`/`Ended` (cluttering active tabs) or vanish completely if `paused`.

---

### c) Root Causes Summary (File & Line)

- `src/lib/supabase.ts:858` — `saveCache(..., true)` suppresses UI update notifications for `EventsTab.tsx:305`.
- `src/lib/supabase.ts:274, 839–845` — `updateCacheTimestamp` is a no-op; `isCacheValid` checks an unpopulated per-org key; cache overwrites instead of merging per `org_id`.
- `src/components/organiser/tabs/EventsTab.tsx:1012–1064, 1114–1122` — Missing `archived` tab, `paused` omitted from status filter predicates and miscounted in `draft`, `is_archived` not excluded from non-archived tabs/counts.
- `src/lib/lazyWithRetry.ts:29–35` & `public/sw.js:76–90` — One-shot reload guard never resets after recovery; SWR static asset caching can serve mismatched chunk manifests.

---

## 0.3 Admin Loop Audit

### Root Cause (`src/admin/AdminApp.tsx:156–175` & `src/App.tsx:80–82, 138–142`)

1. `App.tsx:80–82` and `hashchange` at `App.tsx:138–142` enter and stay in `<AdminApp />` whenever `window.location.hash.startsWith('#/admin')`.
2. When the admin clicks **Sign out / Lock** (`MoreView.tsx:347`, desktop rail `AdminApp.tsx:772`) or hits the **30-minute idle timeout** (`AdminApp.tsx:294, 312`), `handleLock()` runs:
   - `adminService.signOut()` + `clearAdminStorage()` + `setAdmin(null)`
   - Lines `168–170`:
     ```ts
     if (typeof window !== 'undefined' && window.location.hash !== '#/admin') {
       history.replaceState(null, '', window.location.pathname + window.location.search + '#/admin');
     }
     ```
   - Instead of calling `onExit()` (or clearing `#/admin` from the URL hash), `handleLock()` **keeps or forces `#/admin` in the URL**.
3. Because `App.tsx` checks `window.location.hash.startsWith('#/admin')`, the Admin `<SignIn />` screen remains rendered immediately after Sign-out/Lock **and across every page refresh** until the user manually edits the URL bar or clicks Back to FairJudge (`onExit`).
4. Secondary factors to handle cleanly in the fix:
   - `useAdminRoute.ts:135–146` pushes `#/admin/...` sub-routes into browser history; exiting cleanly should normalize the URL back to root (`window.location.pathname + window.location.search` with no `#/admin` hash) or distinguish explicit Sign-out from Lock.
   - Also confirm `platform_admins` row for the admin user via SQL check query #1 / Supabase Auth so `is_platform_admin()` evaluates `true` after sign-in.

---

## 0.4 Notifications Audit

1. **Scoped Only to `LiveTab` (`src/components/organiser/tabs/LiveTab.tsx:867–929, 1201–1527`)**
   - The Alerts bell button and modal exist only inside `LiveTab.tsx`, leaving `EventsTab`, `PeopleTab`, and `InsightsTab` without unified access to operational alerts.
   - `specificWarnings` (`:867–912`) only evaluates failed offline mutations, pending offline score count, and active events missing participants/judges. It does **not** surface active platform announcements or org verification notices.
2. **Missing Announcements in `ScoringPanel.tsx`**
   - `src/components/judge/ScoringPanel.tsx` does not fetch or render `AnnouncementBanner` (whereas `OrganiserDashboard` / `JudgeLobby` use `announcements.ts` / `AnnouncementBanner.tsx`).
3. **Global UI / Battery Rule Violations in `LiveTab.tsx`**
   - `LiveTab.tsx:1201` uses `backdrop-blur-md`; `:1301, :1359, :1407` use `backdrop-blur-sm`.
   - `LiveTab.tsx:513, :1214` use infinite `animate-ping`; `:307` uses `animate-pulse`.
   - Multiple buttons and containers use `transition-all` (`:373, :386, :394, :408, :416, :1206, :1222, :1342, :1390, :1467, :1477`).

---

## 0.5 Account Modal Audit

Files audited: **`src/components/organiser/AccountModal.tsx`** (and judge counterpart **`src/components/judge/JudgeLobby.tsx:355–549`**).

### Rule & Accessibility Findings in `AccountModal.tsx`
1. **Forbidden `backdrop-filter` / Glass Blur & Semi-Transparent Surface:**
   - `:282` uses `bg-black/60 backdrop-blur-sm` on the modal backdrop.
   - `:286` uses semi-transparent `bg-stone-100/50 dark:bg-black` on the modal sheet instead of solid `bg-white` / `bg-stone-50` + AMOLED dark `dark:bg-black` / `dark:bg-zinc-950`.
   - `:865, :925` (Reset / Delete confirmation overlays) use `bg-black/80 backdrop-blur-md`.
2. **Forbidden `transition-all` (17 occurrences):**
   - Lines `359, 390, 397, 456, 530, 537, 568, 600, 659, 708, 728, 829, 846, 906, 914, 966, 974` use `transition-all` instead of `transition-transform` / `transition-opacity` / `transition-colors`.
3. **Infinite / Non-Compliant Animations:**
   - `:857` uses infinite `animate-pulse` and `animate-shimmer` on the footer signature.
   - `:286` `animate-spring-sheet` and `:365, :505, :608, :865, :925` `animate-in` need `prefers-reduced-motion` parity and transform/opacity-only discipline.
4. **Sub-44px Touch Targets:**
   - `:314` Close button (`X`) is `w-9 h-9` (`36px` < `44px` minimum).
   - `:359, :456, :568` Edit/eye buttons are `w-8 h-8` (`32px`, relying on pseudo-element `before:-inset-1.5` instead of `min-w-[44px] min-h-[44px]`).
   - `:390, :397, :530, :537` (`min-h-[40px]`), `:600, :708, :728, :829, :846` (`min-h-[38px]`), and `:659, :906, :914, :966, :974` (`min-h-[42px]`) are all below `44px`.
5. **Accessibility / Keyboard Handling:**
   - Missing `Escape` key handler (to close confirmation overlays or the main modal) and missing focus trap / focus return to trigger button on close.
6. **Judge Profile Drawer (`JudgeLobby.tsx:355–549`) Parity:**
   - Uses `backdrop-blur-sm` (`:362`), `backdrop-blur-md` (`:504`), and `transition-all` (`:482, :528, :538`).

---

## Next Step

1. Paste the output of the **6 SQL check queries** from Section `0.1(d)` (run in the Supabase SQL Editor).
2. Reply with **`EXECUTE A`**, **`EXECUTE B`**, or **`EXECUTE C`** (and any extra instructions for Notifications / Account Modal) to begin Stage 1.
