import { type RankedParticipantItem } from '../tieBreakerEngine';
import {
  buildTieGroupKey,
  computeCountbackPreview,
  computeGroupScoreFingerprint,
  computeOlympicPreview,
  detectTiedGroups,
  isRoundStale,
  type DetectedTiedGroup,
} from '../tieDecisionEngine';
import type {
  Organization,
  ProjectorTieRound,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
  TieRoundPlacement,
} from '../supabaseTypes';
import type { ProjectorSnapshot } from '../projectorService';
import { isEventProvisional } from '../../components/public/PublicLeaderboard';

export const PROJECTOR_TIE_ROUND_IN_PROGRESS_LABEL = 'Tie round in progress';

export interface ProjectorEventState {
  org: Organization | null;
  event: SupabaseEvent | null;
  participants: SupabaseParticipant[];
  judges: SupabaseJudge[];
  scores: SupabaseScore[];
  tieRounds?: ProjectorTieRound[];
}

export interface ProjectorTieStatus {
  hasOpenTieRound: boolean;
  openTieRoundCount: number;
  openTieGroupKeys: string[];
  bannerLabel: string | null;
}

export interface ProjectorOverviewMetrics {
  isProvisional: boolean;
  isEnded: boolean;
  totalContenders: number;
  scoredContenders: number;
  waitingContenders: number;
  totalJudges: number;
  totalBallots: number;
  expectedBallots: number;
  completionPercent: number;
  hasOpenTieRound: boolean;
  tieStatusBanner: string | null;
  judgeProgress: Array<{
    judge: SupabaseJudge;
    ballotsCast: number;
    expected: number;
  }>;
}

function parseTimestampMs(createdAt?: string): number {
  if (!createdAt) return 0;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Deduplicates scores to the latest row per (participant_id, judge_id) by created_at.
 * Skips rows with null/non-numeric total_score.
 */
export function deduplicateEventScores(
  scores: SupabaseScore[],
  eventId?: string
): SupabaseScore[] {
  const latest = new Map<string, { score: SupabaseScore; ts: number; order: number }>();

  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!s || !s.participant_id || !s.judge_id) continue;
    if (eventId && s.event_id !== eventId) continue;

    const raw = s.total_score as unknown;
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) continue;

    const key = `${s.participant_id}::${s.judge_id}`;
    const ts = parseTimestampMs(s.created_at);
    const existing = latest.get(key);
    if (!existing || ts > existing.ts || (ts === existing.ts && i > existing.order)) {
      latest.set(key, {
        score: { ...s, total_score: numeric },
        ts,
        order: i,
      });
    }
  }

  return Array.from(latest.values(), (v) => v.score);
}

/**
 * Returns active participants assigned to the scoped event.
 * Names remain visible even when blind_judging_enabled is true (blind judging hides names on judge screens only).
 */
export function getActiveAssignedParticipants(
  event: SupabaseEvent | null,
  participants: SupabaseParticipant[]
): SupabaseParticipant[] {
  if (!event) return [];
  const active = participants.filter((p) => p.is_active !== false);
  const assignedIds = event.assigned_participants || [];
  if (assignedIds.length > 0) {
    const allowed = new Set(assignedIds);
    return active.filter((p) => allowed.has(p.id));
  }
  return active;
}

export function getActiveAssignedJudges(
  event: SupabaseEvent | null,
  judges: SupabaseJudge[]
): SupabaseJudge[] {
  if (!event) return [];
  const active = judges.filter((j) => j.is_active !== false);
  const assignedIds = new Set(event.assigned_judges || []);
  if (assignedIds.size === 0) return active;
  const matched = active.filter(
    (j) => assignedIds.has(j.id) || (j.assigned_events || []).includes(event.id)
  );
  return matched.length > 0 ? matched : active;
}

function getScopedEventRounds(state: ProjectorEventState): ProjectorTieRound[] {
  if (!state.event) return [];
  return (state.tieRounds || []).filter(
    (r) =>
      r &&
      (!r.event_id || r.event_id === state.event?.id) &&
      r.status !== 'cancelled_stale' &&
      r.status !== 'closed'
  );
}

/**
 * Returns whether an active (non-stale) re-compete tie round is currently in progress
 * for the scoped event, exposing the "Tie round in progress" status label.
 */
