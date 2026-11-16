import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { isSupabaseConfigured, callSecuredWriteRpc, callSecuredReadRpc } from './supabase';
import { invalidateCache } from './db/indexedDB';
import { DB_TABLES } from './dbTables';
import { blackBox } from './blackBox';
import { APP_VERSION } from '../config/version';
import { stampLocal, downloadJson } from './downloadUtils';
import { parseOrgEnforcementError } from './orgEnforcement';
import { eventBus } from './eventBus';

export interface PendingScoreRecord {
  id: string;
  clientUuid?: string;
  legacyMigrated?: boolean;
  legacyId?: string;
  event_id: string;
  judge_id: string;
  participant_id: string;
  score_data: Record<string, number>;
  total_score: number;
  score_payload: {
    criteria: Record<string, number>;
    total_score: number;
    submitted_at: string;
    client_uuid?: string;
  };
  queuedAt: string;
  syncStatus: 'pending' | 'syncing' | 'failed';
  retryCount?: number;
  lastError?: string;
}

export type MutationOperation = 'INSERT' | 'UPDATE' | 'DELETE';
export type MutationTable = 'events' | 'participants' | 'judges' | 'organizations';

export interface PendingMutationRecord {
  id: string;
  clientUuid?: string;
  legacyMigrated?: boolean;
  legacyId?: string;
  table: MutationTable;
  operation: MutationOperation;
  entityId: string;
  payload?: any;
  queuedAt: string;
  syncStatus: 'pending' | 'syncing' | 'failed';
  retryCount: number;
  lastError?: string;
}

export type OutboxKind = 'mutation' | 'score' | 'draft';
export type OutboxSyncStatus = 'pending' | 'syncing' | 'failed' | 'draft';

export interface OutboxRecord {
  id: string;
  clientUuid?: string;
  legacyMigrated?: boolean;
  legacyId?: string;
  kind: OutboxKind;
  table: MutationTable | 'scores' | 'drafts';
  operation: MutationOperation | 'DRAFT';
  entityId: string;
  payload?: any;
  queuedAt: string;
  syncStatus: OutboxSyncStatus;
  retryCount: number;
  lastError?: string;
}

interface FairJudgeOfflineDB extends DBSchema {
  outbox: {
    key: string;
    value: OutboxRecord;
    indexes: {
      'by-kind': OutboxKind;
      'by-table': string;
      'by-time': string;
      'by-status': OutboxSyncStatus;
    };
  };
}

export const OFFLINE_DB_NAME = 'fairjudge_offline_queue_v3';
export const OFFLINE_DB_VERSION = 2;
const DRAFT_ID_PREFIX = 'draft:';
const DRAFT_TTL_MS = 24 * 3600 * 1000;
const LEGACY_ORG_DRAFT_PREFIX = ['fj', 'draft', ''].join('_');
const LEGACY_SCORE_DRAFT_PREFIX = ['draft', 'score', ''].join('_');
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let dbPromise: Promise<IDBPDatabase<FairJudgeOfflineDB>> | null = null;
let legacyDraftsMigrated = false;
let lastMigrationError: string | null = null;

// Instant synchronous draft mirror (authoritative persistence lives in IndexedDB `outbox`)
const draftMirror = new Map<string, any>();

export function isValidOutboxUUID(val: unknown): val is string {
  return typeof val === 'string' && UUID_V4_RE.test(val.trim());
}

export function generateOutboxUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getOfflineMigrationError(): string | null {
  return lastMigrationError;
}

function emitMigrationError(title: string, message: string, source: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : String(err || message);
  lastMigrationError = detail;
  blackBox.recordError('console_error', `${title}: ${detail}`, source);
  eventBus.emit('toast', {
    type: 'error',
    title,
    message,
  });
}

function normalizeScoreOutboxPayload(score: PendingScoreRecord): PendingScoreRecord {
  const clientUuid = isValidOutboxUUID(score.clientUuid)
    ? score.clientUuid
    : isValidOutboxUUID(score.id)
    ? score.id
    : generateOutboxUUID();
  const basePayload = score.score_payload || {
    criteria: score.score_data || {},
    total_score: Number(score.total_score ?? 0),
    submitted_at: score.queuedAt || new Date().toISOString(),
  };
  return {
    id: isValidOutboxUUID(score.id) ? score.id : clientUuid,
    clientUuid,
    ...(score.legacyMigrated ? { legacyMigrated: true } : {}),
    ...(score.legacyId ? { legacyId: score.legacyId } : {}),
    event_id: score.event_id,
    judge_id: score.judge_id,
    participant_id: score.participant_id,
    score_data: score.score_data || basePayload.criteria || {},
    total_score: Number(score.total_score ?? basePayload.total_score ?? 0),
    score_payload: {
      ...basePayload,
      client_uuid: basePayload.client_uuid || clientUuid,
    },
    queuedAt: score.queuedAt || new Date().toISOString(),
    syncStatus: score.syncStatus === 'failed' || score.syncStatus === 'syncing' ? score.syncStatus : 'pending',
    retryCount: Number(score.retryCount || 0),
    ...(score.lastError ? { lastError: score.lastError } : {}),
  };
}

function mutationToOutbox(m: PendingMutationRecord): OutboxRecord {
  const clientUuid = isValidOutboxUUID(m.clientUuid)
    ? m.clientUuid
    : isValidOutboxUUID(m.id)
    ? m.id
    : generateOutboxUUID();
  return {
    id: isValidOutboxUUID(m.id) ? m.id : clientUuid,
    clientUuid,
    ...(m.legacyMigrated ? { legacyMigrated: true } : {}),
    ...(m.legacyId ? { legacyId: m.legacyId } : {}),
    kind: 'mutation',
    table: m.table,
    operation: m.operation,
    entityId: m.entityId,
    payload: m.payload ?? null,
    queuedAt: m.queuedAt || new Date().toISOString(),
    syncStatus: m.syncStatus || 'pending',
    retryCount: Number(m.retryCount || 0),
    ...(m.lastError ? { lastError: m.lastError } : {}),
  };
}

function scoreToOutbox(s: PendingScoreRecord): OutboxRecord {
  const norm = normalizeScoreOutboxPayload(s);
  return {
    id: norm.id,
    clientUuid: norm.clientUuid,
    ...(norm.legacyMigrated ? { legacyMigrated: true } : {}),
    ...(norm.legacyId ? { legacyId: norm.legacyId } : {}),
    kind: 'score',
    table: 'scores',
    operation: 'INSERT',
    entityId: norm.id,
    payload: {
      event_id: norm.event_id,
      judge_id: norm.judge_id,
      participant_id: norm.participant_id,
      score_data: norm.score_data,
      total_score: norm.total_score,
      score_payload: norm.score_payload,
    },
    queuedAt: norm.queuedAt,
    syncStatus: norm.syncStatus,
    retryCount: Number(norm.retryCount || 0),
    ...(norm.lastError ? { lastError: norm.lastError } : {}),
  };
}

function outboxToMutation(rec: OutboxRecord): PendingMutationRecord {
  const isLegacy = Boolean(rec.legacyMigrated || !isValidOutboxUUID(rec.id));
  const clientUuid = isValidOutboxUUID(rec.clientUuid)
    ? rec.clientUuid
    : isValidOutboxUUID(rec.id)
    ? rec.id
    : generateOutboxUUID();
  return {
    id: rec.id,
    clientUuid,
    ...(isLegacy ? { legacyMigrated: true } : {}),
    ...(rec.legacyId ? { legacyId: rec.legacyId } : !isValidOutboxUUID(rec.id) ? { legacyId: rec.id } : {}),
    table: rec.table as MutationTable,
    operation: rec.operation as MutationOperation,
    entityId: rec.entityId,
    payload: rec.payload ?? null,
    queuedAt: rec.queuedAt,
    syncStatus: rec.syncStatus === 'failed' || rec.syncStatus === 'syncing' ? rec.syncStatus : 'pending',
    retryCount: Number(rec.retryCount || 0),
    ...(rec.lastError ? { lastError: rec.lastError } : {}),
  };
}

