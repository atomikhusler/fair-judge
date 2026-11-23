import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  EVENT_MODE_GROUP_KEY,
  applyTieDecisions,
  buildTieGroupKey,
  computeGroupScoreFingerprint,
  computeRankedStandingsWithDecisions,
  detectTiedGroups,
  resolveOrgTieDefault,
  resolveTieDecisionUpsertResponse,
  type TieDecisionLike,
} from '../src/lib/tieDecisionEngine';
import {
  applyProjectorChanges,
  fetchProjectorChanges,
} from '../src/lib/projector/projectorAppService';
import {
  computeProjectorRankings,
  type ProjectorEventState,
} from '../src/lib/projector/projectorRanking';
import type {
  Organization,
  ProjectorTieDecision,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
} from '../src/lib/supabaseTypes';

const ORG_SHARED: Organization = {
  id: 'ORG1',
  org_id: 'ORG1',
  name: 'Fair Judge Academy',
  tie_breaker_enabled: false,
  tie_breaker_method: 'shared',
  tie_management_enabled: true,
  blind_judging_enabled: false,
  created_at: '2026-11-01T00:00:00Z',
};

const EVENT_1: SupabaseEvent = {
  id: 'ev-tie-1',
  org_id: 'ORG1',
  name: 'Debate Finals',
  category: 'Senior',
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
  { id: 'j1', org_id: 'ORG1', name: 'Judge 1', judge_id: 'J01', pin: '', judge_pin: '', assigned_events: ['ev-tie-1'], is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'j2', org_id: 'ORG1', name: 'Judge 2', judge_id: 'J02', pin: '', judge_pin: '', assigned_events: ['ev-tie-1'], is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'j3', org_id: 'ORG1', name: 'Judge 3', judge_id: 'J03', pin: '', judge_pin: '', assigned_events: ['ev-tie-1'], is_active: true, created_at: '2026-11-01T00:00:00Z' },
];

const PARTICIPANTS: SupabaseParticipant[] = [
  { id: 'p1', org_id: 'ORG1', identity_id: 'ID-1', sl_no: '1', name: 'Asha Verma', school: 'Alpha', is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'p2', org_id: 'ORG1', identity_id: 'ID-2', sl_no: '2', name: 'Bala Nair', school: 'Beta', is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'p3', org_id: 'ORG1', identity_id: 'ID-3', sl_no: '3', name: 'Cara Dias', school: 'Gamma', is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'p4', org_id: 'ORG1', identity_id: 'ID-4', sl_no: '4', name: 'Dev Patel', school: 'Delta', is_active: true, created_at: '2026-11-01T00:00:00Z' },
  { id: 'p5', org_id: 'ORG1', identity_id: 'ID-5', sl_no: '5', name: 'Inactive Student', school: 'Epsilon', is_active: false, created_at: '2026-11-01T00:00:00Z' },
];

function mkScore(id: string, p: string, j: string, val: number, ts = '2026-11-22T10:00:00Z'): SupabaseScore {
  return {
    id,
    event_id: 'ev-tie-1',
    participant_id: p,
    judge_id: j,
    total_score: val,
    score_data: {},
    score_payload: { criteria: {}, total_score: val, submitted_at: ts },
    created_at: ts,
  };
}

// p1: 95 avg | p2: [100, 80, 60] (raw 80, olympic 80) | p3: [95, 85, 60] (raw 80, olympic 85) | p4: 70 avg
const BASE_SCORES: SupabaseScore[] = [
  mkScore('s1a', 'p1', 'j1', 95),
  mkScore('s1b', 'p1', 'j2', 95),
  mkScore('s1c', 'p1', 'j3', 95),
  mkScore('s2a', 'p2', 'j1', 100),
  mkScore('s2b', 'p2', 'j2', 80),
  mkScore('s2c', 'p2', 'j3', 60),
  mkScore('s3a', 'p3', 'j1', 95),
  mkScore('s3b', 'p3', 'j2', 85),
  mkScore('s3c', 'p3', 'j3', 60),
  mkScore('s4a', 'p4', 'j1', 70),
  mkScore('s4b', 'p4', 'j2', 70),
  mkScore('s4c', 'p4', 'j3', 70),
  // Score for inactive participant p5 (tied at 80) that MUST be ignored
  mkScore('s5a', 'p5', 'j1', 80),
  mkScore('s5b', 'p5', 'j2', 80),
  mkScore('s5c', 'p5', 'j3', 80),
];

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`PASS [${passed}]: ${name}`);
}

