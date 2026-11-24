/**
 * Pure TypeScript ballot-hygiene and read-only tie-breaker suggestion helpers (17.4.1).
 * Zero DOM, zero Supabase runtime, zero SQL dependencies.
 *
 * Covers:
 * - Active-only, deduplicated ballot hygiene (latest created_at wins; 0-score absentees excluded)
 * - Blind-judging participant label formatting
 * - Read-only tie-breaker suggestions linked to existing organisation settings without mutating ranks
 */
import type {
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
  TieBreakerMethod,
} from '../supabaseTypes';
import { calculateRankings } from '../tieBreakerEngine';
import { getActiveAssignedJudges, getActiveEnrolledParticipants } from './eventRules';
import type {
  DedupedEventData,
  TieBreakerContext,
  TieBreakerResolutionMethod,
  TieBreakerSuggestedEntry,
  TieBreakerSuggestionItem,
} from './types';

export const TIE_BREAKER_SEPARATION_EPSILON = 0.0001;

function parseScoreTimestamp(score: {
  created_at?: string;
  score_payload?: { submitted_at?: string };
}): number {
  const raw = score.created_at || score.score_payload?.submitted_at || '';
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

export function formatFairnessParticipantLabel(
  participant: SupabaseParticipant,
  blindJudgingEnabled: boolean
): string {
  if (!blindJudgingEnabled) {
    return participant.name;
  }
  const identity = String(participant.identity_id || '').trim();
  if (identity) return `Participant ${identity}`;
  const sl = String(participant.sl_no || '').trim();
  return sl ? `Participant #${sl}` : 'Participant';
}

// ==========================================
// DEDUPLICATED ACTIVE-ONLY EVENT DATA
// ==========================================

/**
 * Filters org scores to active assigned judges and active enrolled participants per event,
 * deduplicating duplicate (participant_id, judge_id) ballots by keeping latest created_at.
 * Absent participants (0 valid ballots) never appear in `scoresByParticipant`.
 */
export function buildDeduplicatedEventData(
  events: SupabaseEvent[],
  orgJudges: SupabaseJudge[],
  orgParticipants: SupabaseParticipant[],
  allScores: SupabaseScore[]
): DedupedEventData[] {
  const rawScoresByEvent = new Map<string, SupabaseScore[]>();
  for (let i = 0; i < allScores.length; i++) {
    const score = allScores[i];
    let list = rawScoresByEvent.get(score.event_id);
    if (!list) {
      list = [];
      rawScoresByEvent.set(score.event_id, list);
    }
    list.push(score);
  }

  return events.map((event) => {
    const activeJudges = getActiveAssignedJudges(event, orgJudges);
    const activeParticipants = getActiveEnrolledParticipants(event, orgParticipants);

    const activeJudgeById = new Map<string, SupabaseJudge>();
    for (let i = 0; i < activeJudges.length; i++) {
      activeJudgeById.set(activeJudges[i].id, activeJudges[i]);
    }

    const activeParticipantById = new Map<string, SupabaseParticipant>();
    for (let i = 0; i < activeParticipants.length; i++) {
      activeParticipantById.set(activeParticipants[i].id, activeParticipants[i]);
    }

    const eventRawScores = rawScoresByEvent.get(event.id) || [];
    const byParticipantJudge = new Map<
      string,
      Map<string, { score: SupabaseScore; ts: number | null; idx: number }>
    >();

    for (let idx = 0; idx < eventRawScores.length; idx++) {
      const score = eventRawScores[idx];
      if (!activeJudgeById.has(score.judge_id)) continue;
      if (!activeParticipantById.has(score.participant_id)) continue;

      let judgeScores = byParticipantJudge.get(score.participant_id);
      if (!judgeScores) {
        judgeScores = new Map();
        byParticipantJudge.set(score.participant_id, judgeScores);
      }

      const existing = judgeScores.get(score.judge_id);
      if (!existing) {
        judgeScores.set(score.judge_id, { score, ts: null, idx });
      } else {
        const existingTs =
          existing.ts !== null ? existing.ts : parseScoreTimestamp(existing.score);
        existing.ts = existingTs;
        const nextTs = parseScoreTimestamp(score);
        if (nextTs > existingTs || (nextTs === existingTs && idx >= existing.idx)) {
          judgeScores.set(score.judge_id, { score, ts: nextTs, idx });
        }
      }
    }

    const deduplicatedScores: SupabaseScore[] = [];
    const scoresByParticipant = new Map<string, SupabaseScore[]>();

    byParticipantJudge.forEach((judgeScores, participantId) => {
      const list: SupabaseScore[] = [];
      judgeScores.forEach(({ score }) => {
        deduplicatedScores.push(score);
        list.push(score);
      });
      scoresByParticipant.set(participantId, list);
    });

    return {
      event,
      activeJudges,
      activeParticipants,
      activeJudgeById,
      activeParticipantById,
      deduplicatedScores,
      scoresByParticipant,
    };
  });
}

// ==========================================
// TIE-BREAKER SUGGESTIONS (READ-ONLY, SETTINGS-LINKED)
// ==========================================

function hasScoreSeparation(
  ranked: Array<{ avgScore: number }>,
  epsilon: number = TIE_BREAKER_SEPARATION_EPSILON
): boolean {
  if (ranked.length < 2) return false;
  let minScore = ranked[0].avgScore;
  let maxScore = ranked[0].avgScore;
  for (let i = 1; i < ranked.length; i++) {
    const v = ranked[i].avgScore;
    if (v < minScore) minScore = v;
    if (v > maxScore) maxScore = v;
  }
  return maxScore - minScore >= epsilon;
}

function buildSuggestedEntries(
  ranked: Array<{ id: string; avgScore: number }>,
  participantById: Map<string, SupabaseParticipant>,
  blindJudgingEnabled: boolean,
  epsilon: number = TIE_BREAKER_SEPARATION_EPSILON
): TieBreakerSuggestedEntry[] {
  const entries: TieBreakerSuggestedEntry[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i];
    const participant = participantById.get(item.id);
    if (!participant) continue;
    let suggestedRank = i + 1;
    if (i > 0 && Math.abs(item.avgScore - ranked[i - 1].avgScore) < epsilon) {
      suggestedRank = entries[i - 1]?.suggestedRank ?? suggestedRank;
    }
    entries.push({
      participant,
      displayName: formatFairnessParticipantLabel(participant, blindJudgingEnabled),
      suggestedRank,
      suggestedScore: item.avgScore,
    });
  }
  return entries;
}