function outboxToScore(rec: OutboxRecord): PendingScoreRecord {
  const p = rec.payload || {};
  const criteria = p.score_data || p.score_payload?.criteria || {};
  const total = Number(p.total_score ?? p.score_payload?.total_score ?? 0);
  const isLegacy = Boolean(rec.legacyMigrated || !isValidOutboxUUID(rec.id));
  const clientUuid = isValidOutboxUUID(rec.clientUuid)
    ? rec.clientUuid
    : isValidOutboxUUID(rec.id)
    ? rec.id
    : generateOutboxUUID();
  const basePayload = p.score_payload || {
    criteria,
    total_score: total,
    submitted_at: rec.queuedAt || new Date().toISOString(),
  };
  return {
    id: rec.id,
    clientUuid,
    ...(isLegacy ? { legacyMigrated: true } : {}),
    ...(rec.legacyId ? { legacyId: rec.legacyId } : !isValidOutboxUUID(rec.id) ? { legacyId: rec.id } : {}),
    event_id: p.event_id || '',
    judge_id: p.judge_id || '',
    participant_id: p.participant_id || '',
    score_data: criteria,
    total_score: total,
    score_payload: {
      ...basePayload,
      client_uuid: basePayload.client_uuid || clientUuid,
    },
    queuedAt: rec.queuedAt,
    syncStatus: rec.syncStatus === 'failed' || rec.syncStatus === 'syncing' ? rec.syncStatus : 'pending',
    retryCount: Number(rec.retryCount || 0),
    ...(rec.lastError ? { lastError: rec.lastError } : {}),
  };
}

function isLegacyDraftStorageKey(key: string | null | undefined): key is string {
  return Boolean(key && (key.startsWith(LEGACY_ORG_DRAFT_PREFIX) || key.startsWith(LEGACY_SCORE_DRAFT_PREFIX)));
}

function normalizeDraftKey(rawKey: string): string {
  const scorePrefix = `${LEGACY_ORG_DRAFT_PREFIX}score_`;
  if (rawKey.startsWith(scorePrefix)) {
    const parts = rawKey.slice(scorePrefix.length).split('_');
    if (parts.length >= 3) {
      return `score_draft:${parts[0]}:${parts[1]}:${parts.slice(2).join('_')}`;
    }
  }
  const participantPrefix = `${LEGACY_ORG_DRAFT_PREFIX}participant_`;
  if (rawKey.startsWith(participantPrefix)) {
    return `participant_draft:${rawKey.slice(participantPrefix.length)}`;
  }
  if (rawKey.startsWith(LEGACY_SCORE_DRAFT_PREFIX)) {
    return `score_draft:${rawKey.slice(LEGACY_SCORE_DRAFT_PREFIX.length)}`;
  }
  return rawKey;
}

function isDraftExpired(payload: any): boolean {
  const ts = Number(payload?.timestamp ?? 0);
  return Boolean(ts > 0 && Date.now() - ts >= DRAFT_TTL_MS);
}

export function getOfflineDB(): Promise<IDBPDatabase<FairJudgeOfflineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FairJudgeOfflineDB>(OFFLINE_DB_NAME, OFFLINE_DB_VERSION, {
      async upgrade(db, _oldVersion, _newVersion, transaction) {
        const legacyDb = db as unknown as IDBPDatabase<any>;
        const legacyTx = transaction as any;

        let outboxStore: any;
        if (!legacyDb.objectStoreNames.contains('outbox')) {
          outboxStore = legacyDb.createObjectStore('outbox', { keyPath: 'id' });
          outboxStore.createIndex('by-kind', 'kind');
          outboxStore.createIndex('by-table', 'table');
          outboxStore.createIndex('by-time', 'queuedAt');
          outboxStore.createIndex('by-status', 'syncStatus');
        } else {
          outboxStore = legacyTx.objectStore('outbox');
        }

        // Lossless atomic migration from v1 `pending_mutations` -> `outbox` with fresh UUIDs
        if (legacyDb.objectStoreNames.contains('pending_mutations')) {
          try {
            const mutStore = legacyTx.objectStore('pending_mutations');
            const oldMutations: PendingMutationRecord[] = await mutStore.getAll();
            for (const mut of oldMutations) {
              if (!mut?.id) continue;
              const freshId = generateOutboxUUID();
              await outboxStore.put(
                mutationToOutbox({
                  ...mut,
                  id: freshId,
                  clientUuid: freshId,
                  legacyMigrated: true,
                  legacyId: mut.id,
                })
              );
            }
            legacyDb.deleteObjectStore('pending_mutations');
          } catch (err) {
            emitMigrationError(
              'Queue Migration Failed',
              'Could not migrate legacy pending changes. Old queue data was kept safely.',
              'offlineQueue.upgrade.mutations',
              err
            );
          }
        }

        // Lossless atomic migration from v1 `pending_scores` -> `outbox` with fresh UUIDs
        if (legacyDb.objectStoreNames.contains('pending_scores')) {
          try {
            const scoreStore = legacyTx.objectStore('pending_scores');
            const oldScores: PendingScoreRecord[] = await scoreStore.getAll();
            for (const sc of oldScores) {
              if (!sc?.id) continue;
              const freshId = generateOutboxUUID();
              await outboxStore.put(
                scoreToOutbox({
                  ...sc,
                  id: freshId,
                  clientUuid: freshId,
                  legacyMigrated: true,
                  legacyId: sc.id,
                })
              );
            }
            legacyDb.deleteObjectStore('pending_scores');
          } catch (err) {
            emitMigrationError(
              'Score Queue Migration Failed',
              'Could not migrate legacy pending ballots. Old ballot queue was kept safely.',
              'offlineQueue.upgrade.scores',
              err
            );
          }
        }
      },
    }).catch((err) => {
      dbPromise = null;
      emitMigrationError(
        'Offline Storage Error',
        'Failed to open IndexedDB offline outbox. Legacy queue data remains preserved.',
        'offlineQueue.openDB',
        err
      );
      throw err;
    });
  }
  return dbPromise;
}

/**
 * Resets cached DB handle and in-memory draft mirror (for unit tests).
 */
export function resetOfflineQueueForTest(): void {
  dbPromise = null;
  legacyDraftsMigrated = false;
  lastMigrationError = null;
  draftMirror.clear();
}

// ==========================================
// 0. UNIFIED OUTBOX DRAFTS (IndexedDB Only + One-Time Legacy Migration)
// ==========================================

