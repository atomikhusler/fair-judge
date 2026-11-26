import { SupabaseParticipant, SupabaseScore, TieBreakerMethod } from './supabaseTypes';
import {
  computeRankings,
  RankedParticipantItem,
  WorkerRankingPayload,
  WorkerRankingResponse,
} from './tieBreakerEngine.worker';

export type { RankedParticipantItem };

// Global Worker instance with fallback
let workerInstance: Worker | null = null;

interface PendingRankingCallback {
  resolve: (val: RankedParticipantItem[]) => void;
  reject: (err: unknown) => void;
  fallback: () => RankedParticipantItem[];
  timer: ReturnType<typeof setTimeout>;
}

const pendingCallbacks = new Map<string, PendingRankingCallback>();

function settleAllPendingWithFallback(reason?: unknown): void {
  if (reason) {
    console.warn('TieBreaker Web Worker error, falling back to main thread:', reason);
  }
  const entries = Array.from(pendingCallbacks.values());
  pendingCallbacks.clear();

  if (workerInstance) {
    try {
      workerInstance.terminate();
    } catch {
      // Ignore worker termination errors
    }
    workerInstance = null;
  }

  for (const entry of entries) {
    clearTimeout(entry.timer);
    try {
      entry.resolve(entry.fallback());
    } catch (err) {
      entry.reject(err);
    }
  }
}

function getWorker(): Worker | null {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return null;
  }
  if (!workerInstance) {
    try {
      workerInstance = new Worker(
        new URL('./tieBreakerEngine.worker.ts', import.meta.url),
        { type: 'module' }
      );
      workerInstance.onmessage = (event: MessageEvent<WorkerRankingResponse>) => {
        const { id, result } = event.data;
        const cb = pendingCallbacks.get(id);
        if (cb) {
          pendingCallbacks.delete(id);
          clearTimeout(cb.timer);
          cb.resolve(result);
        }
      };
      workerInstance.onerror = (err) => {
        settleAllPendingWithFallback(err);
      };
    } catch (e) {
      console.warn('Unable to initialize Web Worker for tie-breakers:', e);
      workerInstance = null;
    }
  }
  return workerInstance;
}

function toAbsentIdSet(
  absentParticipantIds?: ReadonlySet<string> | ReadonlyArray<string>
): Set<string> {
  if (!absentParticipantIds) return new Set<string>();
  return absentParticipantIds instanceof Set
    ? new Set<string>(absentParticipantIds)
    : new Set<string>(absentParticipantIds);
}

function filterAbsentInputs(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  absentParticipantIds?: ReadonlySet<string> | ReadonlyArray<string>
): { participants: SupabaseParticipant[]; scores: SupabaseScore[] } {
  const absentSet = toAbsentIdSet(absentParticipantIds);
  const filteredParticipants =
    absentSet.size > 0
      ? participants.filter((p) => !absentSet.has(p.id))
      : participants;
  const filteredScores = scores.filter((s) => {
    if (!s) return false;
    if (absentSet.has(s.participant_id)) return false;
    const payload = s.score_payload as { is_absent?: boolean } | undefined;
    if (payload?.is_absent === true) return false;
    return true;
  });
  return { participants: filteredParticipants, scores: filteredScores };
}

/**
 * Synchronous ranking & tie-breaker computation on the main thread.
 * Used as immediate fallback or when async promises are not suitable.
 */
export function calculateRankings(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  assignedJudgesCount: number = 0,
  method: TieBreakerMethod = 'olympic',
  tieBreakerEnabled: boolean = false,
  absentParticipantIds?: ReadonlySet<string> | ReadonlyArray<string>
): RankedParticipantItem[] {
  const filtered = filterAbsentInputs(participants, scores, absentParticipantIds);
  return computeRankings(
    filtered.participants,
    filtered.scores,
    assignedJudgesCount,
    method,
    tieBreakerEnabled
  );
}

/**
 * Multithreaded ranking calculation running on a background Web Worker.
 * Frees the main UI thread during heavy sorting/trimming on 100+ participants.
 */
