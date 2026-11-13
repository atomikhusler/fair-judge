import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { 
  Organization, 
  SupabaseEvent, 
  SupabaseJudge, 
  SupabaseParticipant, 
  SupabaseScore, 
  EventStatus,
  TieBreakerMethod,
  VerificationStatus
} from './supabaseTypes';
import { queueMutationLocally, queueScoreLocally, clearAllScoreDrafts } from './offlineQueue';
import { 
  getHotCache, 
  setIndexedDBCache, 
  isCacheFresh, 
  touchCacheTimestamp,
  invalidateCache as invalidateIDBCache,
  hasCachedKey
} from './db/indexedDB';
import { eventBus, areRecordsEqual } from './eventBus';
import { calculateRankings as engineCalculateRankings, calculateRankingsAsync as engineCalculateRankingsAsync } from './tieBreakerEngine';
import { blackBox } from './blackBox';
import { parseOrgEnforcementError } from './orgEnforcement';

// ==========================================
// SUPABASE CREDENTIALS & DYNAMIC CLIENT INJECTION
// ==========================================

export const SUPABASE_STORAGE_CONFIG_KEYS = {
  URL: 'fairjudge_supabase_url',
  ANON_KEY: 'fairjudge_supabase_anon_key',
};

export function getSupabaseCredentials(): { url: string; anonKey: string } {
  let url = '';
  let anonKey = '';
  if (typeof window !== 'undefined') {
    try {
      url = localStorage.getItem(SUPABASE_STORAGE_CONFIG_KEYS.URL) || '';
      anonKey = localStorage.getItem(SUPABASE_STORAGE_CONFIG_KEYS.ANON_KEY) || '';
    } catch {}
  }
  if (!url) {
    url = (import.meta.env.VITE_SUPABASE_URL || '').trim();
  }
  if (!anonKey) {
    anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
  }
  return { url: url.trim(), anonKey: anonKey.trim() };
}

export function setSupabaseCredentials(url: string, anonKey: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(SUPABASE_STORAGE_CONFIG_KEYS.URL, url.trim());
    localStorage.setItem(SUPABASE_STORAGE_CONFIG_KEYS.ANON_KEY, anonKey.trim());
  }
  resetSupabaseClient();
}

export function clearSupabaseCredentials(): void {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(SUPABASE_STORAGE_CONFIG_KEYS.URL);
    localStorage.removeItem(SUPABASE_STORAGE_CONFIG_KEYS.ANON_KEY);
  }
  resetSupabaseClient();
}

export function isSupabaseConfigured(): boolean {
  const { url, anonKey } = getSupabaseCredentials();
  return Boolean(
    url &&
    anonKey &&
    url.startsWith('http') &&
    !url.includes('placeholder') &&
    !url.includes('paste_your_url_here')
  );
}

// Intercepts and sanitizes error payloads to eliminate raw HTML dumps (Directive 1)
export function sanitizeDbError(err: any): Error {
  const rawMsg = err?.message || (typeof err === 'string' ? err : JSON.stringify(err || ''));
  const lower = rawMsg.toLowerCase();

  if (
    lower.includes('<!doctype') ||
    lower.includes('<html') ||
    lower.includes('<head') ||
    lower.includes('<body') ||
    lower.includes('send was called before connect') ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('unexpected token <') ||
    lower.includes('is not valid json') ||
    (lower.includes('404') && lower.includes('supabase-proxy'))
  ) {
    return new Error('Network Error: Could not reach the database. Check Supabase credentials.');
  }

  return new Error(rawMsg || 'Database operation failed.');
}

let activeClient: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (!activeClient) {
    const { url, anonKey } = getSupabaseCredentials();
    const validUrl = isSupabaseConfigured() ? url : 'https://placeholder.supabase.co';
    const validKey = anonKey || 'placeholder-anon-key';

    activeClient = createClient(validUrl, validKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    });
  }
  return activeClient;
}

export function resetSupabaseClient(): void {
  activeClient = null;
}

// Standard Supabase client instance (proxied dynamically to localStorage or env credentials)
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    const client = getSupabaseClient();
    const val = (client as any)[prop];
    if (typeof val === 'function') {
      return val.bind(client);
    }
    return val;
  },
});

// Cache storage keys (persisted asynchronously in IndexedDB)
export const STORAGE_KEYS = {
  ORGS: 'fairjudge_supabase_orgs',
  EVENTS: 'fairjudge_supabase_events',
  JUDGES: 'fairjudge_supabase_judges',
  PARTICIPANTS: 'fairjudge_supabase_participants',
  SCORES: 'fairjudge_supabase_scores',
  PUBLIC_SETTINGS: 'fairjudge_public_settings',
  ACTIVE_SESSION: 'fairjudge_active_session',
  JUDGE_DEVICE_TOKEN: 'fairjudge_judge_device_token',
};

// ==========================================
// ID & SESSION HELPERS
// ==========================================

export function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function generateOrgId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let randomPart = '';
  for (let i = 0; i < 4; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `FJ-${randomPart}`;
}

export function generateIdentityId(): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `P-${num}`;
}

export function getLocalJudgeDeviceToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.JUDGE_DEVICE_TOKEN);
  } catch {
    return null;
  }
}

export function setLocalJudgeDeviceToken(token: string | null): void {
  try {
    if (!token) {
      localStorage.removeItem(STORAGE_KEYS.JUDGE_DEVICE_TOKEN);
    } else {
      localStorage.setItem(STORAGE_KEYS.JUDGE_DEVICE_TOKEN, token);
    }
  } catch {}
}

export interface StoredUserSession {
  role: 'organiser' | 'judge';
  org: Organization;
  judge?: SupabaseJudge;
  event?: SupabaseEvent;
  sessionToken?: string;
}

export function getStoredSession(): StoredUserSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function getStoredSessionToken(): string | null {
  return getStoredSession()?.sessionToken || null;
}

function isAuthRequiredSessionRole(): 'organiser' | 'judge' {
  return getStoredSession()?.role === 'judge' ? 'judge' : 'organiser';
}

function isOnlineNavigator(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function isServerRejectionError(err: any): boolean {
  return Boolean(
    err?.code === 'unauthorized' ||
    err?.code === 'forbidden' ||
    err?.code === 'ROSTER_LOCKED' ||
    err?.code === 'rpc_unavailable' ||
    err?.code === 'not_found' ||
    err?.message?.includes('ROSTER_LOCKED') ||
    err?.message?.includes('RLS Permission Denied') ||
    parseOrgEnforcementError(err)
  );
}

/**
 * Executes a Stage D3 / 15.10 token-authenticated write RPC exclusively.
 * Never falls back to direct table writes.
 * Emits `session_expired` when online with a missing/expired token.
 */
export async function callSecuredWriteRpc<T = any>(
  rpcName: string,
  params: Record<string, any>
): Promise<{ data?: T }> {
  const token = getStoredSessionToken() || '';
  if (!token) {
    eventBus.emit('session_expired', {
      role: isAuthRequiredSessionRole(),
      reason: 'missing',
    });
    const authErr = new Error('Session token missing. Please verify your credentials to continue.');
    (authErr as any).code = 'unauthorized';
    throw authErr;
  }

  const { data, error } = await supabase.rpc(rpcName, {
    p_token: token,
    ...params,
  });

  if (error) {
    const msg = (error.message || '').toLowerCase();
    if (error.code === 'PGRST202' || error.code === '42883' || msg.includes(`function public.${rpcName}`)) {
      const rpcErr = new Error('Database security RPCs are not deployed. Please run sql/15.10-stage1-security-lock.sql.');
      (rpcErr as any).code = 'rpc_unavailable';
      throw rpcErr;
    }
    throw error;
  }

  const res = data as any;
  if (!res || !res.ok) {
    const errCode = res?.error || 'RPC_ERROR';
    const msg = res?.message || res?.error || 'Database operation rejected.';
    if (errCode === 'unauthorized') {
      eventBus.emit('session_expired', {
        role: isAuthRequiredSessionRole(),
        reason: 'expired',
      });
    }
    const err = new Error(msg);
    (err as any).code = errCode === 'ROSTER_LOCKED' ? 'ROSTER_LOCKED' : errCode;
    throw err;
  }

  return { data: res.data as T };
}

export function setStoredSession(session: StoredUserSession | null): void {
  try {
    if (!session) {
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
      localStorage.removeItem(STORAGE_KEYS.JUDGE_DEVICE_TOKEN);
    } else {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, JSON.stringify(session));
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fairjudge_session_change'));
    }
  } catch {}
}