/**
 * Generates read-only tie-breaker suggestions for tied rank groups on concluded events,
 * governed by the organisation's Tie-Breaker Engine settings (`tie_breaker_enabled` and
 * `tie_breaker_method`). Official standings are never mutated.
 */
export function computeEventTieBreakerSuggestions(
  ctx: TieBreakerContext
): TieBreakerSuggestionItem[] {
  if (!ctx.tieBreakerEnabled) return [];

  const statusLower = String(ctx.event.status || '').toLowerCase();
  if (statusLower !== 'ended' && statusLower !== 'archived') return [];

  const blindJudgingEnabled = Boolean(ctx.blindJudgingEnabled);
  const method: TieBreakerMethod = ctx.tieBreakerMethod || 'olympic';

  const tiedByRank = new Map<
    number,
    Array<{ participant: SupabaseParticipant; averageScore: number; ballotCount: number }>
  >();

  for (let i = 0; i < ctx.standings.length; i++) {
    const row = ctx.standings[i];
    if (!row.isTied) continue;
    let group = tiedByRank.get(row.rank);
    if (!group) {
      group = [];
      tiedByRank.set(row.rank, group);
    }
    group.push(row);
  }

  const suggestions: TieBreakerSuggestionItem[] = [];
  const sortedRanks = Array.from(tiedByRank.keys()).sort((a, b) => a - b);

  for (let rIdx = 0; rIdx < sortedRanks.length; rIdx++) {
    const rank = sortedRanks[rIdx];
    const group = tiedByRank.get(rank)!;
    if (group.length < 2) continue;

    const tiedAverageScore = group[0].averageScore;

    // Head-to-Head / Shared: no suggested order is calculated
    if (method === 'shared') {
      suggestions.push({
        id: `${ctx.event.id}__rank_${rank}`,
        eventId: ctx.event.id,
        rank,
        tiedAverageScore,
        resolution: 'shared',
        entries: [],
        level: 'info',
      });
      continue;
    }

    // Legacy unresolved tie setting: no suggested order is calculated
    if (method === 'manual') {
      suggestions.push({
        id: `${ctx.event.id}__rank_${rank}`,
        eventId: ctx.event.id,
        rank,
        tiedAverageScore,
        resolution: 'manual_required',
        entries: [],
        level: 'info',
      });
      continue;
    }

    // Olympic Standard: try Olympic trim (>= 3 ballots each), then 4-decimal precision
    const tiedParticipants = group.map((g) => g.participant);
    const participantById = new Map(tiedParticipants.map((p) => [p.id, p]));
    const tiedIdSet = new Set(tiedParticipants.map((p) => p.id));
    const tiedScores = ctx.deduplicatedEventScores.filter((s) =>
      tiedIdSet.has(s.participant_id)
    );
    const allHaveAtLeast3Judges = group.every((g) => g.ballotCount >= 3);

    let resolution: TieBreakerResolutionMethod = 'manual_required';
    let entries: TieBreakerSuggestedEntry[] = [];

    if (allHaveAtLeast3Judges) {
      const olympicRanked = calculateRankings(
        tiedParticipants,
        tiedScores,
        ctx.activeAssignedJudgesCount,
        'olympic',
        true
      );
      if (hasScoreSeparation(olympicRanked, TIE_BREAKER_SEPARATION_EPSILON)) {
        resolution = 'olympic';
        entries = buildSuggestedEntries(
          olympicRanked,
          participantById,
          blindJudgingEnabled,
          TIE_BREAKER_SEPARATION_EPSILON
        );
      }
    }

    if (resolution === 'manual_required') {
      const precisionRanked = calculateRankings(
        tiedParticipants,
        tiedScores,
        ctx.activeAssignedJudgesCount,
        'manual',
        true
      );
      if (hasScoreSeparation(precisionRanked, TIE_BREAKER_SEPARATION_EPSILON)) {
        resolution = 'precision_4dp';
        entries = buildSuggestedEntries(
          precisionRanked,
          participantById,
          blindJudgingEnabled,
          TIE_BREAKER_SEPARATION_EPSILON
        );
      }
    }

    suggestions.push({
      id: `${ctx.event.id}__rank_${rank}`,
      eventId: ctx.event.id,
      rank,
      tiedAverageScore,
      resolution,
      entries,
      level: 'info',
    });
  }

  return suggestions;
}