export function getProjectorTieStatus(state: ProjectorEventState): ProjectorTieStatus {
  if (!state.event) {
    return {
      hasOpenTieRound: false,
      openTieRoundCount: 0,
      openTieGroupKeys: [],
      bannerLabel: null,
    };
  }
  const activeParticipants = getActiveAssignedParticipants(state.event, state.participants);
  const activeJudges = getActiveAssignedJudges(state.event, state.judges);
  const eventScores = deduplicateEventScores(state.scores, state.event.id);
  const { groups } = detectTiedGroups(
    activeParticipants,
    eventScores,
    activeJudges.length || state.event.assigned_judges?.length || 0
  );

  const openRounds = getScopedEventRounds(state).filter(
    (r) => r.status === 'open' && r.rule === 'recompete' && !isRoundStale(r, groups)
  );
  const openTieGroupKeys = Array.from(new Set(openRounds.map((r) => r.group_key)));
  const hasOpenTieRound = openTieGroupKeys.length > 0;

  return {
    hasOpenTieRound,
    openTieRoundCount: openTieGroupKeys.length,
    openTieGroupKeys,
    bannerLabel: hasOpenTieRound ? PROJECTOR_TIE_ROUND_IN_PROGRESS_LABEL : null,
  };
}

function applyPlacementsToBucket(
  bucket: RankedParticipantItem[],
  baseRank: number,
  placements: ReadonlyArray<TieRoundPlacement>
): RankedParticipantItem[] {
  const rankMap = new Map<string, number>();
  for (const p of placements) {
    if (p && p.participant_id && Number.isFinite(p.after_rank) && p.after_rank >= baseRank) {
      rankMap.set(p.participant_id, Math.floor(p.after_rank));
    }
  }
  return [...bucket]
    .map((item) => ({
      ...item,
      rank: rankMap.get(item.id) ?? baseRank,
    }))
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

/**
 * Computes client-side rankings for the Projector App using the 17.7.0 tie engine.
 * - Active participants only
 * - Deduplicated latest score per (participant_id, judge_id)
 * - Absent participants (rank === 0) excluded from ranked standings
 * - Applies non-stale published tieRounds (countback, olympic, recompete, shared)
 * - Keeps shared places while an open re-compete round is in progress
 * - Ignores cancelled_stale rounds
 */
export function computeProjectorRankings(
  state: ProjectorEventState
): RankedParticipantItem[] {
  if (!state.event) return [];
  const activeParticipants = getActiveAssignedParticipants(state.event, state.participants);
  const activeJudges = getActiveAssignedJudges(state.event, state.judges);
  const eventScores = deduplicateEventScores(state.scores, state.event.id);
  const judgeCount = activeJudges.length || state.event.assigned_judges?.length || 0;

  const { baselineRankings, groups } = detectTiedGroups(
    activeParticipants,
    eventScores,
    judgeCount
  );

  const scored = baselineRankings.filter((r) => r.rank > 0 && r.judgeCount > 0);
  const groupByKey = new Map<string, DetectedTiedGroup>(groups.map((g) => [g.groupKey, g]));
  const scopedRounds = getScopedEventRounds(state);

  const openByKey = new Map<string, ProjectorTieRound>();
  const publishedByKey = new Map<string, ProjectorTieRound>();
  for (const r of scopedRounds) {
    if (isRoundStale(r, groups)) continue;
    if (r.status === 'open' && r.rule === 'recompete') {
      openByKey.set(r.group_key, r);
    } else if (r.status === 'published') {
      publishedByKey.set(r.group_key, r);
    }
  }

  const useLegacyOlympicFallback =
    state.org?.tie_management_enabled !== true &&
    state.org?.tie_breaker_enabled === true &&
    state.org?.tie_breaker_method === 'olympic';

  const finalScored: RankedParticipantItem[] = [];
  let i = 0;
  while (i < scored.length) {
    let j = i + 1;
    while (j < scored.length && scored[j].rank === scored[i].rank) j += 1;
    const bucket = scored.slice(i, j);
    const baseRank = i + 1;

    if (bucket.length < 2) {
      finalScored.push({ ...bucket[0], rank: baseRank });
      i = j;
      continue;
    }

    const groupKey = buildTieGroupKey(bucket.map((b) => b.id));
    const detected = groupByKey.get(groupKey);
    const liveFp = detected?.scoreFingerprint ?? computeGroupScoreFingerprint(bucket);
    const openRound = openByKey.get(groupKey);
    const publishedRound = publishedByKey.get(groupKey);

    if (openRound) {
      // Open re-compete in progress: hold shared rank until published
      finalScored.push(...bucket.map((item) => ({ ...item, rank: baseRank })));
    } else if (publishedRound && publishedRound.score_fingerprint === liveFp) {
      if (publishedRound.rule === 'shared') {
        finalScored.push(...bucket.map((item) => ({ ...item, rank: baseRank })));
      } else {
        const serverPlacements = Array.isArray(publishedRound.result_payload?.placements)
          ? publishedRound.result_payload.placements
          : [];
        if (serverPlacements.length > 0) {
          finalScored.push(...applyPlacementsToBucket(bucket, baseRank, serverPlacements));
        } else if (detected && publishedRound.rule === 'countback') {
          finalScored.push(
            ...applyPlacementsToBucket(bucket, baseRank, computeCountbackPreview(detected).placements)
          );
        } else if (detected && publishedRound.rule === 'olympic') {
          finalScored.push(
            ...applyPlacementsToBucket(
              bucket,
              baseRank,
              computeOlympicPreview(detected, judgeCount).placements
            )
          );
        } else {
          finalScored.push(...bucket.map((item) => ({ ...item, rank: baseRank })));
        }
      }
    } else if (useLegacyOlympicFallback && detected) {
      finalScored.push(
        ...applyPlacementsToBucket(
          bucket,
          baseRank,
          computeOlympicPreview(detected, judgeCount).placements
        )
      );
    } else {
      finalScored.push(...bucket.map((item) => ({ ...item, rank: baseRank })));
    }

    i = j;
  }

  return finalScored;
}

/**
 * Computes Overview screen progress metrics purely from local merged delta rows.
 */
export function computeProjectorOverview(
  state: ProjectorEventState
): ProjectorOverviewMetrics {
  const event = state.event;
  const activeParticipants = getActiveAssignedParticipants(event, state.participants);
  const activeJudges = getActiveAssignedJudges(event, state.judges);
  const dedupScores = deduplicateEventScores(state.scores, event?.id);

  const activeParticipantIds = new Set(activeParticipants.map((p) => p.id));
  const activeJudgeIds = new Set(activeJudges.map((j) => j.id));

  const validScores = dedupScores.filter(
    (s) =>
      activeParticipantIds.has(s.participant_id) &&
      (activeJudgeIds.size === 0 || activeJudgeIds.has(s.judge_id))
  );

  const scoredParticipantSet = new Set(validScores.map((s) => s.participant_id));
  const ballotsByJudge = new Map<string, number>();
  for (const s of validScores) {
    ballotsByJudge.set(s.judge_id, (ballotsByJudge.get(s.judge_id) || 0) + 1);
  }

  const totalContenders = activeParticipants.length;
  const scoredContenders = scoredParticipantSet.size;
  const waitingContenders = Math.max(0, totalContenders - scoredContenders);
  const totalJudges = activeJudges.length;
  const expectedBallots = totalContenders * totalJudges;
  const totalBallots = validScores.length;
  const completionPercent =
    expectedBallots > 0 ? Math.min(100, Math.round((totalBallots / expectedBallots) * 100)) : 0;

  const statusLower = String(event?.status || '').toLowerCase();
  const isEnded = Boolean(event?.is_archived) || statusLower === 'ended' || statusLower === 'archived';
  const tieStatus = getProjectorTieStatus(state);

  return {
    isProvisional: isEventProvisional(event),
    isEnded,
    totalContenders,
    scoredContenders,
    waitingContenders,
    totalJudges,
    totalBallots,
    expectedBallots,
    completionPercent,
    hasOpenTieRound: tieStatus.hasOpenTieRound,
    tieStatusBanner: tieStatus.bannerLabel,
    judgeProgress: activeJudges.map((judge) => ({
      judge,
      ballotsCast: ballotsByJudge.get(judge.id) || 0,
      expected: totalContenders,
    })),
  };
}

/**
 * Adapts local merged state into a ProjectorSnapshot compatible with PublicLeaderboard.tsx.
 * - Always keeps blind_judging_enabled = false on the projector snapshot so participant names
 *   stay visible and server-blind mode is never forced.
 * - Applies local `hideScores` toggle strictly as a display mask (`projector_blind_mode`),
 *   while all ranking maths continue to run client-side on full numeric scores.
 */
export function buildLiveViewSnapshot(
  state: ProjectorEventState,
  hideScores: boolean
): ProjectorSnapshot | null {
  if (!state.org || !state.event) return null;
  const activeParticipants = getActiveAssignedParticipants(state.event, state.participants);
  const activeJudges = getActiveAssignedJudges(state.event, state.judges);
  const dedupScores = deduplicateEventScores(state.scores, state.event.id);

  const liveOrg: Organization = {
    ...state.org,
    blind_judging_enabled: false,
    projector_blind_mode: hideScores,
  };

  return {
    org: liveOrg,
    events: [state.event],
    judges: activeJudges,
    participants: activeParticipants,
    scores: dedupScores,
    blindRanks: [],
    scopedEventId: state.event.id,
    label: state.event.name,
    isBlank: false,
  };
}

export { isEventProvisional };
