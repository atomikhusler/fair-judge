import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { supabase, isSupabaseConfigured } from './supabase';
import { APP_VERSION } from '../config/version';

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

export type MutationOperation = 'INSERT' | 'UPDATE' | 'DELETE';
export type MutationTable = 'events' | 'participants' | 'judges' | 'organizations';

export interface PendingMutationRecord {
  id: string;
  table: MutationTable;
  operation: MutationOperation;
  entityId: string;
  payload?: any;
  queuedAt: string;
  syncStatus: 'pending' | 'syncing' | 'failed';
  retryCount: number;
}

interface FairJudgeOfflineDB extends DBSchema {
  pending_scores: {
    key: string;
    value: PendingScoreRecord;
    indexes: { 'by-event': string; 'by-time': string };
  };
  pending_mutations: {
    key: string;
    value: PendingMutationRecord;
    indexes: { 'by-table': string; 'by-time': string };
  };
}

const DB_NAME = 'fairjudge_offline_queue_v3';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<FairJudgeOfflineDB>> | null = null;

export function getOfflineDB(): Promise<IDBPDatabase<FairJudgeOfflineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FairJudgeOfflineDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('pending_scores')) {
          const scoreStore = db.createObjectStore('pending_scores', {
            keyPath: 'id',
          });
          scoreStore.createIndex('by-event', 'event_id');
          scoreStore.createIndex('by-time', 'queuedAt');
        }
        if (!db.objectStoreNames.contains('pending_mutations')) {
          const mutStore = db.createObjectStore('pending_mutations', {
            keyPath: 'id',
          });
          mutStore.createIndex('by-table', 'table');
          mutStore.createIndex('by-time', 'queuedAt');
        }
      },
    });
  }
  return dbPromise;
}

// ==========================================
// 1. GENERIC MUTATION QUEUE (Offline-First)
// ==========================================

import { eventBus } from './eventBus';

export async function requestBackgroundSync(): Promise<void> {
  if (typeof window !== 'undefined' && 'serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      if ((reg as any).sync) {
        await (reg as any).sync.register('fairjudge-offline-sync');
      }
    } catch {
      // Background Sync is not supported or permission denied in this context
    }
  }
}