export async function calculateRankingsAsync(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  assignedJudgesCount: number = 0,
  method: TieBreakerMethod = 'olympic',
  tieBreakerEnabled: boolean = false,
  absentParticipantIds?: ReadonlySet<string> | ReadonlyArray<string>
): Promise<RankedParticipantItem[]> {
  const filtered = filterAbsentInputs(participants, scores, absentParticipantIds);
  const runFallback = () =>
    computeRankings(
      filtered.participants,
      filtered.scores,
      assignedJudgesCount,
      method,
      tieBreakerEnabled
    );

  const worker = getWorker();
  if (!worker) {
    return runFallback();
  }

  const id = `tb_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const payload: WorkerRankingPayload = {
    id,
    participants: filtered.participants,
    scores: filtered.scores,
    assignedJudgesCount,
    method,
    tieBreakerEnabled,
  };

  return new Promise<RankedParticipantItem[]>((resolve, reject) => {
    // 5-second timeout safeguard: if worker hangs, resolve synchronously
    const timer = setTimeout(() => {
      const entry = pendingCallbacks.get(id);
      if (!entry) return;
      pendingCallbacks.delete(id);
      resolve(entry.fallback());
    }, 5000);

    pendingCallbacks.set(id, {
      resolve,
      reject,
      fallback: runFallback,
      timer,
    });

    try {
      worker.postMessage(payload);
    } catch (err) {
      settleAllPendingWithFallback(err);
    }
  });
}

export interface LocalTieGroup {
  group_key: string;
  tied_rank: number;
  tied_avg: number;
  tied_participant_ids: string[];
  score_fingerprint: string;
}

export interface TieChipGateInput {
  eventStatus: string;
  isArchived?: boolean;
  participants: SupabaseParticipant[];
  scores: SupabaseScore[];
  requiredJudgesCount: number;
  confirmedAbsentIds?: ReadonlySet<string> | ReadonlyArray<string>;
  activeJudgeIds?: ReadonlySet<string> | ReadonlyArray<string>;
  hasServerTie?: boolean;
}

export interface TieChipGateResult {
  allParticipantsDone: boolean;
  eventNotEnded: boolean;
  hasTie: boolean;
  canShowChip: boolean;
  localTieGroups: LocalTieGroup[];
}

function isAbsentOrPlaceholderScore(score: SupabaseScore): boolean {
  const payload = score.score_payload as
    | { is_absent?: boolean; criteria?: Record<string, number> }
    | undefined;
  if (payload?.is_absent === true) return true;
  const criteriaObj = score.score_data || payload?.criteria;
  const criteriaCount =
    criteriaObj && typeof criteriaObj === 'object' ? Object.keys(criteriaObj).length : 0;
  if (Number(score.total_score) === 0 && criteriaCount === 0) return true;
  return false;
}

/**
 * Step 3 Visibility Gate for the Tie Status Chip.
 * Chip may show ONLY when ALL are true:
 *   1. Event has not ended / is not archived
 *   2. Every active participant is fully scored by required judges OR confirmed Absent
 *      (judge-local Not Ready tags and pending absences are NOT scored)
 *   3. A tie actually exists among active non-absent participants
 */
export function evaluateTieChipGate(input: TieChipGateInput): TieChipGateResult {
  const status = String(input.eventStatus || '').toLowerCase();
  const eventNotEnded = !input.isArchived && status !== 'ended' && status !== 'archived';

  const activeParticipants = (input.participants || []).filter(
    (p) => Boolean(p) && p.is_active !== false
  );
  const activeParticipantIds = new Set(activeParticipants.map((p) => p.id));
  const absentSet = toAbsentIdSet(input.confirmedAbsentIds);
  const allowedJudgeSet = input.activeJudgeIds ? toAbsentIdSet(input.activeJudgeIds) : null;
  const requiredJudges = Math.max(1, Math.floor(Number(input.requiredJudgesCount) || 0));

  // Deduplicate latest valid score per (participant_id, judge_id)
  const latestByPair = new Map<string, SupabaseScore>();
  for (const s of input.scores || []) {
    if (!s || !activeParticipantIds.has(s.participant_id)) continue;
    if (absentSet.has(s.participant_id)) continue;
    if (allowedJudgeSet && allowedJudgeSet.size > 0 && !allowedJudgeSet.has(s.judge_id)) continue;
    if (s.total_score === null || s.total_score === undefined || Number.isNaN(Number(s.total_score))) {
      continue;
    }
    if (isAbsentOrPlaceholderScore(s)) continue;

    const key = `${s.participant_id}:${s.judge_id}`;
    const prev = latestByPair.get(key);
    if (!prev) {
      latestByPair.set(key, s);
      continue;
    }
    const prevTime = new Date(prev.created_at || 0).getTime();
    const nextTime = new Date(s.created_at || 0).getTime();
    if (nextTime > prevTime || (nextTime === prevTime && String(s.id || '') > String(prev.id || ''))) {
      latestByPair.set(key, s);
    }
  }

  const scoresByParticipant = new Map<string, number[]>();
  for (const s of latestByPair.values()) {
    let arr = scoresByParticipant.get(s.participant_id);
    if (!arr) {
      arr = [];
      scoresByParticipant.set(s.participant_id, arr);
    }
    arr.push(Number(s.total_score));
  }

  const allParticipantsDone =
    activeParticipants.length > 0 &&
    activeParticipants.every((p) => {
      if (absentSet.has(p.id)) return true;
      const judgeCount = scoresByParticipant.get(p.id)?.length || 0;
      return judgeCount >= requiredJudges;
    });

  // Compute local tie groups (rounded to 2 decimals matching server _fj_detect_event_tie_groups)
  const scoredEntries: Array<{ participantId: string; avg: number }> = [];
  for (const p of activeParticipants) {
    if (absentSet.has(p.id)) continue;
    const vals = scoresByParticipant.get(p.id);
    if (!vals || vals.length === 0) continue;
    const sum = vals.reduce((acc, v) => acc + v, 0);
    const avg = Number((sum / vals.length).toFixed(2));
    scoredEntries.push({ participantId: p.id, avg });
  }

  scoredEntries.sort((a, b) => {
    if (b.avg !== a.avg) return b.avg - a.avg;
    return a.participantId.localeCompare(b.participantId);
  });

  const localTieGroups: LocalTieGroup[] = [];
  let idx = 0;
  while (idx < scoredEntries.length) {
    const startRank = idx + 1;
    const targetAvg = scoredEntries[idx].avg;
    const groupIds: string[] = [scoredEntries[idx].participantId];
    let next = idx + 1;
    while (next < scoredEntries.length && scoredEntries[next].avg === targetAvg) {
      groupIds.push(scoredEntries[next].participantId);
      next += 1;
    }
    if (groupIds.length >= 2) {
      groupIds.sort();
      localTieGroups.push({
        group_key: groupIds.join(','),
        tied_rank: startRank,
        tied_avg: targetAvg,
        tied_participant_ids: groupIds,
        score_fingerprint: '',
      });
    }
    idx = next;
  }

  const hasTie = Boolean(input.hasServerTie || localTieGroups.length > 0);
  const canShowChip = eventNotEnded && allParticipantsDone && hasTie;

  return {
    allParticipantsDone,
    eventNotEnded,
    hasTie,
    canShowChip,
    localTieGroups,
  };
}
