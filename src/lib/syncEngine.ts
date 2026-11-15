import {
  supabase,
  isSupabaseConfigured,
  getStoredSession,
  STORAGE_KEYS,
  notifyDatabaseChange,
  normalizeOrg,
  normalizeEvent,
  normalizeJudge,
  normalizeScore,
  StoredUserSession,
} from './supabase';
import {
  getCacheDB,
  getHotCache,
  setIndexedDBCache,
  touchCacheTimestamp,
  invalidateCache,
} from './db/indexedDB';
import { eventBus, areRecordsEqual, areOrganizationsEqual } from './eventBus';
import { DB_TABLES, DbTableName } from './dbTables';
import type {
  Organization,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
} from './supabaseTypes';

export type SyncCadenceMode = 'fast' | 'normal';

export const FAST_SYNC_INTERVAL_MS = 15_000;
export const NORMAL_SYNC_INTERVAL_MS = 60_000;
export const LOW_BATTERY_MULTIPLIER = 2;
const LOW_BATTERY_THRESHOLD = 0.2;
const SYNC_RPC_TIMEOUT_MS = 10_000;

export interface SyncDeletionEntry {
  id?: number;
  table_name: string;
  record_id: string;
  version: number;
  deleted_at?: string;
}

export interface ReadOrgChangesResponse {
  ok: boolean;
  error?: string;
  message?: string;
  org_id?: string;
  version?: number;
  since?: number;
  unchanged?: boolean;
  full_resync?: boolean;
  organization?: any | null;
  events?: any[];
  judges?: any[];
  participants?: any[];
  scores?: any[];
  deletions?: SyncDeletionEntry[];
}

export interface SyncNowOptions {
  forceFull?: boolean;
  reason?: 'cadence' | 'visibility' | 'online' | 'manual' | 'mount' | 'write';
}

export interface SyncResult {
  ok: boolean;
  skipped?: boolean;
  unchanged?: boolean;
  version?: number;
  changedTables: DbTableName[];
  error?: string;
}

interface BatteryManagerLike {
  charging: boolean;
  level: number;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

// ==========================================
// INTERNAL MODULE STATE
// ==========================================

const cadenceCounts: Record<SyncCadenceMode, number> = {
  fast: 0,
  normal: 0,
};

const cursorMemory = new Map<string, number>();

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activeCadence: SyncCadenceMode | null = null;
let activeEffectiveIntervalMs = 0;
let listenersBound = false;
let batteryBound = false;
let batteryRef: BatteryManagerLike | null = null;
let isLowBattery = false;

let inflightSync: Promise<SyncResult> | null = null;
let pendingForceSync = false;
let lastSyncAttemptAt = 0;
let lastSessionKey: string | null = null;
let rpcUnavailableLogged = false;

function getSessionKey(session: StoredUserSession | null): string | null {
  if (!session?.org?.org_id || !session?.sessionToken) return null;
  const cleanOrg = session.org.org_id.trim().toUpperCase();
  const role = session.role === 'judge' ? 'judge' : 'organiser';
  const judgeId = role === 'judge' ? session.judge?.id || 'unknown' : 'org';
  return `${cleanOrg}_${role}_${judgeId}`;
}

function getCursorStorageKey(session: StoredUserSession): string {
  const cleanOrg = session.org.org_id.trim().toUpperCase();
  const role = session.role === 'judge' ? 'judge' : 'organiser';
  const judgeId = role === 'judge' ? session.judge?.id || 'unknown' : 'org';
  return `fairjudge_sync_cursor_${cleanOrg}_${role}_${judgeId}`;
}

function isDocumentVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible';
}