export async function queueMutationLocally(
  table: MutationTable,
  operation: MutationOperation,
  entityId: string,
  payload?: any
): Promise<string> {
  const db = await getOfflineDB();
  const id = `mut_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  const record: PendingMutationRecord = {
    id,
    table,
    operation,
    entityId,
    payload: payload || null,
    queuedAt: new Date().toISOString(),
    syncStatus: 'pending',
    retryCount: 0,
  };

  await db.put('pending_mutations', record);
  notifyQueueChange();
  requestBackgroundSync();

  getPendingCount().then((count) => {
    eventBus.emit('sync_status', {
      status: 'offline',
      pendingCount: count,
      message: `${count} item${count > 1 ? 's' : ''} queued locally`,
    });
  });

  return id;
}

export async function getPendingMutations(): Promise<PendingMutationRecord[]> {
  try {
    const db = await getOfflineDB();
    return await db.getAll('pending_mutations');
  } catch (err) {
    console.warn('Error fetching pending offline mutations:', err);
    return [];
  }
}

export async function removePendingMutation(id: string): Promise<void> {
  try {
    const db = await getOfflineDB();
    await db.delete('pending_mutations', id);
    notifyQueueChange();
  } catch (err) {
    console.warn('Error removing mutation from offline queue:', err);
  }
}

export async function getPendingMutationsCount(): Promise<number> {
  try {
    const db = await getOfflineDB();
    return await db.count('pending_mutations');
  } catch {
    return 0;
  }
}

// Flush all queued non-score mutations (events, participants, judges, orgs) to Supabase
export async function flushOfflineMutationsToSupabase(): Promise<{
  syncedCount: number;
  failedCount: number;
}> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { syncedCount: 0, failedCount: 0 };
  }
  if (!isSupabaseConfigured()) {
    return { syncedCount: 0, failedCount: 0 };
  }

  const rawMutations = await getPendingMutations();
  if (rawMutations.length === 0) {
    return { syncedCount: 0, failedCount: 0 };
  }

  // 1. Client-Side Optimistic Concurrency Control (OCC) Deduplication
  // If multiple mutations exist for the same entityId on the same table, keep the latest
  const latestMutationMap = new Map<string, PendingMutationRecord>();
  const obsoleteMutationIds: string[] = [];

  // Sort chronological
  rawMutations.sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());

  for (const item of rawMutations) {
    const key = `${item.table}:${item.entityId}`;
    if (latestMutationMap.has(key)) {
      const prev = latestMutationMap.get(key)!;
      // If previous was an INSERT and current is UPDATE, merge payloads into INSERT
      if (prev.operation === 'INSERT' && item.operation === 'UPDATE') {
        prev.payload = { ...(prev.payload || {}), ...(item.payload || {}) };
        prev.queuedAt = item.queuedAt;
        obsoleteMutationIds.push(item.id);
        continue;
      }
      // If superseded, prune previous
      obsoleteMutationIds.push(prev.id);
    }
    latestMutationMap.set(key, item);
  }

  // Prune obsolete superseded mutations from IndexedDB so they never hit network
  if (obsoleteMutationIds.length > 0) {
    await Promise.all(obsoleteMutationIds.map((id) => removePendingMutation(id)));
  }

  const mutations = Array.from(latestMutationMap.values());
  let syncedCount = 0;
  let failedCount = 0;

  for (const item of mutations) {
    try {
      if (item.table === 'events') {
        if (item.operation === 'INSERT') {
          const { error } = await supabase.from('events').upsert([item.payload]);
          if (error) throw error;
        } else if (item.operation === 'UPDATE') {
          const { error } = await supabase.from('events').update(item.payload).eq('id', item.entityId);
          if (error) throw error;
        } else if (item.operation === 'DELETE') {
          const { error } = await supabase.from('events').delete().eq('id', item.entityId);
          if (error) throw error;
        }
      } else if (item.table === 'participants') {
        if (item.operation === 'INSERT') {
          const records = Array.isArray(item.payload) ? item.payload : [item.payload];
          const { error } = await supabase.from('participants').upsert(records);
          if (error) throw error;
        } else if (item.operation === 'UPDATE') {
          const { error } = await supabase.from('participants').update(item.payload).eq('id', item.entityId);
          if (error) throw error;
        } else if (item.operation === 'DELETE') {
          const { error } = await supabase.from('participants').delete().eq('id', item.entityId);
          if (error) throw error;
        }
      } else if (item.table === 'judges') {
        if (item.operation === 'INSERT') {
          const { error } = await supabase.from('judges').upsert([item.payload]);
          if (error) throw error;
        } else if (item.operation === 'UPDATE') {
          const { error } = await supabase.from('judges').update(item.payload).eq('id', item.entityId);
          if (error) throw error;
        } else if (item.operation === 'DELETE') {
          const { error } = await supabase.from('judges').delete().eq('id', item.entityId);
          if (error) throw error;
        }
      } else if (item.table === 'organizations') {
        if (item.operation === 'UPDATE') {
          const { error } = await supabase.from('organizations').update(item.payload).ilike('org_id', item.entityId);
          if (error) throw error;
        } else if (item.operation === 'DELETE') {
          const { error } = await supabase.from('organizations').delete().ilike('org_id', item.entityId);
          if (error) throw error;
        }
      }

      await removePendingMutation(item.id);
      syncedCount++;
    } catch (err: any) {
      console.warn(`Retryable error syncing offline mutation ${item.id} (${item.table}):`, err?.message || err);
      failedCount++;
    }
  }

  notifyQueueChange();
  return { syncedCount, failedCount };
}

// ==========================================
// 2. SCORES QUEUE (Ballots)
// ==========================================

export async function queueScoreLocally(score: any): Promise<string> {
  const db = await getOfflineDB();
  const id =
    score.id ||
    (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `score_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);

  // Idempotency (Double-Submission Prevention): Reject duplicate write attempts
  const existing = await db.get('pending_scores', id);
  if (existing) {
    return id;
  }

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
  requestBackgroundSync();

  getPendingCount().then((count) => {
    eventBus.emit('sync_status', {
      status: 'offline',
      pendingCount: count,
      message: `${count} item${count > 1 ? 's' : ''} queued locally`,
    });
  });

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