export async function migrateLegacyLocalStorageDrafts(): Promise<number> {
  if (typeof localStorage === 'undefined') return 0;
  let migrated = 0;
  let hadFailure = false;

  try {
    const legacyKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (isLegacyDraftStorageKey(k)) {
        legacyKeys.push(k);
      }
    }

    if (legacyKeys.length === 0) {
      legacyDraftsMigrated = true;
      return 0;
    }

    const db = await getOfflineDB();

    for (const key of legacyKeys) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) {
          localStorage.removeItem(key);
          continue;
        }
        const parsed = JSON.parse(raw);
        if (isDraftExpired(parsed)) {
          localStorage.removeItem(key);
          continue;
        }

        const normalizedKey = normalizeDraftKey(key);
        const outboxId = `${DRAFT_ID_PREFIX}${normalizedKey}`;
        const existing = await db.get('outbox', outboxId);
        if (!existing) {
          const record: OutboxRecord = {
            id: outboxId,
            clientUuid: generateOutboxUUID(),
            legacyMigrated: true,
            legacyId: key,
            kind: 'draft',
            table: 'drafts',
            operation: 'DRAFT',
            entityId: normalizedKey,
            payload: parsed,
            queuedAt: new Date(Number(parsed?.timestamp) || Date.now()).toISOString(),
            syncStatus: 'draft',
            retryCount: 0,
          };
          await db.put('outbox', record);
        }
        draftMirror.set(normalizedKey, parsed);
        // Remove legacy localStorage key ONLY after IndexedDB commit succeeded
        localStorage.removeItem(key);
        migrated++;
      } catch (err) {
        hadFailure = true;
        // Preserve unmigrated localStorage key safely and alert user
        emitMigrationError(
          'Draft Migration Warning',
          'Could not move an unsaved draft into IndexedDB. Legacy draft was preserved.',
          'offlineQueue.migrateDraft',
          err
        );
      }
    }

    if (!hadFailure) {
      legacyDraftsMigrated = true;
    }
    if (migrated > 0) {
      notifyQueueChange();
    }
  } catch (err) {
    emitMigrationError(
      'Draft Migration Failed',
      'IndexedDB unavailable while migrating drafts. Existing legacy drafts were preserved.',
      'offlineQueue.migrateDrafts',
      err
    );
  }

  return migrated;
}

export async function hydrateDraftMirror(): Promise<void> {
  if (!legacyDraftsMigrated) {
    await migrateLegacyLocalStorageDrafts();
  }
  try {
    const db = await getOfflineDB();
    const allDrafts = await db.getAllFromIndex('outbox', 'by-kind', 'draft');
    const obsoleteIds: string[] = [];
    for (const rec of allDrafts) {
      if (isDraftExpired(rec.payload)) {
        obsoleteIds.push(rec.id);
        draftMirror.delete(rec.entityId);
        continue;
      }

      if (isLegacyDraftStorageKey(rec.entityId)) {
        const normalizedKey = normalizeDraftKey(rec.entityId);
        const normalizedId = `${DRAFT_ID_PREFIX}${normalizedKey}`;
        const existing = await db.get('outbox', normalizedId);
        if (!existing) {
          await db.put('outbox', {
            ...rec,
            id: normalizedId,
            clientUuid: isValidOutboxUUID(rec.clientUuid) ? rec.clientUuid : generateOutboxUUID(),
            entityId: normalizedKey,
          });
        }
        obsoleteIds.push(rec.id);
        draftMirror.delete(rec.entityId);
        draftMirror.set(normalizedKey, rec.payload);
      } else {
        draftMirror.set(rec.entityId, rec.payload);
      }
    }
    if (obsoleteIds.length > 0) {
      await Promise.all(obsoleteIds.map((id) => db.delete('outbox', id)));
    }
  } catch {}
}

export function getDraftSync<T = any>(draftKey: string): T | null {
  const mem = draftMirror.get(draftKey);
  if (mem !== undefined) {
    if (isDraftExpired(mem)) {
      draftMirror.delete(draftKey);
      return null;
    }
    return mem as T;
  }

  return null;
}

export async function getDraft<T = any>(draftKey: string): Promise<T | null> {
  const syncHit = getDraftSync<T>(draftKey);
  if (syncHit !== null) return syncHit;

  try {
    const db = await getOfflineDB();
    const rec = await db.get('outbox', `${DRAFT_ID_PREFIX}${draftKey}`);
    if (rec && rec.kind === 'draft' && rec.payload !== undefined) {
      if (isDraftExpired(rec.payload)) {
        await db.delete('outbox', rec.id);
        return null;
      }
      draftMirror.set(draftKey, rec.payload);
      return rec.payload as T;
    }
  } catch {}

  return null;
}

export async function saveDraft(draftKey: string, payload: any): Promise<void> {
  const wrapped =
    payload && typeof payload === 'object' && 'timestamp' in payload
      ? payload
      : { version: 1, data: payload, timestamp: Date.now() };

  draftMirror.set(draftKey, wrapped);

  try {
    const db = await getOfflineDB();
    const existing = await db.get('outbox', `${DRAFT_ID_PREFIX}${draftKey}`);
    const record: OutboxRecord = {
      id: `${DRAFT_ID_PREFIX}${draftKey}`,
      clientUuid: isValidOutboxUUID(existing?.clientUuid) ? existing.clientUuid : generateOutboxUUID(),
      kind: 'draft',
      table: 'drafts',
      operation: 'DRAFT',
      entityId: draftKey,
      payload: wrapped,
      queuedAt: new Date(Number(wrapped.timestamp) || Date.now()).toISOString(),
      syncStatus: 'draft',
      retryCount: 0,
    };
    await db.put('outbox', record);
  } catch (err) {
    blackBox.recordError(
      'console_error',
      `IndexedDB draft write failed for ${draftKey}: ${err instanceof Error ? err.message : String(err)}`,
      'offlineQueue.saveDraft'
    );
  }
}

export async function removeDraft(draftKey: string): Promise<void> {
  draftMirror.delete(draftKey);
  try {
    const db = await getOfflineDB();
    await db.delete('outbox', `${DRAFT_ID_PREFIX}${draftKey}`);
  } catch {}
}

export async function getPendingDrafts(): Promise<OutboxRecord[]> {
  try {
    const db = await getOfflineDB();
    return await db.getAllFromIndex('outbox', 'by-kind', 'draft');
  } catch {
    return [];
  }
}

/**
 * Clears all drafts from the in-memory mirror, unified `outbox` store, and any residual legacy `localStorage` keys.
 */
export function clearAllScoreDrafts(): void {
  draftMirror.clear();

  if (typeof localStorage !== 'undefined') {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (isLegacyDraftStorageKey(key)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        localStorage.removeItem(key);
      }
    } catch {}
  }

  void (async () => {
    try {
      const db = await getOfflineDB();
      const allDrafts = await db.getAllFromIndex('outbox', 'by-kind', 'draft');
      await Promise.all(allDrafts.map((d) => db.delete('outbox', d.id)));
    } catch {}
  })();
}

/**
 * Clears all queued mutations, pending scores, and drafts belonging to `orgId`
 * from the unified IndexedDB `outbox` store (and in-memory / legacy draft mirrors)
 * without disturbing queued work for any other organization.
 */
