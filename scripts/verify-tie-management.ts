/**
 * Pure TypeScript verification suite for Phase 17.7.0 Tie Management (Stage B3).
 * Zero database or network calls.
 * Run: npx tsx scripts/verify-tie-management.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildCanonicalGroupScoreString,
  buildTieGroupKey,
  computeCountbackPreview,
  computeGroupScoreFingerprint,
  computeOlympicAverage,
  computeOlympicPreview,
  computeRecompeteStandings,
  detectTiedGroups,
  isRoundStale,
  isValidTieGrade,
} from '../src/lib/tieDecisionEngine';
import { md5Hex } from '../src/lib/tieMd5';
import {
  applyProjectorChanges,
  fetchProjectorChanges,
} from '../src/lib/projector/projectorAppService';
import {
  PROJECTOR_TIE_ROUND_IN_PROGRESS_LABEL,
  computeProjectorOverview,
  computeProjectorRankings,
  getProjectorTieStatus,
  type ProjectorEventState,
} from '../src/lib/projector/projectorRanking';
import type {
  Organization,
  ProjectorTieRound,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
} from '../src/lib/supabaseTypes';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`PASS [${passed}]: ${name}`);
}

const ORG: Organization = {
  id: 'org-1',
  org_id: 'FJ-TIE1',
  name: 'Fair Judge Finals',
  tie_breaker_enabled: false,
  tie_management_enabled: true,
  tie_rule: 'countback',
  created_at: '2026-11-22T00:00:00Z',
};

const EVENT: SupabaseEvent = {
  id: 'ev-1',
  org_id: 'FJ-TIE1',
  name: 'Classical Vocal Finals',
  status: 'active',
  rubric_schema: [],
  rubric: [],
  assigned_judges: ['j1', 'j2', 'j3', 'j4', 'j5'],
  assigned_participants: ['p1', 'p2', 'p3', 'p4'],
  created_at: '2026-11-22T00:00:00Z',
};

const JUDGES: SupabaseJudge[] = ['j1', 'j2', 'j3', 'j4', 'j5'].map((id, i) => ({
  id,
  org_id: 'FJ-TIE1',
  name: `Judge ${i + 1}`,
  judge_id: `J0${i + 1}`,
  pin: '',
  judge_pin: '',
  assigned_events: ['ev-1'],
  is_active: true,
  created_at: '2026-11-22T00:00:00Z',
}));

const PARTICIPANTS: SupabaseParticipant[] = [
  { id: 'p1', org_id: 'FJ-TIE1', identity_id: 'P-01', sl_no: '01', name: 'Aarav', school: 'North', is_active: true, created_at: '2026-11-22T00:00:00Z' },
  { id: 'p2', org_id: 'FJ-TIE1', identity_id: 'P-02', sl_no: '02', name: 'Bianca', school: 'South', is_active: true, created_at: '2026-11-22T00:00:00Z' },
  { id: 'p3', org_id: 'FJ-TIE1', identity_id: 'P-03', sl_no: '03', name: 'Cyrus', school: 'East', is_active: true, created_at: '2026-11-22T00:00:00Z' },
  { id: 'p4', org_id: 'FJ-TIE1', identity_id: 'P-04', sl_no: '04', name: 'Diya', school: 'West', is_active: true, created_at: '2026-11-22T00:00:00Z' },
  { id: 'p5', org_id: 'FJ-TIE1', identity_id: 'P-05', sl_no: '05', name: 'Inactive', school: 'Ghost', is_active: false, created_at: '2026-11-22T00:00:00Z' },
];

function mkScore(pid: string, jid: string, val: number): SupabaseScore {
  return {
    id: `${pid}-${jid}-${val}`,
    event_id: 'ev-1',
    participant_id: pid,
    judge_id: jid,
    total_score: val,
    score_data: {},
    score_payload: { criteria: {}, total_score: val, submitted_at: '2026-11-22T10:00:00Z' },
    created_at: '2026-11-22T10:00:00Z',
  };
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

async function runAll() {
  // 1. MD5 & SQL score_fingerprint parity ('s1:' + md5(canonical))
  await test('Fingerprint matches PostgreSQL s1:md5(canonical) bit-for-bit', () => {
    const vectors = ['', 'abc', 'p1[j1=90.0000,j2=80.0000]|p2[j1=85.0000,j2=85.0000]'];
    for (const v of vectors) {
      const nodeMd5 = crypto.createHash('md5').update(v, 'utf8').digest('hex');
      assert.equal(md5Hex(v), nodeMd5, `MD5 mismatch for vector "${v}"`);
    }

    const scores = [
      mkScore('p1', 'j2', 80),
      mkScore('p1', 'j1', 90),
      mkScore('p2', 'j1', 85),
      mkScore('p2', 'j2', 85),
    ];
    const { groups } = detectTiedGroups(PARTICIPANTS, scores, 2);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].groupKey, buildTieGroupKey(['p2', 'p1']));
    assert.equal(groups[0].groupKey, 'p1,p2');

    const canonical = buildCanonicalGroupScoreString(groups[0].members.map((m) => m.participant));
    assert.equal(canonical, 'p1[j1=90.0000,j2=80.0000]|p2[j1=85.0000,j2=85.0000]');
    const expectedFp = `s1:${crypto.createHash('md5').update(canonical, 'utf8').digest('hex')}`;
    assert.equal(groups[0].scoreFingerprint, expectedFp);
    assert.equal(computeGroupScoreFingerprint(groups[0].members.map((m) => m.participant)), expectedFp);
  });

  // 2. Countback: equal averages broken by highest single score, then second highest, then shared
  await test('Countback breaks equal averages by 1st highest, then 2nd highest, else shared place', () => {
    // All 4 participants average 80.00 across 3 judges:
    // p1: [95, 75, 70] -> highest 95 (rank 1)
    // p2: [90, 82, 68] -> highest 90, 2nd highest 82 (rank 2)
    // p3: [90, 80, 70] -> highest 90, 2nd highest 80 (rank 3 — shared with p4)
    // p4: [90, 80, 70] -> identical to p3 (rank 3 — shared with p3)
    const scores = [
      mkScore('p1', 'j1', 95), mkScore('p1', 'j2', 75), mkScore('p1', 'j3', 70),
      mkScore('p2', 'j1', 90), mkScore('p2', 'j2', 82), mkScore('p2', 'j3', 68),
      mkScore('p3', 'j1', 90), mkScore('p3', 'j2', 80), mkScore('p3', 'j3', 70),
      mkScore('p4', 'j1', 90), mkScore('p4', 'j2', 80), mkScore('p4', 'j3', 70),
      // Inactive participant p5 must be excluded from tie detection
      mkScore('p5', 'j1', 80), mkScore('p5', 'j2', 80), mkScore('p5', 'j3', 80),
    ];
    const { groups } = detectTiedGroups(PARTICIPANTS, scores, 3);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].members.length, 4, 'Inactive participant excluded');

    const preview = computeCountbackPreview(groups[0]);
    assert.equal(preview.rule, 'countback');
    assert.equal(preview.stillTied, true);
    assert.equal(preview.resolved, false);
    const byId = new Map(preview.placements.map((p) => [p.participant_id, p.after_rank]));
    assert.equal(byId.get('p1'), 1);
    assert.equal(byId.get('p2'), 2);
    assert.equal(byId.get('p3'), 3);
    assert.equal(byId.get('p4'), 3);

    // Distinct 2nd highest breaks tie cleanly -> resolved = true
    const cleanScores = [
      mkScore('p1', 'j1', 90), mkScore('p1', 'j2', 82), mkScore('p1', 'j3', 68),
      mkScore('p2', 'j1', 90), mkScore('p2', 'j2', 80), mkScore('p2', 'j3', 70),
    ];
    const cleanDetect = detectTiedGroups(PARTICIPANTS, cleanScores, 3);
    const cleanPreview = computeCountbackPreview(cleanDetect.groups[0]);
    assert.equal(cleanPreview.resolved, true);
    assert.equal(cleanPreview.stillTied, false);
    assert.deepEqual(
      cleanPreview.placements.map((p) => ({ id: p.participant_id, rank: p.after_rank })),
      [
        { id: 'p1', rank: 1 },
        { id: 'p2', rank: 2 },
      ]
    );
  });

  // 3. Olympic trim: drops 1 highest + 1 lowest; lowJudgeWarning for 3 or 4 judges, cleared at 5+
  await test('Olympic drops 1 high + 1 low; lowJudgeWarning true at 3 or 4 judges, false at 5+', () => {
    assert.equal(computeOlympicAverage([100, 80]), null);
    assert.equal(computeOlympicAverage([100, 80, 60]), 80);

    // 3 judges: p1 [100, 80, 60] (avg 80, trim 80) vs p2 [95, 85, 60] (avg 80, trim 85)
    const scores3 = [
      mkScore('p1', 'j1', 100), mkScore('p1', 'j2', 80), mkScore('p1', 'j3', 60),
      mkScore('p2', 'j1', 95), mkScore('p2', 'j2', 85), mkScore('p2', 'j3', 60),
    ];
    const g3 = detectTiedGroups(PARTICIPANTS, scores3, 3).groups[0];
    const prev3 = computeOlympicPreview(g3, 3);
    assert.equal(prev3.lowJudgeWarning, true, '3 judges must trigger lowJudgeWarning');
    assert.equal(prev3.resolved, true);
    assert.equal(prev3.placements[0].participant_id, 'p2');
    assert.equal(prev3.placements[0].trimmed_avg, 85);
    assert.equal(prev3.placements[1].participant_id, 'p1');
    assert.equal(prev3.placements[1].trimmed_avg, 80);

    // 4 judges: both avg 80 -> p1 [100, 82, 78, 60] (trim 80) vs p2 [92, 86, 82, 60] (trim 84)
    const scores4 = [
      mkScore('p1', 'j1', 100), mkScore('p1', 'j2', 82), mkScore('p1', 'j3', 78), mkScore('p1', 'j4', 60),
      mkScore('p2', 'j1', 92), mkScore('p2', 'j2', 86), mkScore('p2', 'j3', 82), mkScore('p2', 'j4', 60),
    ];
    const g4 = detectTiedGroups(PARTICIPANTS, scores4, 4).groups[0];
    const prev4 = computeOlympicPreview(g4, 4);
    assert.equal(prev4.lowJudgeWarning, true, '4 judges must trigger lowJudgeWarning');
    assert.equal(prev4.placements[0].participant_id, 'p2');
    assert.equal(prev4.placements[0].trimmed_avg, 84);

    // 5 judges: both avg 80 -> p1 [100, 80, 80, 80, 60] (trim 80) vs p2 [90, 85, 84, 83, 58] (trim 84)
    const scores5 = [
      mkScore('p1', 'j1', 100), mkScore('p1', 'j2', 80), mkScore('p1', 'j3', 80), mkScore('p1', 'j4', 80), mkScore('p1', 'j5', 60),
      mkScore('p2', 'j1', 90), mkScore('p2', 'j2', 85), mkScore('p2', 'j3', 84), mkScore('p2', 'j4', 83), mkScore('p2', 'j5', 58),
    ];
    const g5 = detectTiedGroups(PARTICIPANTS, scores5, 5).groups[0];
    const prev5 = computeOlympicPreview(g5, 5);
    assert.equal(prev5.lowJudgeWarning, false, '5 judges must clear lowJudgeWarning');
    assert.equal(prev5.resolved, true);
    assert.equal(prev5.placements[0].participant_id, 'p2');
    assert.equal(prev5.placements[0].after_rank, 1);
    assert.equal(prev5.placements[1].participant_id, 'p1');
    assert.equal(prev5.placements[1].after_rank, 2);
  });

  // 4. Re-compete standings: grade sum desc -> sealed countback -> shared place
  await test('Re-compete orders by grade sum, then sealed countback, then shared place', () => {
    // All 4 average 80.00:
    // p1: [85, 80, 75] -> grades sum 10 (5+5) -> rank 1 (wins on grade sum)
    // p2: [92, 78, 70] -> grades sum 8 (4+4) -> rank 2 (ties p3/p4 on grade sum, wins on sealed 92)
    // p3: [88, 82, 70] -> grades sum 8 (4+4) -> rank 3 (shared with p4, identical sealed marks)
    // p4: [88, 82, 70] -> grades sum 8 (4+4) -> rank 3 (shared with p3)
    const sealed = [
      mkScore('p1', 'j1', 85), mkScore('p1', 'j2', 80), mkScore('p1', 'j3', 75),
      mkScore('p2', 'j1', 92), mkScore('p2', 'j2', 78), mkScore('p2', 'j3', 70),
      mkScore('p3', 'j1', 88), mkScore('p3', 'j2', 82), mkScore('p3', 'j3', 70),
      mkScore('p4', 'j1', 88), mkScore('p4', 'j2', 82), mkScore('p4', 'j3', 70),
    ];
    const group = detectTiedGroups(PARTICIPANTS, sealed, 3).groups[0];
    const standings = computeRecompeteStandings(group, [
      { judge_id: 'j1', participant_id: 'p1', grade: 5 },
      { judge_id: 'j2', participant_id: 'p1', grade: 5 },
      { judge_id: 'j1', participant_id: 'p2', grade: 4 },
      { judge_id: 'j2', participant_id: 'p2', grade: 4 },
      { judge_id: 'j1', participant_id: 'p3', grade: 4 },
      { judge_id: 'j2', participant_id: 'p3', grade: 4 },
      { judge_id: 'j1', participant_id: 'p4', grade: 4 },
      { judge_id: 'j2', participant_id: 'p4', grade: 4 },
      // Invalid out-of-range grades must be ignored
      { judge_id: 'j3', participant_id: 'p4', grade: 99 },
      { judge_id: 'j3', participant_id: 'p3', grade: 0 },
    ]);

    assert.equal(standings.submittedJudgeCount, 2);
    assert.equal(standings.totalGrades, 8);
    assert.equal(standings.stillTied, true);
    const byId = new Map(standings.placements.map((p) => [p.participant_id, p.after_rank]));
    assert.equal(byId.get('p1'), 1);
    assert.equal(byId.get('p2'), 2);
    assert.equal(byId.get('p3'), 3);
    assert.equal(byId.get('p4'), 3);
  });

  // 5. Grade scale: strictly integer 1 to 5 only
  await test('Grade scale accepts strictly integers 1..5 only', () => {
    for (const valid of [1, 2, 3, 4, 5]) {
      assert.equal(isValidTieGrade(valid), true, `Expected ${valid} to be valid`);
    }
    for (const invalid of [0, 6, -1, 2.5, 4.9, NaN, Infinity, '5', null, undefined]) {
      assert.equal(isValidTieGrade(invalid), false, `Expected ${String(invalid)} to be invalid`);
    }
  });

  // 6. isRoundStale: true when fingerprint changes or group disappears
  await test('isRoundStale flags changed score fingerprint or disappeared tie group', () => {
    const scores = [
      mkScore('p1', 'j1', 90), mkScore('p1', 'j2', 70),
      mkScore('p2', 'j1', 80), mkScore('p2', 'j2', 80),
    ];
    const { groups } = detectTiedGroups(PARTICIPANTS, scores, 2);
    const liveGroup = groups[0];

    const round: ProjectorTieRound = {
      id: 'round-1',
      event_id: 'ev-1',
      group_key: liveGroup.groupKey,
      tied_rank: 1,
      tied_participant_ids: ['p1', 'p2'],
      rule: 'recompete',
      status: 'open',
      is_stale: false,
      score_fingerprint: liveGroup.scoreFingerprint,
      result_payload: {},
      published_at: null,
      version: 1,
    };

    assert.equal(isRoundStale(round, groups), false, 'Matching live group & fingerprint is fresh');

    // Sealed score changes while still tied -> fingerprint changes -> stale = true
    const alteredStillTied = [
      mkScore('p1', 'j1', 88), mkScore('p1', 'j2', 72),
      mkScore('p2', 'j1', 80), mkScore('p2', 'j2', 80),
    ];
    const { groups: alteredGroups } = detectTiedGroups(PARTICIPANTS, alteredStillTied, 2);
    assert.equal(isRoundStale(round, alteredGroups), true, 'Changed score fingerprint marks round stale');

    // Tie disappears -> group missing -> stale = true
    const brokenTie = [
      mkScore('p1', 'j1', 95), mkScore('p1', 'j2', 95),
      mkScore('p2', 'j1', 80), mkScore('p2', 'j2', 80),
    ];
    const { groups: noTies } = detectTiedGroups(PARTICIPANTS, brokenTie, 2);
    assert.equal(noTies.length, 0);
    assert.equal(isRoundStale(round, noTies), true, 'Disappeared tie group marks round stale');

    // Already cancelled_stale round is not flagged as active stale
    assert.equal(isRoundStale({ ...round, status: 'cancelled_stale', is_stale: true }, noTies), false);
  });

  // 7. Projector state allowlist, cancelled_stale ignored, open -> "Tie round in progress", published shared & countback
  await test('Projector state strips grades/audit/private fields, ignores cancelled_stale, and surfaces Tie round in progress', async () => {
    const scores = [
      mkScore('p1', 'j1', 92), mkScore('p1', 'j2', 68),
      mkScore('p2', 'j1', 80), mkScore('p2', 'j2', 80),
    ];
    const { groups } = detectTiedGroups(PARTICIPANTS, scores, 2);
    const g = groups[0];

    // Simulate server response polluted with forbidden fields
    const fetched = await fetchProjectorChanges(
      async () => ({
        data: {
          ok: true,
          changed: true,
          cursor: 12,
          org: { ...ORG, password: 'SECRET_PASSWORD', email: 'org@secret.test' },
          event: { ...EVENT, secret_note: 'DROP_ME' },
          participants: [
            { ...PARTICIPANTS[0], mobile_number: '+1-555-0199' },
            { ...PARTICIPANTS[1], mobile_number: '+1-555-0299' },
          ],
          judges: [
            { ...JUDGES[0], pin: '9999', judge_pin: '9999', current_session_token: 'TOK_SECRET' },
            { ...JUDGES[1], pin: '8888', judge_pin: '8888', current_session_token: 'TOK_SECRET2' },
          ],
          scores,
          tie_round_grades: [{ id: 'g1', judge_id: 'j1', participant_id: 'p1', grade: 5 }],
          tie_audit_log: [{ id: 'a1', actor_label: 'Secret Organiser', reason: 'Private' }],
          tie_rounds: [
            {
              id: 'r-open',
              event_id: 'ev-1',
              group_key: g.groupKey,
              tied_rank: 1,
              tied_participant_ids: ['p1', 'p2'],
              rule: 'recompete',
              status: 'open',
              is_stale: false,
              score_fingerprint: g.scoreFingerprint,
              result_payload: { extra_pin: '4321' },
              published_at: null,
              version: 12,
              actor_label: 'SHOULD_NOT_ENTER',
              last_reopen_reason: 'SHOULD_NOT_ENTER',
              decided_by: 'SHOULD_NOT_ENTER',
              grades: [{ grade: 5 }],
              mobile_number: '555-0000',
              pin: '1234',
            },
            {
              id: 'r-stale',
              event_id: 'ev-1',
              group_key: 'p3,p4',
              tied_rank: 3,
              tied_participant_ids: ['p3', 'p4'],
              rule: 'recompete',
              status: 'cancelled_stale',
              is_stale: true,
              score_fingerprint: 's1:old',
              result_payload: {},
              published_at: null,
              version: 12,
            },
          ],
          deletions: [],
        },
        error: null,
      }),
      'proj-tok',
      0
    );

    assert.equal(fetched.ok, true);
    assert.ok(fetched.payload);

    const empty: ProjectorEventState = {
      org: null,
      event: null,
      participants: [],
      judges: [],
      scores: [],
      tieRounds: [],
    };
    const state1 = applyProjectorChanges(empty, fetched.payload!);

    // Assert forbidden keys never exist anywhere in serialized projector state
    assert.equal('tie_round_grades' in (state1 as unknown as Record<string, unknown>), false);
    assert.equal('tie_audit_log' in (state1 as unknown as Record<string, unknown>), false);
    assert.equal('grades' in (state1 as unknown as Record<string, unknown>), false);
    assert.equal('audit' in (state1 as unknown as Record<string, unknown>), false);
    const serialized = JSON.stringify(state1);
    assert.doesNotMatch(serialized, /SHOULD_NOT_ENTER/);
    assert.doesNotMatch(serialized, /SECRET_PASSWORD|TOK_SECRET|555-0199|555-0299|555-0000|extra_pin|decided_by|actor_label|last_reopen_reason|mobile_number/);
    assert.equal(state1.judges.every((j) => j.pin === '' && j.judge_pin === '' && j.current_session_token === null), true);

    // cancelled_stale round is ignored; open re-compete round is retained
    assert.equal(state1.tieRounds?.length, 1);
    assert.equal(state1.tieRounds?.[0].id, 'r-open');

    // Open re-compete surfaces "Tie round in progress" and holds shared places
    const tieStatus = getProjectorTieStatus(state1);
    assert.equal(tieStatus.hasOpenTieRound, true);
    assert.equal(tieStatus.bannerLabel, PROJECTOR_TIE_ROUND_IN_PROGRESS_LABEL);
    assert.equal(tieStatus.bannerLabel, 'Tie round in progress');
    assert.equal(computeProjectorOverview(state1).tieStatusBanner, 'Tie round in progress');
    const rankedDuringOpen = computeProjectorRankings(state1);
    assert.deepEqual(rankedDuringOpen.map((r) => r.rank), [1, 1]);

    // Publish countback resolution -> banner clears, p1 ranks 1st, p2 ranks 2nd
    const cbPreview = computeCountbackPreview(g);
    const state2 = applyProjectorChanges(state1, {
      changed: true,
      cursor: 13,
      participants: [],
      judges: [],
      scores: [],
      tieRounds: [
        {
          id: 'r-open',
          event_id: 'ev-1',
          group_key: g.groupKey,
          tied_rank: 1,
          tied_participant_ids: ['p1', 'p2'],
          rule: 'countback',
          status: 'published',
          is_stale: false,
          score_fingerprint: g.scoreFingerprint,
          result_payload: {
            rule: 'countback',
            tied_rank: 1,
            score_fingerprint: g.scoreFingerprint,
            resolved: true,
            still_tied: false,
            placements: cbPreview.placements,
          },
          published_at: '2026-11-22T10:05:00Z',
          version: 13,
        },
      ],
      deletions: [],
    });
    assert.equal(getProjectorTieStatus(state2).hasOpenTieRound, false);
    assert.equal(getProjectorTieStatus(state2).bannerLabel, null);
    const rankedPublished = computeProjectorRankings(state2);
    assert.deepEqual(
      rankedPublished.map((r) => ({ id: r.id, rank: r.rank })),
      [
        { id: 'p1', rank: 1 },
        { id: 'p2', rank: 2 },
      ]
    );

    // Published 'shared' rule keeps shared places explicitly
    const state3 = applyProjectorChanges(state2, {
      changed: true,
      cursor: 14,
      participants: [],
      judges: [],
      scores: [],
      tieRounds: [
        {
          id: 'r-open',
          event_id: 'ev-1',
          group_key: g.groupKey,
          tied_rank: 1,
          tied_participant_ids: ['p1', 'p2'],
          rule: 'shared',
          status: 'published',
          is_stale: false,
          score_fingerprint: g.scoreFingerprint,
          result_payload: {
            rule: 'shared',
            tied_rank: 1,
            score_fingerprint: g.scoreFingerprint,
            resolved: false,
            still_tied: true,
            placements: [],
          },
          published_at: '2026-11-22T10:06:00Z',
          version: 14,
        },
      ],
      deletions: [],
    });
    assert.deepEqual(computeProjectorRankings(state3).map((r) => r.rank), [1, 1]);

    // Deletion tombstone removes tie round cleanly
    const state4 = applyProjectorChanges(state3, {
      changed: true,
      cursor: 15,
      participants: [],
      judges: [],
      scores: [],
      tieRounds: [],
      deletions: [{ table_name: 'tie_rounds', record_id: 'r-open', version: 15 }],
    });
    assert.equal(state4.tieRounds?.length, 0);
  });

  // 8. Static source scan: old manual-order names are completely gone from src/
  await test('Old manual-order tie names are absent from src/ (count = 0)', () => {
    const srcRoot = path.resolve(process.cwd(), 'src');
    const files = walkFiles(srcRoot);
    const bannedPattern =
      /\b(TieDecisionMode|TieDecision|ProjectorTieDecision|tieDecisions|ordered_participant_ids|decided_by|resolveTieDecisionUpsertResponse|applyTieDecisions)\b/g;
    const hits: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const matches = content.match(bannedPattern);
      if (matches && matches.length > 0) {
        hits.push(`${path.relative(process.cwd(), file)}: ${matches.join(', ')}`);
      }
    }
    assert.equal(hits.length, 0, `Found banned old manual-order names in src/: ${hits.join('; ')}`);
  });

  console.log(`\nALL ${passed} TIE MANAGEMENT TESTS PASSED.`);
}

runAll().catch((err) => {
  console.error('VERIFY TIE MANAGEMENT FAILED:', err);
  process.exit(1);
});