// Total pending items count (both mutations & scores)
export async function getPendingCount(): Promise<number> {
  try {
    const db = await getOfflineDB();
    const [scoreCount, mutationCount] = await Promise.all([
      db.count('pending_scores'),
      db.count('pending_mutations'),
    ]);
    return scoreCount + mutationCount;
  } catch {
    return 0;
  }
}

// Sync all pending scores and mutations to Supabase with OCC Deduplication & Batched Upsert
export async function flushOfflineQueueToSupabase(): Promise<{
  syncedCount: number;
  failedCount: number;
}> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { syncedCount: 0, failedCount: 0 };
  }

  // 1. Flush offline structural mutations first (events, participants, judges)
  const mutationResult = await flushOfflineMutationsToSupabase();

  // 2. Flush pending scores (ballots) with OCC deduplication and batched upsert
  const rawScores = await getPendingScores();
  let scoreSynced = 0;
  let scoreFailed = 0;

  if (isSupabaseConfigured() && rawScores.length > 0) {
    // OCC Deduplication: Group by event_id + participant_id + judge_id
    const dedupedScoreMap = new Map<string, PendingScoreRecord>();
    const obsoleteScoreIds: string[] = [];

    // Sort chronological so newer score overwrites older
    rawScores.sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());

    for (const item of rawScores) {
      const entityKey = `${item.event_id}___${item.participant_id}___${item.judge_id}`;
      if (dedupedScoreMap.has(entityKey)) {
        const prev = dedupedScoreMap.get(entityKey)!;
        obsoleteScoreIds.push(prev.id);
      }
      dedupedScoreMap.set(entityKey, item);
    }

    // Prune stale superseded score ballots from IndexedDB immediately
    if (obsoleteScoreIds.length > 0) {
      await Promise.all(obsoleteScoreIds.map((id) => removePendingScore(id)));
    }

    const dedupedScores = Array.from(dedupedScoreMap.values());

    // Batched Network Upsert: Scoop all deduped records into a single batched array
    const batchedPayload = dedupedScores.map((item) => ({
      id: item.id,
      event_id: item.event_id,
      judge_id: item.judge_id,
      participant_id: item.participant_id,
      total_score: item.total_score,
      score_payload: {
        criteria: item.score_data || item.score_payload?.criteria || {},
        total_score: item.total_score,
        submitted_at: item.score_payload?.submitted_at || item.queuedAt || new Date().toISOString(),
      },
    }));

    try {
      // Single batched network call
      const { error } = await supabase.from('scores').upsert(batchedPayload);

      if (error) {
        throw error;
      }

      // Success: Clean up all synced items from IndexedDB
      await Promise.all(dedupedScores.map((item) => removePendingScore(item.id)));
      scoreSynced += dedupedScores.length;
    } catch (batchErr: any) {
      console.warn('Batched score upsert encountered error, falling back to granular safe sync:', batchErr?.message || batchErr);

      // Granular fallback in case one score has an RLS immutability conflict
      for (const item of dedupedScores) {
        try {
          const payloadJson = {
            criteria: item.score_data || item.score_payload?.criteria || {},
            total_score: item.total_score,
            submitted_at: item.score_payload?.submitted_at || item.queuedAt || new Date().toISOString(),
          };

          const { error } = await supabase.from('scores').upsert([
            {
              id: item.id,
              event_id: item.event_id,
              judge_id: item.judge_id,
              participant_id: item.participant_id,
              total_score: item.total_score,
              score_payload: payloadJson,
            },
          ]);

          if (error) {
            if (error.message && error.message.includes('RLS Permission Denied')) {
              await removePendingScore(item.id);
              scoreSynced++;
              continue;
            }
            throw error;
          }

          await removePendingScore(item.id);
          scoreSynced++;
        } catch (err: any) {
          console.warn(`Retryable error syncing offline score ${item.id}:`, err?.message || err);
          scoreFailed++;
        }
      }
    }
  }

  eventBus.emit('sync_status', { status: 'syncing', message: 'Syncing with cloud...' });

  notifyQueueChange();
  const totalSynced = mutationResult.syncedCount + scoreSynced;
  const remainingCount = await getPendingCount();

  if (totalSynced > 0) {
    eventBus.emit('toast', {
      type: 'success',
      title: 'Synced to Cloud',
      message: `Synchronized ${totalSynced} offline change${totalSynced > 1 ? 's' : ''}.`,
    });
    eventBus.emit('cache_updated', { table: 'all' });
  }

  eventBus.emit('sync_status', {
    status: remainingCount > 0 ? 'offline' : 'synced',
    pendingCount: remainingCount,
    message: remainingCount > 0 ? `${remainingCount} queued` : 'Cloud Synced',
  });

  return {
    syncedCount: totalSynced,
    failedCount: mutationResult.failedCount + scoreFailed,
  };
}

