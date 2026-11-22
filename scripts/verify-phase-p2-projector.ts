import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  mergeProjectorDelta,
  fetchProjectorChanges,
  ProjectorChangesPayload,
} from '../src/lib/projector/projectorAppService';
import {
  ProjectorEventState,
  computeProjectorRankings,
  computeProjectorOverview,
  buildLiveViewSnapshot,
} from '../src/lib/projector/projectorRanking';
import {
  saveProjectorSession,
  loadProjectorSession,
  updateProjectorCursor,
  clearProjectorSession,
  PROJECTOR_TOKEN_STORAGE_KEYS,
} from '../src/lib/projector/projectorTokenStore';
import { ProjectorLiveSection } from '../src/components/projector/ProjectorLiveSection';
import { computeProjectorPollConnectionState } from '../src/components/projector/ProjectorApp';
import {
  isProjectorAppHash,
  resolveProjectorAppRoute,
  clearProjectorRouteState,
} from '../src/App';
import type {
  Organization,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
} from '../src/lib/supabaseTypes';

// Minimal in-memory sessionStorage mock for Node test runner
function installMockSessionStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  const mockStorage: Storage = {
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(key: string) {
      return backing.has(key) ? backing.get(key)! : null;
    },
    key(index: number) {
      return Array.from(backing.keys())[index] ?? null;
    },
    removeItem(key: string) {
      backing.delete(key);
    },
    setItem(key: string, value: string) {
      backing.set(key, String(value));
    },
  };
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = mockStorage;
  return backing;
}

const ORG_BASE: Organization = {
  id: 'ORG1',
  org_id: 'ORG1',
  name: 'Northridge Science Fair',
  tie_breaker_enabled: false,
  tie_breaker_method: 'olympic',
  blind_judging_enabled: true, // Blind judging ON for judges — projector must still show names!
  projector_blind_mode: false,
  projector_spotlight_mode: true,
  projector_ticker_text: '',
  projector_carousel_interval: 60,
  projector_confetti_at: null,
  created_at: '2026-11-01T00:00:00Z',
};

const EVENT_ACTIVE: SupabaseEvent = {
  id: 'ev-1',
  org_id: 'ORG1',
  name: 'Robotics Finals',
  category: 'STEM',
  status: 'active',
  is_locked: false,
  is_archived: false,
  rubric_schema: [],
  rubric: [],
  assigned_judges: ['j1', 'j2', 'j3'],
  assigned_participants: ['p1', 'p2', 'p3', 'p4', 'p5'],
  participant_sl_numbers: {},
  created_at: '2026-11-01T00:00:00Z',
};

const JUDGES: SupabaseJudge[] = [
  { id: 'j1', org_id: 'ORG1', name: 'Judge A', judge_id: 'J01', pin: '', assigned_events: ['ev-1'], is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'j2', org_id: 'ORG1', name: 'Judge B', judge_id: 'J02', pin: '', assigned_events: ['ev-1'], is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'j3', org_id: 'ORG1', name: 'Judge C', judge_id: 'J03', pin: '', assigned_events: ['ev-1'], is_active: true, created_at: '2026-11-01T00:00:00Z' },
];

const PARTICIPANTS: SupabaseParticipant[] = [
  { id: 'p1', org_id: 'ORG1', identity_id: 'ID-1', sl_no: '1', name: 'Amina Rao', school: 'Alpha', is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'p2', org_id: 'ORG1', identity_id: 'ID-2', sl_no: '2', name: 'Benito Cruz', school: 'Beta', is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'p3', org_id: 'ORG1', identity_id: 'ID-3', sl_no: '3', name: 'Chloe Park', school: 'Gamma', is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'p4', org_id: 'ORG1', identity_id: 'ID-4', sl_no: '4', name: 'Devon Brooks', school: 'Delta', is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'p5', org_id: 'ORG1', identity_id: 'ID-5', sl_no: '5', name: 'Inactive Contender', school: 'Epsilon', is_active: false, created_at: '2026-11-01T00:00:00Z' },
];

