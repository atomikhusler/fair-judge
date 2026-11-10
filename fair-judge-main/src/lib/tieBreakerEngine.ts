import { SupabaseParticipant, SupabaseScore, RubricCriterion, TieBreakerMethod } from './supabaseTypes';

export interface RankedParticipant {
  id: string;
  name: string;
  school: string;
  sl_no: string;
  class_or_age?: string;
  totalScore: number;
  avgScore: number;
  judgeCount: number;
  scoresCount?: number;
  rank: number;
  isTied: boolean;
  tieBreakerApplied?: boolean;
  scoreBreakdown?: Record<string, number>;
  participant?: SupabaseParticipant;
}

export function calculateRankings(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  _assignedJudgesCount: number = 0,
  _method: TieBreakerMethod = 'olympic',
  _tieBreakerEnabled: boolean = false
): RankedParticipant[] {
  const scoreMap = new Map<string, number[]>();
  scores.forEach((s) => {
    const list = scoreMap.get(s.participant_id) || [];
    list.push(Number(s.total_score) || 0);
    scoreMap.set(s.participant_id, list);
  });

  const ranked: RankedParticipant[] = participants.map((p) => {
    const rawScores = scoreMap.get(p.id) || [];
    const count = rawScores.length;
    let total = 0;
    if (count > 0) {
      total = rawScores.reduce((acc, v) => acc + v, 0);
    }
    const avg = count > 0 ? total / count : 0;
    return {
      id: p.id,
      name: p.name,
      school: p.school,
      sl_no: p.sl_no,
      class_or_age: p.class_or_age,
      totalScore: Number(total.toFixed(2)),
      avgScore: Number(avg.toFixed(2)),
      judgeCount: count,
      scoresCount: count,
      rank: 0,
      isTied: false,
      participant: p,
    };
  });

  ranked.sort((a, b) => b.totalScore - a.totalScore);

  let currentRank = 1;
  for (let i = 0; i < ranked.length; i++) {
    if (i > 0 && ranked[i].totalScore === ranked[i - 1].totalScore) {
      ranked[i].rank = ranked[i - 1].rank;
      ranked[i].isTied = true;
      ranked[i - 1].isTied = true;
    } else {
      ranked[i].rank = currentRank;
    }
    currentRank++;
  }

  return ranked;
}

export async function calculateRankingsAsync(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  assignedJudgesCount: number = 0,
  method: TieBreakerMethod = 'olympic',
  tieBreakerEnabled: boolean = false
): Promise<RankedParticipant[]> {
  return calculateRankings(participants, scores, assignedJudgesCount, method, tieBreakerEnabled);
}
