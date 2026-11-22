import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { calculateRankings, calculateRankingsAsync } from '../src/lib/tieBreakerEngine';
import { runGoldenTests } from '../src/lib/goldenTests';
import { isEventProvisional, PublicLeaderboard } from '../src/components/public/PublicLeaderboard';
import { ProjectorScoreboard } from '../src/components/public/ProjectorScoreboard';
import type {
  Organization,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
  TieBreakerMethod,
} from '../src/lib/supabaseTypes';
import type { ProjectorSnapshot } from '../src/lib/projectorService';

function makeParticipant(
  id: string,
  name: string,
  slNo: string,
  isActive?: boolean
): SupabaseParticipant {
  return {
    id,
    org_id: 'ORG-TEST',
    identity_id: id,
    sl_no: slNo,
    name,
    school: 'Test School',
    is_active: isActive,
    created_at: '2026-11-19T00:00:00Z',
  };
}

function makeScore(
  id: string,
  participantId: string,
  judgeId: string,
  totalScore: number | null | undefined,
  createdAt = '2026-11-19T10:00:00Z',
  eventId = 'evt-1'
): SupabaseScore {
  return {
    id,
    event_id: eventId,
    judge_id: judgeId,
    participant_id: participantId,
    total_score: totalScore as number,
    score_data: {},
    score_payload: { criteria: {}, total_score: (totalScore ?? 0) as number },
    created_at: createdAt,
  };
}

function makeEvent(status: SupabaseEvent['status'], isArchived = false): SupabaseEvent {
  return {
    id: 'evt-1',
    org_id: 'ORG-TEST',
    name: 'Classical Solo',
    category: 'MUSIC',
    date: '2026-11-19',
    status,
    is_archived: isArchived,
    is_locked: false,
    rubric_schema: [{ id: 'c1', name: 'Technique', max_marks: 100 }],
    assigned_judges: ['j1', 'j2', 'j3'],
    assigned_participants: ['p1', 'p2', 'p3', 'p4'],
    created_at: '2026-11-19T00:00:00Z',
  };
}

function makeOrg(tieBreakerEnabled: boolean, method: TieBreakerMethod = 'olympic'): Organization {
  return {
    id: 'ORG-TEST',
    org_id: 'ORG-TEST',
    name: 'Test Championship',
    tie_breaker_enabled: tieBreakerEnabled,
    tie_breaker_method: method,
    blind_judging_enabled: false,
    projector_blind_mode: false,
    projector_spotlight_mode: true,
    created_at: '2026-11-19T00:00:00Z',
  };
}

const JUDGES: SupabaseJudge[] = [
  { id: 'j1', org_id: 'ORG-TEST', name: 'Judge 1', judge_id: 'J1', pin: '', assigned_events: ['evt-1'], created_at: '2026-11-19T00:00:00Z' },
  { id: 'j2', org_id: 'ORG-TEST', name: 'Judge 2', judge_id: 'J2', pin: '', assigned_events: ['evt-1'], created_at: '2026-11-19T00:00:00Z' },
  { id: 'j3', org_id: 'ORG-TEST', name: 'Judge 3', judge_id: 'J3', pin: '', assigned_events: ['evt-1'], created_at: '2026-11-19T00:00:00Z' },
];

// Minimal DOM/navigator shims for SSR rendering of PublicLeaderboard
function ensureDomShims(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.navigator === 'undefined') {
    g.navigator = { onLine: true };
  }
  if (typeof g.localStorage === 'undefined') {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, String(v)),
      removeItem: (k: string) => store.delete(k),
      clear: () => store.clear(),
    };
  }
}

