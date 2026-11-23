/**
 * Pure TypeScript Tie Decision Engine (17.7.0). Zero DOM, DB, or UI dependencies.
 */
import { calculateRankings, type RankedParticipantItem } from './tieBreakerEngine';
import type { Organization, SupabaseParticipant, SupabaseScore, TieDecisionMode } from './supabaseTypes';

export const EVENT_MODE_GROUP_KEY = '__event_mode__';

export interface TieDecisionLike {
  id?: string;
  event_id?: string;
  group_key: string;
  mode: TieDecisionMode;
  ordered_participant_ids: string[];
  score_fingerprint: string;
  decided_by?: string;
  decided_at?: string;
  version?: number;
}

export interface TieGroupMember {
  participant: RankedParticipantItem;
  perJudgeScores: Array<{ judgeId: string; score: number }>;
  rawAverage: number;
  olympicAverage: number | null;
}

export interface DetectedTiedGroup {
  groupKey: string;
  rank: number;
  tiedAverageScore: number;
  scoreFingerprint: string;
  members: TieGroupMember[];
}

export interface ResolvedTiedGroup extends DetectedTiedGroup {
  decision: TieDecisionLike | null;
  effectiveMode: TieDecisionMode;
  isStale: boolean;
  isResolved: boolean;
}

export interface AppliedTieRankingsResult {
  rankings: RankedParticipantItem[];
  tiedGroups: ResolvedTiedGroup[];
  unresolvedTieCount: number;
  staleDecisionGroupKeys: string[];
}

export interface TieDecisionRpcResponse {
  ok: boolean;
  error?: string;
  message?: string;
  data?: TieDecisionLike | null;
  current?: TieDecisionLike | null;
}

export interface TieDecisionConflictOutcome {
  status: 'saved' | 'conflict' | 'error';
  decision: TieDecisionLike | null;
  conflictServerDecision: TieDecisionLike | null;
  message: string;
}

export function resolveOrgTieDefault(
  org?: Pick<Organization, 'tie_breaker_enabled' | 'tie_breaker_method'> | null
): TieDecisionMode {
  if (!org || !org.tie_breaker_enabled) return 'shared';
  if (org.tie_breaker_method === 'olympic') return 'olympic';
  if (org.tie_breaker_method === 'manual') return 'manual';
  return 'shared';
}

export function buildTieGroupKey(participantIds: ReadonlyArray<string>): string {
  return Array.from(new Set(participantIds.map((id) => String(id).trim()).filter(Boolean)))
    .sort()
    .join(',');
}

export function computeOlympicAverage(scores: ReadonlyArray<SupabaseScore>): number | null {
  if (scores.length < 3) return null;
  const sorted = scores.map((s) => Number(s.total_score)).sort((a, b) => a - b);
  const trimmed = sorted.slice(1, sorted.length - 1);
  return Number((trimmed.reduce((acc, v) => acc + v, 0) / trimmed.length).toFixed(2));
}

function fnv1aHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (ch + ((i + 1) & 0xff)), 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

export function computeGroupScoreFingerprint(
  members: ReadonlyArray<Pick<RankedParticipantItem, 'id' | 'pScores'>>
): string {
  const canonical = [...members]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((m) => {
      const ballots = [...(m.pScores || [])]
        .map((s) => ({ judgeId: String(s.judge_id), val: Number(s.total_score).toFixed(4) }))
        .sort((a, b) => a.judgeId.localeCompare(b.judgeId))
        .map((b) => `${b.judgeId}=${b.val}`)
        .join(',');
      return `${m.id}[${ballots}]`;
    })
    .join('|');
  return `v1:${fnv1aHex(canonical)}`;
}

function toTieGroupMember(item: RankedParticipantItem): TieGroupMember {
  const perJudgeScores = [...(item.pScores || [])]
    .map((s) => ({ judgeId: String(s.judge_id), score: Number(s.total_score) }))
    .sort((a, b) => a.judgeId.localeCompare(b.judgeId));
  return {
    participant: item,
    perJudgeScores,
    rawAverage: item.avgScore,
    olympicAverage: computeOlympicAverage(item.pScores || []),
  };
}

function normalizeActiveBaseline(rankings: ReadonlyArray<RankedParticipantItem>) {
  const active = rankings.filter((r) => r.is_active !== false);
  const scoredRaw = active.filter((r) => r.judgeCount > 0).map((r) => ({ ...r })).sort((a, b) => b.avgScore - a.avgScore);
  const absent = active.filter((r) => r.judgeCount <= 0).map((r) => ({ ...r, rank: 0 }));
  let currentRank = 1;
  const scored = scoredRaw.map((item, idx) => {
    if (idx === 0) currentRank = 1;
    else if (item.avgScore !== scoredRaw[idx - 1].avgScore) currentRank = idx + 1;
    return { ...item, rank: currentRank };
  });
  return { scored, absent };
}