export const syncPendingScoresToFirestore = flushOfflineQueueToSupabase;

// ==========================================
// 3. GLOBAL AUTO-SYNC LISTENER
// ==========================================

let isListenerInitialized = false;

export function initOfflineSyncListener(): () => void {
  if (typeof window === 'undefined' || isListenerInitialized) return () => {};
  isListenerInitialized = true;

  const onlineHandler = () => {
    console.log('[Fair Judge] Device came online. Flushing local offline mutations & ballots to Supabase...');
    flushOfflineQueueToSupabase().then(({ syncedCount }) => {
      if (syncedCount > 0) {
        console.log(`[Fair Judge] Successfully synchronized ${syncedCount} queued mutations.`);
      }
    });
  };

  const swMessageHandler = (event: MessageEvent) => {
    if (event.data && event.data.type === 'TRIGGER_BACKGROUND_SYNC') {
      console.log('[Fair Judge] BackgroundSync triggered from Service Worker.');
      flushOfflineQueueToSupabase();
    }
  };

  window.addEventListener('online', onlineHandler);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', swMessageHandler);
  }

  // Initial check on load
  if (typeof navigator !== 'undefined' && navigator.onLine) {
    flushOfflineQueueToSupabase();
  }

  return () => {
    window.removeEventListener('online', onlineHandler);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.removeEventListener('message', swMessageHandler);
    }
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

export async function exportDiagnosticLog(): Promise<Record<string, any>> {
  const [scores, mutations] = await Promise.all([
    getPendingScores().catch(() => []),
    getPendingMutations().catch(() => []),
  ]);

  let storagePersisted: boolean | null = null;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persisted) {
      storagePersisted = await navigator.storage.persisted();
    }
  } catch {}

  return {
    app: 'Fair Judge',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    storagePersisted,
    queueSummary: {
      totalPendingScores: scores.length,
      totalPendingMutations: mutations.length,
      isQueueHealthy: scores.length === 0 && mutations.length === 0,
    },
    pendingScores: scores,
    pendingMutations: mutations,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  };
}

export async function downloadDiagnosticLog(): Promise<void> {
  const data = await exportDiagnosticLog();
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fairjudge-diagnostic-v${APP_VERSION}-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