function isNavigatorOnline(): boolean {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

function getTargetCadence(): SyncCadenceMode | null {
  if (cadenceCounts.fast > 0) return 'fast';
  if (cadenceCounts.normal > 0) return 'normal';
  return null;
}

function computeIntervalMs(mode: SyncCadenceMode): number {
  const base = mode === 'fast' ? FAST_SYNC_INTERVAL_MS : NORMAL_SYNC_INTERVAL_MS;
  return isLowBattery ? base * LOW_BATTERY_MULTIPLIER : base;
}

async function readStoredCursor(cursorKey: string): Promise<number> {
  if (cursorMemory.has(cursorKey)) {
    return cursorMemory.get(cursorKey)!;
  }
  try {
    const db = await getCacheDB();
    const entry = await db.get('cache_store', cursorKey);
    const ver = Number(entry?.data?.version ?? 0);
    if (Number.isFinite(ver) && ver > 0) {
      cursorMemory.set(cursorKey, ver);
      return ver;
    }
  } catch {
    // Non-fatal: fallback to 0 (server responds with full_resync snapshot)
  }
  return 0;
}

async function writeStoredCursor(cursorKey: string, version: number): Promise<void> {
  const cleanVer = Math.max(0, Math.floor(Number(version) || 0));
  cursorMemory.set(cursorKey, cleanVer);
  try {
    const db = await getCacheDB();
    await db.put('cache_store', {
      key: cursorKey,
      data: { version: cleanVer, updatedAt: Date.now() },
      timestamp: Date.now(),
    });
  } catch {
    // Keep cursor in memory for current session even if IDB put fails
  }
}

export async function clearSyncCursorForSession(session: StoredUserSession | null): Promise<void> {
  if (!session?.org?.org_id) return;
  const cursorKey = getCursorStorageKey(session);
  cursorMemory.delete(cursorKey);
  try {
    const db = await getCacheDB();
    await db.delete('cache_store', cursorKey);
  } catch {}
}

// ==========================================
// BATTERY AWARENESS
// ==========================================

function updateBatteryFlag(): void {
  const nextLow = Boolean(
    batteryRef && batteryRef.charging === false && Number(batteryRef.level) < LOW_BATTERY_THRESHOLD
  );
  if (nextLow !== isLowBattery) {
    isLowBattery = nextLow;
    refreshSchedule();
  }
}

function ensureBatteryMonitor(): void {
  if (batteryBound || typeof navigator === 'undefined') return;
  const navAny = navigator as any;
  if (typeof navAny.getBattery !== 'function') return;
  batteryBound = true;
  Promise.resolve(navAny.getBattery())
    .then((bat: BatteryManagerLike) => {
      if (!bat) return;
      batteryRef = bat;
      updateBatteryFlag();
      bat.addEventListener?.('levelchange', updateBatteryFlag);
      bat.addEventListener?.('chargingchange', updateBatteryFlag);
    })
    .catch(() => {});
}

// ==========================================
// DELTA MERGE ENGINE
// ==========================================

function upsertById<T extends { id: string }>(
  existing: T[],
  incoming: T[],
  prependNew: boolean = false
): T[] {
  if (incoming.length === 0) return existing;
  const map = new Map<string, T>();
  for (const item of existing) {
    map.set(item.id, item);
  }
  for (const item of incoming) {
    map.set(item.id, item);
  }
  if (!prependNew) {
    const ordered: T[] = [];
    const seen = new Set<string>();
    for (const item of existing) {
      ordered.push(map.get(item.id)!);
      seen.add(item.id);
    }
    for (const item of incoming) {
      if (!seen.has(item.id)) {
        ordered.push(map.get(item.id)!);
        seen.add(item.id);
      }
    }
    return ordered;
  }
  const existingIds = new Set(existing.map((e) => e.id));
  const brandNew = incoming.filter((i) => !existingIds.has(i.id));
  const updatedExisting = existing.map((e) => map.get(e.id)!);
  return [...brandNew, ...updatedExisting];
}

function touchAllOrgCacheKeys(orgId: string, eventIds: string[], role: 'organiser' | 'judge'): void {
  const cleanOrgId = orgId.trim().toUpperCase();
  touchCacheTimestamp(`${STORAGE_KEYS.ORGS}_${cleanOrgId}`);
  touchCacheTimestamp(`${STORAGE_KEYS.EVENTS}_${cleanOrgId}`);
  touchCacheTimestamp(`${STORAGE_KEYS.JUDGES}_${cleanOrgId}`);
  touchCacheTimestamp(`${STORAGE_KEYS.PARTICIPANTS}_${cleanOrgId}`);
  if (role === 'organiser') {
    touchCacheTimestamp(`${STORAGE_KEYS.SCORES}_ORG_${cleanOrgId}`);
  }
  for (const eventId of eventIds) {
    touchCacheTimestamp(`${STORAGE_KEYS.SCORES}_${eventId}`);
  }
}

async function applyOrgChangesPayload(
  session: StoredUserSession,
  res: ReadOrgChangesResponse
): Promise<DbTableName[]> {
  const cleanOrgId = session.org.org_id.trim().toUpperCase();
  const isOrganiser = session.role === 'organiser';
  const fullResync = Boolean(res.full_resync);
  const deletions = Array.isArray(res.deletions) ? res.deletions : [];

  const changedTables = new Set<DbTableName>();
  let rosterCredentialsNeedRefresh = false;

  // Group deletions by canonical table
  const deletedEventIds = new Set<string>();
  const deletedJudgeIds = new Set<string>();
  const deletedParticipantIds = new Set<string>();
  const deletedScoreIds = new Set<string>();

  for (const del of deletions) {
    const tbl = String(del.table_name || '').toLowerCase();
    const recId = String(del.record_id || '');
    if (!recId) continue;
    if (tbl === 'events') deletedEventIds.add(recId);
    else if (tbl === 'judges') deletedJudgeIds.add(recId);
    else if (tbl === 'participants') deletedParticipantIds.add(recId);
    else if (tbl === 'scores') deletedScoreIds.add(recId);
  }

  // 1. ORGANIZATION
  if (res.organization) {
    const rawOrg = { ...res.organization };
    delete rawOrg.password;
    if (!isOrganiser) {
      delete rawOrg.email;
    }
    const nextOrg = normalizeOrg(rawOrg);
    const allOrgs = getHotCache<Organization[]>(STORAGE_KEYS.ORGS, []);
    const prevOrg = allOrgs.find((o) => (o.org_id || '').trim().toUpperCase() === cleanOrgId);
    const otherOrgs = allOrgs.filter((o) => (o.org_id || '').trim().toUpperCase() !== cleanOrgId);

    if (!prevOrg || !areOrganizationsEqual(prevOrg, nextOrg)) {
      await setIndexedDBCache(STORAGE_KEYS.ORGS, [nextOrg, ...otherOrgs], true);
      changedTables.add(DB_TABLES.ORGANIZATIONS);
    }

    if (nextOrg.deleted_at) {
      eventBus.emit('org_enforcement', { code: 'DELETED' });
    } else if (nextOrg.suspended) {
      eventBus.emit('org_enforcement', { code: 'SUSPENDED', reason: nextOrg.suspended_reason || undefined });
    }
  }

  // 2. EVENTS
  const allCachedEvents = getHotCache<SupabaseEvent[]>(STORAGE_KEYS.EVENTS, []);
  const prevOrgEventsRaw = allCachedEvents.filter(
    (e) => (e.org_id || '').trim().toUpperCase() === cleanOrgId
  );
  const prevOrgEvents = prevOrgEventsRaw.map(normalizeEvent);
  const otherOrgEvents = allCachedEvents.filter(
    (e) => (e.org_id || '').trim().toUpperCase() !== cleanOrgId
  );

  const incomingEvents = (Array.isArray(res.events) ? res.events : []).map(normalizeEvent);
  let nextOrgEvents = prevOrgEvents;

  if (fullResync) {
    nextOrgEvents = incomingEvents;
  } else if (incomingEvents.length > 0 || deletedEventIds.size > 0) {
    const surviving = prevOrgEvents.filter((e) => !deletedEventIds.has(e.id));
    nextOrgEvents = upsertById(surviving, incomingEvents, true);
  }

  if (fullResync || incomingEvents.length > 0 || deletedEventIds.size > 0) {
    if (!areRecordsEqual(prevOrgEvents, nextOrgEvents)) {
      await setIndexedDBCache(STORAGE_KEYS.EVENTS, [...nextOrgEvents, ...otherOrgEvents], true);
      changedTables.add(DB_TABLES.EVENTS);
    }
  }

  const orgEventIds = new Set<string>([
    ...prevOrgEvents.map((e) => e.id),
    ...nextOrgEvents.map((e) => e.id),
  ]);
  for (const id of deletedEventIds) {
    orgEventIds.add(id);
  }

  // 3. JUDGES (Strict PII enforcement: zero pin / current_session_token for judge devices)
  const allCachedJudges = getHotCache<SupabaseJudge[]>(STORAGE_KEYS.JUDGES, []);
  const prevOrgJudgesRaw = allCachedJudges.filter(
    (j) => (j.org_id || '').trim().toUpperCase() === cleanOrgId
  );
  const prevOrgJudges = prevOrgJudgesRaw.map(normalizeJudge);
  const otherOrgJudges = allCachedJudges.filter(
    (j) => (j.org_id || '').trim().toUpperCase() !== cleanOrgId
  );
  const prevPinById = new Map(prevOrgJudgesRaw.map((j) => [j.id, j.pin || j.judge_pin || '']));

  const incomingJudges = (Array.isArray(res.judges) ? res.judges : []).map((row) => {
    const norm = normalizeJudge(row);
    if (!isOrganiser) {
      return { ...norm, pin: '', judge_pin: '', current_session_token: null };
    }
    if (!norm.pin) {
      const existingPin = prevPinById.get(norm.id);
      if (existingPin) {
        return { ...norm, pin: existingPin, judge_pin: existingPin };
      }
    }
    return norm;
  });

  if (isOrganiser && incomingJudges.length > 0) {
    rosterCredentialsNeedRefresh = true;
  }

  let nextOrgJudges = prevOrgJudges;
  if (fullResync) {
    nextOrgJudges = incomingJudges;
  } else if (incomingJudges.length > 0 || deletedJudgeIds.size > 0) {
    const surviving = prevOrgJudges.filter((j) => !deletedJudgeIds.has(j.id));
    nextOrgJudges = upsertById(surviving, incomingJudges, true);
  }

  if (fullResync || incomingJudges.length > 0 || deletedJudgeIds.size > 0) {
    if (!areRecordsEqual(prevOrgJudges, nextOrgJudges)) {
      await setIndexedDBCache(STORAGE_KEYS.JUDGES, [...otherOrgJudges, ...nextOrgJudges], true);
      changedTables.add(DB_TABLES.JUDGES);
    }
  }

  // 4. PARTICIPANTS (Zero mobile_number for judges; full replace on blind mode switch)
  const allCachedParticipants = getHotCache<SupabaseParticipant[]>(STORAGE_KEYS.PARTICIPANTS, []);
  const prevOrgParticipants = allCachedParticipants.filter(
    (p) => (p.org_id || '').trim().toUpperCase() === cleanOrgId
  );
  const otherOrgParticipants = allCachedParticipants.filter(
    (p) => (p.org_id || '').trim().toUpperCase() !== cleanOrgId
  );
  const prevMobileById = new Map(prevOrgParticipants.map((p) => [p.id, p.mobile_number]));

  const incomingParticipants = (Array.isArray(res.participants) ? res.participants : []).map(
    (row: any): SupabaseParticipant => {
      if (!isOrganiser) {
        const { mobile_number: _stripMobile, ...safeRow } = row || {};
        return safeRow as SupabaseParticipant;
      }
      if (!row?.mobile_number) {
        const cachedMobile = prevMobileById.get(row.id);
        if (cachedMobile) {
          return { ...row, mobile_number: cachedMobile } as SupabaseParticipant;
        }
      }
      return row as SupabaseParticipant;
    }
  );

  if (isOrganiser && incomingParticipants.length > 0) {
    rosterCredentialsNeedRefresh = true;
  }

  let nextOrgParticipants = prevOrgParticipants;
  if (fullResync) {
    nextOrgParticipants = incomingParticipants;
  } else if (incomingParticipants.length > 0 || deletedParticipantIds.size > 0) {
    const surviving = prevOrgParticipants.filter((p) => !deletedParticipantIds.has(p.id));
    nextOrgParticipants = upsertById(surviving, incomingParticipants, false);
  }

  if (fullResync || incomingParticipants.length > 0 || deletedParticipantIds.size > 0) {
    if (!areRecordsEqual(prevOrgParticipants, nextOrgParticipants)) {
      await setIndexedDBCache(
        STORAGE_KEYS.PARTICIPANTS,
        [...nextOrgParticipants, ...otherOrgParticipants],
        true
      );
      changedTables.add(DB_TABLES.PARTICIPANTS);
    }
  }

  // 5. SCORES (Supports full_resync, upserts, composite-key replacements, and deletion cascades)
  const allCachedScores = getHotCache<SupabaseScore[]>(STORAGE_KEYS.SCORES, []);
  const belongsToOrg = (s: SupabaseScore & { org_id?: string }) =>
    (s.org_id && s.org_id.trim().toUpperCase() === cleanOrgId) || orgEventIds.has(s.event_id);

  const prevOrgScores = allCachedScores.filter(belongsToOrg).map(normalizeScore);
  const otherOrgScores = allCachedScores.filter((s) => !belongsToOrg(s));

  const incomingScores = (Array.isArray(res.scores) ? res.scores : []).map(normalizeScore);
  let nextOrgScores = prevOrgScores;

  if (fullResync) {
    nextOrgScores = incomingScores;
  } else if (incomingScores.length > 0 || deletedScoreIds.size > 0 || deletedEventIds.size > 0) {
    const incomingComposite = new Set(
      incomingScores.map((s) => `${s.event_id}:${s.judge_id}:${s.participant_id}`)
    );
    const incomingIds = new Set(incomingScores.map((s) => s.id));
    const surviving = prevOrgScores.filter((s) => {
      if (deletedScoreIds.has(s.id) || deletedEventIds.has(s.event_id)) return false;
      const comp = `${s.event_id}:${s.judge_id}:${s.participant_id}`;
      if (!incomingIds.has(s.id) && incomingComposite.has(comp)) return false;
      return true;
    });
    nextOrgScores = upsertById(surviving, incomingScores, false);
  }

  if (
    fullResync ||
    incomingScores.length > 0 ||
    deletedScoreIds.size > 0 ||
    deletedEventIds.size > 0
  ) {
    if (!areRecordsEqual(prevOrgScores, nextOrgScores)) {
      await setIndexedDBCache(STORAGE_KEYS.SCORES, [...otherOrgScores, ...nextOrgScores], true);
      changedTables.add(DB_TABLES.SCORES);
    }
  }

  // Touch SWR timestamps AFTER cache mutation so mounted screen reads hit fresh cache (0 extra RPCs)
  touchAllOrgCacheKeys(
    cleanOrgId,
    nextOrgEvents.map((e) => e.id),
    isOrganiser ? 'organiser' : 'judge'
  );
  for (const deletedEvtId of deletedEventIds) {
    touchCacheTimestamp(`${STORAGE_KEYS.SCORES}_${deletedEvtId}`);
  }

  // If organiser roster received new/edited judges or participants via delta, invalidate roster PII cache
  if (rosterCredentialsNeedRefresh) {
    void invalidateCache(`${STORAGE_KEYS.JUDGES}_roster_${cleanOrgId}`);
  }

  // Emit batched database change events for changed tables only
  for (const tbl of changedTables) {
    notifyDatabaseChange(tbl);
  }

  return Array.from(changedTables);
}

// ==========================================
// CORE SYNC EXECUTION
// ==========================================

async function callReadOrgChangesRpc(
  token: string,
  since: number
): Promise<{ data: ReadOrgChangesResponse | null; error: any }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Delta sync timed out'));
    }, SYNC_RPC_TIMEOUT_MS);
  });

  try {
    const rpcPromise = Promise.resolve(
      supabase.rpc('read_org_changes', {
        p_token: token,
        p_since: since,
      })
    );
    const result = (await Promise.race([rpcPromise, timeoutPromise])) as {
      data: ReadOrgChangesResponse | null;
      error: any;
    };
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function runSyncOnce(options: SyncNowOptions = {}): Promise<SyncResult> {
  const { forceFull = false, reason = 'cadence' } = options;

  if (!isSupabaseConfigured()) {
    return { ok: true, skipped: true, changedTables: [] };
  }
  if (!isNavigatorOnline()) {
    return { ok: true, skipped: true, changedTables: [] };
  }
  if (!forceFull && reason !== 'manual' && !isDocumentVisible()) {
    return { ok: true, skipped: true, changedTables: [] };
  }

  const session = getStoredSession();
  const token = (session?.sessionToken || '').trim();
  const orgId = (session?.org?.org_id || '').trim().toUpperCase();
  if (!session || !token || !orgId) {
    return { ok: true, skipped: true, changedTables: [] };
  }

  const sessionKey = getSessionKey(session);
  if (sessionKey && lastSessionKey && lastSessionKey !== sessionKey) {
    // Switched user/org/role — avoid leaking previous cursor
    cursorMemory.clear();
  }
  lastSessionKey = sessionKey;

  const cursorKey = getCursorStorageKey(session);
  const since = forceFull ? 0 : await readStoredCursor(cursorKey);
  lastSyncAttemptAt = Date.now();

  try {
    const { data, error } = await callReadOrgChangesRpc(token, since);

    if (error) {
      const msg = String(error.message || '').toLowerCase();
      if (
        error.code === 'PGRST202' ||
        error.code === '42883' ||
        msg.includes('read_org_changes')
      ) {
        if (!rpcUnavailableLogged) {
          rpcUnavailableLogged = true;
          console.warn(
            'Delta sync RPC read_org_changes is not deployed yet (run sql/15.12-phase4d-simple-sync.sql).'
          );
        }
        return { ok: false, changedTables: [], error: 'rpc_unavailable' };
      }
      return { ok: false, changedTables: [], error: error.message || 'Sync RPC failed' };
    }

    const res = data as ReadOrgChangesResponse | null;
    if (!res) {
      return { ok: false, changedTables: [], error: 'Empty delta response' };
    }

    if (!res.ok) {
      if (res.error === 'unauthorized') {
        void invalidateCache(`${STORAGE_KEYS.ORGS}_${orgId}`);
        notifyDatabaseChange(DB_TABLES.ORGANIZATIONS);
      }
      return { ok: false, changedTables: [], error: res.error || 'unauthorized' };
    }

    const resOrgId = String(res.org_id || '').trim().toUpperCase();
    if (resOrgId && resOrgId !== orgId) {
      return { ok: true, skipped: true, changedTables: [] };
    }

    const serverVersion = Number(res.version ?? since);
    if (Number.isFinite(serverVersion) && serverVersion > 0) {
      await writeStoredCursor(cursorKey, serverVersion);
    }

    if (res.unchanged) {
      const orgEventIds = getHotCache<SupabaseEvent[]>(STORAGE_KEYS.EVENTS, [])
        .filter((e) => (e.org_id || '').trim().toUpperCase() === orgId)
        .map((e) => e.id);
      touchAllOrgCacheKeys(orgId, orgEventIds, session.role === 'organiser' ? 'organiser' : 'judge');
      return {
        ok: true,
        unchanged: true,
        version: serverVersion,
        changedTables: [],
      };
    }

    const changedTables = await applyOrgChangesPayload(session, res);
    return {
      ok: true,
      unchanged: false,
      version: serverVersion,
      changedTables,
    };
  } catch (err: any) {
    return {
      ok: false,
      changedTables: [],
      error: err?.message || 'Delta sync network error',
    };
  }
}

export function syncNow(options: SyncNowOptions = {}): Promise<SyncResult> {
  if (inflightSync) {
    if (options.forceFull) {
      pendingForceSync = true;
    }
    return inflightSync;
  }

  inflightSync = runSyncOnce(options).finally(() => {
    inflightSync = null;
    if (pendingForceSync) {
      pendingForceSync = false;
      void syncNow({ forceFull: true, reason: options.reason || 'manual' });
    }
  });

  return inflightSync;
}

// ==========================================
// LIFECYCLE & ADAPTIVE CADENCE SCHEDULER
// ==========================================

function clearPollTimer(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  activeEffectiveIntervalMs = 0;
}

function handleVisibilityOrOnlineWakeup(eventName: 'visibility' | 'online'): void {
  if (!isDocumentVisible() || !isNavigatorOnline()) {
    // Pause background timers cleanly while hidden or offline (0 checks)
    clearPollTimer();
    return;
  }

  const target = getTargetCadence();
  if (!target) return;

  refreshSchedule();
  void syncNow({ reason: eventName });
}

const onVisibilityChange = () => handleVisibilityOrOnlineWakeup('visibility');
const onWindowOnline = () => handleVisibilityOrOnlineWakeup('online');
const onWindowOffline = () => {
  clearPollTimer();
};
const onSessionChange = () => {
  handleSyncSessionChange();
};

function bindGlobalListeners(): void {
  if (listenersBound || typeof window === 'undefined') return;
  listenersBound = true;
  window.addEventListener('online', onWindowOnline);
  window.addEventListener('offline', onWindowOffline);
  window.addEventListener('fairjudge_session_change', onSessionChange);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }
  ensureBatteryMonitor();
}

