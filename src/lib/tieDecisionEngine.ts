/**
 * Pure TypeScript Tie Management Engine (17.7.0).
 * Mirrors PostgreSQL _fj_detect_event_tie_groups, tie_round_apply_auto,
 * tie_round_close, tie_round_publish, and _fj_find_stale_tie_rounds.
 * Zero DOM, DB, or UI dependencies.
 */
import { calculateRankings, type RankedParticipantItem } from './tieBreakerEngine';
import { md5Hex } from './tieMd5';
import type {
  ProjectorTieRound,
  SupabaseParticipant,
  SupabaseScore,
  TieRound,
  TieRoundGrade,
  TieRoundPlacement,
  TieRoundRule,
} from './supabaseTypes';

export const TIE_GRADE_MIN = 1;
export const TIE_GRADE_MAX = 5;
export const TIE_GRADE_LABELS: Readonly<Record<1 | 2 | 3 | 4 | 5, string>> = {
  5: 'A', 4: 'B', 3: 'C', 2: 'D', 1: 'E',
};

export interface TieGroupMember {
  participant: RankedParticipantItem;
  perJudgeScores: Array<{ judgeId: string; score: number }>;
  scoresDesc: number[];
  ballotCount: number;
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

export interface AutoTiePreview {
  rule: 'countback' | 'olympic';
  groupKey: string;
  tiedRank: number;
  scoreFingerprint: string;
  placements: TieRoundPlacement[];
  stillTied: boolean;
  resolved: boolean;
  lowJudgeWarning: boolean;
}

export interface RecompeteStandingsResult {
  rule: 'recompete';
  groupKey: string;
  tiedRank: number;
  scoreFingerprint: string;
  placements: TieRoundPlacement[];
  stillTied: boolean;
  resolved: boolean;
  submittedJudgeCount: number;
  totalGrades: number;
}

const lexCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

export function isValidTieGrade(grade: unknown): grade is 1 | 2 | 3 | 4 | 5 {
  return typeof grade === 'number' && Number.isInteger(grade) && grade >= TIE_GRADE_MIN && grade <= TIE_GRADE_MAX;
}

export function buildTieGroupKey(participantIds: ReadonlyArray<string>): string {
  return Array.from(new Set(participantIds.map((id) => String(id).trim()).filter(Boolean)))
    .sort(lexCompare)
    .join(',');
}

export function computeOlympicAverage(scores: ReadonlyArray<SupabaseScore> | ReadonlyArray<number>): number | null {
  if (scores.length < 3) return null;
  const numeric = scores
    .map((entry) => (typeof entry === 'number' ? entry : Number(entry.total_score)))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (numeric.length < 3) return null;
  const trimmed = numeric.slice(1, numeric.length - 1);
  return round2(trimmed.reduce((acc, v) => acc + v, 0) / trimmed.length);
}

/**
 * Mirrors PostgreSQL _fj_detect_event_tie_groups:
 * 's1:' || md5(string_agg(pid || '[' || string_agg(jid || '=' || to_char(val, 'FM999999990.0000'), ',' order by jid) || ']', '|' order by pid))
 */
export function buildCanonicalGroupScoreString(
  members: ReadonlyArray<Pick<RankedParticipantItem, 'id' | 'pScores'>>
): string {
  return [...members]
    .sort((a, b) => lexCompare(String(a.id), String(b.id)))
    .map((m) => {
      const ballots = [...(m.pScores || [])]
        .map((s) => ({ judgeId: String(s.judge_id), val: Number(s.total_score).toFixed(4) }))
        .sort((a, b) => lexCompare(a.judgeId, b.judgeId))
        .map((b) => `${b.judgeId}=${b.val}`)
        .join(',');
      return `${m.id}[${ballots}]`;
    })
    .join('|');
}

export function computeGroupScoreFingerprint(
  members: ReadonlyArray<Pick<RankedParticipantItem, 'id' | 'pScores'>>
): string {
  return `s1:${md5Hex(buildCanonicalGroupScoreString(members))}`;
}

export function compareScoresDesc(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return b[i] - a[i];
  }
  return b.length - a.length;
}