async function runAll() {
  // 1. Shared rank 1, 2, 2, 4 when no decision
  await test('Shared rank 1, 2, 2, 4 when no decision exists', () => {
    const { baselineRankings, groups } = detectTiedGroups(PARTICIPANTS, BASE_SCORES, 3);
    assert.equal(groups.length, 1, 'Exactly one tied group detected (p2, p3)');
    assert.equal(groups[0].groupKey, 'p2,p3');
    assert.equal(groups[0].rank, 2);

    const applied = applyTieDecisions(baselineRankings, [], 'shared');
    assert.deepEqual(
      applied.rankings.map((r) => r.rank),
      [1, 2, 2, 4],
      'Unresolved tie preserves standard competition ranking 1, 2, 2, 4'
    );
    assert.equal(applied.unresolvedTieCount, 1);
    assert.equal(applied.staleDecisionGroupKeys.length, 0);
  });

  // 2. Olympic applied ONLY when chosen, and NOT when org default is shared
  await test('Olympic trim applied only when chosen, never when org default is shared', () => {
    assert.equal(resolveOrgTieDefault({ tie_breaker_enabled: false, tie_breaker_method: 'olympic' }), 'shared');
    assert.equal(resolveOrgTieDefault({ tie_breaker_enabled: true, tie_breaker_method: 'shared' }), 'shared');
    assert.equal(resolveOrgTieDefault({ tie_breaker_enabled: true, tie_breaker_method: 'olympic' }), 'olympic');

    const { baselineRankings, groups } = detectTiedGroups(PARTICIPANTS, BASE_SCORES, 3);

    // Org default is shared, no decision -> stays 1, 2, 2, 4 (no silent Olympic trim)
    const sharedRes = applyTieDecisions(baselineRankings, [], 'shared');
    assert.deepEqual(sharedRes.rankings.map((r) => r.rank), [1, 2, 2, 4]);

    // Organiser explicitly chooses Olympic trim for the event or group -> p3 (85) beats p2 (80)
    const olympicDecision: TieDecisionLike = {
      id: 'td-1',
      event_id: 'ev-tie-1',
      group_key: groups[0].groupKey,
      mode: 'olympic',
      ordered_participant_ids: [],
      score_fingerprint: groups[0].scoreFingerprint,
      version: 2,
    };
    const olympicRes = applyTieDecisions(baselineRankings, [olympicDecision], 'shared');
    assert.deepEqual(olympicRes.rankings.map((r) => r.id), ['p1', 'p3', 'p2', 'p4']);
    assert.deepEqual(olympicRes.rankings.map((r) => r.rank), [1, 2, 3, 4]);
    assert.equal(olympicRes.unresolvedTieCount, 0);

    // Per-event shared override also overrides orgDefault = 'olympic' back to 1, 2, 2, 4
    const eventSharedOverride: TieDecisionLike = {
      id: 'td-ev',
      event_id: 'ev-tie-1',
      group_key: EVENT_MODE_GROUP_KEY,
      mode: 'shared',
      ordered_participant_ids: [],
      score_fingerprint: '',
      version: 3,
    };
    const overrideRes = applyTieDecisions(baselineRankings, [eventSharedOverride], 'olympic');
    assert.deepEqual(overrideRes.rankings.map((r) => r.rank), [1, 2, 2, 4]);
    assert.equal(overrideRes.unresolvedTieCount, 0, 'Explicit shared decision counts as resolved');
  });

  // 3. Manual order gives sequential ranks
  await test('Manual order places tied members in exact organiser order with sequential ranks', () => {
    const { baselineRankings, groups } = detectTiedGroups(PARTICIPANTS, BASE_SCORES, 3);
    const manualDecision: TieDecisionLike = {
      id: 'td-manual',
      event_id: 'ev-tie-1',
      group_key: groups[0].groupKey,
      mode: 'manual',
      ordered_participant_ids: ['p2', 'p3'], // organiser deliberately picks p2 ahead of p3
      score_fingerprint: groups[0].scoreFingerprint,
      version: 4,
    };
    const applied = applyTieDecisions(baselineRankings, [manualDecision], 'shared');
    assert.deepEqual(applied.rankings.map((r) => r.id), ['p1', 'p2', 'p3', 'p4']);
    assert.deepEqual(applied.rankings.map((r) => r.rank), [1, 2, 3, 4]);
    assert.equal(applied.unresolvedTieCount, 0);

    // Flip manual order to ['p3', 'p2']
    const flipped = applyTieDecisions(
      baselineRankings,
      [{ ...manualDecision, ordered_participant_ids: ['p3', 'p2'] }],
      'shared'
    );
    assert.deepEqual(flipped.rankings.map((r) => r.id), ['p1', 'p3', 'p2', 'p4']);
    assert.deepEqual(flipped.rankings.map((r) => r.rank), [1, 2, 3, 4]);
  });

  // 4. Changed score makes decision stale and falls back to shared rank
  await test('Changed score invalidates fingerprint, marks decision stale, and falls back to shared rank', () => {
    const { groups } = detectTiedGroups(PARTICIPANTS, BASE_SCORES, 3);
    const savedManual: TieDecisionLike = {
      id: 'td-manual',
      event_id: 'ev-tie-1',
      group_key: groups[0].groupKey,
      mode: 'manual',
      ordered_participant_ids: ['p2', 'p3'],
      score_fingerprint: groups[0].scoreFingerprint,
      version: 5,
    };

    // Judge j1 & j3 adjust p2 scores so p2 STILL averages 80 ([90, 80, 70]) -> still tied with p3, different marks!
    const editedScores: SupabaseScore[] = [
      ...BASE_SCORES,
      mkScore('s2a-new', 'p2', 'j1', 90, '2026-11-22T10:05:00Z'),
      mkScore('s2c-new', 'p2', 'j3', 70, '2026-11-22T10:05:00Z'),
    ];

    const res = computeRankedStandingsWithDecisions(PARTICIPANTS, editedScores, 3, [savedManual], 'olympic');
    assert.notEqual(res.tiedGroups[0].scoreFingerprint, savedManual.score_fingerprint);
    assert.equal(res.tiedGroups[0].isStale, true, 'Changed score flags decision as stale');
    assert.deepEqual(res.staleDecisionGroupKeys, ['p2,p3']);
    assert.deepEqual(
      res.rankings.map((r) => r.rank),
      [1, 2, 2, 4],
      'Stale decision falls back to safe shared rank 1, 2, 2, 4 even if orgDefault was olympic'
    );
    assert.equal(res.unresolvedTieCount, 1);
  });

  // 5. Deactivated participant is excluded before grouping
  await test('Deactivated participants are excluded before grouping and ranking', () => {
    const { baselineRankings, groups } = detectTiedGroups(PARTICIPANTS, BASE_SCORES, 3);
    assert.equal(baselineRankings.some((r) => r.id === 'p5'), false, 'p5 excluded from baseline');
    assert.equal(groups[0].groupKey, 'p2,p3', 'p5 excluded from tied group key');

    // Now deactivate p2 so p3 is no longer tied with anyone
    const p2Deactivated = PARTICIPANTS.map((p) => (p.id === 'p2' ? { ...p, is_active: false } : p));
    const afterDeactivation = computeRankedStandingsWithDecisions(p2Deactivated, BASE_SCORES, 3, [], 'shared');
    assert.equal(afterDeactivation.tiedGroups.length, 0, 'No ties remain after deactivating p2');
    assert.equal(afterDeactivation.unresolvedTieCount, 0);
    assert.deepEqual(afterDeactivation.rankings.map((r) => r.id), ['p1', 'p3', 'p4']);
    assert.deepEqual(afterDeactivation.rankings.map((r) => r.rank), [1, 2, 3]);
    assert.equal(buildTieGroupKey(['p3', 'p2', 'p2']), 'p2,p3');
    assert.ok(computeGroupScoreFingerprint(afterDeactivation.rankings.slice(0, 1)).startsWith('v1:'));
  });

  // 6. Conflict response from concurrent organiser edit is handled cleanly
  await test('Optimistic-lock conflict response is parsed and exposes server winning decision', () => {
    const serverDecision: TieDecisionLike = {
      id: 'td-1',
      event_id: 'ev-tie-1',
      group_key: 'p2,p3',
      mode: 'manual',
      ordered_participant_ids: ['p3', 'p2'],
      score_fingerprint: 'v1:abc123',
      decided_by: 'Fair Judge Academy (Safari on iPad)',
      decided_at: '2026-11-22T10:12:00Z',
      version: 9,
    };
    const conflict = resolveTieDecisionUpsertResponse({
      ok: false,
      error: 'conflict',
      message: 'This tie decision was updated by another organiser.',
      current: serverDecision,
    });
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(conflict.conflictServerDecision, serverDecision);
    assert.deepEqual(conflict.decision, serverDecision);

    const saved = resolveTieDecisionUpsertResponse({ ok: true, data: serverDecision });
    assert.equal(saved.status, 'saved');
    assert.equal(saved.conflictServerDecision, null);
  });

  // 7. Projector ranking calls the same engine & applyProjectorChanges merges/tombstones/strips decided_by
  await test('Projector ranking matches tieDecisionEngine and delta merge strips decided_by + applies tombstones', async () => {
    const { groups } = detectTiedGroups(PARTICIPANTS, BASE_SCORES, 3);
    const manualDecision: ProjectorTieDecision = {
      id: 'td-proj-1',
      event_id: 'ev-tie-1',
      group_key: groups[0].groupKey,
      mode: 'manual',
      ordered_participant_ids: ['p2', 'p3'],
      score_fingerprint: groups[0].scoreFingerprint,
      decided_at: '2026-11-22T10:15:00Z',
      version: 12,
    };

    // Simulate fetchProjectorChanges receiving a server row that accidentally includes decided_by -> must be stripped
    const fetchRes = await fetchProjectorChanges(
      async () => ({
        data: {
          ok: true,
          changed: true,
          cursor: 12,
          event_ended: false,
          org: ORG_SHARED,
          event: EVENT_1,
          participants: PARTICIPANTS,
          judges: JUDGES,
          scores: BASE_SCORES,
          tie_decisions: [
            {
              ...manualDecision,
              decided_by: 'SHOULD_BE_STRIPPED_SECRET_LABEL',
            },
          ],
          deletions: [],
        },
        error: null,
      }),
      'pjt_token',
      0
    );
    assert.equal(fetchRes.ok, true);
    assert.equal(fetchRes.payload?.tieDecisions?.length, 1);
    assert.equal(
      'decided_by' in (fetchRes.payload!.tieDecisions![0] as unknown as Record<string, unknown>),
      false,
      'Projector tie decision MUST NEVER expose decided_by'
    );

    // Apply delta -> projector ranking matches tieDecisionEngine exactly
    const empty: ProjectorEventState = {
      org: null,
      event: null,
      participants: [],
      judges: [],
      scores: [],
      tieDecisions: [],
    };
    const state1 = applyProjectorChanges(empty, fetchRes.payload!);
    const projRanked1 = computeProjectorRankings(state1);
    const engineRanked1 = computeRankedStandingsWithDecisions(
      PARTICIPANTS,
      BASE_SCORES,
      3,
      [manualDecision],
      'shared'
    ).rankings.filter((r) => r.rank > 0);
    assert.deepEqual(
      projRanked1.map((r) => ({ id: r.id, rank: r.rank })),
      engineRanked1.map((r) => ({ id: r.id, rank: r.rank })),
      'Projector ranking matches tieDecisionEngine identically'
    );
    assert.deepEqual(projRanked1.map((r) => r.id), ['p1', 'p2', 'p3', 'p4']);
    assert.deepEqual(projRanked1.map((r) => r.rank), [1, 2, 3, 4]);

    // Apply deletion tombstone for td-proj-1 -> falls back to shared 1, 2, 2, 4
    const state2 = applyProjectorChanges(state1, {
      changed: true,
      cursor: 15,
      participants: [],
      judges: [],
      scores: [],
      tieDecisions: [],
      deletions: [{ table_name: 'tie_decisions', record_id: 'td-proj-1', version: 15 }],
    });
    assert.equal(state2.tieDecisions?.length, 0, 'Tombstoned tie_decisions row removed');
    const projRanked2 = computeProjectorRankings(state2);
    assert.deepEqual(projRanked2.map((r) => r.rank), [1, 2, 2, 4]);
  });

  // 8. Static SQL audit on sql/17.7.0-tie-decisions.sql
  await test('SQL 17.7.0-tie-decisions.sql satisfies schema, RLS, security, and projector privacy rules', () => {
    const sqlPath = path.resolve(process.cwd(), 'sql/17.7.0-tie-decisions.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    assert.match(sql, /create table if not exists public\.tie_decisions/i);
    assert.match(sql, /references public\.events\(id\) on delete cascade/i);
    assert.match(sql, /unique \(event_id, group_key\)/i);
    assert.match(sql, /alter table public\.tie_decisions enable row level security/i);
    assert.match(sql, /revoke all on table public\.tie_decisions from public, anon, authenticated/i);
    assert.match(sql, /add column if not exists tie_management_enabled boolean not null default true/i);
    assert.match(sql, /create or replace function public\.tie_decisions_list/i);
    assert.match(sql, /create or replace function public\.tie_decision_upsert/i);
    assert.match(sql, /create or replace function public\.tie_decision_delete/i);
    assert.match(sql, /'error',\s*'conflict'/i);
    assert.match(sql, /verify_17_7_0_part_1/);
    assert.match(sql, /verify_17_7_0_part_2/);
    assert.match(sql, /verify_17_7_0_part_3/);
    assert.match(sql, /verify_17_7_0_part_4/);

    // Ensure no note column in table creation
    const part1Body = sql.split('-- PART 1 VERIFICATION')[0] || '';
    assert.doesNotMatch(part1Body, /\bnote\s+text\b/i, 'tie_decisions table must NOT have a note column');

    // Ensure Part 4 projector_changes function body never references decided_by, array[]::uuid[], or mobile_number
    const part4 = (sql.split('create or replace function public.projector_changes(')[1] || '').split('-- PART 4 VERIFICATION')[0] || '';
    assert.match(part4, /v_tie_decisions/);
    assert.match(part4, /'tie_decisions'/);
    assert.doesNotMatch(part4, /decided_by/i, 'projector_changes must NEVER reference decided_by');
    assert.doesNotMatch(part4, /array\[\]::uuid\[\]/i, 'projector_changes must NOT use array[]::uuid[]');
    assert.doesNotMatch(part4, /p\.mobile_number/i, 'projector_changes must NEVER select mobile_number');
  });

  console.log(`\nALL ${passed} TIE DECISIONS (17.7.0 PART B1) CHECKS PASSED.`);
}

runAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
