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

export function computeRankings(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  assignedJudgesCount: number,
  method: TieBreakerMethod = 'olympic',
  tieBreakerEnabled: boolean = false
): RankedParticipantItem[] {
  // Fast Map lookup for scores: O(S) instead of O(P * S)
  const scoresByParticipant = new Map<string, SupabaseScore[]>();
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    let list = scoresByParticipant.get(s.participant_id);
    if (!list) {
      list = [];
      scoresByParticipant.set(s.participant_id, list);
    }
    list.push(s);
  }

  const rawList = participants.map((p) => {
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

  // Multithreaded sort O(N log N)
  rawList.sort((a, b) => b.avgScore - a.avgScore);

  let currentRank = 1;
  return rawList.map((item, index) => {
    if (index === 0) {
      currentRank = 1;
    } else {
      const prev = rawList[index - 1];
      const isTied =
        item.avgScore === prev.avgScore && item.judgeCount > 0 && prev.judgeCount > 0;
      if (!tieBreakerEnabled || method === 'shared') {
        if (!isTied) {
          currentRank = index + 1;
        }
      } else {
        currentRank = index + 1;
      }
    }
    return {
      ...item,
      rank: item.judgeCount > 0 ? currentRank : 0,
    };
  });
}

// Worker message listener
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