function toTieGroupMember(item: RankedParticipantItem): TieGroupMember {
  const perJudgeScores = [...(item.pScores || [])]
    .map((s) => ({ judgeId: String(s.judge_id), score: Number(s.total_score) }))
    .sort((a, b) => lexCompare(a.judgeId, b.judgeId));
  const scoresDesc = perJudgeScores.map((s) => s.score).sort((a, b) => b - a);
  return {
    participant: item,
    perJudgeScores,
    scoresDesc,
    ballotCount: perJudgeScores.length,
    rawAverage: item.avgScore,
    olympicAverage: computeOlympicAverage(scoresDesc),
  };
}

function assignCompetitionRanks<T>(
  sorted: ReadonlyArray<T>,
  baseRank: number,
  isSameTie: (curr: T, prev: T) => boolean,
  buildPlacement: (item: T, afterRank: number) => TieRoundPlacement
): { placements: TieRoundPlacement[]; stillTied: boolean } {
  let currentRank = baseRank;
  let stillTied = false;
  const placements = sorted.map((item, idx) => {
    if (idx === 0) currentRank = baseRank;
    else if (isSameTie(item, sorted[idx - 1])) stillTied = true;
    else currentRank = baseRank + idx;
    return buildPlacement(item, currentRank);
  });
  return { placements, stillTied };
}