async function run(): Promise<void> {
  let passedCount = 0;
  const pass = (label: string) => {
    passedCount++;
    console.log(`  PASS: ${label}`);
  };

  console.log('Running Phase 2 (17.5.0) Projector Ranking Verification...');

  // -------------------------------------------------------------------------
  // 1. Unresolved ties share standard competition ranks (1, 2, 2, 4)
  //    for tieBreakerEnabled = false AND true across olympic, manual, shared
  // -------------------------------------------------------------------------
  {
    const participants = [
      makeParticipant('p1', 'Alice', '01', true),
      makeParticipant('p2', 'Bob', '02', true),
      makeParticipant('p3', 'Cara', '03', true),
      makeParticipant('p4', 'Dan', '04', true),
    ];
    const scores = [
      makeScore('s1', 'p1', 'j1', 95),
      makeScore('s2', 'p2', 'j1', 90),
      makeScore('s3', 'p3', 'j1', 90),
      makeScore('s4', 'p4', 'j1', 80),
    ];

    const configs: Array<[TieBreakerMethod, boolean]> = [
      ['olympic', false],
      ['manual', false],
      ['shared', false],
      ['olympic', true],
      ['manual', true],
      ['shared', true],
    ];

    for (const [method, enabled] of configs) {
      const ranked = calculateRankings(participants, scores, 1, method, enabled);
      assert.deepEqual(
        ranked.map((r) => r.rank),
        [1, 2, 2, 4],
        `Expected [1, 2, 2, 4] for method=${method}, enabled=${enabled}`
      );
    }
    pass('Shared competition ranks [1, 2, 2, 4] hold for tie-breaker OFF and ON (olympic, manual, shared)');
  }

  // -------------------------------------------------------------------------
  // 2. Inactive participants excluded
  // -------------------------------------------------------------------------
  {
    const pActive = makeParticipant('p1', 'Active Star', '01', true);
    const pDefault = makeParticipant('p2', 'Default Active', '02', undefined);
    const pInactive = makeParticipant('p3', 'Withdrawn', '03', false);
    const scores = [
      makeScore('s1', 'p1', 'j1', 80),
      makeScore('s2', 'p2', 'j1', 70),
      makeScore('s3', 'p3', 'j1', 99),
    ];
    const ranked = calculateRankings([pActive, pDefault, pInactive], scores, 1, 'olympic', true);
    assert.deepEqual(ranked.map((r) => r.id), ['p1', 'p2']);
    assert.deepEqual(ranked.map((r) => r.rank), [1, 2]);
    pass('Inactive participants (is_active === false) are excluded from rankings');
  }

  // -------------------------------------------------------------------------
  // 3. Latest-score deduplication per (participant_id, judge_id) & invalid score skip
  // -------------------------------------------------------------------------
  {
    const p1 = makeParticipant('p1', 'Alice', '01', true);
    const p2 = makeParticipant('p2', 'Bob', '02', true);
    const scores = [
      // Newer score appears FIRST in array, older score appears SECOND — newer must win
      makeScore('s-new', 'p1', 'j1', 92, '2026-11-19T12:00:00Z'),
      makeScore('s-old', 'p1', 'j1', 60, '2026-11-19T11:00:00Z'),
      // Null / non-numeric scores must be skipped
      makeScore('s-null', 'p1', 'j2', null, '2026-11-19T12:30:00Z'),
      makeScore('s-nan', 'p1', 'j3', Number.NaN, '2026-11-19T12:30:00Z'),
      // Bob has one valid score
      makeScore('s-b1', 'p2', 'j1', 85, '2026-11-19T11:00:00Z'),
    ];
    const ranked = calculateRankings([p1, p2], scores, 3, 'olympic', true);
    assert.equal(ranked[0].id, 'p1');
    assert.equal(ranked[0].judgeCount, 1);
    assert.equal(ranked[0].avgScore, 92);
    assert.equal(ranked[1].id, 'p2');
    assert.equal(ranked[1].avgScore, 85);
    pass('Scores deduplicate to latest created_at per (participant_id, judge_id) and skip null/non-numeric marks');
  }

  // -------------------------------------------------------------------------
  // 4. Absentee exclusion & scored-0 sorts strictly before absentee
  // -------------------------------------------------------------------------
  {
    const pZero = makeParticipant('p1', 'Scored Zero', '01', true);
    const pAbsent = makeParticipant('p2', 'Absent Competitor', '02', true);
    const scores = [makeScore('s1', 'p1', 'j1', 0)];
    const ranked = calculateRankings([pAbsent, pZero], scores, 1, 'olympic', false);
    assert.equal(ranked[0].id, 'p1');
    assert.equal(ranked[0].rank, 1);
    assert.equal(ranked[1].id, 'p2');
    assert.equal(ranked[1].rank, 0);
    pass('Scored participants (including score 0) sort before absentees; absentees keep rank 0');
  }

  // -------------------------------------------------------------------------
  // 5. Tie-breaker ON trims a 3+ judge tie; OFF does not
  // -------------------------------------------------------------------------
  {
    const pA = makeParticipant('p1', 'Trimmed Winner', '01', true);
    const pB = makeParticipant('p2', 'Steady Competitor', '02', true);
    // pA: [60, 90, 90] -> raw avg = 80.00, Olympic trimmed avg = 90.00
    // pB: [80, 80, 80] -> raw avg = 80.00, Olympic trimmed avg = 80.00
    const scores = [
      makeScore('a1', 'p1', 'j1', 60),
      makeScore('a2', 'p1', 'j2', 90),
      makeScore('a3', 'p1', 'j3', 90),
      makeScore('b1', 'p2', 'j1', 80),
      makeScore('b2', 'p2', 'j2', 80),
      makeScore('b3', 'p2', 'j3', 80),
    ];

    const offRanks = calculateRankings([pA, pB], scores, 3, 'olympic', false);
    assert.deepEqual(offRanks.map((r) => [r.id, r.avgScore, r.rank]), [
      ['p1', 80, 1],
      ['p2', 80, 1],
    ]);

    const onRanks = calculateRankings([pA, pB], scores, 3, 'olympic', true);
    assert.deepEqual(onRanks.map((r) => [r.id, r.avgScore, r.rank]), [
      ['p1', 90, 1],
      ['p2', 80, 2],
    ]);
    pass('Tie-breaker ON trims 3+ judge Olympic tie ([90, 80] -> [1, 2]); OFF keeps raw average ([80, 80] -> [1, 1])');
  }

  // -------------------------------------------------------------------------
  // 6. Worker error path settles pending promises immediately (< 250ms, not 5000ms)
  // -------------------------------------------------------------------------
  {
    const g = globalThis as Record<string, unknown>;
    const prevWindow = g.window;
    const prevWorker = g.Worker;
    let terminateCount = 0;

    try {
      g.window = {};

      // 6a: worker.onerror fires asynchronously after postMessage
      class ErroringWorker {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: ((ev: unknown) => void) | null = null;
        postMessage() {
          queueMicrotask(() => {
            this.onerror?.(new Error('Simulated worker crash'));
          });
        }
        terminate() {
          terminateCount++;
        }
      }
      g.Worker = ErroringWorker;

      const p1 = makeParticipant('p1', 'Alice', '01', true);
      const s1 = makeScore('s1', 'p1', 'j1', 88);

      const t0 = Date.now();
      const [resA, resB] = await Promise.all([
        calculateRankingsAsync([p1], [s1], 1, 'olympic', false),
        calculateRankingsAsync([p1], [s1], 1, 'olympic', true),
      ]);
      const elapsedOnError = Date.now() - t0;

      assert.ok(elapsedOnError < 500, `Expected immediate fallback on worker.onerror, took ${elapsedOnError}ms`);
      assert.equal(resA[0].rank, 1);
      assert.equal(resB[0].rank, 1);
      assert.ok(terminateCount >= 1, 'Expected broken worker to be terminated');

      // 6b: worker.postMessage throws synchronously
      class ThrowingPostMessageWorker {
        onmessage: ((ev: MessageEvent) => void) | null = null;
        onerror: ((ev: unknown) => void) | null = null;
        postMessage() {
          throw new Error('DataCloneError');
        }
        terminate() {
          terminateCount++;
        }
      }
      g.Worker = ThrowingPostMessageWorker;

      const t1 = Date.now();
      const resC = await calculateRankingsAsync([p1], [s1], 1, 'olympic', true);
      const elapsedThrow = Date.now() - t1;

      assert.ok(elapsedThrow < 500, `Expected immediate fallback on postMessage throw, took ${elapsedThrow}ms`);
      assert.equal(resC[0].rank, 1);
      assert.ok(terminateCount >= 2, 'Expected worker to be terminated after postMessage throw');

      pass(`Worker error & postMessage throw settle immediately via sync fallback (${elapsedOnError}ms / ${elapsedThrow}ms, not 5000ms)`);
    } finally {
      if (prevWindow === undefined) delete g.window;
      else g.window = prevWindow;
      if (prevWorker === undefined) delete g.Worker;
      else g.Worker = prevWorker;
    }
  }

  // -------------------------------------------------------------------------
  // 7. Provisional rule & projector rendering (active vs ended + tie-breaker on/off)
  // -------------------------------------------------------------------------
  {
    assert.equal(isEventProvisional(makeEvent('active')), true);
    assert.equal(isEventProvisional(makeEvent('draft')), true);
    assert.equal(isEventProvisional(makeEvent('paused')), true);
    assert.equal(isEventProvisional(makeEvent('ended')), false);
    assert.equal(isEventProvisional(makeEvent('archived')), false);
    assert.equal(isEventProvisional(makeEvent('active', true)), false);

    ensureDomShims();
    const participants = [
      makeParticipant('p1', 'Trimmed Winner', '01', true),
      makeParticipant('p2', 'Steady Competitor', '02', true),
      makeParticipant('p3', 'Absent Competitor', '03', true),
      makeParticipant('p4', 'Inactive Competitor', '04', false),
    ];
    const scores = [
      makeScore('a1', 'p1', 'j1', 60),
      makeScore('a2', 'p1', 'j2', 90),
      makeScore('a3', 'p1', 'j3', 90),
      makeScore('b1', 'p2', 'j1', 80),
      makeScore('b2', 'p2', 'j2', 80),
      makeScore('b3', 'p2', 'j3', 80),
      makeScore('inact1', 'p4', 'j1', 100),
    ];

    const buildSnapshot = (
      status: SupabaseEvent['status'],
      tieBreakerEnabled: boolean
    ): ProjectorSnapshot => ({
      org: makeOrg(tieBreakerEnabled, 'olympic'),
      events: [makeEvent(status)],
      judges: JUDGES,
      participants,
      scores,
      blindRanks: [],
      scopedEventId: 'evt-1',
      label: 'Stage A',
      isBlank: false,
    });

    // Active event -> shows Provisional badge, excludes absent & inactive competitors
    const activeHtml = renderToStaticMarkup(
      React.createElement(PublicLeaderboard, { snapshot: buildSnapshot('active', true) })
    );
    assert.ok(activeHtml.includes('Provisional'), 'Active leaderboard must render Provisional badge');
    assert.ok(!activeHtml.includes('Absent Competitor'), 'Absent competitor (rank 0) must be excluded');
    assert.ok(!activeHtml.includes('Inactive Competitor'), 'Inactive competitor must be excluded');
    assert.ok(
      activeHtml.includes('<span>90 <span'),
      'Leaderboard with tie-breaker ON must render Olympic trimmed avg 90'
    );

    // Ended event -> omits Provisional badge, shows normal final ranking
    const endedHtml = renderToStaticMarkup(
      React.createElement(PublicLeaderboard, { snapshot: buildSnapshot('ended', false) })
    );
    assert.ok(!endedHtml.includes('Provisional'), 'Ended leaderboard must NOT render Provisional badge');
    assert.ok(
      endedHtml.includes('<span>80 <span'),
      'Leaderboard with tie-breaker OFF must render untrimmed avg 80'
    );
    assert.ok(
      !endedHtml.includes('<span>90 <span'),
      'Leaderboard with tie-breaker OFF must NOT apply Olympic trim'
    );

    // Scoreboard: active shows Provisional, ended hides it, tie-breaker ON trims to 90 vs OFF keeps 80
    const activeScoreboardHtml = renderToStaticMarkup(
      React.createElement(ProjectorScoreboard, {
        organization: makeOrg(true, 'olympic'),
        currentEvent: makeEvent('active'),
        judges: JUDGES,
        participants,
        scores,
        isStadiumWhite: false,
        isBlindMode: false,
      })
    );
    assert.ok(activeScoreboardHtml.includes('Provisional'), 'Active scoreboard must render Provisional badge');
    assert.ok(!activeScoreboardHtml.includes('Absent Competitor'), 'Scoreboard must exclude rank 0 absentees');
    assert.ok(!activeScoreboardHtml.includes('Inactive Competitor'), 'Scoreboard must exclude inactive participants');
    assert.ok(activeScoreboardHtml.includes('>90<'), 'Scoreboard with tie-breaker ON must show trimmed avg 90');

    const endedScoreboardHtml = renderToStaticMarkup(
      React.createElement(ProjectorScoreboard, {
        organization: makeOrg(false, 'olympic'),
        currentEvent: makeEvent('ended'),
        judges: JUDGES,
        participants,
        scores,
        isStadiumWhite: false,
        isBlindMode: false,
      })
    );
    assert.ok(!endedScoreboardHtml.includes('Provisional'), 'Ended scoreboard must NOT render Provisional badge');

    // Confirm celebration suppression guards exist in PublicLeaderboard.tsx
    const lbSource = fs.readFileSync(
      path.resolve('src/components/public/PublicLeaderboard.tsx'),
      'utf8'
    );
    assert.ok(
      lbSource.includes('<ConfettiBurst active={!isProvisional && isConfettiActive} />'),
      'ConfettiBurst must be suppressed when isProvisional is true'
    );
    assert.ok(
      lbSource.includes('{!isProvisional && newLeaderModal && newLeaderModal.show && ('),
      'newLeaderModal must be suppressed when isProvisional is true'
    );
    assert.ok(
      lbSource.includes('{!isProvisional && perfectScoreModal && perfectScoreModal.show && ('),
      'perfectScoreModal must be suppressed when isProvisional is true'
    );

    pass('Active events show Provisional & suppress celebrations; ended events show normal final ranking; projector honors tie-breaker OFF and ON');
  }

  // -------------------------------------------------------------------------
  // 8. Golden Tests suite (all 10 pass including updated Test #6)
  // -------------------------------------------------------------------------
  {
    const golden = runGoldenTests();
    const failed = golden.cases.filter((c) => !c.passed);
    assert.equal(
      failed.length,
      0,
      `Golden tests failed: ${failed.map((f) => `${f.id} (${f.expected} vs ${f.actual})`).join(', ')}`
    );
    pass(`All ${golden.total} Golden Tests pass (including Test #6 shared rank [1, 1])`);
  }

  console.log(`\nALL ${passedCount} PHASE 2 VERIFICATION CHECKS PASSED.`);
}

run().catch((err) => {
  console.error('\nPHASE 2 VERIFICATION FAILED:', err);
  process.exit(1);
});