function unbindGlobalListeners(): void {
  if (!listenersBound || typeof window === 'undefined') return;
  window.removeEventListener('online', onWindowOnline);
  window.removeEventListener('offline', onWindowOffline);
  window.removeEventListener('fairjudge_session_change', onSessionChange);
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  listenersBound = false;
}

function refreshSchedule(): void {
  const target = getTargetCadence();

  if (!target) {
    activeCadence = null;
    clearPollTimer();
    unbindGlobalListeners();
    return;
  }

  bindGlobalListeners();

  // Do NOT run any background timer when tab is hidden or device is offline
  if (!isDocumentVisible() || !isNavigatorOnline()) {
    activeCadence = target;
    clearPollTimer();
    return;
  }

  const desiredInterval = computeIntervalMs(target);
  if (pollTimer && activeCadence === target && activeEffectiveIntervalMs === desiredInterval) {
    return;
  }

  clearPollTimer();
  activeCadence = target;
  activeEffectiveIntervalMs = desiredInterval;
  pollTimer = setInterval(() => {
    void syncNow({ reason: 'cadence' });
  }, desiredInterval);
}

/**
 * Registers a mounted screen's sync cadence requirement.
 * - 'fast' (15s, or 30s on low battery): Organiser LiveTab & Judge ScoringPanel
 * - 'normal' (60s, or 120s on low battery): Other Organiser tabs & JudgeLobby
 */