export function detectTiedGroups(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  assignedJudgesCount: number = 0
): { baselineRankings: RankedParticipantItem[]; groups: DetectedTiedGroup[] } {
  const active = participants.filter((p) => p.is_active !== false);
  const baselineRankings = calculateRankings(active, scores, assignedJudgesCount, 'shared', false);
  const byRank = new Map<number, RankedParticipantItem[]>();
  for (const row of baselineRankings) {
    if (row.rank <= 0 || row.judgeCount <= 0) continue;
    const bucket = byRank.get(row.rank) || [];
    bucket.push(row);
    byRank.set(row.rank, bucket);
  }
  const groups: DetectedTiedGroup[] = [];
  for (const [rank, rows] of Array.from(byRank.entries()).sort((a, b) => a[0] - b[0])) {
    if (rows.length < 2) continue;
    groups.push({
      groupKey: buildTieGroupKey(rows.map((r) => r.id)),
      rank,
      tiedAverageScore: rows[0].avgScore,
      scoreFingerprint: computeGroupScoreFingerprint(rows),
      members: rows.map(toTieGroupMember),
    });
  }
  return { baselineRankings, groups };
}

export function applyTieDecisions(
  rankings: ReadonlyArray<RankedParticipantItem>,
  decisions: ReadonlyArray<TieDecisionLike> = [],
  orgDefault: TieDecisionMode = 'shared'
): AppliedTieRankingsResult {
  const { scored, absent } = normalizeActiveBaseline(rankings);
  const byKey = new Map<string, TieDecisionLike>();
  for (const d of decisions || []) {
    if (d?.group_key) byKey.set(d.group_key, d);
  }
  const eventModeDecision = byKey.get(EVENT_MODE_GROUP_KEY) ?? null;

  const finalScored: RankedParticipantItem[] = [];
  const tiedGroups: ResolvedTiedGroup[] = [];
  const staleDecisionGroupKeys: string[] = [];
  let unresolvedTieCount = 0;

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
    const scoreFingerprint = computeGroupScoreFingerprint(bucket);
    const groupDecision = byKey.get(groupKey) ?? null;
    const isStale = Boolean(groupDecision?.score_fingerprint && groupDecision.score_fingerprint !== scoreFingerprint);

    let effectiveMode: TieDecisionMode = orgDefault;
    let activeDecision: TieDecisionLike | null = groupDecision;
    if (isStale) {
      effectiveMode = 'shared';
      staleDecisionGroupKeys.push(groupKey);
    } else if (groupDecision) {
      effectiveMode = groupDecision.mode;
    } else if (eventModeDecision) {
      effectiveMode = eventModeDecision.mode;
      activeDecision = eventModeDecision;
    }

    let resolvedRows: RankedParticipantItem[];
    let isResolved = false;

    if (effectiveMode === 'manual' && groupDecision && !isStale) {
      const orderIndex = new Map<string, number>();
      (groupDecision.ordered_participant_ids || []).forEach((id, idx) => {
        if (!orderIndex.has(id)) orderIndex.set(id, idx);
      });
      const ordered = [...bucket].sort(
        (a, b) => (orderIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      );
      resolvedRows = ordered.map((item, idx) => ({ ...item, rank: baseRank + idx }));
      isResolved = true;
    } else if (effectiveMode === 'olympic') {
      const withTrim = bucket
        .map((item) => {
          const trimAvg = computeOlympicAverage(item.pScores || []);
          return { ...item, avgScore: trimAvg !== null ? trimAvg : item.avgScore };
        })
        .sort((a, b) => b.avgScore - a.avgScore);
      let subRank = baseRank;
      let hasSubTie = false;
      resolvedRows = withTrim.map((item, idx) => {
        if (idx === 0) subRank = baseRank;
        else if (item.avgScore === withTrim[idx - 1].avgScore) hasSubTie = true;
        else subRank = baseRank + idx;
        return { ...item, rank: subRank };
      });
      isResolved = !hasSubTie;
    } else {
      resolvedRows = bucket.map((item) => ({ ...item, rank: baseRank }));
      isResolved = Boolean(!isStale && activeDecision?.mode === 'shared');
    }

    if (!isResolved) unresolvedTieCount += 1;
    tiedGroups.push({
      groupKey, rank: baseRank, tiedAverageScore: bucket[0].avgScore, scoreFingerprint,
      members: bucket.map(toTieGroupMember), decision: activeDecision, effectiveMode, isStale, isResolved,
    });
    finalScored.push(...resolvedRows);
    i = j;
  }

  return { rankings: [...finalScored, ...absent], tiedGroups, unresolvedTieCount, staleDecisionGroupKeys };
}

export function computeRankedStandingsWithDecisions(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  assignedJudgesCount: number = 0,
  decisions: ReadonlyArray<TieDecisionLike> = [],
  orgDefault: TieDecisionMode = 'shared'
): AppliedTieRankingsResult {
  const { baselineRankings } = detectTiedGroups(participants, scores, assignedJudgesCount);
  return applyTieDecisions(baselineRankings, decisions, orgDefault);
}

export function resolveTieDecisionUpsertResponse(
  response: TieDecisionRpcResponse,
  localFallback: TieDecisionLike | null = null
): TieDecisionConflictOutcome {
  if (response.ok) {
    return { status: 'saved', decision: response.data ?? localFallback, conflictServerDecision: null, message: 'Tie decision saved.' };
  }
  if (response.error === 'conflict') {
    return {
      status: 'conflict', decision: response.current ?? localFallback, conflictServerDecision: response.current ?? null,
      message: response.message || 'Another organiser updated this tie decision. Review before saving again.',
    };
  }
  return { status: 'error', decision: localFallback, conflictServerDecision: null, message: response.message || 'Could not save tie decision.' };
}