// ==========================================
// 5-MINUTE SWR CACHE THROTTLE & EVENT BUS
// ==========================================

export function isCacheValid(key: string): boolean {
  return isCacheFresh(key);
}

export function updateCacheTimestamp(key: string): void {
  touchCacheTimestamp(key);
}

export function invalidateCache(key?: string): void {
  invalidateIDBCache(key);
}

function loadCache<T>(key: string, defaultData: T[] = []): T[] {
  return getHotCache<T[]>(key, defaultData);
}

// Asynchronously writes to IndexedDB and immediately updates the in-memory hot mirror
function saveCache<T>(key: string, data: T[], silent: boolean = false) {
  setIndexedDBCache(key, data, silent);
  if (!silent) {
    notifyDatabaseChange(key);
  }
}

const DB_CHANGE_EVENT = 'fairjudge_db_change';
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let batchedTables = new Set<string>();

// Debounced event broadcaster: batches multiple database changes into EventBus & CustomEvents
function notifyDatabaseChange(table: string) {
  batchedTables.add(table);
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    let rawTable = table.replace('fairjudge_supabase_', '');
    if (rawTable === 'orgs') rawTable = 'organizations';

    // Broadcast through typed EventBus
    eventBus.emit('cache_updated', { table: rawTable });

    if (typeof window !== 'undefined') {
      const tables = Array.from(batchedTables);
      batchedTables.clear();
      window.dispatchEvent(
        new CustomEvent(DB_CHANGE_EVENT, {
          detail: { table: tables.length === 1 ? tables[0] : 'all', tables },
        })
      );
    }
    debounceTimer = null;
  }, 150);
}

// Global Supabase Realtime Channel
let realtimeChannel: RealtimeChannel | null = null;

function ensureRealtimeSubscription() {
  if (!isSupabaseConfigured() || realtimeChannel || typeof window === 'undefined') return;

  try {
    realtimeChannel = supabase
      .channel('fairjudge-live-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, () => {
        invalidateCache();
        notifyDatabaseChange('events');
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'scores' }, () => {
        invalidateCache(STORAGE_KEYS.SCORES);
        notifyDatabaseChange('scores');
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'participants' }, () => {
        invalidateCache();
        notifyDatabaseChange('participants');
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'judges' }, () => {
        invalidateCache();
        notifyDatabaseChange('judges');
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'organizations' }, () => {
        invalidateCache();
        notifyDatabaseChange('organizations');
      })
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('Supabase realtime sync status:', status, '- relying on local event bus');
        }
      });
  } catch (err) {
    console.warn('Realtime channel subscription error:', err);
  }
}