function mkScore(id: string, p: string, j: string, val: number, ts: string): SupabaseScore {
  return {
    id,
    event_id: 'ev-1',
    participant_id: p,
    judge_id: j,
    total_score: val,
    score_data: {},
    score_payload: { criteria: {}, total_score: val, submitted_at: ts },
    created_at: ts,
  };
}

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`PASS [${passed}]: ${name}`);
}

async function runAll() {

// 1. Delta Merge Tests
await test('Delta merge: initial load, incremental score upsert, tombstone delete, and no-op', () => {
  const empty: ProjectorEventState = { org: null, event: null, participants: [], judges: [], scores: [] };
  const initial: ProjectorChangesPayload = {
    changed: true,
    cursor: 10,
    org: ORG_BASE,
    event: EVENT_ACTIVE,
    participants: PARTICIPANTS,
    judges: JUDGES,
    scores: [
      mkScore('s1', 'p1', 'j1', 90, '2026-11-19T10:00:00Z'),
      mkScore('s2', 'p2', 'j1', 80, '2026-11-19T10:00:00Z'),
    ],
    deletions: [],
  };

  const state1 = mergeProjectorDelta(empty, initial);
  assert.equal(state1.participants.length, 4, 'Inactive participant p5 filtered out');
  assert.equal(state1.scores.length, 2);

  // No-op when changed === false
  const stateNoOp = mergeProjectorDelta(state1, {
    changed: false,
    cursor: 10,
    participants: [],
    judges: [],
    scores: [],
    deletions: [],
  });
  assert.strictEqual(stateNoOp, state1, 'No-op delta returns exact previous reference');

  // Incremental upsert + tombstone delete
  const state2 = mergeProjectorDelta(state1, {
    changed: true,
    cursor: 14,
    participants: [],
    judges: [],
    scores: [
      mkScore('s2', 'p2', 'j1', 85, '2026-11-19T10:05:00Z'),
      mkScore('s3', 'p3', 'j1', 85, '2026-11-19T10:06:00Z'),
    ],
    deletions: [{ table_name: 'scores', record_id: 's1', version: 13 }],
  });
  assert.equal(state2.scores.length, 2, 's1 removed via deletion tombstone, s2 updated, s3 inserted');
  assert.equal(state2.scores.find((s) => s.id === 's1'), undefined);
  assert.equal(state2.scores.find((s) => s.id === 's2')?.total_score, 85);
});

// 2. Client-side ranking parity + tie-breaker + blind judging name visibility
await test('Ranking parity: latest-score dedup, absentee exclusion, shared [1,2,2,4], Olympic trim, visible names', () => {
  const scores: SupabaseScore[] = [
    // p1: 95 across 3 judges (with older duplicate score that must be ignored)
    mkScore('s1-old', 'p1', 'j1', 50, '2026-11-19T09:00:00Z'),
    mkScore('s1-new', 'p1', 'j1', 95, '2026-11-19T09:10:00Z'),
    mkScore('s1-j2', 'p1', 'j2', 95, '2026-11-19T09:11:00Z'),
    mkScore('s1-j3', 'p1', 'j3', 95, '2026-11-19T09:12:00Z'),
    // p2: [90, 80, 70] -> avg 80, Olympic middle = 80
    mkScore('s2-j1', 'p2', 'j1', 90, '2026-11-19T09:10:00Z'),
    mkScore('s2-j2', 'p2', 'j2', 80, '2026-11-19T09:11:00Z'),
    mkScore('s2-j3', 'p2', 'j3', 70, '2026-11-19T09:12:00Z'),
    // p3: [90, 80, 70] -> exact tie with p2 (both should share rank 2!)
    mkScore('s3-j1', 'p3', 'j1', 90, '2026-11-19T09:10:00Z'),
    mkScore('s3-j2', 'p3', 'j2', 80, '2026-11-19T09:11:00Z'),
    mkScore('s3-j3', 'p3', 'j3', 70, '2026-11-19T09:12:00Z'),
    // p4: absent (no scores yet) -> excluded from ranked standings
  ];

  const state: ProjectorEventState = {
    org: ORG_BASE,
    event: EVENT_ACTIVE,
    participants: PARTICIPANTS,
    judges: JUDGES,
    scores,
  };

  const ranked = computeProjectorRankings(state);
  assert.equal(ranked.length, 3, 'Absentee p4 and inactive p5 excluded');
  assert.deepEqual(
    ranked.map((r) => r.rank),
    [1, 2, 2],
    'Unresolved tie shares standard competition rank [1, 2, 2]'
  );

  // Add a 4th scored contender below the tie -> rank must jump to 4 (1, 2, 2, 4)
  const state4: ProjectorEventState = {
    ...state,
    scores: [...scores, mkScore('s4-j1', 'p4', 'j1', 60, '2026-11-19T09:15:00Z')],
  };
  const ranked4 = computeProjectorRankings(state4);
  assert.deepEqual(
    ranked4.map((r) => r.rank),
    [1, 2, 2, 4],
    'Next contender after 2-way tie for 2nd gets rank 4'
  );

  // Olympic tie-breaker ON breaks tie between [100, 80, 60] (avg 80, olympic 80) and [95, 85, 60] (avg 80, olympic 85)
  const tieBreakScores: SupabaseScore[] = [
    mkScore('tb1', 'p1', 'j1', 100, '2026-11-19T09:00:00Z'),
    mkScore('tb2', 'p1', 'j2', 80, '2026-11-19T09:00:00Z'),
    mkScore('tb3', 'p1', 'j3', 60, '2026-11-19T09:00:00Z'),
    mkScore('tb4', 'p2', 'j1', 95, '2026-11-19T09:00:00Z'),
    mkScore('tb5', 'p2', 'j2', 85, '2026-11-19T09:00:00Z'),
    mkScore('tb6', 'p2', 'j3', 60, '2026-11-19T09:00:00Z'),
  ];
  const rankedOlympic = computeProjectorRankings({
    org: { ...ORG_BASE, tie_breaker_enabled: true, tie_breaker_method: 'olympic' },
    event: EVENT_ACTIVE,
    participants: PARTICIPANTS,
    judges: JUDGES,
    scores: tieBreakScores,
  });
  assert.equal(rankedOlympic[0].id, 'p2', 'Olympic trim ranks higher trimmed average first');
  assert.deepEqual(rankedOlympic.map((r) => r.rank), [1, 2]);

  // buildLiveViewSnapshot keeps blind_judging_enabled = false so participant names stay visible!
  const snapVisible = buildLiveViewSnapshot(state, false);
  assert.ok(snapVisible);
  assert.equal(snapVisible.org.blind_judging_enabled, false, 'Blind judging never hides names on projector');
  assert.equal(snapVisible.org.projector_blind_mode, false);
  const snapHiddenScores = buildLiveViewSnapshot(state, true);
  assert.ok(snapHiddenScores);
  assert.equal(snapHiddenScores.org.blind_judging_enabled, false);
  assert.equal(snapHiddenScores.org.projector_blind_mode, true, 'Local hideScores maps cleanly to display mask');

  // Overview metrics check
  const overview = computeProjectorOverview(state);
  assert.equal(overview.totalContenders, 4);
  assert.equal(overview.scoredContenders, 3);
  assert.equal(overview.waitingContenders, 1);
  assert.equal(overview.isProvisional, true);
});

// 3. Provisional vs Final results SSR rendering
await test('Live View renders Provisional while active and Final results banner when event ends', () => {
  const baseState: ProjectorEventState = {
    org: ORG_BASE,
    event: EVENT_ACTIVE,
    participants: PARTICIPANTS,
    judges: JUDGES,
    scores: [
      mkScore('s1', 'p1', 'j1', 92, '2026-11-19T09:00:00Z'),
      mkScore('s2', 'p2', 'j1', 84, '2026-11-19T09:00:00Z'),
    ],
  };

  const activeHtml = renderToStaticMarkup(
    React.createElement(ProjectorLiveSection, {
      state: baseState,
      settings: { theme: 'dark', liveMode: 'scoreboard', hideScores: false, overscan: 0 },
      isReconnecting: false,
      eventEnded: false,
      onBackToOverview: () => {},
      onSignInAnotherEvent: () => {},
    })
  );
  assert.match(activeHtml, /Provisional/i, 'Active event shows Provisional tag');
  assert.match(activeHtml, /Amina Rao/, 'Participant names stay visible even when org blind_judging_enabled = true');
  assert.doesNotMatch(activeHtml, /projector-final-results-banner/, 'Active event does not show Final results banner');

  const endedHtml = renderToStaticMarkup(
    React.createElement(ProjectorLiveSection, {
      state: { ...baseState, event: { ...EVENT_ACTIVE, status: 'ended' } },
      settings: { theme: 'dark', liveMode: 'scoreboard', hideScores: false, overscan: 0 },
      isReconnecting: false,
      eventEnded: true,
      onBackToOverview: () => {},
      onSignInAnotherEvent: () => {},
    })
  );
  assert.match(endedHtml, /Final results/i, 'Ended event shows Final results banner');
  assert.match(endedHtml, /Sign in for another event/i, 'Ended event offers quick sign-in for next event');
  assert.doesNotMatch(endedHtml, /Provisional/i, 'Ended event drops Provisional tag');
});

// 4. sessionStorage Token Store Hygiene
await test('sessionStorage token store saves only projector token + metadata, clears on expiry, never stores secrets', () => {
  const backing = installMockSessionStorage();
  const future = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

  saveProjectorSession({
    token: 'pjt_test_secret_token_123',
    orgId: 'ORG1',
    orgName: 'Northridge',
    eventId: 'ev-1',
    eventName: 'Robotics Finals',
    expiresAt: future,
    cursorVersion: 5,
    // Intentionally attempt to inject forbidden keys via unsafe cast
    ...({ password: 'secret', org_token: 'bad', pin: '1234', mobile_number: '555-0100' } as Record<string, unknown>),
  });

  const rawJson = backing.get(PROJECTOR_TOKEN_STORAGE_KEYS.SESSION) || '';
  assert.ok(rawJson.includes('pjt_test_secret_token_123'));
  assert.ok(!rawJson.includes('password'), 'Password never persisted');
  assert.ok(!rawJson.includes('org_token'), 'Organiser token never persisted');
  assert.ok(!rawJson.includes('mobile_number'), 'Mobile number never persisted');
  assert.ok(!rawJson.includes('1234'), 'Judge PIN never persisted');

  updateProjectorCursor(42);
  const loaded = loadProjectorSession();
  assert.equal(loaded?.cursorVersion, 42);

  // Expired token must auto-clear
  saveProjectorSession({
    token: 'pjt_expired',
    orgId: 'ORG1',
    orgName: 'Northridge',
    eventId: 'ev-1',
    eventName: 'Robotics Finals',
    expiresAt: new Date(Date.now() - 10_000).toISOString(),
    cursorVersion: 42,
  });
  assert.equal(loadProjectorSession(), null, 'Expired session clears automatically');

  clearProjectorSession();
  assert.equal(backing.has(PROJECTOR_TOKEN_STORAGE_KEYS.SESSION), false);
});

// 5. Static SQL & Hard-Rules Audit on sql/17.6.0-projector-app.sql
await test('SQL 17.6.0 enforces 8-hour expiry, RLS, zero PII, 1-active-per-org, and 4 verified parts', () => {
  const sqlPath = path.resolve(process.cwd(), 'sql/17.6.0-projector-app.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  assert.match(sql, /interval '8 hours'/i, 'Uses 8-hour projector session limit');
  assert.doesNotMatch(sql, /interval '4 hours'/i, 'Must NOT contain stale 4-hour projector limit');
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all on table public\.projector_token from public, anon, authenticated/i);
  assert.match(sql, /idx_projector_token_one_active_per_org/i);
  assert.match(sql, /idx_scores_event_version/i);
  assert.match(sql, /verify_part_1/);
  assert.match(sql, /verify_part_2/);
  assert.match(sql, /verify_part_3/);
  assert.match(sql, /verify_part_4/);
  assert.doesNotMatch(sql, /p\.mobile_number/i, 'projector_changes must never select mobile_number');
  assert.doesNotMatch(sql, /j\.pin\b/i, 'projector_changes must never select judge PIN');
  assert.doesNotMatch(sql, /j\.current_session_token/i, 'projector_changes must never select judge session token');
  assert.doesNotMatch(sql, /rank\(\)\s+over/i, 'projector_changes must perform zero ranking maths in SQL');

  // Verify Gateway.tsx 5-tap BrandBadge super admin shortcut remains completely untouched
  const gatewayPath = path.resolve(process.cwd(), 'src/components/auth/Gateway.tsx');
  const gatewaySrc = fs.readFileSync(gatewayPath, 'utf8');
  assert.match(gatewaySrc, /BrandBadge/, 'Gateway BrandBadge intact');
  assert.match(gatewaySrc, /onOpenAdmin/, 'Gateway 5-tap super admin shortcut intact');
});

// 6. 17.6.1 SQL Fix Verification (text[] coalesce + zero array[]::uuid[])
await test('SQL 17.6.1 fix uses {}::text[], contains no array[]::uuid[], and casts sl_no::text', () => {
  const fixSqlPath = path.resolve(process.cwd(), 'sql/17.6.1-projector-changes-fix.sql');
  const fixSql = fs.readFileSync(fixSqlPath, 'utf8');

  assert.match(fixSql, /'\{\}'::text\[\]/, 'Fix SQL uses {}::text[] for text[] columns');
  assert.match(fixSql, /coalesce\(p\.sl_no::text,\s*''\)/i, 'Fix SQL casts p.sl_no::text');
  assert.match(fixSql, /security definer/i, 'Fix SQL keeps SECURITY DEFINER');
  assert.match(fixSql, /set search_path = public, extensions/i, 'Fix SQL keeps search_path');
  assert.match(fixSql, /grant execute on function public\.projector_changes\(text, bigint\) to anon, authenticated/i);
  assert.match(fixSql, /verify_17_6_1_part_1/, 'Fix SQL ends with single-cell jsonb verification query');

  // Strip the verification query check literal before asserting function body has zero array[]::uuid[]
  const bodyOnly = fixSql.split('-- PART 1 VERIFICATION')[0] || '';
  assert.doesNotMatch(bodyOnly, /array\[\]::uuid\[\]/i, 'projector_changes body must not contain array[]::uuid[]');
});

// 7. Client error split: fetch failure -> network_error; DB/RPC error -> rpc_error; Reconnecting only on network_error
await test('Client splits network_error vs rpc_error and sets Reconnecting ONLY for network_error', async () => {
  // Case A: thrown fetch failure -> network_error -> isReconnecting = true
  const thrownFetchRes = await fetchProjectorChanges(
    async () => {
      throw new TypeError('Failed to fetch');
    },
    'pjt_tok',
    0
  );
  assert.equal(thrownFetchRes.ok, false);
  assert.equal(thrownFetchRes.error, 'network_error');
  const thrownConn = computeProjectorPollConnectionState(thrownFetchRes);
  assert.equal(thrownConn.isReconnecting, true, 'Thrown fetch sets Reconnecting = true');
  assert.equal(thrownConn.rpcError, null);

  // Case B: Supabase PostgREST wrapper returning Failed to fetch without SQLSTATE code -> network_error
  const postgrestNetRes = await fetchProjectorChanges(
    async () => ({
      data: null,
      error: { code: '', message: 'TypeError: Failed to fetch' },
    }),
    'pjt_tok',
    0
  );
  assert.equal(postgrestNetRes.ok, false);
  assert.equal(postgrestNetRes.error, 'network_error');
  assert.equal(computeProjectorPollConnectionState(postgrestNetRes).isReconnecting, true);

  // Case C: Database error (42804) -> rpc_error -> isReconnecting = false + rpcError populated
  const dbErrRes = await fetchProjectorChanges(
    async () => ({
      data: null,
      error: { code: '42804', message: 'COALESCE types text[] and uuid[] cannot be matched' },
    }),
    'pjt_tok',
    0
  );
  assert.equal(dbErrRes.ok, false);
  assert.equal(dbErrRes.error, 'rpc_error');
  assert.equal(dbErrRes.errorCode, '42804');
  assert.match(dbErrRes.message || '', /COALESCE types text\[\] and uuid\[\]/);
  const dbErrConn = computeProjectorPollConnectionState(dbErrRes);
  assert.equal(dbErrConn.isReconnecting, false, 'DB rpc_error MUST NOT set Reconnecting');
  assert.equal(dbErrConn.rpcError?.code, '42804');

  // Case D: Successful response (even with changed: false) clears Reconnecting & rpcError at once
  const okNoChangeRes = await fetchProjectorChanges(
    async () => ({
      data: { ok: true, changed: false, cursor: 12, event_ended: false },
      error: null,
    }),
    'pjt_tok',
    12
  );
  assert.equal(okNoChangeRes.ok, true);
  const okConn = computeProjectorPollConnectionState(okNoChangeRes);
  assert.equal(okConn.isReconnecting, false, 'Success clears Reconnecting at once');
  assert.equal(okConn.rpcError, null, 'Success clears rpcError at once');
});

// 8. 17.6.3 Cold start on #/projector-app with NO session (or expired session) -> cleans address and shows start screen
await test('17.6.3: Cold start on #/projector-app with no/expired session cleans address and falls back to start screen', () => {
  const backing = installMockSessionStorage();
  let currentHash = '#/projector-app';
  const replacedUrls: string[] = [];

  const mockWindow = {
    location: {
      pathname: '/fairjudge/',
      search: '?lang=en',
      get hash() {
        return currentHash;
      },
      set hash(val: string) {
        currentHash = val;
      },
    },
    history: {
      replaceState(_state: unknown, _title: string, url: string) {
        replacedUrls.push(url);
        const hashIdx = url.indexOf('#');
        currentHash = hashIdx >= 0 ? url.slice(hashIdx) : '';
      },
    },
    sessionStorage: (globalThis as unknown as { sessionStorage: Storage }).sessionStorage,
  };
  (globalThis as unknown as { window: unknown }).window = mockWindow;

  // Case A: no session in sessionStorage
  backing.clear();
  currentHash = '#/projector-app';
  const openNoSession = resolveProjectorAppRoute();
  assert.equal(openNoSession, false, 'Must NOT open projector screen without a valid session');
  assert.equal(currentHash, '', 'Hash must be cleaned to root');
  assert.equal(replacedUrls[replacedUrls.length - 1], '/fairjudge/?lang=en');

  // Case B: expired session in sessionStorage
  saveProjectorSession({
    token: 'pjt_expired_cold_start',
    orgId: 'ORG1',
    orgName: 'Northridge',
    eventId: 'ev-1',
    eventName: 'Robotics Finals',
    expiresAt: new Date(Date.now() - 5_000).toISOString(),
    cursorVersion: 1,
  });
  currentHash = '#/projector-app';
  const openExpired = resolveProjectorAppRoute();
  assert.equal(openExpired, false, 'Expired session must NOT open projector screen');
  assert.equal(currentHash, '', 'Expired session cleans hash back to root');
  assert.equal(loadProjectorSession(), null, 'Expired session removed from sessionStorage');
});

// 9. 17.6.3 Cold start / reload on #/projector-app WITH valid session -> keeps projector app open
await test('17.6.3: Cold start/reload on #/projector-app with valid session keeps projector open', () => {
  installMockSessionStorage();
  let currentHash = '#/projector-app';
  let replaceCount = 0;

  (globalThis as unknown as { window: unknown }).window = {
    location: {
      pathname: '/',
      search: '',
      get hash() {
        return currentHash;
      },
      set hash(val: string) {
        currentHash = val;
      },
    },
    history: {
      replaceState(_state: unknown, _title: string, url: string) {
        replaceCount += 1;
        const hashIdx = url.indexOf('#');
        currentHash = hashIdx >= 0 ? url.slice(hashIdx) : '';
      },
    },
    sessionStorage: (globalThis as unknown as { sessionStorage: Storage }).sessionStorage,
  };

  saveProjectorSession({
    token: 'pjt_live_valid_token',
    orgId: 'ORG1',
    orgName: 'Northridge',
    eventId: 'ev-1',
    eventName: 'Robotics Finals',
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    cursorVersion: 17,
  });

  const keepOpen = resolveProjectorAppRoute();
  assert.equal(keepOpen, true, 'Valid session keeps projector app open across reload');
  assert.equal(currentHash, '#/projector-app', 'Hash preserved when valid session exists');
  assert.equal(replaceCount, 0, 'replaceState not called when valid session exists');
  assert.equal(isProjectorAppHash(currentHash), true);
});

// 10. 17.6.3 Every projector exit path clears sessionStorage and cleans address back to root
await test('17.6.3: All projector exit paths clear session, clean address, and route through onExit', () => {
  const backing = installMockSessionStorage();
  let currentHash = '#/projector-app';
  const replacedUrls: string[] = [];

  (globalThis as unknown as { window: unknown }).window = {
    location: {
      pathname: '/',
      search: '',
      get hash() {
        return currentHash;
      },
      set hash(val: string) {
        currentHash = val;
      },
    },
    history: {
      replaceState(_state: unknown, _title: string, url: string) {
        replacedUrls.push(url);
        const hashIdx = url.indexOf('#');
        currentHash = hashIdx >= 0 ? url.slice(hashIdx) : '';
      },
    },
    sessionStorage: (globalThis as unknown as { sessionStorage: Storage }).sessionStorage,
  };

  saveProjectorSession({
    token: 'pjt_active_token',
    orgId: 'ORG1',
    orgName: 'Northridge',
    eventId: 'ev-1',
    eventName: 'Robotics Finals',
    expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    cursorVersion: 9,
  });
  assert.ok(loadProjectorSession());

  clearProjectorRouteState();
  assert.equal(loadProjectorSession(), null, 'clearProjectorRouteState clears projector sessionStorage');
  assert.equal(backing.has(PROJECTOR_TOKEN_STORAGE_KEYS.SESSION), false);
  assert.equal(currentHash, '', 'clearProjectorRouteState cleans #/projector-app hash');
  assert.equal(replacedUrls[replacedUrls.length - 1], '/');

  // Verify ProjectorApp.tsx wires all 4 exit paths through triggerAnimatedExit -> onExit({ animate: true })
  // and Back to start through onExit({ animate: false })
  const projectorAppSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/projector/ProjectorApp.tsx'),
    'utf8'
  );
  assert.match(projectorAppSrc, /onExit\(\{ animate: true, endToken: activeToken \}\)/, 'Animated exit uses onExit({ animate: true })');
  assert.match(projectorAppSrc, /onExit\(\{ animate: false \}\)/, 'Back to start uses onExit({ animate: false })');
  assert.match(projectorAppSrc, /onSwitchEvent=\{handleEndAndExit\}/, 'Switch Event routes through animated exit');
  assert.match(projectorAppSrc, /onEndSession=\{handleEndAndExit\}/, 'End Projector Session routes through animated exit');
  assert.match(projectorAppSrc, /onSignInAnotherEvent=\{handleEndAndExit\}/, 'Sign in another event routes through animated exit');
  assert.match(
    projectorAppSrc,
    /result\.error === 'replaced' \|\| result\.error === 'expired' \|\| result\.error === 'revoked'[\s\S]*?triggerAnimatedExit\(false\)/,
    'Revoked/expired/replaced poll triggers animated exit'
  );
  assert.match(
    projectorAppSrc,
    /expMs <= Date\.now\(\)[\s\S]*?triggerAnimatedExit\(true\)/,
    '8-hour local expiry triggers animated exit'
  );
  // Cleanup mock window for any downstream Node code
  delete (globalThis as unknown as { window?: unknown }).window;
});

console.log(`\nALL ${passed} PHASE P2 PROJECTOR APP CHECKS PASSED.`);
}

runAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