export async function clearOfflineWorkForOrg(
  orgId: string,
  knownEntityIds?: {
    eventIds?: Iterable<string>;
    participantIds?: Iterable<string>;
    judgeIds?: Iterable<string>;
  }
): Promise<number> {
  const cleanOrgId = orgId.trim().toUpperCase();
  if (!cleanOrgId) return 0;

  const eventIds = new Set<string>(knownEntityIds?.eventIds || []);
  const participantIds = new Set<string>(knownEntityIds?.participantIds || []);
  const judgeIds = new Set<string>(knownEntityIds?.judgeIds || []);

  const payloadHasOrg = (payload: any): boolean => {
    if (!payload) return false;
    if (Array.isArray(payload)) {
      return payload.some((entry) => payloadHasOrg(entry));
    }
    if (typeof payload !== 'object') return false;
    const pOrg = typeof payload.org_id === 'string' ? payload.org_id.trim().toUpperCase() : '';
    if (pOrg === cleanOrgId) return true;
    const pEvent = typeof payload.event_id === 'string' ? payload.event_id : '';
    if (pEvent && eventIds.has(pEvent)) return true;
    return false;
  };

  const draftMatchesOrg = (rawKey: string, payload?: any): boolean => {
    const key = normalizeDraftKey(rawKey);
    const keyUpper = key.toUpperCase();
    if (keyUpper === `PARTICIPANT_DRAFT:${cleanOrgId}`) return true;
    if (key.startsWith('score_draft:')) {
      const parts = key.slice('score_draft:'.length).split(':');
      const evtId = parts[0] || '';
      const jId = parts[1] || '';
      const pId = parts[2] || '';
      if ((evtId && eventIds.has(evtId)) || (jId && judgeIds.has(jId)) || (pId && participantIds.has(pId))) {
        return true;
      }
    }
    return payloadHasOrg(payload);
  };

  let removed = 0;
  const matchedDraftKeys = new Set<string>();

  try {
    const db = await getOfflineDB();
    const allItems = await db.getAll('outbox');

    // Pass 1: Discover org-owned entity IDs embedded in queued mutation payloads
    for (const rec of allItems) {
      if (rec.kind !== 'mutation') continue;
      if (rec.table === 'events' && payloadHasOrg(rec.payload) && rec.entityId) {
        eventIds.add(rec.entityId);
      } else if (rec.table === 'judges' && payloadHasOrg(rec.payload) && rec.entityId) {
        judgeIds.add(rec.entityId);
      } else if (rec.table === 'participants' && payloadHasOrg(rec.payload)) {
        if (rec.entityId) participantIds.add(rec.entityId);
        if (Array.isArray(rec.payload)) {
          for (const row of rec.payload) {
            if (row?.id) participantIds.add(String(row.id));
          }
        }
      }
    }

    // Pass 2: Collect outbox record IDs belonging to this org across mutations, scores, and drafts
    const idsToDelete: string[] = [];
    for (const rec of allItems) {
      if (rec.kind === 'mutation') {
        const matchesOrgTable =
          rec.table === 'organizations' && (rec.entityId || '').trim().toUpperCase() === cleanOrgId;
        const matchesEvent =
          rec.table === 'events' && (eventIds.has(rec.entityId) || payloadHasOrg(rec.payload));
        const matchesJudge =
          rec.table === 'judges' && (judgeIds.has(rec.entityId) || payloadHasOrg(rec.payload));
        const matchesParticipant =
          rec.table === 'participants' && (participantIds.has(rec.entityId) || payloadHasOrg(rec.payload));

        if (matchesOrgTable || matchesEvent || matchesJudge || matchesParticipant) {
          idsToDelete.push(rec.id);
        }
      } else if (rec.kind === 'score') {
        const p = rec.payload || {};
        const matchesScore =
          payloadHasOrg(p) ||
          Boolean(p.event_id && eventIds.has(p.event_id)) ||
          Boolean(p.judge_id && judgeIds.has(p.judge_id)) ||
          Boolean(p.participant_id && participantIds.has(p.participant_id));
        if (matchesScore) {
          idsToDelete.push(rec.id);
        }
      } else if (rec.kind === 'draft') {
        if (draftMatchesOrg(rec.entityId, rec.payload)) {
          idsToDelete.push(rec.id);
          matchedDraftKeys.add(rec.entityId);
          matchedDraftKeys.add(normalizeDraftKey(rec.entityId));
        }
      }
    }

    if (idsToDelete.length > 0) {
      await Promise.all(idsToDelete.map((id) => db.delete('outbox', id)));
      removed = idsToDelete.length;
    }
  } catch (err) {
    console.warn('Error clearing offline work for org:', err);
  }

  for (const [key, val] of Array.from(draftMirror.entries())) {
    if (matchedDraftKeys.has(key) || draftMatchesOrg(key, val)) {
      draftMirror.delete(key);
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      const legacyToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && isLegacyDraftStorageKey(k) && draftMatchesOrg(k)) {
          legacyToRemove.push(k);
        }
      }
      for (const k of legacyToRemove) {
        localStorage.removeItem(k);
      }
    } catch {}
  }

  if (removed > 0) {
    notifyQueueChange();
  }

  getPendingCount()
    .then((count) => {
      eventBus.emit('sync_status', {
        status: count > 0 ? 'offline' : 'synced',
        pendingCount: count,
        message: count > 0 ? `${count} queued` : 'Cloud Synced',
      });
    })
    .catch(() => {});

  return removed;
}

// ==========================================
// 1. UNIFIED OUTBOX MUTATIONS & SCORES
// ==========================================

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

export async function getOutboxItems(): Promise<OutboxRecord[]> {
  try {
    const db = await getOfflineDB();
    return await db.getAll('outbox');
  } catch {
    return [];
  }
}

export async function queueMutationLocally(
  table: MutationTable,
  operation: MutationOperation,
  entityId: string,
  payload?: any
): Promise<string> {
  const db = await getOfflineDB();
  const id = generateOutboxUUID();

  const record: OutboxRecord = {
    id,
    clientUuid: id,
    kind: 'mutation',
    table,
    operation,
    entityId,
    payload: payload || null,
    queuedAt: new Date().toISOString(),
    syncStatus: 'pending',
    retryCount: 0,
  };

  await db.put('outbox', record);
  notifyQueueChange();
  requestBackgroundSync();

  getPendingCount()
    .then((count) => {
      eventBus.emit('sync_status', {
        status: 'offline',
        pendingCount: count,
        message: `${count} item${count > 1 ? 's' : ''} queued locally`,
      });
    })
    .catch(() => {});

  if (typeof navigator === 'undefined' || navigator.onLine !== false) {
    flushOfflineQueueToSupabase().catch(() => {});
  }

  return id;
}

export async function getPendingMutations(): Promise<PendingMutationRecord[]> {
  try {
    const db = await getOfflineDB();
    const rows = await db.getAllFromIndex('outbox', 'by-kind', 'mutation');
    return rows.map(outboxToMutation);
  } catch (err) {
    console.warn('Error fetching pending offline mutations:', err);
    return [];
  }
}

export async function removePendingMutation(id: string): Promise<void> {
  try {
    const db = await getOfflineDB();
    await db.delete('outbox', id);
    notifyQueueChange();
  } catch (err) {
    console.warn('Error removing mutation from offline queue:', err);
  }
}

export async function getPendingMutationsCount(): Promise<number> {
  try {
    const muts = await getPendingMutations();
    return muts.filter((m) => m.syncStatus !== 'failed').length;
  } catch {
    return 0;
  }
}

export async function scrubOfflineOutboxSecrets(): Promise<number> {
  let scrubbed = 0;
  try {
    const db = await getOfflineDB();
    const mutations = await db.getAllFromIndex('outbox', 'by-kind', 'mutation');
    for (const item of mutations) {
      if (item.table === 'organizations' && item.payload && item.payload.password) {
        scrubbed++;
        delete item.payload.password;
        await db.put('outbox', item);
      }
    }
  } catch {}
  return scrubbed;
}

export interface OfflineFlushResult {
  syncedCount: number;
  failedCount: number;
  authRequired?: boolean;
}

let activeMutationsFlush: Promise<OfflineFlushResult> | null = null;
let activeQueueFlush: Promise<OfflineFlushResult> | null = null;
let pendingQueueFlushRequested = false;