export function subscribeToDatabase(callback: (table: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  ensureRealtimeSubscription();

  const handler = (e: Event) => {
    const custom = e as CustomEvent<{ table: string }>;
    callback(custom.detail?.table || 'all');
  };
  window.addEventListener(DB_CHANGE_EVENT, handler);
  return () => window.removeEventListener(DB_CHANGE_EVENT, handler);
}

// ==========================================
// DATA NORMALIZERS (PostgreSQL <-> UI)
// ==========================================

function normalizeOrg(o: any): Organization {
  const { password: _p, ...rest } = o || {};
  return {
    ...rest,
    verification_status: (rest.verification_status || 'pending') as VerificationStatus,
  };
}

function normalizeEvent(e: any): SupabaseEvent {
  const schema = Array.isArray(e.rubric_schema)
    ? e.rubric_schema
    : Array.isArray(e.rubric)
    ? e.rubric
    : [];
  return {
    ...e,
    status: (e.status?.toLowerCase() as EventStatus) || 'draft',
    is_locked: Boolean(e.is_locked),
    is_archived: Boolean(e.is_archived),
    rubric_schema: schema,
    rubric: schema,
    assigned_judges: Array.isArray(e.assigned_judges) ? e.assigned_judges : [],
    assigned_participants: Array.isArray(e.assigned_participants) ? e.assigned_participants : [],
    participant_sl_numbers: e.participant_sl_numbers || {},
  };
}

function normalizeJudge(j: any): SupabaseJudge {
  const cleanPin = j.pin || j.judge_pin || '0000';
  return {
    ...j,
    pin: cleanPin,
    judge_pin: cleanPin,
    assigned_events: Array.isArray(j.assigned_events) ? j.assigned_events : [],
    current_session_token: j.current_session_token || null,
  };
}

function normalizeScore(s: any): SupabaseScore {
  const criteria = s.score_data || s.score_payload?.criteria || {};
  const total = Number(s.total_score ?? s.score_payload?.total_score ?? 0);
  return {
    ...s,
    total_score: total,
    score_data: criteria,
    score_payload: s.score_payload || {
      criteria,
      total_score: total,
      submitted_at: s.created_at || new Date().toISOString(),
    },
  };
}

export interface PublicLinkSettings {
  delaySeconds: number;
  isPaused: boolean;
  isRevoked: boolean;
  lastUpdated: string;
  // Phase 14.3: 6 Broadcast Settings
  blindMode?: boolean; // 1. Score Secrecy (Blind Mode)
  spotlightMode?: boolean; // 2. Spotlight / Focus Mode
  tickerText?: string; // 3. Custom Broadcast Ticker
  confettiTrigger?: number; // 4. Confetti Trigger timestamp
  showAppQr?: boolean; // 5. App Login QR
  paginationTimer?: number; // 6. Custom Pagination Timer in seconds
}

// ==========================================
// TOAST & TELEMETRY EMITTERS
// ==========================================

function notifyCloudSync(entityName: string = 'Update') {
  eventBus.emit('toast', {
    type: 'success',
    title: 'Synced to Cloud',
    message: `${entityName} synced to cloud ledger.`,
  });
  eventBus.emit('sync_status', { status: 'synced' });
}

function notifyOfflineSaved(entityName: string = 'Change') {
  eventBus.emit('toast', {
    type: 'warning',
    title: 'Saved locally',
    message: `${entityName} saved locally. Pending cloud sync.`,
  });
  eventBus.emit('sync_status', { status: 'offline' });
}

// ==========================================
// PRODUCTION SUPABASE DATA SERVICE
// ==========================================

export const dbService = {
  // ------------------------------------------
  // SYNCHRONOUS CACHE READERS (Anti-Flicker)
  // ------------------------------------------
  getCachedEvents(orgId: string): SupabaseEvent[] {
    const cleanOrgId = orgId.trim().toUpperCase();
    const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    return events
      .filter((e) => e.org_id.toUpperCase() === cleanOrgId)
      .map(normalizeEvent);
  },

  getCachedParticipants(orgId: string): SupabaseParticipant[] {
    const cleanOrgId = orgId.trim().toUpperCase();
    const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    return participants.filter((p) => p.org_id.toUpperCase() === cleanOrgId);
  },

  getCachedJudges(orgId: string): SupabaseJudge[] {
    const cleanOrgId = orgId.trim().toUpperCase();
    const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    return judges
      .filter((j) => j.org_id.toUpperCase() === cleanOrgId)
      .map(normalizeJudge);
  },

  getCachedScores(): SupabaseScore[] {
    const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    return scores.map(normalizeScore);
  },

  hasCachedData(orgId: string): boolean {
    const cleanOrgId = orgId.trim().toUpperCase();
    const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    return events.some((e) => e.org_id.toUpperCase() === cleanOrgId);
  },

  // ------------------------------------------
  // 1. ORGANIZATIONS
  // ------------------------------------------
  async getOrganizations(force: boolean = false): Promise<Organization[]> {
    const cacheKey = STORAGE_KEYS.ORGS;
    const cachedOrgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []).map(normalizeOrg);

    if (!force && isCacheValid(cacheKey) && cachedOrgs.length > 0) {
      return cachedOrgs;
    }

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('organizations')
          .select('*')
          .order('created_at', { ascending: false });

        if (!error && data) {
          const normalized = data.map(normalizeOrg);
          // SILENT CACHE UPDATE: Do not trigger infinite re-renders!
          saveCache(STORAGE_KEYS.ORGS, normalized, true);
          updateCacheTimestamp(cacheKey);
          return normalized;
        }
        if (error) console.warn('Supabase getOrganizations fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getOrganizations network fallback:', err?.message || err);
      }
    }

    updateCacheTimestamp(cacheKey);
    return cachedOrgs;
  },

  async getOrganizationByOrgId(orgId: string, force: boolean = false): Promise<Organization | null> {
    const cleanOrgId = orgId.trim().toUpperCase();
    const cacheKey = `${STORAGE_KEYS.ORGS}_${cleanOrgId}`;
    const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
    const found = orgs.find((o) => o.org_id.toUpperCase() === cleanOrgId);

    if (!force && isCacheValid(cacheKey) && found) {
      return normalizeOrg(found);
    }

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('organizations')
          .select('*')
          .ilike('org_id', cleanOrgId)
          .maybeSingle();

        if (!error) {
          if (data) {
            const normalized = normalizeOrg(data);
            saveCache(
              STORAGE_KEYS.ORGS,
              [normalized, ...orgs.filter((o) => o.org_id.toUpperCase() !== cleanOrgId)],
              true // SILENT
            );
            updateCacheTimestamp(cacheKey);
            return normalized;
          }
          // Server explicitly confirmed org does not exist
          return null;
        }
        console.warn('Supabase getOrganizationByOrgId fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getOrganizationByOrgId network fallback:', err?.message || err);
      }
    } else if (found) {
      updateCacheTimestamp(cacheKey);
    }

    if (found) {
      return normalizeOrg(found);
    }
    return null;
  },

  async getOrganizationByIdentifier(identifier: string): Promise<Organization | null> {
    const clean = identifier.trim();
    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('organizations')
          .select('*')
          .or(`org_id.ilike.${clean},email.ilike.${clean}`)
          .maybeSingle();

        if (!error && data) return normalizeOrg(data);
        if (error) console.warn('Supabase getOrganizationByIdentifier fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getOrganizationByIdentifier network fallback:', err?.message || err);
      }
    }
    const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
    const lower = clean.toLowerCase();
    const found = orgs.find(
      (o) => o.org_id.toLowerCase() === lower || (o.email && o.email.toLowerCase() === lower)
    );
    return found ? normalizeOrg(found) : null;
  },

  async updateOrganization(orgId: string, updates: Partial<Organization>): Promise<Organization> {
    const cleanOrgId = orgId.trim().toUpperCase();
    // Strict security: Never update or queue password through standard entity updates
    const { password: _stripPassword, ...safeUpdates } = updates as any;
    const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
    const idx = orgs.findIndex((o) => o.org_id.toUpperCase() === cleanOrgId);
    const existing = idx !== -1 ? orgs[idx] : null;

    const updated = normalizeOrg({
      ...(existing || { org_id: cleanOrgId, id: generateUUID(), name: 'Organization' }),
      ...safeUpdates,
    });

    const orgsSnapshot = [...orgs];

    // Optimistically save to cache & notify UI
    if (idx !== -1) {
      orgs[idx] = updated;
    } else {
      orgs.unshift(updated);
    }
    saveCache(STORAGE_KEYS.ORGS, orgs, false);
    invalidateCache(`${STORAGE_KEYS.ORGS}_${cleanOrgId}`);

    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        const rpcRes = await callSecuredWriteRpc<Organization>('org_update', {
          p_org_id: cleanOrgId,
          p_updates: safeUpdates,
        });

        const syncedRow = rpcRes.data;
        if (syncedRow) {
          const synced = normalizeOrg(syncedRow);
          const currentOrgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
          saveCache(
            STORAGE_KEYS.ORGS,
            currentOrgs.map((o) => (o.org_id.toUpperCase() === cleanOrgId ? synced : o)),
            true
          );
          return synced;
        }
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.ORGS, orgsSnapshot, false);
          throw err;
        }
        console.warn('Offline mode: organization update saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('organizations', 'UPDATE', cleanOrgId, safeUpdates);
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('organizations', 'UPDATE', cleanOrgId, safeUpdates);
    }

    return updated;
  },

  async resetOrganizationData(orgId: string): Promise<void> {
    const cleanOrgId = orgId.toUpperCase().trim();

    if (isSupabaseConfigured()) {
      await callSecuredWriteRpc('org_reset_data', { p_org_id: cleanOrgId });
    }

    // Clear local cache for this org
    const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const orgEventIds = new Set(
      events.filter((e) => e.org_id.toUpperCase().trim() === cleanOrgId).map((e) => e.id)
    );
    saveCache(
      STORAGE_KEYS.EVENTS,
      events.filter((e) => e.org_id.toUpperCase().trim() !== cleanOrgId),
      false
    );

    const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    saveCache(
      STORAGE_KEYS.SCORES,
      scores.filter((s) => !orgEventIds.has(s.event_id)),
      false
    );

    const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    saveCache(
      STORAGE_KEYS.PARTICIPANTS,
      participants.filter((p) => p.org_id.toUpperCase().trim() !== cleanOrgId),
      false
    );

    const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    saveCache(
      STORAGE_KEYS.JUDGES,
      judges.filter((j) => j.org_id.toUpperCase().trim() !== cleanOrgId),
      false
    );

    invalidateCache();
    clearAllScoreDrafts();
  },

  async deleteOrganization(orgId: string): Promise<void> {
    const cleanOrgId = orgId.toUpperCase().trim();

    if (isSupabaseConfigured()) {
      await callSecuredWriteRpc('org_delete', { p_org_id: cleanOrgId });
      // Clear local cache after confirmed RPC deletion (never re-call org_reset_data RPC on org_delete)
      const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
      const orgEventIds = new Set(
        events.filter((e) => e.org_id.toUpperCase().trim() === cleanOrgId).map((e) => e.id)
      );
      saveCache(STORAGE_KEYS.EVENTS, events.filter((e) => e.org_id.toUpperCase().trim() !== cleanOrgId), false);
      const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
      saveCache(STORAGE_KEYS.SCORES, scores.filter((s) => !orgEventIds.has(s.event_id)), false);
      const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
      saveCache(STORAGE_KEYS.PARTICIPANTS, participants.filter((p) => p.org_id.toUpperCase().trim() !== cleanOrgId), false);
      const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
      saveCache(STORAGE_KEYS.JUDGES, judges.filter((j) => j.org_id.toUpperCase().trim() !== cleanOrgId), false);
      invalidateCache();
      clearAllScoreDrafts();
    } else {
      await this.resetOrganizationData(cleanOrgId);
    }

    const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
    saveCache(
      STORAGE_KEYS.ORGS,
      orgs.filter((o) => o.org_id.toUpperCase().trim() !== cleanOrgId),
      false
    );
    setStoredSession(null);
    invalidateCache();
    clearAllScoreDrafts();
  },

  // ------------------------------------------
  // 2. PUBLIC LINK SETTINGS
  // ------------------------------------------
  getPublicSettings(orgId: string): PublicLinkSettings {
    try {
      const raw = localStorage.getItem(`${STORAGE_KEYS.PUBLIC_SETTINGS}_${orgId.toUpperCase()}`);
      if (raw) return JSON.parse(raw);
    } catch {}
    return {
      delaySeconds: 0,
      isPaused: false,
      isRevoked: false,
      lastUpdated: new Date().toISOString(),
      blindMode: false,
      spotlightMode: true,
      tickerText: '',
      confettiTrigger: 0,
      showAppQr: false,
      paginationTimer: 60,
    };
  },

  savePublicSettings(orgId: string, settings: Partial<PublicLinkSettings>): PublicLinkSettings {
    const current = this.getPublicSettings(orgId);
    const updated: PublicLinkSettings = {
      ...current,
      ...settings,
      lastUpdated: new Date().toISOString(),
    };
    try {
      localStorage.setItem(
        `${STORAGE_KEYS.PUBLIC_SETTINGS}_${orgId.toUpperCase()}`,
        JSON.stringify(updated)
      );
      notifyDatabaseChange(STORAGE_KEYS.PUBLIC_SETTINGS);
    } catch {}
    return updated;
  },

  // ------------------------------------------
  // 3. EVENTS (Optimistic Mutations + SWR)
  // ------------------------------------------
  async getEvents(orgId: string, force: boolean = false): Promise<SupabaseEvent[]> {
    const cleanOrgId = orgId.trim().toUpperCase();
    const cacheKey = `${STORAGE_KEYS.EVENTS}_${cleanOrgId}`;
    const cachedEvents = this.getCachedEvents(cleanOrgId);

    // 5-Minute SWR Cache Throttle: If cache is valid and has data, return it immediately!
    if (!force && isCacheValid(cacheKey) && cachedEvents.length > 0) {
      return cachedEvents;
    }

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('events')
          .select('*')
          .ilike('org_id', cleanOrgId)
          .order('created_at', { ascending: false });

        if (!error && data) {
          const normalized = data.map(normalizeEvent);
          const allCachedEvents = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
          const otherOrgEvents = allCachedEvents.filter(
            (e) => (e.org_id || '').trim().toUpperCase() !== cleanOrgId
          );
          const changed = !areRecordsEqual(cachedEvents, normalized);
          saveCache(STORAGE_KEYS.EVENTS, [...normalized, ...otherOrgEvents], !changed);
          updateCacheTimestamp(cacheKey);
          return normalized;
        }
        if (error) console.warn('Supabase getEvents fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getEvents network fallback:', err?.message || err);
      }
    } else {
      updateCacheTimestamp(cacheKey);
    }

    return cachedEvents;
  },

  async getEventById(eventId: string): Promise<SupabaseEvent | null> {
    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('events')
          .select('*')
          .eq('id', eventId)
          .maybeSingle();

        if (!error && data) return normalizeEvent(data);
        if (error) console.warn('Supabase getEventById fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getEventById network fallback:', err?.message || err);
      }
    }

    const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const found = events.find((item) => item.id === eventId);
    return found ? normalizeEvent(found) : null;
  },

  async createEvent(eventData: {
    org_id: string;
    name: string;
    category?: string;
    date?: string;
    status: EventStatus;
    rubric_schema: any[];
    assigned_judges: string[];
    assigned_participants: string[];
  }): Promise<SupabaseEvent> {
    const cleanOrgId = eventData.org_id.toUpperCase().trim();
    const normalizedStatus = (eventData.status?.toLowerCase() as EventStatus) || 'draft';
    const newId = generateUUID();
    const now = new Date().toISOString();

    const newEvent: SupabaseEvent = normalizeEvent({
      ...eventData,
      id: newId,
      org_id: cleanOrgId,
      name: eventData.name.trim(),
      category: eventData.category?.trim() || 'General',
      date: eventData.date || now.split('T')[0],
      status: normalizedStatus,
      rubric_schema: eventData.rubric_schema || [],
      assigned_judges: eventData.assigned_judges || [],
      assigned_participants: eventData.assigned_participants || [],
      participant_sl_numbers: {},
      created_at: now,
      updated_at: now,
    });

    // 1. OPTIMISTIC WRITE: Update local cache immediately & notify UI
    const eventsSnapshot = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    saveCache(STORAGE_KEYS.EVENTS, [newEvent, ...eventsSnapshot.filter((e) => e.id !== newId)], false);
    invalidateCache(`${STORAGE_KEYS.EVENTS}_${cleanOrgId}`);

    const payload = {
      id: newEvent.id,
      org_id: newEvent.org_id,
      name: newEvent.name,
      category: newEvent.category,
      date: newEvent.date,
      status: newEvent.status,
      rubric_schema: newEvent.rubric_schema,
      assigned_judges: newEvent.assigned_judges,
      assigned_participants: newEvent.assigned_participants,
      participant_sl_numbers: newEvent.participant_sl_numbers,
    };

    // 2. BACKGROUND CLOUD SYNC
    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        const rpcRes = await callSecuredWriteRpc<SupabaseEvent>('event_upsert', {
          p_record: payload,
        });

        const createdRow = rpcRes.data;
        if (createdRow) {
          const created = normalizeEvent(createdRow);
          const currentEvents = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
          saveCache(
            STORAGE_KEYS.EVENTS,
            currentEvents.map((e) => (e.id === created.id ? created : e)),
            true // silent
          );
          notifyCloudSync('Event');
        }
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.EVENTS, eventsSnapshot, false);
          throw err;
        }
        console.warn('Offline mode: event saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('events', 'INSERT', newEvent.id, payload);
        notifyOfflineSaved('Event');
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('events', 'INSERT', newEvent.id, payload);
      notifyOfflineSaved('Event');
    } else {
      notifyOfflineSaved('Event');
    }

    // Always resolve and return the created event immediately!
    return newEvent;
  },

  async updateEventStatus(eventId: string, newStatus: EventStatus): Promise<SupabaseEvent> {
    const normalized = (newStatus.toLowerCase() as EventStatus);
    return this.updateEvent(eventId, { status: normalized });
  },

  async updateEvent(eventId: string, updates: Partial<SupabaseEvent>): Promise<SupabaseEvent> {
    const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const idx = events.findIndex((e) => e.id === eventId);
    const existing = idx !== -1 ? events[idx] : null;

    // PRE-CHECK: If locked and the call touches a roster column without setting is_locked: false, throw typed error BEFORE optimistic write
    const touchesRoster =
      updates.assigned_participants !== undefined ||
      updates.assigned_judges !== undefined ||
      updates.participant_sl_numbers !== undefined;

    if (existing?.is_locked && updates.is_locked !== false && touchesRoster) {
      const err = new Error(`ROSTER_LOCKED: Cannot modify roster on locked event "${existing.name}". Unlock event first.`);
      (err as any).code = 'ROSTER_LOCKED';
      throw err;
    }

    const updated: SupabaseEvent = normalizeEvent({
      ...(existing || {}),
      ...updates,
      id: eventId,
      updated_at: new Date().toISOString(),
    });

    // 1. OPTIMISTIC WRITE: Save to local cache immediately & notify UI
    if (idx !== -1) {
      events[idx] = updated;
    } else {
      events.unshift(updated);
    }
    saveCache(STORAGE_KEYS.EVENTS, events, false);
    if (updated.org_id) {
      invalidateCache(`${STORAGE_KEYS.EVENTS}_${updated.org_id.toUpperCase()}`);
    }

    // 2. BACKGROUND CLOUD SYNC
    const dbUpdates: Record<string, any> = {
      ...updates,
      updated_at: updated.updated_at,
    };
    if (dbUpdates.rubric && !dbUpdates.rubric_schema) {
      dbUpdates.rubric_schema = dbUpdates.rubric;
    }
    delete dbUpdates.rubric;

    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        const rpcRes = await callSecuredWriteRpc<SupabaseEvent>('event_update', {
          p_event_id: eventId,
          p_updates: dbUpdates,
        });

        const syncedRow = rpcRes.data;
        if (syncedRow) {
          const synced = normalizeEvent({ ...syncedRow, is_archived: updated.is_archived });
          const currentEvents = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
          saveCache(
            STORAGE_KEYS.EVENTS,
            currentEvents.map((e) => (e.id === synced.id ? synced : e)),
            true
          );
          notifyCloudSync('Event');
        }
      } catch (err: any) {
        const orgBlock = parseOrgEnforcementError(err);
        if (orgBlock) {
          eventBus.emit('org_enforcement', { code: orgBlock });
        }
        const isRosterLocked = Boolean(
          err?.code === 'ROSTER_LOCKED' ||
          err?.message?.includes('ROSTER_LOCKED') ||
          (err?.details && String(err.details).includes('ROSTER_LOCKED'))
        );

        // If ROSTER_LOCKED, unauthorized, or any server-returned error: roll cache back and rethrow
        if (isServerRejectionError(err) || Boolean(err?.code) || isRosterLocked) {
          const currentEvents = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
          if (existing) {
            const rollbackList = currentEvents.map((e) => (e.id === eventId ? existing : e));
            saveCache(STORAGE_KEYS.EVENTS, rollbackList, false);
          } else {
            const rollbackList = currentEvents.filter((e) => e.id !== eventId);
            saveCache(STORAGE_KEYS.EVENTS, rollbackList, false);
          }
          if (updated.org_id && err?.code !== 'unauthorized') {
            this.getEvents(updated.org_id, true).catch(() => {});
          }
          throw err;
        }

        // Queue ONLY network errors
        console.warn('Offline mode: event update saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('events', 'UPDATE', eventId, dbUpdates);
        notifyOfflineSaved('Event');
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('events', 'UPDATE', eventId, dbUpdates);
      notifyOfflineSaved('Event');
    } else {
      notifyOfflineSaved('Event');
    }

    return updated;
  },

  async updateEventParticipantSerial(
    eventId: string,
    participantId: string,
    newSlNo: string
  ): Promise<SupabaseEvent> {
    const event = await this.getEventById(eventId);
    if (!event) throw new Error('Event not found');

    const updatedSerialMap = {
      ...(event.participant_sl_numbers || {}),
      [participantId]: newSlNo.trim(),
    };

    return this.updateEvent(eventId, {
      participant_sl_numbers: updatedSerialMap,
    });
  },

  async canDeleteEvent(eventId: string): Promise<boolean> {
    if (isSupabaseConfigured()) {
      try {
        const { count, error } = await supabase
          .from('scores')
          .select('*', { count: 'exact', head: true })
          .eq('event_id', eventId);

        if (!error) return (count ?? 0) === 0;
      } catch {}
    }
    const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    return !scores.some((s) => s.event_id === eventId);
  },

  async deleteEvent(eventId: string): Promise<boolean> {
    const eventsSnapshot = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const target = eventsSnapshot.find((e) => e.id === eventId);
    const remaining = eventsSnapshot.filter((e) => e.id !== eventId);
    saveCache(STORAGE_KEYS.EVENTS, remaining, false);
    if (target?.org_id) {
      invalidateCache(`${STORAGE_KEYS.EVENTS}_${target.org_id.toUpperCase()}`);
    }

    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        await callSecuredWriteRpc('event_delete', { p_event_id: eventId });
        notifyCloudSync('Event');
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.EVENTS, eventsSnapshot, false);
          throw err;
        }
        console.warn('Offline mode: event deletion saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('events', 'DELETE', eventId, null);
        notifyOfflineSaved('Event');
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('events', 'DELETE', eventId, null);
      notifyOfflineSaved('Event');
    } else {
      notifyOfflineSaved('Event');
    }

    return true;
  },

  async deleteOrArchiveEvent(eventId: string): Promise<{ action: 'deleted' | 'archived' }> {
    const canDelete = await this.canDeleteEvent(eventId);
    if (canDelete) {
      await this.deleteEvent(eventId);
      return { action: 'deleted' };
    } else {
      await this.updateEvent(eventId, { status: 'archived' });
      return { action: 'archived' };
    }
  },

  // ------------------------------------------
  // 4. JUDGES (Optimistic Mutations + SWR)
  // ------------------------------------------
  async getJudges(orgId: string, force: boolean = false): Promise<SupabaseJudge[]> {
    const cleanOrgId = orgId.trim().toUpperCase();
    const cacheKey = `${STORAGE_KEYS.JUDGES}_${cleanOrgId}`;
    const cachedJudges = this.getCachedJudges(cleanOrgId);

    // 5-Minute SWR Cache Throttle
    if (!force && isCacheValid(cacheKey) && cachedJudges.length > 0) {
      return cachedJudges;
    }

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('judges')
          .select('*')
          .ilike('org_id', cleanOrgId)
          .order('created_at', { ascending: false });

        if (!error && data) {
          const normalized = data.map(normalizeJudge);
          const currentJudges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
          const otherJudges = currentJudges.filter(
            (j) => (j.org_id || '').trim().toUpperCase() !== cleanOrgId
          );
          const changed = !areRecordsEqual(cachedJudges, normalized);
          saveCache(STORAGE_KEYS.JUDGES, [...otherJudges, ...normalized], !changed);
          updateCacheTimestamp(cacheKey);
          return normalized;
        }
        if (error) console.warn('Supabase getJudges fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getJudges network fallback:', err?.message || err);
      }
    } else {
      updateCacheTimestamp(cacheKey);
    }

    return cachedJudges;
  },

  async getJudgeById(judgeId: string): Promise<SupabaseJudge | null> {
    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('judges')
          .select('*')
          .eq('id', judgeId)
          .maybeSingle();

        if (!error && data) return normalizeJudge(data);
        if (error) console.warn('Supabase getJudgeById fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getJudgeById network fallback:', err?.message || err);
      }
    }
    const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    const found = judges.find((j) => j.id === judgeId || j.judge_id === judgeId);
    return found ? normalizeJudge(found) : null;
  },

  async createJudge(
    orgId: string,
    name: string,
    pin?: string,
    customJudgeId?: string
  ): Promise<SupabaseJudge> {
    const cleanOrgId = orgId.trim().toUpperCase();
    const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    const existingOrgJudges = judges.filter((j) => j.org_id.toUpperCase() === cleanOrgId);
    const assignedJudgeId =
      customJudgeId?.trim() || `J-${String(existingOrgJudges.length + 1).padStart(2, '0')}`;
    const generatedPin = pin?.trim() || Math.floor(1000 + Math.random() * 9000).toString();
    const newId = generateUUID();

    const newJudge = normalizeJudge({
      id: newId,
      judge_id: assignedJudgeId,
      org_id: cleanOrgId,
      name: name.trim(),
      pin: generatedPin,
      assigned_events: [],
      current_session_token: null,
      created_at: new Date().toISOString(),
    });

    // 1. OPTIMISTIC WRITE: Save to local cache immediately & notify UI
    const judgesSnapshot = [...judges];
    saveCache(STORAGE_KEYS.JUDGES, [newJudge, ...judges], false);
    invalidateCache(`${STORAGE_KEYS.JUDGES}_${cleanOrgId}`);

    const payload = {
      id: newJudge.id,
      org_id: newJudge.org_id,
      name: newJudge.name,
      judge_id: newJudge.judge_id,
      pin: newJudge.pin,
      assigned_events: newJudge.assigned_events,
      current_session_token: newJudge.current_session_token,
    };

    // 2. BACKGROUND CLOUD SYNC
    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        const rpcRes = await callSecuredWriteRpc<SupabaseJudge>('judge_upsert', { p_record: payload });
        const createdRow = rpcRes.data;
        if (createdRow) {
          const synced = normalizeJudge(createdRow);
          const currentList = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
          saveCache(
            STORAGE_KEYS.JUDGES,
            currentList.map((j) => (j.id === synced.id ? synced : j)),
            true
          );
        }
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.JUDGES, judgesSnapshot, false);
          throw err;
        }
        console.warn('Offline mode: judge saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('judges', 'INSERT', newJudge.id, payload);
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('judges', 'INSERT', newJudge.id, payload);
    }

    return newJudge;
  },

  async updateJudge(judgeId: string, updates: Partial<SupabaseJudge>): Promise<SupabaseJudge> {
    const cleanPin = updates.pin?.trim() || updates.judge_pin?.trim();
    const judgesSnapshot = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    const judges = [...judgesSnapshot];
    const idx = judges.findIndex((j) => j.id === judgeId || j.judge_id === judgeId);
    const existing = idx !== -1 ? judges[idx] : null;

    const updated = normalizeJudge({
      ...(existing || {}),
      ...updates,
      pin: cleanPin || existing?.pin || '0000',
    });

    // 1. OPTIMISTIC WRITE: Save to local cache & notify UI
    if (idx !== -1) {
      judges[idx] = updated;
    } else {
      judges.unshift(updated);
    }
    saveCache(STORAGE_KEYS.JUDGES, judges, false);
    if (updated.org_id) {
      invalidateCache(`${STORAGE_KEYS.JUDGES}_${updated.org_id.toUpperCase()}`);
    }

    const dbUpdates: Record<string, any> = { ...updates };
    if (cleanPin) dbUpdates.pin = cleanPin;
    delete dbUpdates.judge_pin;

    // 2. BACKGROUND CLOUD SYNC
    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        const rpcRes = await callSecuredWriteRpc<SupabaseJudge>('judge_update', {
          p_judge_id: judgeId,
          p_updates: dbUpdates,
        });
        const syncedRow = rpcRes.data;
        if (syncedRow) {
          const synced = normalizeJudge(syncedRow);
          const currentList = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
          saveCache(
            STORAGE_KEYS.JUDGES,
            currentList.map((j) => (j.id === judgeId ? synced : j)),
            true
          );
        }
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.JUDGES, judgesSnapshot, false);
          throw err;
        }
        console.warn('Offline mode: judge update saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('judges', 'UPDATE', judgeId, dbUpdates);
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('judges', 'UPDATE', judgeId, dbUpdates);
    }

    return updated;
  },

  async deleteJudge(judgeId: string): Promise<void> {
    // PRE-FLIGHT LOCK CHECK: Check ALL events before any mutation
    const allEvents = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const lockedEvent = allEvents.find(
      (e) => e.is_locked && (e.assigned_judges || []).some((j) => j === judgeId)
    );
    if (lockedEvent) {
      const err = new Error(`ROSTER_LOCKED: Cannot delete judge. Assigned to locked event "${lockedEvent.name}". Unlock event first.`);
      (err as any).code = 'ROSTER_LOCKED';
      throw err;
    }

    const judgesSnapshot = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    const target = judgesSnapshot.find((j) => j.id === judgeId || j.judge_id === judgeId);
    const remaining = judgesSnapshot.filter((j) => j.id !== judgeId && j.judge_id !== judgeId);
    saveCache(STORAGE_KEYS.JUDGES, remaining, false);
    if (target?.org_id) {
      invalidateCache(`${STORAGE_KEYS.JUDGES}_${target.org_id.toUpperCase()}`);
    }

    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        await callSecuredWriteRpc('judge_delete', { p_judge_id: judgeId });
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.JUDGES, judgesSnapshot, false);
          throw err;
        }
        console.warn('Offline mode: judge deletion saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('judges', 'DELETE', judgeId, null);
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('judges', 'DELETE', judgeId, null);
    }
  },

  // ------------------------------------------
  // 5. PARTICIPANTS (Optimistic Mutations + SWR)
  // ------------------------------------------
  async getParticipants(orgId: string, force: boolean = false): Promise<SupabaseParticipant[]> {
    const cleanOrgId = orgId.trim().toUpperCase();
    const cacheKey = `${STORAGE_KEYS.PARTICIPANTS}_${cleanOrgId}`;
    const cached = this.getCachedParticipants(cleanOrgId);

    // 5-Minute SWR Cache Throttle
    if (!force && isCacheValid(cacheKey) && cached.length > 0) {
      return cached;
    }

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('participants')
          .select('*')
          .ilike('org_id', cleanOrgId)
          .order('created_at', { ascending: true });

        if (!error && data) {
          const allCached = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
          const otherOrgParticipants = allCached.filter(
            (p) => (p.org_id || '').trim().toUpperCase() !== cleanOrgId
          );
          const changed = !areRecordsEqual(cached, data);
          saveCache(STORAGE_KEYS.PARTICIPANTS, [...data, ...otherOrgParticipants], !changed);
          updateCacheTimestamp(cacheKey);
          return data;
        }
        if (error) console.warn('Supabase getParticipants fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getParticipants network fallback:', err?.message || err);
      }
    } else {
      updateCacheTimestamp(cacheKey);
    }

    return cached;
  },

  async createParticipant(
    orgId: string,
    data: {
      identity_id?: string;
      sl_no?: string;
      name: string;
      school?: string;
      class_or_age?: string;
      mobile_number?: string;
      custom_values?: Record<string, string>;
    }
  ): Promise<SupabaseParticipant> {
    const cleanOrgId = orgId.trim().toUpperCase();
    const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const existingOrgParticipants = participants.filter(
      (p) => p.org_id.toUpperCase() === cleanOrgId
    );
    const assignedSl =
      data.sl_no?.trim() || String(existingOrgParticipants.length + 1).padStart(2, '0');
    const newId = generateUUID();
    const now = new Date().toISOString();

    const newParticipant: SupabaseParticipant = {
      id: newId,
      org_id: cleanOrgId,
      identity_id: data.identity_id?.trim() || generateIdentityId(),
      sl_no: assignedSl,
      name: data.name.trim(),
      school: data.school?.trim() || 'General',
      class_or_age: data.class_or_age?.trim() || '',
      mobile_number: data.mobile_number?.trim() || '',
      custom_values: data.custom_values || {},
      created_at: now,
    };

    // 1. OPTIMISTIC WRITE: Save to local cache immediately & notify UI
    const participantsSnapshot = [...participants];
    saveCache(STORAGE_KEYS.PARTICIPANTS, [newParticipant, ...participants], false);
    invalidateCache(`${STORAGE_KEYS.PARTICIPANTS}_${cleanOrgId}`);

    const payload = {
      id: newParticipant.id,
      org_id: newParticipant.org_id,
      identity_id: newParticipant.identity_id,
      sl_no: newParticipant.sl_no,
      name: newParticipant.name,
      school: newParticipant.school,
      class_or_age: newParticipant.class_or_age,
      mobile_number: newParticipant.mobile_number,
      custom_values: newParticipant.custom_values,
    };

    // 2. BACKGROUND CLOUD SYNC
    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        const rpcRes = await callSecuredWriteRpc<SupabaseParticipant[]>('participant_upsert_batch', {
          p_records: [payload],
        });
        const createdRow = Array.isArray(rpcRes.data) ? rpcRes.data[0] : null;
        if (createdRow) {
          const currentList = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
          saveCache(
            STORAGE_KEYS.PARTICIPANTS,
            currentList.map((p) => (p.id === createdRow.id ? createdRow : p)),
            true
          );
        }
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.PARTICIPANTS, participantsSnapshot, false);
          throw err;
        }
        console.warn('Offline mode: participant saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('participants', 'INSERT', newParticipant.id, payload);
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('participants', 'INSERT', newParticipant.id, payload);
    }

    return newParticipant;
  },

  async bulkCreateParticipants(
    orgId: string,
    rows: Array<{
      identity_id?: string;
      sl_no?: string;
      name: string;
      school?: string;
      class_or_age?: string;
      mobile_number?: string;
      custom_values?: Record<string, string>;
    }>
  ): Promise<number> {
    const cleanOrgId = orgId.trim().toUpperCase();
    const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const existingOrgCount = participants.filter(
      (p) => p.org_id.toUpperCase() === cleanOrgId
    ).length;

    const usedIds = new Set<string>(participants.map((p) => p.identity_id));
    const makeUniqueIdentityId = (provided?: string) => {
      let candidate = provided?.trim() || generateIdentityId();
      while (usedIds.has(candidate)) {
        candidate = generateIdentityId();
      }
      usedIds.add(candidate);
      return candidate;
    };

    const newItems: SupabaseParticipant[] = rows.map((r, i) => ({
      id: generateUUID(),
      org_id: cleanOrgId,
      identity_id: makeUniqueIdentityId(r.identity_id),
      sl_no: r.sl_no ? r.sl_no.trim() : String(existingOrgCount + i + 1).padStart(2, '0'),
      name: r.name.trim(),
      school: r.school ? r.school.trim() : 'General',
      class_or_age: r.class_or_age ? r.class_or_age.trim() : '',
      mobile_number: r.mobile_number ? r.mobile_number.trim() : '',
      custom_values: r.custom_values || {},
      created_at: new Date().toISOString(),
    }));

    // 1. OPTIMISTIC WRITE: Save to local cache immediately & notify UI
    const participantsSnapshot = [...participants];
    saveCache(STORAGE_KEYS.PARTICIPANTS, [...newItems, ...participants], false);
    invalidateCache(`${STORAGE_KEYS.PARTICIPANTS}_${cleanOrgId}`);

    const payloads = newItems.map((item) => ({
      id: item.id,
      org_id: item.org_id,
      identity_id: item.identity_id,
      sl_no: item.sl_no,
      name: item.name,
      school: item.school,
      class_or_age: item.class_or_age,
      mobile_number: item.mobile_number,
      custom_values: item.custom_values,
    }));

    // 2. BACKGROUND CLOUD SYNC
    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        const rpcRes = await callSecuredWriteRpc<SupabaseParticipant[]>('participant_upsert_batch', {
          p_records: payloads,
        });
        const createdRows = rpcRes.data;
        if (createdRows) {
          const currentList = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
          const dataMap = new Map(createdRows.map((d: any) => [d.id, d]));
          saveCache(
            STORAGE_KEYS.PARTICIPANTS,
            currentList.map((p) => (dataMap.has(p.id) ? dataMap.get(p.id)! : p)),
            true
          );
        }
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.PARTICIPANTS, participantsSnapshot, false);
          throw err;
        }
        console.warn('Offline mode: bulk participants saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('participants', 'INSERT', `bulk_${Date.now()}`, payloads);
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('participants', 'INSERT', `bulk_${Date.now()}`, payloads);
    }

    return newItems.length;
  },

  async updateParticipant(
    participantId: string,
    updates: Partial<SupabaseParticipant>
  ): Promise<SupabaseParticipant> {
    const safeUpdates = { ...updates };
    delete safeUpdates.identity_id;

    const participantsSnapshot = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const participants = [...participantsSnapshot];
    const idx = participants.findIndex((p) => p.id === participantId);
    const existing = idx !== -1 ? participants[idx] : null;

    const updated = {
      ...(existing || { id: participantId, name: 'Participant', org_id: '' }),
      ...safeUpdates,
    } as SupabaseParticipant;

    // 1. OPTIMISTIC WRITE: Update cache & notify UI
    if (idx !== -1) {
      participants[idx] = updated;
    } else {
      participants.unshift(updated);
    }
    saveCache(STORAGE_KEYS.PARTICIPANTS, participants, false);
    if (updated.org_id) {
      invalidateCache(`${STORAGE_KEYS.PARTICIPANTS}_${updated.org_id.toUpperCase()}`);
    }

    // 2. BACKGROUND CLOUD SYNC
    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        const rpcRes = await callSecuredWriteRpc<SupabaseParticipant>('participant_update', {
          p_participant_id: participantId,
          p_updates: safeUpdates,
        });
        const updatedRow = rpcRes.data;
        if (updatedRow) {
          const currentList = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
          saveCache(
            STORAGE_KEYS.PARTICIPANTS,
            currentList.map((p) => (p.id === participantId ? updatedRow : p)),
            true
          );
        }
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.PARTICIPANTS, participantsSnapshot, false);
          throw err;
        }
        console.warn('Offline mode: participant update saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('participants', 'UPDATE', participantId, safeUpdates);
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('participants', 'UPDATE', participantId, safeUpdates);
    }

    return updated;
  },

  /**
   * Smart Deletion & Ledger Integrity Guardrail (Directive 3)
   * 1. Ended Events (Hard Block): If participant has finalized scores in ended/archived event, block deletion.
   * 2. Ongoing Events (Warning): If participant is in active/draft events, require user confirmation.
   * 3. No Events (Safe): Immediate clean deletion.
   */
  async checkParticipantDeletion(participantId: string): Promise<{
    tier: 'blocked' | 'warning' | 'safe';
    reason: string;
    eventNames: string[];
  }> {
    const allEvents = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const allScores = this.getCachedScores();

    // Tier 1: Ended Events Check (The Hard Block)
    const endedEventsWithParticipant = allEvents.filter((e) => {
      const isEnded = e.status === 'ended' || e.status === 'archived';
      if (!isEnded) return false;
      const isAssigned = (e.assigned_participants || []).includes(participantId);
      const hasScores = allScores.some((s) => s.participant_id === participantId && s.event_id === e.id);
      return isAssigned || hasScores;
    });

    if (endedEventsWithParticipant.length > 0) {
      return {
        tier: 'blocked',
        reason: 'ended_events',
        eventNames: endedEventsWithParticipant.map((e) => e.name),
      };
    }

    // Tier 2: Ongoing/Draft Events Check (Warning & Override)
    const ongoingEvents = allEvents.filter((e) => {
      const isOngoing = e.status !== 'ended' && e.status !== 'archived';
      return isOngoing && (e.assigned_participants || []).includes(participantId);
    });

    if (ongoingEvents.length > 0) {
      return {
        tier: 'warning',
        reason: 'ongoing_events',
        eventNames: ongoingEvents.map((e) => e.name),
      };
    }

    // Tier 3: No Events (Safe)
    return {
      tier: 'safe',
      reason: 'no_events',
      eventNames: [],
    };
  },

  async deleteParticipant(participantId: string, forceOverrideActive: boolean = false): Promise<void> {
    // PRE-FLIGHT LOCK CHECK: Check ALL events before any mutation or forceOverrideActive branch
    const allEvents = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const lockedEvent = allEvents.find(
      (e) => e.is_locked && (e.assigned_participants || []).includes(participantId)
    );
    if (lockedEvent) {
      const err = new Error(`ROSTER_LOCKED: Cannot delete participant. Enrolled in locked event "${lockedEvent.name}". Unlock event first.`);
      (err as any).code = 'ROSTER_LOCKED';
      throw err;
    }

    const safety = await this.checkParticipantDeletion(participantId);

    if (safety.tier === 'blocked') {
      throw new Error('Cannot delete: Participant has finalized scores in a completed event.');
    }

    if (safety.tier === 'warning' && !forceOverrideActive) {
      throw new Error('This participant is currently enrolled in active events. Deleting them will pull them from all active rosters. Proceed?');
    }

    // If enrolled in active/draft events, clean from rosters
    if (safety.tier === 'warning' && forceOverrideActive) {
      const currentEvents = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
      for (const evt of currentEvents) {
        if ((evt.assigned_participants || []).includes(participantId)) {
          const updatedAssigned = (evt.assigned_participants || []).filter((id) => id !== participantId);
          const updatedSl = { ...(evt.participant_sl_numbers || {}) };
          delete updatedSl[participantId];
          await this.updateEvent(evt.id, {
            assigned_participants: updatedAssigned,
            participant_sl_numbers: updatedSl,
          });
        }
      }
    }

    const participantsSnapshot = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const target = participantsSnapshot.find((p) => p.id === participantId);
    const remaining = participantsSnapshot.filter((p) => p.id !== participantId);
    saveCache(STORAGE_KEYS.PARTICIPANTS, remaining, false);
    if (target?.org_id) {
      invalidateCache(`${STORAGE_KEYS.PARTICIPANTS}_${target.org_id.toUpperCase()}`);
    }

    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        await callSecuredWriteRpc('participant_delete', { p_participant_id: participantId });
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.PARTICIPANTS, participantsSnapshot, false);
          throw err;
        }
        console.warn('Offline mode: participant deletion saved locally, deferring cloud sync:', err?.message || err);
        await queueMutationLocally('participants', 'DELETE', participantId, null);
      }
    } else if (isSupabaseConfigured()) {
      await queueMutationLocally('participants', 'DELETE', participantId, null);
    }
  },

  // ------------------------------------------
  // 6. SCORES (Optimistic Submissions + SWR)
  // ------------------------------------------
  async getScores(eventId: string, force: boolean = false): Promise<SupabaseScore[]> {
    const cacheKey = `${STORAGE_KEYS.SCORES}_${eventId}`;
    const allCached = this.getCachedScores();
    const eventCached = allCached.filter((s) => s.event_id === eventId);

    // 5-Minute SWR Cache Throttle
    if (!force && isCacheValid(cacheKey) && eventCached.length > 0) {
      return eventCached;
    }

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('scores')
          .select('*')
          .eq('event_id', eventId)
          .order('created_at', { ascending: true });

        if (!error && data) {
          const normalized = data.map(normalizeScore);
          const existingCache = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []).filter(
            (s) => s.event_id !== eventId
          );
          const changed = !areRecordsEqual(eventCached, normalized);
          saveCache(STORAGE_KEYS.SCORES, [...existingCache, ...normalized], !changed);
          updateCacheTimestamp(cacheKey);
          return normalized;
        }
        if (error) console.warn('Supabase getScores fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getScores network fallback:', err?.message || err);
      }
    } else {
      updateCacheTimestamp(cacheKey);
    }

    return eventCached;
  },

  async getAllScores(force: boolean = false): Promise<SupabaseScore[]> {
    const cacheKey = STORAGE_KEYS.SCORES;
    const cached = this.getCachedScores();

    // 5-Minute SWR Cache Throttle
    if (!force && isCacheValid(cacheKey) && cached.length > 0) {
      return cached;
    }

    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('scores')
          .select('*')
          .order('created_at', { ascending: true });

        if (!error && data) {
          const normalized = data.map(normalizeScore);
          const changed = !areRecordsEqual(cached, normalized);
          saveCache(STORAGE_KEYS.SCORES, normalized, !changed);
          updateCacheTimestamp(cacheKey);
          return normalized;
        }
        if (error) console.warn('Supabase getAllScores fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getAllScores network fallback:', err?.message || err);
      }
    } else {
      updateCacheTimestamp(cacheKey);
    }

    return cached;
  },

  async getScoreForJudgeParticipant(
    eventId: string,
    judgeId: string,
    participantId: string
  ): Promise<SupabaseScore | null> {
    if (isSupabaseConfigured()) {
      try {
        const { data, error } = await supabase
          .from('scores')
          .select('*')
          .eq('event_id', eventId)
          .eq('judge_id', judgeId)
          .eq('participant_id', participantId)
          .maybeSingle();

        if (!error && data) return normalizeScore(data);
        if (error) console.warn('Supabase getScore fallback:', error.message || error);
      } catch (err: any) {
        console.warn('Supabase getScore network fallback:', err?.message || err);
      }
    }

    const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    const match = scores.find(
      (s) =>
        s.event_id === eventId && s.judge_id === judgeId && s.participant_id === participantId
    );
    return match ? normalizeScore(match) : null;
  },

  async submitScore(scoreData: {
    event_id: string;
    judge_id: string;
    participant_id: string;
    score_data?: Record<string, number>;
    total_score: number;
    score_payload?: {
      criteria: Record<string, number>;
      total_score: number;
      submitted_at: string;
    };
  }): Promise<SupabaseScore> {
    // 1. Verify Event exists
    const event = await this.getEventById(scoreData.event_id);
    if (!event) throw new Error('Event not found');

    // 2. Verify Judge assigned
    const judge = await this.getJudgeById(scoreData.judge_id);
    if (!judge) throw new Error('Judge not found');

    const isAssigned =
      event.assigned_judges.includes(judge.id) ||
      (judge.assigned_events || []).includes(event.id) ||
      event.status === 'active';
    if (!isAssigned) {
      throw new Error('Judge is not assigned to evaluate this event');
    }

    // 3. Check if score already exists (Strict Immutability with 5-minute grace period support)
    const existing = await this.getScoreForJudgeParticipant(
      scoreData.event_id,
      scoreData.judge_id,
      scoreData.participant_id
    );

    let isWithinGrace = false;
    if (existing) {
      const org = await this.getOrganizationByOrgId(event.org_id);
      const isGraceAllowed = Boolean(org?.grace_period_enabled);
      const diffMs = Date.now() - new Date(existing.created_at).getTime();
      isWithinGrace = isGraceAllowed && diffMs <= 5 * 60 * 1000;

      if (!isWithinGrace) {
        throw new Error(
          'RLS Permission Denied: Scores are immutable and cannot be updated once inserted.'
        );
      }
    }

    const criteriaMap = scoreData.score_data || scoreData.score_payload?.criteria || {};
    const timestamp = new Date().toISOString();
    const payloadJson = scoreData.score_payload || {
      criteria: criteriaMap,
      total_score: scoreData.total_score,
      submitted_at: timestamp,
    };

    // 4. OPTIMISTIC WRITE: Update local cache immediately
    const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    let optimisticScore: SupabaseScore;

    if (existing && isWithinGrace) {
      const idx = scores.findIndex((s) => s.id === existing.id);
      optimisticScore = normalizeScore({
        ...existing,
        score_data: criteriaMap,
        total_score: scoreData.total_score,
        score_payload: payloadJson,
      });
      if (idx !== -1) {
        scores[idx] = optimisticScore;
      }
      saveCache(STORAGE_KEYS.SCORES, scores, false);
    } else {
      optimisticScore = normalizeScore({
        id: generateUUID(),
        event_id: scoreData.event_id,
        judge_id: scoreData.judge_id,
        participant_id: scoreData.participant_id,
        score_data: criteriaMap,
        total_score: scoreData.total_score,
        score_payload: payloadJson,
        created_at: timestamp,
      });
      scores.push(optimisticScore);
      saveCache(STORAGE_KEYS.SCORES, scores, false);
    }

    invalidateCache(STORAGE_KEYS.SCORES);

    // 5. BACKGROUND CLOUD SYNC
    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        const scorePayload = {
          id: existing && isWithinGrace ? existing.id : optimisticScore.id,
          event_id: scoreData.event_id,
          judge_id: scoreData.judge_id,
          participant_id: scoreData.participant_id,
          total_score: scoreData.total_score,
          score_payload: payloadJson,
        };

        const rpcRes = await callSecuredWriteRpc<SupabaseScore[]>('score_upsert_batch', {
          p_records: [scorePayload],
        });

        const syncedRow = Array.isArray(rpcRes.data) ? rpcRes.data[0] : null;
        if (syncedRow) {
          const synced = normalizeScore(syncedRow);
          const currentScores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
          const existsInCache = currentScores.some((s) => s.id === synced.id);
          saveCache(
            STORAGE_KEYS.SCORES,
            existsInCache
              ? currentScores.map((s) => (s.id === synced.id ? synced : s))
              : [...currentScores, synced],
            true
          );
          notifyCloudSync('Score ballot');
          return synced;
        }
      } catch (err: any) {
        if (err?.message?.includes('RLS Permission Denied') || err?.code === 'RLS Permission Denied') {
          throw err;
        }
        const orgBlock = parseOrgEnforcementError(err);
        if (orgBlock) {
          eventBus.emit('org_enforcement', { code: orgBlock });
          await queueScoreLocally(optimisticScore);
          return optimisticScore;
        }
        // On expired/missing session token, STILL queue score locally so judge never loses a ballot.
        if (err?.code === 'unauthorized') {
          await queueScoreLocally(optimisticScore);
          return optimisticScore;
        }
        console.warn('Offline mode: score ballot saved locally, deferring cloud sync:', err?.message || err);
        await queueScoreLocally(optimisticScore);
        notifyOfflineSaved('Score ballot');
      }
    } else if (isSupabaseConfigured()) {
      await queueScoreLocally(optimisticScore);
      notifyOfflineSaved('Score ballot');
    } else {
      notifyOfflineSaved('Score ballot');
    }

    return optimisticScore;
  },

  async deleteScore(scoreId: string): Promise<boolean> {
    const scoresSnapshot = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    saveCache(
      STORAGE_KEYS.SCORES,
      scoresSnapshot.filter((s) => s.id !== scoreId),
      true
    );
    if (isSupabaseConfigured() && isOnlineNavigator()) {
      try {
        await callSecuredWriteRpc('score_delete', { p_score_id: scoreId });
        notifyCloudSync('Score ballot removed');
        return true;
      } catch (err: any) {
        if (isServerRejectionError(err)) {
          saveCache(STORAGE_KEYS.SCORES, scoresSnapshot, false);
          throw err;
        }
        console.warn('deleteScore cloud sync note:', err?.message || err);
      }
    }
    return true;
  },

  // ------------------------------------------
  // 7. TIE-BREAKER ENGINE LOGIC (Multithreaded Web Worker & Fast Fallback)
  // ------------------------------------------
  calculateRankings(
    participants: SupabaseParticipant[],
    scores: SupabaseScore[],
    assignedJudgesCount: number = 0,
    method: TieBreakerMethod = 'olympic',
    tieBreakerEnabled: boolean = false
  ) {
    return engineCalculateRankings(
      participants,
      scores,
      assignedJudgesCount,
      method,
      tieBreakerEnabled
    );
  },

  async calculateRankingsAsync(
    participants: SupabaseParticipant[],
    scores: SupabaseScore[],
    assignedJudgesCount: number = 0,
    method: TieBreakerMethod = 'olympic',
    tieBreakerEnabled: boolean = false
  ) {
    return engineCalculateRankingsAsync(
      participants,
      scores,
      assignedJudgesCount,
      method,
      tieBreakerEnabled
    );
  },
};
