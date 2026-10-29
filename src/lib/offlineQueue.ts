import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { dbService } from './supabase';
import { SupabaseScore } from './supabaseTypes';

export interface PendingScoreRecord {
  id: string;
  event_id: string;
  judge_id: string;
  participant_id: string;
  score_data: Record<string, number>;
  total_score: number;
  score_payload: {
    criteria: Record<string, number>;
    total_score: number;
    submitted_at: string;
  };
  queuedAt: string;
  syncStatus: 'pending' | 'syncing' | 'failed';
  retryCount?: number;
}

interface FairJudgeOfflineDB extends DBSchema {
  pending_scores: {
    key: string;
    value: PendingScoreRecord;
    indexes: { 'by-event': string; 'by-time': string };
  };
}

const DB_NAME = 'fairjudge_offline_queue_v2';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<FairJudgeOfflineDB>> | null = null;

export function getOfflineDB(): Promise<IDBPDatabase<FairJudgeOfflineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FairJudgeOfflineDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('pending_scores')) {
          const store = db.createObjectStore('pending_scores', {
            keyPath: 'id',
          });
          store.createIndex('by-event', 'event_id');
          store.createIndex('by-time', 'queuedAt');
        }
      },
    });
  }
  return dbPromise;
}

// Queue score to IndexedDB (supports both Supabase format and legacy format)
export async function queueScoreLocally(
  score: any
): Promise<string> {
  const db = await getOfflineDB();
  const id = score.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `score_${Date.now()}`);
  
  const eventId = score.event_id || score.eventId || '';
  const judgeId = score.judge_id || score.judgeId || '';
  const participantId = score.participant_id || score.participantId || '';
  const scoreData = score.score_data || score.scoreData || score.score_payload?.criteria || {};
  const totalScore = Number(score.total_score !== undefined ? score.total_score : score.totalScore) || 0;

  const record: PendingScoreRecord = {
    id,
    event_id: eventId,
    judge_id: judgeId,
    participant_id: participantId,
    score_data: scoreData,
    total_score: totalScore,
    score_payload: score.score_payload || {
      criteria: scoreData,
      total_score: totalScore,
      submitted_at: new Date().toISOString(),
    },
    queuedAt: new Date().toISOString(),
    syncStatus: 'pending',
    retryCount: 0,
  };

  await db.put('pending_scores', record);
  notifyQueueChange();
  return id;
}

export async function getPendingScores(): Promise<PendingScoreRecord[]> {
  try {
    const db = await getOfflineDB();
    return await db.getAll('pending_scores');
  } catch (err) {
    console.warn('Error fetching pending offline scores:', err);
    return [];
  }
}

export async function removePendingScore(scoreId: string): Promise<void> {
  try {
    const db = await getOfflineDB();
    await db.delete('pending_scores', scoreId);
    notifyQueueChange();
  } catch (err) {
    console.warn('Error removing score from offline queue:', err);
  }
}

export async function getPendingCount(): Promise<number> {
  try {
    const db = await getOfflineDB();
    return await db.count('pending_scores');
  } catch {
    return 0;
  }
}

// Sync all pending scores to Supabase
export async function flushOfflineQueueToSupabase(): Promise<{
  syncedCount: number;
  failedCount: number;
}> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { syncedCount: 0, failedCount: 0 };
  }

  const pending = await getPendingScores();
  if (pending.length === 0) {
    return { syncedCount: 0, failedCount: 0 };
  }

  let syncedCount = 0;
  let failedCount = 0;

  for (const item of pending) {
    try {
      await dbService.submitScore({
        event_id: item.event_id,
        judge_id: item.judge_id,
        participant_id: item.participant_id,
        score_data: item.score_data,
        total_score: item.total_score,
        score_payload: item.score_payload,
      });

      await removePendingScore(item.id);
      syncedCount++;
    } catch (err: any) {
      // If already recorded due to RLS immutability, remove from local queue
      if (err.message && err.message.includes('RLS Permission Denied')) {
        await removePendingScore(item.id);
        syncedCount++;
      } else {
        console.warn(`Retryable error syncing offline score ${item.id}:`, err);
        failedCount++;
      }
    }
  }

  notifyQueueChange();
  return { syncedCount, failedCount };
}

// Compatibility export
export const syncPendingScoresToFirestore = flushOfflineQueueToSupabase;

// Global auto-sync listener
let isListenerInitialized = false;
export function initOfflineSyncListener(): () => void {
  if (typeof window === 'undefined' || isListenerInitialized) return () => {};
  isListenerInitialized = true;

  const onlineHandler = () => {
    console.log('[Fair Judge] Device came online. Flushing local score queue to Supabase...');
    flushOfflineQueueToSupabase().then(({ syncedCount }) => {
      if (syncedCount > 0) {
        console.log(`[Fair Judge] Successfully synchronized ${syncedCount} queued ballots.`);
      }
    });
  };

  window.addEventListener('online', onlineHandler);

  // Initial check on load
  if (navigator.onLine) {
    flushOfflineQueueToSupabase();
  }

  return () => {
    window.removeEventListener('online', onlineHandler);
    isListenerInitialized = false;
  };
}

const QUEUE_EVENT_NAME = 'fairjudge_queue_changed';
function notifyQueueChange() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(QUEUE_EVENT_NAME));
  }
}

export function subscribeToQueueChanges(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(QUEUE_EVENT_NAME, callback);
  return () => {
    window.removeEventListener(QUEUE_EVENT_NAME, callback);
  };
}