// Flush all queued non-score mutations (events, participants, judges, orgs) to Supabase
export function flushOfflineMutationsToSupabase(): Promise<OfflineFlushResult> {
  if (activeMutationsFlush) {
    return activeMutationsFlush;
  }
  activeMutationsFlush = runFlushOfflineMutationsOnce().finally(() => {
    activeMutationsFlush = null;
  });
  return activeMutationsFlush;
}

async function isLegacyMutationAlreadyAppliedOnServer(item: PendingMutationRecord): Promise<boolean> {
  const needsCheck = Boolean(item.legacyMigrated || !isValidOutboxUUID(item.id));
  if (!needsCheck) return false;

  if (item.table === 'events') {
    const res = await callSecuredReadRpc<any[]>('read_events', { p_event_id: item.entityId });
    const rows = Array.isArray(res.data) ? res.data : [];
    if (item.operation === 'DELETE') return rows.length === 0;
    if (item.operation === 'INSERT') return rows.length > 0;
    if (item.operation === 'UPDATE') {
      if (rows.length === 0) return true;
      const serverUpdated = Date.parse(String(rows[0]?.updated_at || ''));
      const queuedMs = Date.parse(item.queuedAt || '');
      if (Number.isFinite(serverUpdated) && Number.isFinite(queuedMs) && serverUpdated >= queuedMs) {
        return true;
      }
    }
    return false;
  }

  if (item.table === 'judges') {
    const res = await callSecuredReadRpc<any[]>('read_judges', { p_judge_id: item.entityId });
    const rows = Array.isArray(res.data) ? res.data : [];
    if (item.operation === 'DELETE') return rows.length === 0;
    if (item.operation === 'INSERT') return rows.length > 0;
    if (item.operation === 'UPDATE') return rows.length === 0;
    return false;
  }

  if (item.table === 'participants') {
    const res = await callSecuredReadRpc<any[]>('read_participants');
    const rows = Array.isArray(res.data) ? res.data : [];
    if (item.operation === 'DELETE') return !rows.some((p) => p?.id === item.entityId);
    if (item.operation === 'INSERT') {
      if (Array.isArray(item.payload)) {
        const ids = item.payload.map((r: any) => r?.id).filter(Boolean);
        return ids.length > 0 && ids.every((id: string) => rows.some((p) => p?.id === id));
      }
      return rows.some((p) => p?.id === item.entityId);
    }
    if (item.operation === 'UPDATE') return !rows.some((p) => p?.id === item.entityId);
    return false;
  }

  if (item.table === 'organizations' && item.operation === 'DELETE') {
    const res = await callSecuredReadRpc<any>('read_organization', { p_org_id: item.entityId });
    return Boolean(res.not_found || !res.data);
  }

  return false;
}

async function runFlushOfflineMutationsOnce(): Promise<OfflineFlushResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { syncedCount: 0, failedCount: 0 };
  }
  if (!isSupabaseConfigured()) {
    return { syncedCount: 0, failedCount: 0 };
  }

  const db = await getOfflineDB();
  const rawMutations = (await getPendingMutations()).filter((m) => m.syncStatus !== 'failed');
  if (rawMutations.length === 0) {
    return { syncedCount: 0, failedCount: 0 };
  }

  // Normalize any pre-existing non-UUID mutation rows to a fresh UUID key + legacy flag
  for (let i = 0; i < rawMutations.length; i++) {
    const m = rawMutations[i];
    if (!isValidOutboxUUID(m.id)) {
      const oldId = m.id;
      const freshId = isValidOutboxUUID(m.clientUuid) ? m.clientUuid : generateOutboxUUID();
      const upgraded: PendingMutationRecord = {
        ...m,
        id: freshId,
        clientUuid: freshId,
        legacyMigrated: true,
        legacyId: m.legacyId || oldId,
      };
      await db.put('outbox', mutationToOutbox(upgraded));
      await db.delete('outbox', oldId);
      rawMutations[i] = upgraded;
    }
  }

  // 1. Client-Side Optimistic Concurrency Control (OCC) Deduplication
  const latestMutationMap = new Map<string, PendingMutationRecord>();
  const obsoleteMutationIds: string[] = [];

  rawMutations.sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());

  for (const item of rawMutations) {
    const key = `${item.table}:${item.entityId}`;
    if (latestMutationMap.has(key)) {
      const prev = latestMutationMap.get(key)!;
      if (prev.operation === 'INSERT' && item.operation === 'UPDATE') {
        prev.payload = { ...(prev.payload || {}), ...(item.payload || {}) };
        prev.queuedAt = item.queuedAt;
        await db.put('outbox', mutationToOutbox(prev));
        obsoleteMutationIds.push(item.id);
        continue;
      }
      if (prev.operation === 'UPDATE' && item.operation === 'UPDATE') {
        item.payload = { ...(prev.payload || {}), ...(item.payload || {}) };
        await db.put('outbox', mutationToOutbox(item));
        obsoleteMutationIds.push(prev.id);
        latestMutationMap.set(key, item);
        continue;
      }
      obsoleteMutationIds.push(prev.id);
    }
    latestMutationMap.set(key, item);
  }

  if (obsoleteMutationIds.length > 0) {
    await Promise.all(obsoleteMutationIds.map((id) => removePendingMutation(id)));
  }

  const mutations = Array.from(latestMutationMap.values()).filter((m) => m.syncStatus !== 'failed');
  let syncedCount = 0;
  let failedCount = 0;
  let authRequired = false;

  for (const item of mutations) {
    try {
      // Outcome #3: Check legacy migrated items against server before resending
      if (item.legacyMigrated) {
        const alreadyOnServer = await isLegacyMutationAlreadyAppliedOnServer(item);
        if (alreadyOnServer) {
          await removePendingMutation(item.id);
          continue;
        }
      }

      if (item.table === 'events') {
        if (item.operation === 'INSERT') {
          await callSecuredWriteRpc('event_upsert', { p_record: item.payload });
        } else if (item.operation === 'UPDATE') {
          await callSecuredWriteRpc('event_update', {
            p_event_id: item.entityId,
            p_updates: item.payload,
          });
        } else if (item.operation === 'DELETE') {
          await callSecuredWriteRpc('event_delete', { p_event_id: item.entityId });
        }
      } else if (item.table === 'participants') {
        if (item.operation === 'INSERT') {
          const records = Array.isArray(item.payload) ? item.payload : [item.payload];
          await callSecuredWriteRpc('participant_upsert_batch', { p_records: records });
        } else if (item.operation === 'UPDATE') {
          await callSecuredWriteRpc('participant_update', {
            p_participant_id: item.entityId,
            p_updates: item.payload,
          });
        } else if (item.operation === 'DELETE') {
          await callSecuredWriteRpc('participant_delete', { p_participant_id: item.entityId });
        }
      } else if (item.table === 'judges') {
        if (item.operation === 'INSERT') {
          await callSecuredWriteRpc('judge_upsert', { p_record: item.payload });
        } else if (item.operation === 'UPDATE') {
          await callSecuredWriteRpc('judge_update', {
            p_judge_id: item.entityId,
            p_updates: item.payload,
          });
        } else if (item.operation === 'DELETE') {
          await callSecuredWriteRpc('judge_delete', { p_judge_id: item.entityId });
        }
      } else if (item.table === 'organizations') {
        if (item.operation === 'UPDATE') {
          await callSecuredWriteRpc('org_update', {
            p_org_id: item.entityId,
            p_updates: item.payload,
          });
        } else if (item.operation === 'DELETE') {
          await callSecuredWriteRpc('org_delete', { p_org_id: item.entityId });
        }
      }

      await removePendingMutation(item.id);
      syncedCount++;
    } catch (err: any) {
      console.warn(`Error syncing offline mutation ${item.id} (${item.table}):`, err?.message || err);

      if (err?.code === 'unauthorized') {
        authRequired = true;
        break;
      }

      if (err?.code === 'rpc_unavailable') {
        break;
      }

      const orgBlock = parseOrgEnforcementError(err);
      if (orgBlock) {
        eventBus.emit('org_enforcement', { code: orgBlock });
        item.lastError = `ORG_NOT_ALLOWED: ${orgBlock}`;
        if (orgBlock === 'SUSPENDED' || orgBlock === 'DELETED') {
          item.syncStatus = 'failed';
          blackBox.recordError(
            'console_error',
            `Offline ${item.table}:${item.operation} blocked (${orgBlock})`,
            'offlineQueue.mutations'
          );
        }
        await db.put('outbox', mutationToOutbox(item));
        failedCount++;
        continue;
      }

      const isRosterLocked = Boolean(
        err?.code === 'ROSTER_LOCKED' ||
        err?.message?.includes('ROSTER_LOCKED') ||
        (err?.details && String(err.details).includes('ROSTER_LOCKED'))
      );
      const isRls = Boolean(
        err?.code === '42501' ||
        err?.code === 'forbidden' ||
        err?.message?.toLowerCase().includes('row-level security') ||
        err?.message?.toLowerCase().includes('permission denied')
      );
      const isServerReturned = Boolean(err?.code || isRosterLocked || isRls);

      if (isRosterLocked && item.table === 'events' && item.operation === 'UPDATE' && item.payload) {
        const fullPayload = { ...(item.payload || {}) };
        const rosterPayload: Record<string, any> = {};
        const nonRosterPayload: Record<string, any> = {};

        for (const [k, v] of Object.entries(fullPayload)) {
          if (k === 'assigned_participants' || k === 'assigned_judges' || k === 'participant_sl_numbers') {
            rosterPayload[k] = v;
          } else {
            nonRosterPayload[k] = v;
          }
        }

        if (Object.keys(nonRosterPayload).length > 0) {
          const splitId = generateOutboxUUID();
          const newNonRosterItem: PendingMutationRecord = {
            id: splitId,
            clientUuid: splitId,
            table: item.table,
            operation: 'UPDATE',
            entityId: item.entityId,
            payload: nonRosterPayload,
            queuedAt: new Date().toISOString(),
            syncStatus: 'pending',
            retryCount: 0,
          };
          await db.put('outbox', mutationToOutbox(newNonRosterItem));
        }

        item.payload = rosterPayload;
        item.syncStatus = 'failed';
        item.lastError = 'ROSTER_LOCKED: Roster modifications rejected because event is locked.';
        await db.put('outbox', mutationToOutbox(item));
        failedCount++;
        continue;
      }

      if (!isServerReturned) {
        failedCount++;
        continue;
      }

      item.retryCount = (item.retryCount || 0) + 1;
      item.lastError = err?.message || 'Server rejected mutation';

      const isRosterLockedDelete =
        isRosterLocked && (item.table === 'participants' || item.table === 'judges') && item.operation === 'DELETE';

      if (item.retryCount >= 3 || isRls || isRosterLockedDelete) {
        item.syncStatus = 'failed';
        blackBox.recordError(
          'console_error',
          `Offline ${item.table}:${item.operation} failed: ${item.lastError}`,
          'offlineQueue.mutations'
        );
      }

      await db.put('outbox', mutationToOutbox(item));
      failedCount++;
    }
  }

  notifyQueueChange();
  return { syncedCount, failedCount, authRequired };
}