export function registerSyncCadence(mode: SyncCadenceMode): () => void {
  const prevTarget = getTargetCadence();
  cadenceCounts[mode] += 1;
  const nextTarget = getTargetCadence();

  refreshSchedule();

  // Immediate check when first activating sync or escalating from normal -> fast
  const escalatedToFast = prevTarget !== 'fast' && nextTarget === 'fast';
  const startedFromIdle = prevTarget === null && nextTarget !== null;
  if ((startedFromIdle || escalatedToFast) && isDocumentVisible() && isNavigatorOnline()) {
    const elapsed = Date.now() - lastSyncAttemptAt;
    if (elapsed > 1500) {
      void syncNow({ reason: 'mount' });
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    cadenceCounts[mode] = Math.max(0, cadenceCounts[mode] - 1);
    refreshSchedule();
  };
}

/**
 * Called on login/logout/session changes so timers & cursors track the active account cleanly.
 */
export function handleSyncSessionChange(): void {
  const session = getStoredSession();
  const nextKey = getSessionKey(session);
  if (!nextKey) {
    lastSessionKey = null;
    cursorMemory.clear();
    clearPollTimer();
    return;
  }
  if (nextKey !== lastSessionKey) {
    lastSessionKey = nextKey;
    cursorMemory.clear();
    refreshSchedule();
    if (getTargetCadence() && isDocumentVisible() && isNavigatorOnline()) {
      void syncNow({ forceFull: true, reason: 'mount' });
    }
  }
}

/**
 * Clears in-memory sync state and timers (primarily used on logout or unit tests).
 */
export function resetSyncEngineForTest(): void {
  clearPollTimer();
  unbindGlobalListeners();
  cadenceCounts.fast = 0;
  cadenceCounts.normal = 0;
  activeCadence = null;
  activeEffectiveIntervalMs = 0;
  lastSessionKey = null;
  lastSyncAttemptAt = 0;
  inflightSync = null;
  pendingForceSync = false;
  rpcUnavailableLogged = false;
  isLowBattery = false;
  batteryRef = null;
  batteryBound = false;
  cursorMemory.clear();
}

export function getSyncEngineDebugState() {
  return {
    activeCadence,
    activeEffectiveIntervalMs,
    cadenceCounts: { ...cadenceCounts },
    isLowBattery,
    hasTimer: Boolean(pollTimer),
    cursorEntries: Array.from(cursorMemory.entries()),
  };
}
