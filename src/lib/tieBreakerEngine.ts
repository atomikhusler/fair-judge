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

/**
 * Synchronous ranking & tie-breaker computation on the main thread.
 * Used as immediate fallback or when async promises are not suitable.
 */
export function calculateRankings(
  participants: SupabaseParticipant[],
  scores: SupabaseScore[],
  assignedJudgesCount: number = 0,
  method: TieBreakerMethod = 'olympic',
  tieBreakerEnabled: boolean = false
): RankedParticipantItem[] {
  return computeRankings(
    participants,
    scores,
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
  tieBreakerEnabled: boolean = false
): Promise<RankedParticipantItem[]> {
  const runFallback = () =>
    calculateRankings(
      participants,
      scores,
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
    participants,
    scores,
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