// ==========================================
// 2. SCORES IN UNIFIED OUTBOX (Ballots)
// ==========================================

export async function queueScoreLocally(score: any): Promise<string> {
  const db = await getOfflineDB();
  const id = isValidOutboxUUID(score.id) ? score.id : generateOutboxUUID();

  // Idempotency (Double-Submission Prevention)
  const existing = await db.get('outbox', id);
  if (existing && existing.kind === 'score') {
    return id;
  }

  const eventId = score.event_id || score.eventId || '';
  const judgeId = score.judge_id || score.judgeId || '';
  const participantId = score.participant_id || score.participantId || '';
  const scoreData = score.score_data || score.scoreData || score.score_payload?.criteria || {};
  const totalScore = Number(score.total_score !== undefined ? score.total_score : score.totalScore) || 0;
  const submittedAt = score.score_payload?.submitted_at || new Date().toISOString();

  const scoreRec: PendingScoreRecord = {
    id,
    clientUuid: id,
    event_id: eventId,
    judge_id: judgeId,
    participant_id: participantId,
    score_data: scoreData,
    total_score: totalScore,
    score_payload: {
      ...(score.score_payload || {
        criteria: scoreData,
        total_score: totalScore,
        submitted_at: submittedAt,
      }),
      client_uuid: score.score_payload?.client_uuid || id,
    },
    queuedAt: new Date().toISOString(),
    syncStatus: 'pending',
    retryCount: 0,
  };

  await db.put('outbox', scoreToOutbox(scoreRec));
  notifyQueueChange();
  requestBackgroundSync();

  getPendingCount()
    .then((count) => {
      eventBus.emit('sync_status', {
        status: 'offline',
        pendingCount: count,
        message: `${count} item${count > 1 ? 's' : ''} queued locally`,
      });
    })
    .catch(() => {});

  if (typeof navigator === 'undefined' || navigator.onLine !== false) {
    flushOfflineQueueToSupabase().catch(() => {});
  }

  return id;
}

export async function getPendingScores(): Promise<PendingScoreRecord[]> {
  try {
    const db = await getOfflineDB();
    const rows = await db.getAllFromIndex('outbox', 'by-kind', 'score');
    return rows.map(outboxToScore);
  } catch (err) {
    console.warn('Error fetching pending offline scores:', err);
    return [];
  }
}

export async function removePendingScore(scoreId: string): Promise<void> {
  try {
    const db = await getOfflineDB();
    await db.delete('outbox', scoreId);
    notifyQueueChange();
  } catch (err) {
    console.warn('Error removing score from offline queue:', err);
  }
}

// Total pending items count (mutations + scores, excluding failed items & drafts)
export async function getPendingCount(): Promise<number> {
  try {
    const db = await getOfflineDB();
    const [scores, muts] = await Promise.all([
      db.getAllFromIndex('outbox', 'by-kind', 'score'),
      db.getAllFromIndex('outbox', 'by-kind', 'mutation'),
    ]);
    const pendingScores = scores.filter((s) => s.syncStatus !== 'failed').length;
    const pendingMutations = muts.filter((m) => m.syncStatus !== 'failed').length;
    return pendingScores + pendingMutations;
  } catch {
    return 0;
  }
}

export async function getFailedMutations(): Promise<PendingMutationRecord[]> {
  try {
    const muts = await getPendingMutations();
    return muts.filter((m) => m.syncStatus === 'failed');
  } catch {
    return [];
  }
}

export async function getFailedScores(): Promise<PendingScoreRecord[]> {
  try {
    const scores = await getPendingScores();
    return scores.filter((s) => s.syncStatus === 'failed');
  } catch {
    return [];
  }
}

export async function retryFailedScore(id: string): Promise<void> {
  try {
    const db = await getOfflineDB();
    const item = await db.get('outbox', id);
    if (item && item.kind === 'score') {
      item.syncStatus = 'pending';
      item.retryCount = 0;
      delete item.lastError;
      await db.put('outbox', item);
      notifyQueueChange();
      requestBackgroundSync().catch(() => {});
      flushOfflineQueueToSupabase().catch(() => {});
    }
  } catch (err) {
    console.warn('Error retrying failed score:', err);
  }
}

