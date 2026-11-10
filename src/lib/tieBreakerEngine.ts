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
const pendingCallbacks = new Map<
  string,
  {
    resolve: (val: RankedParticipantItem[]) => void;
    reject: (err: any) => void;
  }
>();

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
          cb.resolve(result);
          pendingCallbacks.delete(id);
        }
      };
      workerInstance.onerror = (err) => {
        console.warn('TieBreaker Web Worker error, falling back to main thread:', err);
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
  const worker = getWorker();
  if (!worker) {
    return calculateRankings(
      participants,
      scores,
      assignedJudgesCount,
      method,
      tieBreakerEnabled
    );
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
      pendingCallbacks.delete(id);
      resolve(
        calculateRankings(
          participants,
          scores,
          assignedJudgesCount,
          method,
          tieBreakerEnabled
        )
      );
    }, 5000);

    pendingCallbacks.set(id, {
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    worker.postMessage(payload);
  });
}