export function detectTiedGroups(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  assignedJudgesCount: number = 0,
  absentParticipantIds?: ReadonlySet<string> | ReadonlyArray<string>
): { baselineRankings: RankedParticipantItem[]; groups: DetectedTiedGroup[] } {
  const absentSet = absentParticipantIds
    ? absentParticipantIds instanceof Set
      ? absentParticipantIds
      : new Set<string>(absentParticipantIds)
    : new Set<string>();
  const active = participants.filter((p) => p.is_active !== false && !absentSet.has(p.id));
  const eligibleScores = scores.filter((s) => {
    if (!s || absentSet.has(s.participant_id)) return false;
    const payload = s.score_payload as { is_absent?: boolean; criteria?: Record<string, unknown> } | undefined;
    if (payload?.is_absent === true) return false;
    const criteriaCount = Object.keys(s.score_data || payload?.criteria || {}).length;
    if (Number(s.total_score) === 0 && criteriaCount === 0) return false;
    return true;
  });
  const baselineRankings = calculateRankings(
    active,
    eligibleScores,
    assignedJudgesCount,
    'shared',
    false,
    absentSet
  );
  const byRank = new Map<number, RankedParticipantItem[]>();
  for (const row of baselineRankings) {
    if (row.rank <= 0 || row.judgeCount <= 0 || absentSet.has(row.id)) continue;
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

export function computeCountbackPreview(group: DetectedTiedGroup): AutoTiePreview {
  const sorted = [...group.members].sort((a, b) => {
    const cmp = compareScoresDesc(a.scoresDesc, b.scoresDesc);
    return cmp !== 0 ? cmp : lexCompare(a.participant.id, b.participant.id);
  });
  const { placements, stillTied } = assignCompetitionRanks(
    sorted,
    group.rank,
    (curr, prev) => compareScoresDesc(curr.scoresDesc, prev.scoresDesc) === 0,
    (m, afterRank) => ({
      participant_id: m.participant.id, before_rank: group.rank, after_rank: afterRank,
      base_avg: m.rawAverage, ballot_count: m.ballotCount, scores_desc: [...m.scoresDesc], trimmed_avg: null,
    })
  );
  return {
    rule: 'countback', groupKey: group.groupKey, tiedRank: group.rank,
    scoreFingerprint: group.scoreFingerprint, placements, stillTied, resolved: !stillTied, lowJudgeWarning: false,
  };
}

export function computeOlympicPreview(group: DetectedTiedGroup, configuredJudgesCount?: number): AutoTiePreview {
  const sorted = group.members
    .map((member) => ({
      member,
      trimmedAvg: member.ballotCount >= 3 && member.olympicAverage !== null ? member.olympicAverage : member.rawAverage,
    }))
    .sort((a, b) =>
      a.trimmedAvg !== b.trimmedAvg
        ? b.trimmedAvg - a.trimmedAvg
        : lexCompare(a.member.participant.id, b.member.participant.id)
    );
  const { placements, stillTied } = assignCompetitionRanks(
    sorted,
    group.rank,
    (curr, prev) => curr.trimmedAvg === prev.trimmedAvg,
    (entry, afterRank) => ({
      participant_id: entry.member.participant.id, before_rank: group.rank, after_rank: afterRank,
      base_avg: entry.member.rawAverage, ballot_count: entry.member.ballotCount,
      scores_desc: [...entry.member.scoresDesc], trimmed_avg: entry.trimmedAvg,
    })
  );
  const lowJudgeWarning =
    (configuredJudgesCount !== undefined && configuredJudgesCount < 5) ||
    group.members.some((m) => m.ballotCount < 5);
  return {
    rule: 'olympic', groupKey: group.groupKey, tiedRank: group.rank,
    scoreFingerprint: group.scoreFingerprint, placements, stillTied, resolved: !stillTied, lowJudgeWarning,
  };
}

export function computeRecompeteStandings(
  group: DetectedTiedGroup,
  grades: ReadonlyArray<Pick<TieRoundGrade, 'participant_id' | 'judge_id' | 'grade'>>
): RecompeteStandingsResult {
  const memberIds = new Set(group.members.map((m) => m.participant.id));
  const dedup = new Map<string, { judgeId: string; participantId: string; grade: number }>();
  for (const g of grades || []) {
    if (!g || !memberIds.has(g.participant_id) || !isValidTieGrade(g.grade)) continue;
    const judgeId = String(g.judge_id || '').trim();
    if (!judgeId) continue;
    dedup.set(`${judgeId}::${g.participant_id}`, { judgeId, participantId: g.participant_id, grade: g.grade });
  }
  const sums = new Map<string, { sum: number; count: number }>();
  const judges = new Set<string>();
  for (const entry of dedup.values()) {
    judges.add(entry.judgeId);
    const cur = sums.get(entry.participantId) || { sum: 0, count: 0 };
    cur.sum += entry.grade;
    cur.count += 1;
    sums.set(entry.participantId, cur);
  }
  const sorted = group.members
    .map((member) => {
      const agg = sums.get(member.participant.id) || { sum: 0, count: 0 };
      return { member, gradeSum: agg.sum, gradeCount: agg.count };
    })
    .sort((a, b) => {
      if (a.gradeSum !== b.gradeSum) return b.gradeSum - a.gradeSum;
      const cb = compareScoresDesc(a.member.scoresDesc, b.member.scoresDesc);
      return cb !== 0 ? cb : lexCompare(a.member.participant.id, b.member.participant.id);
    });
  const { placements, stillTied } = assignCompetitionRanks(
    sorted,
    group.rank,
    (curr, prev) =>
      curr.gradeSum === prev.gradeSum && compareScoresDesc(curr.member.scoresDesc, prev.member.scoresDesc) === 0,
    (entry, afterRank) => ({
      participant_id: entry.member.participant.id, before_rank: group.rank, after_rank: afterRank,
      base_avg: entry.member.rawAverage, grade_sum: entry.gradeSum,
      grade_count: entry.gradeCount, scores_desc: [...entry.member.scoresDesc],
    })
  );
  return {
    rule: 'recompete', groupKey: group.groupKey, tiedRank: group.rank, scoreFingerprint: group.scoreFingerprint,
    placements, stillTied, resolved: !stillTied, submittedJudgeCount: judges.size, totalGrades: dedup.size,
  };
}

export function isRoundStale(
  round: Pick<TieRound | ProjectorTieRound, 'group_key' | 'status' | 'is_stale' | 'score_fingerprint'>,
  liveGroups: ReadonlyArray<Pick<DetectedTiedGroup, 'groupKey' | 'scoreFingerprint'>>
): boolean {
  if (round.status === 'cancelled_stale') return false;
  if (round.is_stale) return true;
  const live = liveGroups.find((g) => g.groupKey === round.group_key);
  if (!live) return true;
  return (round.score_fingerprint || '') !== (live.scoreFingerprint || '');
}

export type TieMethodOption = 'countback' | 'olympic' | 'recompete' | 'shared';

export interface TieMethodRecommendation {
  method: TieMethodOption;
  recommended: boolean;
  lowJudgeWarning: boolean;
}

export interface TieMethodPreview {
  rule: TieMethodOption;
  groupKey: string;
  tiedRank: number;
  scoreFingerprint: string;
  placements: TieRoundPlacement[];
  stillTied: boolean;
  resolved: boolean;
  lowJudgeWarning: boolean;
  isRangeAfterRank?: boolean;
}

/**
 * Pure recommendation tag rules (tag only — never forces a choice):
 * - Countback: recommended for 2 tied for 1st
 * - Olympic trim: recommended only with 5+ judges (warn under 5 judges)
 * - Re-compete: recommended for 3+ tied
 * - Shared places: never forced or tagged recommended
 */
export function getTieMethodRecommendations(
  tiedRank: number,
  tiedCount: number,
  judgeCount: number
): Record<TieMethodOption, TieMethodRecommendation> {
  const safeJudges = Number.isFinite(judgeCount) ? Math.max(0, Math.floor(judgeCount)) : 0;
  return {
    countback: {
      method: 'countback',
      recommended: tiedRank === 1 && tiedCount === 2,
      lowJudgeWarning: false,
    },
    olympic: {
      method: 'olympic',
      recommended: safeJudges >= 5,
      lowJudgeWarning: safeJudges < 5,
    },
    recompete: {
      method: 'recompete',
      recommended: tiedCount >= 3,
      lowJudgeWarning: false,
    },
    shared: {
      method: 'shared',
      recommended: false,
      lowJudgeWarning: false,
    },
  };
}

export function computeSharedPreview(group: DetectedTiedGroup): TieMethodPreview {
  const sorted = [...group.members].sort((a, b) => lexCompare(a.participant.id, b.participant.id));
  const placements: TieRoundPlacement[] = sorted.map((m) => ({
    participant_id: m.participant.id,
    before_rank: group.rank,
    after_rank: group.rank,
    base_avg: m.rawAverage,
    ballot_count: m.ballotCount,
    scores_desc: [...m.scoresDesc],
    trimmed_avg: null,
  }));
  return {
    rule: 'shared',
    groupKey: group.groupKey,
    tiedRank: group.rank,
    scoreFingerprint: group.scoreFingerprint,
    placements,
    stillTied: placements.length >= 2,
    resolved: false,
    lowJudgeWarning: false,
  };
}

export function computeRecompetePreview(group: DetectedTiedGroup): TieMethodPreview {
  const sorted = [...group.members].sort((a, b) => lexCompare(a.participant.id, b.participant.id));
  const placements: TieRoundPlacement[] = sorted.map((m) => ({
    participant_id: m.participant.id,
    before_rank: group.rank,
    after_rank: group.rank,
    base_avg: m.rawAverage,
    ballot_count: m.ballotCount,
    scores_desc: [...m.scoresDesc],
    trimmed_avg: null,
  }));
  return {
    rule: 'recompete',
    groupKey: group.groupKey,
    tiedRank: group.rank,
    scoreFingerprint: group.scoreFingerprint,
    placements,
    stillTied: false,
    resolved: false,
    lowJudgeWarning: false,
    isRangeAfterRank: true,
  };
}

export type ActiveTieRoundRule = TieRoundRule;