export async function discardFailedScore(id: string): Promise<void> {
  await removePendingScore(id);
}

export async function retryFailedMutation(id: string): Promise<void> {
  try {
    const db = await getOfflineDB();
    const item = await db.get('outbox', id);
    if (item && item.kind === 'mutation') {
      item.syncStatus = 'pending';
      item.retryCount = 0;
      delete item.lastError;
      await db.put('outbox', item);
      notifyQueueChange();
      requestBackgroundSync().catch(() => {});
      flushOfflineQueueToSupabase().catch(() => {});
    }
  } catch (err) {
    console.warn('Error retrying failed mutation:', err);
  }
}

export async function discardFailedMutation(id: string): Promise<void> {
  await removePendingMutation(id);
}

async function handleScoreSyncError(
  db: IDBPDatabase<FairJudgeOfflineDB>,
  item: PendingScoreRecord,
  err: any
): Promise<{ authRequired?: boolean; rpcUnavailable?: boolean; newlyFailed?: boolean }> {
  if (err?.code === 'unauthorized') {
    return { authRequired: true };
  }
  if (err?.code === 'rpc_unavailable') {
    return { rpcUnavailable: true };
  }
  const orgBlock = parseOrgEnforcementError(err);
  if (orgBlock) {
    eventBus.emit('org_enforcement', { code: orgBlock });
    item.lastError = `ORG_NOT_ALLOWED: ${orgBlock}`;
    let newlyFailed = false;
    if (orgBlock === 'SUSPENDED' || orgBlock === 'DELETED') {
      item.syncStatus = 'failed';
      newlyFailed = true;
      blackBox.recordError(
        'console_error',
        `Offline ballot sync blocked (${orgBlock})`,
        'offlineQueue.scores'
      );
    }
    await db.put('outbox', scoreToOutbox(item)).catch(() => {});
    return { newlyFailed };
  }

  const errMsg = String(err?.message || err || 'Server rejected ballot');
  const lowerMsg = errMsg.toLowerCase();
  const isPermanentReject = Boolean(
    err?.code === '42501' ||
      err?.code === 'forbidden' ||
      err?.code === 'not_found' ||
      err?.code === 'ROSTER_LOCKED' ||
      err?.code === 'RLS Permission Denied' ||
      err?.code === '23505' ||
      err?.code === '23503' ||
      err?.code === '23502' ||
      err?.code === '22P02' ||
      errMsg.includes('RLS Permission Denied') ||
      lowerMsg.includes('permission denied') ||
      lowerMsg.includes('row-level security') ||
      lowerMsg.includes('not assigned') ||
      lowerMsg.includes('event has ended') ||
      lowerMsg.includes('event is paused') ||
      lowerMsg.includes('ballot submission rejected')
  );
  const isServerReturned = Boolean(err?.code || isPermanentReject);

  if (!isServerReturned) {
    return {};
  }

  item.retryCount = (item.retryCount || 0) + 1;
  item.lastError = errMsg;
  let newlyFailed = false;
  if (isPermanentReject || item.retryCount >= 3) {
    item.syncStatus = 'failed';
    newlyFailed = true;
    blackBox.recordError(
      'console_error',
      `Offline ballot rejected: ${errMsg}`,
      'offlineQueue.scores'
    );
  }
  await db.put('outbox', scoreToOutbox(item)).catch(() => {});
  return { newlyFailed };
}

// Sync all pending scores and mutations from unified outbox to Supabase
export function flushOfflineQueueToSupabase(): Promise<OfflineFlushResult> {
  if (activeQueueFlush) {
    pendingQueueFlushRequested = true;
    return activeQueueFlush;
  }

  activeQueueFlush = (async () => {
    let aggregateSynced = 0;
    let lastResult: OfflineFlushResult = { syncedCount: 0, failedCount: 0 };

    do {
      pendingQueueFlushRequested = false;
      lastResult = await runFlushOfflineQueueOnce();
      aggregateSynced += lastResult.syncedCount;
      if (lastResult.authRequired) {
        pendingQueueFlushRequested = false;
        break;
      }
    } while (pendingQueueFlushRequested);

    return {
      syncedCount: aggregateSynced,
      failedCount: lastResult.failedCount,
      authRequired: lastResult.authRequired,
    };
  })().finally(() => {
    activeQueueFlush = null;
  });

  return activeQueueFlush;
}

