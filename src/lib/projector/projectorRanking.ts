import { calculateRankings, RankedParticipantItem } from '../tieBreakerEngine';
import { applyTieDecisions, resolveOrgTieDefault } from '../tieDecisionEngine';
import type {
  Organization,
  ProjectorTieDecision,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
} from '../supabaseTypes';
import type { ProjectorSnapshot } from '../projectorService';
import { isEventProvisional } from '../../components/public/PublicLeaderboard';

export interface ProjectorEventState {
  org: Organization | null;
  event: SupabaseEvent | null;
  participants: SupabaseParticipant[];
  judges: SupabaseJudge[];
  scores: SupabaseScore[];
  tieDecisions?: ProjectorTieDecision[];
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

/**
 * Computes client-side rankings for the Projector App using the shared tieBreakerEngine.
 * - Active participants only
 * - Deduplicated latest score per (participant_id, judge_id)
 * - Absent participants (rank === 0) excluded from ranked standings
 * - Unresolved ties share standard competition ranks (1, 2, 2, 4)
 */
export function computeProjectorRankings(
  state: ProjectorEventState
): RankedParticipantItem[] {
  if (!state.event) return [];
  const activeParticipants = getActiveAssignedParticipants(state.event, state.participants);
  const activeJudges = getActiveAssignedJudges(state.event, state.judges);
  const eventScores = deduplicateEventScores(state.scores, state.event.id);
  const eventDecisions = (state.tieDecisions || []).filter(
    (d) => !d.event_id || d.event_id === state.event?.id
  );

  const baseline = calculateRankings(
    activeParticipants,
    eventScores,
    activeJudges.length || state.event.assigned_judges?.length || 0,
    'shared',
    false
  );

  const applied = applyTieDecisions(
    baseline,
    eventDecisions,
    resolveOrgTieDefault(state.org)
  );

  return applied.rankings.filter((item) => item.rank > 0);
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
