import type { SupabaseParticipant, SupabaseScore, TieBreakerMethod } from './supabaseTypes';

export interface WorkerRankingPayload {
  id: string;
  participants: SupabaseParticipant[];
  scores: SupabaseScore[];
  assignedJudgesCount: number;
  method?: TieBreakerMethod;
  tieBreakerEnabled?: boolean;
}

export interface RankedParticipantItem extends SupabaseParticipant {
  judgeCount: number;
  pScores: SupabaseScore[];
  avgScore: number;
  rank: number;
}

export interface WorkerRankingResponse {
  id: string;
  result: RankedParticipantItem[];
}

function parseScoreTimestamp(createdAt?: string): number {
  if (!createdAt) return 0;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function computeRankings(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  assignedJudgesCount: number,
  method: TieBreakerMethod = 'olympic',
  tieBreakerEnabled: boolean = false
): RankedParticipantItem[] {
  void assignedJudgesCount;

  // 1. Active participants only
  const activeParticipants = participants.filter((p) => p.is_active !== false);

  // 2. Deduplicate scores to latest row per (participant_id, judge_id) by created_at;
  //    skip null, undefined, or non-numeric total_score values.
  const latestByPair = new Map<
    string,
    { score: SupabaseScore; ts: number; order: number }
  >();

  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (!s || !s.participant_id || !s.judge_id) continue;
    const raw = s.total_score as unknown;
    if (raw === null || raw === undefined) continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    const numericScore = Number(raw);
    if (!Number.isFinite(numericScore)) continue;

    const pairKey = `${s.participant_id}::${s.judge_id}`;
    const ts = parseScoreTimestamp(s.created_at);
    const existing = latestByPair.get(pairKey);
    if (!existing || ts > existing.ts || (ts === existing.ts && i > existing.order)) {
      latestByPair.set(pairKey, {
        score: { ...s, total_score: numericScore },
        ts,
        order: i,
      });
    }
  }

  // Group deduplicated scores by participant: O(S)
  const scoresByParticipant = new Map<string, SupabaseScore[]>();
  latestByPair.forEach(({ score }) => {
    let list = scoresByParticipant.get(score.participant_id);
    if (!list) {
      list = [];
      scoresByParticipant.set(score.participant_id, list);
    }
    list.push(score);
  });

  const rawList = activeParticipants.map((p) => {
    const pScores = scoresByParticipant.get(p.id) || [];
    const judgeCount = pScores.length;

    let computedAverage = 0;
    if (judgeCount > 0) {
      if (tieBreakerEnabled && method === 'olympic' && judgeCount >= 3) {
        // Olympic Trimming: Sort and drop highest & lowest judge marks
        const sorted = [...pScores].sort((a, b) => a.total_score - b.total_score);
        const trimmed = sorted.slice(1, sorted.length - 1);
        const sum = trimmed.reduce((acc, s) => acc + s.total_score, 0);
        computedAverage = Number((sum / trimmed.length).toFixed(2));
      } else if (tieBreakerEnabled && method === 'manual') {
        const sum = pScores.reduce((acc, s) => acc + s.total_score, 0);
        computedAverage = Number((sum / judgeCount).toFixed(4));
      } else {
        const sum = pScores.reduce((acc, s) => acc + s.total_score, 0);
        computedAverage = Number((sum / judgeCount).toFixed(2));
      }
    }

    return {
      ...p,
      judgeCount,
      pScores,
      avgScore: computedAverage,
    };
  });

  // Sort scored participants strictly before absentees (judgeCount === 0), then by avgScore desc
  rawList.sort((a, b) => {
    const aScored = a.judgeCount > 0 ? 1 : 0;
    const bScored = b.judgeCount > 0 ? 1 : 0;
    if (aScored !== bScored) return bScored - aScored;
    return b.avgScore - a.avgScore;
  });

  // Standard competition ranking (1, 2, 2, 4): unresolved ties always share a rank.
  // Absent participants (judgeCount === 0) keep rank 0.
  let currentRank = 1;
  return rawList.map((item, index) => {
    if (item.judgeCount === 0) {
      return {
        ...item,
        rank: 0,
      };
    }
    if (index === 0) {
      currentRank = 1;
    } else {
      const prev = rawList[index - 1];
      const isTied = prev.judgeCount > 0 && item.avgScore === prev.avgScore;
      if (!isTied) {
        currentRank = index + 1;
      }
    }
    return {
      ...item,
      rank: currentRank,
    };
  });
}

// Worker message listener (guarded for Node/SSR test environments)
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (event: MessageEvent<WorkerRankingPayload>) => {
    const { id, participants, scores, assignedJudgesCount, method, tieBreakerEnabled } = event.data;
    const result = computeRankings(
      participants || [],
      scores || [],
      assignedJudgesCount || 0,
      method || 'olympic',
      tieBreakerEnabled || false
    );
    self.postMessage({ id, result } as WorkerRankingResponse);
  };
}