async function runFlushOfflineQueueOnce(): Promise<OfflineFlushResult> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { syncedCount: 0, failedCount: 0 };
  }

  // 1. Flush offline structural mutations first (events, participants, judges)
  const mutationResult = await flushOfflineMutationsToSupabase();
  let authRequired = Boolean(mutationResult.authRequired);

  // 2. Flush pending scores (ballots) with OCC deduplication, legacy server pre-check, and batched upsert
  const dbForScores = await getOfflineDB();
  const rawScores = (await getPendingScores()).filter((s) => s.syncStatus !== 'failed');
  let scoreSynced = 0;
  let scoreFailed = 0;

  if (!authRequired && isSupabaseConfigured() && rawScores.length > 0) {
    // Normalize any pre-existing non-UUID score entries
    for (let i = 0; i < rawScores.length; i++) {
      const s = rawScores[i];
      if (!isValidOutboxUUID(s.id)) {
        const oldId = s.id;
        const freshId = isValidOutboxUUID(s.clientUuid) ? s.clientUuid : generateOutboxUUID();
        const upgraded: PendingScoreRecord = {
          ...s,
          id: freshId,
          clientUuid: freshId,
          legacyMigrated: true,
          legacyId: s.legacyId || oldId,
          score_payload: {
            ...s.score_payload,
            client_uuid: freshId,
          },
        };
        await dbForScores.put('outbox', scoreToOutbox(upgraded));
        await dbForScores.delete('outbox', oldId);
        rawScores[i] = upgraded;
      }
    }

    const dedupedScoreMap = new Map<string, PendingScoreRecord>();
    const obsoleteScoreIds: string[] = [];

    rawScores.sort((a, b) => new Date(a.queuedAt).getTime() - new Date(b.queuedAt).getTime());

    for (const item of rawScores) {
      const entityKey = `${item.event_id}___${item.participant_id}___${item.judge_id}`;
      if (dedupedScoreMap.has(entityKey)) {
        const prev = dedupedScoreMap.get(entityKey)!;
        obsoleteScoreIds.push(prev.id);
      }
      dedupedScoreMap.set(entityKey, item);
    }

    if (obsoleteScoreIds.length > 0) {
      await Promise.all(obsoleteScoreIds.map((id) => removePendingScore(id)));
    }

    // Outcome #3: Check any legacy migrated score against server before resending so nothing applies twice
    const scoresToSend: PendingScoreRecord[] = [];
    for (const item of dedupedScoreMap.values()) {
      if (item.legacyMigrated) {
        try {
          const checkRes = await callSecuredReadRpc<any>('read_score_for_ballot', {
            p_event_id: item.event_id,
            p_judge_id: item.judge_id,
            p_participant_id: item.participant_id,
          });
          if (checkRes.data) {
            await removePendingScore(item.id);
            continue;
          }
        } catch (checkErr: any) {
          if (checkErr?.code === 'unauthorized') {
            authRequired = true;
            break;
          }
          if (checkErr?.code === 'rpc_unavailable') {
            break;
          }
          // Network/transient read failure: stop score flush cleanly without double-sending
          scoresToSend.length = 0;
          break;
        }
      }
      scoresToSend.push(item);
    }

    if (!authRequired && scoresToSend.length > 0) {
      const dedupedScores = scoresToSend;

      const batchedPayload = dedupedScores.map((item) => {
        const clientUuid = isValidOutboxUUID(item.clientUuid) ? item.clientUuid : item.id;
        return {
          id: clientUuid,
          event_id: item.event_id,
          judge_id: item.judge_id,
          participant_id: item.participant_id,
          total_score: item.total_score,
          score_payload: {
            criteria: item.score_data || item.score_payload?.criteria || {},
            total_score: item.total_score,
            submitted_at: item.score_payload?.submitted_at || item.queuedAt || new Date().toISOString(),
            client_uuid: item.score_payload?.client_uuid || clientUuid,
          },
        };
      });

      try {
        await callSecuredWriteRpc('score_upsert_batch', { p_records: batchedPayload });
        await Promise.all(dedupedScores.map((item) => removePendingScore(item.id)));
        scoreSynced += dedupedScores.length;
      } catch (batchErr: any) {
        const db = await getOfflineDB();

        if (dedupedScores.length === 1) {
          const res = await handleScoreSyncError(db, dedupedScores[0], batchErr);
          if (res.authRequired) {
            authRequired = true;
          } else if (!res.rpcUnavailable) {
            scoreFailed++;
            if (res.newlyFailed) {
              eventBus.emit('toast', {
                type: 'error',
                title: 'Ballot Sync Rejected',
                message: '1 offline ballot was rejected by the server and kept for review.',
              });
            }
          }
        } else if (batchErr?.code === 'unauthorized') {
          authRequired = true;
        } else if (batchErr?.code === 'rpc_unavailable') {
          // Keep all scores safely pending in outbox
        } else {
          console.warn('Batched score upsert encountered error, falling back to granular safe sync:', batchErr?.message || batchErr);

          let newlyFailedScores = 0;
          for (const item of dedupedScores) {
            try {
              const clientUuid = isValidOutboxUUID(item.clientUuid) ? item.clientUuid : item.id;
              const payloadJson = {
                criteria: item.score_data || item.score_payload?.criteria || {},
                total_score: item.total_score,
                submitted_at: item.score_payload?.submitted_at || item.queuedAt || new Date().toISOString(),
                client_uuid: item.score_payload?.client_uuid || clientUuid,
              };

              const singleRecord = {
                id: clientUuid,
                event_id: item.event_id,
                judge_id: item.judge_id,
                participant_id: item.participant_id,
                total_score: item.total_score,
                score_payload: payloadJson,
              };

              await callSecuredWriteRpc('score_upsert_batch', { p_records: [singleRecord] });
              await removePendingScore(item.id);
              scoreSynced++;
            } catch (err: any) {
              const res = await handleScoreSyncError(db, item, err);
              if (res.authRequired) {
                authRequired = true;
                break;
              }
              if (res.rpcUnavailable) {
                break;
              }
              if (res.newlyFailed) {
                newlyFailedScores++;
              }
              scoreFailed++;
            }
          }
          if (newlyFailedScores > 0) {
            eventBus.emit('toast', {
              type: 'error',
              title: 'Ballot Sync Rejected',
              message: `${newlyFailedScores} offline ballot${newlyFailedScores > 1 ? 's were' : ' was'} rejected by the server and kept for review.`,
            });
          }
        }
      }
    }
  }

  notifyQueueChange();
  const totalSynced = mutationResult.syncedCount + scoreSynced;
  const remainingCount = await getPendingCount();

  if (totalSynced > 0) {
    await invalidateCache(scoreSynced > 0 && mutationResult.syncedCount === 0 ? 'fairjudge_supabase_scores' : undefined);
    eventBus.emit('toast', {
      type: 'success',
      title: 'Synced to Cloud',
      message: `Synchronized ${totalSynced} offline change${totalSynced > 1 ? 's' : ''}.`,
    });
    eventBus.emit('cache_updated', { table: DB_TABLES.ALL });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('fairjudge_db_change', {
          detail: {
            table: scoreSynced > 0 && mutationResult.syncedCount === 0 ? DB_TABLES.SCORES : DB_TABLES.ALL,
          },
        })
      );
    }
  }

  eventBus.emit('sync_status', {
    status: remainingCount > 0 ? 'offline' : 'synced',
    pendingCount: remainingCount,
    message: authRequired
      ? 'Verification required to sync'
      : remainingCount > 0
      ? `${remainingCount} queued`
      : 'Cloud Synced',
  });

  return {
    syncedCount: totalSynced,
    failedCount: mutationResult.failedCount + scoreFailed,
    authRequired,
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

  // Migrate any legacy localStorage drafts & prime synchronous draft mirror
  void hydrateDraftMirror();

  const onlineHandler = () => {
    console.log('[Fair Judge] Device came online. Flushing unified outbox to Supabase...');
    flushOfflineQueueToSupabase()
      .then(({ syncedCount }) => {
        if (syncedCount > 0) {
          console.log(`[Fair Judge] Successfully synchronized ${syncedCount} outbox items.`);
        }
      })
      .catch((err) => {
        console.warn('[Fair Judge] Auto-sync on online failed:', err);
      });
  };

  const swMessageHandler = (event: MessageEvent) => {
    if (event.data && event.data.type === 'TRIGGER_BACKGROUND_SYNC') {
      console.log('[Fair Judge] BackgroundSync triggered from Service Worker.');
      flushOfflineQueueToSupabase().catch((err) => {
        console.warn('[Fair Judge] SW background sync failed:', err);
      });
    }
  };

  const visibilityHandler = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        flushOfflineQueueToSupabase().catch(() => {});
      }
    }
  };

  window.addEventListener('online', onlineHandler);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', visibilityHandler);
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', swMessageHandler);
  }

  if (typeof navigator !== 'undefined' && navigator.onLine) {
    flushOfflineQueueToSupabase().catch(() => {});
  }

  return () => {
    window.removeEventListener('online', onlineHandler);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityHandler);
    }
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
  const [scores, mutations, drafts] = await Promise.all([
    getPendingScores().catch(() => []),
    getPendingMutations().catch(() => []),
    getPendingDrafts().catch(() => []),
  ]);

  const redactedScores = scores.map((s) => ({
    ...s,
    score_data: '[REDACTED]',
    score_payload: '[REDACTED]',
  }));

  const redactedMutations = mutations.map((m) => ({
    ...m,
    payload: m.payload ? '[REDACTED]' : null,
  }));

  let storagePersisted: boolean | null = null;
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persisted) {
      storagePersisted = await navigator.storage.persisted();
    }
  } catch {}

  const failedScores = scores.filter((s) => s.syncStatus === 'failed').length;
  const failedMutations = mutations.filter((m) => m.syncStatus === 'failed').length;

  return {
    app: 'Fair Judge',
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
    storagePersisted,
    queueSummary: {
      outboxUnified: true,
      totalPendingScores: scores.filter((s) => s.syncStatus !== 'failed').length,
      totalPendingMutations: mutations.filter((m) => m.syncStatus !== 'failed').length,
      totalPendingDrafts: drafts.length,
      totalFailedScores: failedScores,
      totalFailedMutations: failedMutations,
      isQueueHealthy: scores.length === 0 && mutations.length === 0,
    },
    pendingScores: redactedScores,
    pendingMutations: redactedMutations,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  };
}

export async function downloadDiagnosticLog(): Promise<string> {
  const data = await exportDiagnosticLog();
  const filename = `fairjudge-queue-log_v${APP_VERSION}_${stampLocal()}.json`;
  return downloadJson(filename, data);
}
