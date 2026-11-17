/**
 * Fair Judge Zero-Trust Authentication Service (Phase 14.4 + Epic 15.7 Stage D2)
 * Enforces strict server-verified credential validation with opaque session tokens.
 * Eliminates all automated insert/upsert fallbacks to prevent phantom duplicate accounts.
 */

import { supabase, isSupabaseConfigured, dbService, getStoredSessionToken } from './supabase';
import {
  Organization,
  SupabaseJudge,
  SupabaseEvent,
} from './supabaseTypes';
import { getHotCache, setIndexedDBCache } from './db/indexedDB';
import { STORAGE_KEYS, generateOrgId } from './supabase';
import { blackBox } from './blackBox';
import { eventBus } from './eventBus';
import { buildDeviceLabel, getOrCreateDeviceId } from './deviceIdentity';

export interface JudgeAuthParams {
  orgId?: string;
  judgeId?: string;
  pin: string;
  eventId?: string;
}

export interface JudgeAuthResult {
  judge: SupabaseJudge;
  assignedEvents: SupabaseEvent[];
  org?: Organization;
  sessionToken?: string;
}

export interface OrganiserAuthResult {
  org: Organization;
  sessionToken?: string;
  mustChange?: boolean;
}

export interface ActiveOrgSession {
  id: string;
  device_label: string;
  created_at: string;
  last_seen_at: string;
  expires_at?: string;
  is_current?: boolean;
  is_same_device?: boolean;
}

export class SessionLimitError extends Error {
  readonly code = 'session_limit' as const;
  readonly sessions: ActiveOrgSession[];

  constructor(sessions: ActiveOrgSession[], message = 'Maximum of 3 active devices reached.') {
    super(message);
    this.name = 'SessionLimitError';
    this.sessions = sessions;
  }
}

const OFFLINE_VERIFIERS_KEY = 'fairjudge_judge_offline_verifiers';
const PBKDF2_ITERATIONS = 100_000;

interface OfflineJudgeVerifier {
  judgeId: string;
  judgeCode?: string;
  judgeName: string;
  orgId: string;
  assignedEvents: string[];
  salt: string;
  hash: string;
  iterations: number;
  updatedAt: string;
  judgeSnapshot: SupabaseJudge;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

async function derivePinHash(pin: string, saltBytes: Uint8Array, iterations: number): Promise<Uint8Array> {
  if (typeof globalThis === 'undefined' || !globalThis.crypto?.subtle) {
    throw new Error('WebCrypto SubtleCrypto is required for offline PIN verification.');
  }
  const encoder = new TextEncoder();
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    encoder.encode(pin.trim().toLowerCase()),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return new Uint8Array(bits);
}

function readOfflineVerifiers(): OfflineJudgeVerifier[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(OFFLINE_VERIFIERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeOfflineVerifiers(list: OfflineJudgeVerifier[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(OFFLINE_VERIFIERS_KEY, JSON.stringify(list));
  } catch {}
}

async function saveOfflineJudgeVerifier(judge: SupabaseJudge, rawPin: string): Promise<void> {
  if (!rawPin.trim() || typeof globalThis === 'undefined' || !globalThis.crypto?.subtle) return;
  try {
    const saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const derived = await derivePinHash(rawPin, saltBytes, PBKDF2_ITERATIONS);
    const scrubbedJudge: SupabaseJudge = {
      ...judge,
      pin: '',
      judge_pin: '',
      current_session_token: null,
      assigned_events: Array.isArray(judge.assigned_events) ? judge.assigned_events : [],
    };
    const record: OfflineJudgeVerifier = {
      judgeId: scrubbedJudge.id,
      judgeCode: scrubbedJudge.judge_id,
      judgeName: scrubbedJudge.name,
      orgId: scrubbedJudge.org_id,
      assignedEvents: scrubbedJudge.assigned_events,
      salt: bytesToBase64(saltBytes),
      hash: bytesToBase64(derived),
      iterations: PBKDF2_ITERATIONS,
      updatedAt: new Date().toISOString(),
      judgeSnapshot: scrubbedJudge,
    };
    const existing = readOfflineVerifiers().filter((v) => v.judgeId !== scrubbedJudge.id);
    writeOfflineVerifiers([record, ...existing].slice(0, 20));
  } catch {
    // Non-fatal if WebCrypto unavailable
  }
}

async function verifyOfflineJudgePin(params: {
  cleanOrgId: string;
  cleanJudgeId: string;
  cleanPin: string;
  cleanEventId: string;
}): Promise<SupabaseJudge | null> {
  const { cleanOrgId, cleanJudgeId, cleanPin, cleanEventId } = params;
  const verifiers = readOfflineVerifiers();
  if (verifiers.length === 0) return null;

  for (const v of verifiers) {
    if (cleanOrgId && String(v.orgId || '').toUpperCase() !== cleanOrgId) continue;

    if (cleanJudgeId) {
      const idMatches =
        String(v.judgeId || '').toLowerCase() === cleanJudgeId.toLowerCase() ||
        String(v.judgeCode || '').toLowerCase() === cleanJudgeId.toLowerCase() ||
        String(v.judgeName || '').toLowerCase() === cleanJudgeId.toLowerCase();
      if (!idMatches) continue;
    }

    if (cleanEventId) {
      const assignedMatches = Array.isArray(v.assignedEvents) && v.assignedEvents.includes(cleanEventId);
      if (!assignedMatches) continue;
    }

    try {
      const saltBytes = base64ToBytes(v.salt);
      const expectedBytes = base64ToBytes(v.hash);
      const derived = await derivePinHash(cleanPin, saltBytes, v.iterations || PBKDF2_ITERATIONS);
      if (constantTimeEqual(derived, expectedBytes)) {
        return {
          ...v.judgeSnapshot,
          pin: '',
          judge_pin: '',
          current_session_token: null,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export const authService = {
  /**
   * ARCHITECTURAL DIRECTIVE 1: JUDGE AUTHENTICATION LOCKDOWN
   * Validates credentials against server `judge_login` RPC (bcrypt via judge_secrets)
   * and uses salted PBKDF2-SHA256 local verifier when offline (zero plaintext PIN storage).
   */
  async authenticateJudge(params: JudgeAuthParams): Promise<JudgeAuthResult> {
    const cleanOrgId = (params.orgId || '').trim().toUpperCase();
    const cleanJudgeId = (params.judgeId || '').trim();
    const cleanPin = (params.pin || '').trim();
    const cleanEventId = (params.eventId || '').trim();

    if (!cleanPin) {
      throw new Error('Authentication Failed: Invalid ID or PIN. Please request a new QR code.');
    }

    let authenticatedJudge: SupabaseJudge | null = null;
    let targetOrgId = cleanOrgId;
    let sessionToken: string | undefined;
    let rpcAssignedEvents: SupabaseEvent[] | null = null;
    let rpcOrg: Organization | undefined;

    // 1. ONLINE VALIDATION: Server-side `judge_login` RPC only
    if (isSupabaseConfigured() && typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        const { data: rpcData, error: rpcError } = await supabase.rpc('judge_login', {
          p_org_id: cleanOrgId || null,
          p_judge_id: cleanJudgeId || null,
          p_pin: cleanPin,
          p_event_id: cleanEventId || null,
        });

        if (rpcError) {
          const msg = (rpcError.message || '').toLowerCase();
          if (rpcError.code === 'PGRST202' || rpcError.code === '42883' || msg.includes('judge_login')) {
            throw new Error(
              'Authentication service unavailable: judge_login RPC is missing. Run the latest SQL migration.'
            );
          }
          throw rpcError;
        } else {
          const res = rpcData as any;
          if (!res || !res.ok || !res.judge) {
            const errCode = res?.error || res?.reason;
            if (errCode === 'too_many_attempts') {
              throw new Error('Too many attempts. Try again in 15 minutes.');
            }
            if (errCode === 'org_deleted') {
              throw new Error('This organization has been removed.');
            }
            if (errCode === 'org_suspended') {
              const reason = typeof res?.detail === 'string' && res.detail.trim() ? `: ${res.detail.trim()}` : '';
              throw new Error(`This organization is suspended${reason}`);
            }
            throw new Error('Authentication Failed: Invalid ID or PIN. Please request a new QR code.');
          }

          // Zero plaintext PIN / session token stored on judge device
          const matchedJudge: SupabaseJudge = {
            ...res.judge,
            pin: '',
            judge_pin: '',
            current_session_token: null,
            assigned_events: Array.isArray(res.judge.assigned_events) ? res.judge.assigned_events : [],
          };
          authenticatedJudge = matchedJudge;
          targetOrgId = matchedJudge.org_id;
          sessionToken = typeof res.session_token === 'string' ? res.session_token : undefined;

          if (Array.isArray(res.assigned_events)) {
            rpcAssignedEvents = res.assigned_events;
          }
          if (res.org) {
            const cleanOrg = { ...res.org };
            delete cleanOrg.password;
            rpcOrg = cleanOrg as Organization;
          }

          await saveOfflineJudgeVerifier(matchedJudge, cleanPin);

          const currentCached = getHotCache<SupabaseJudge[]>(STORAGE_KEYS.JUDGES, []).map((j) => ({
            ...j,
            pin: '',
            judge_pin: '',
            current_session_token: null,
          }));
          await setIndexedDBCache(
            STORAGE_KEYS.JUDGES,
            [matchedJudge, ...currentCached.filter((j) => j.id !== matchedJudge.id)],
            true
          );
        }
      } catch (cloudErr: any) {
        if (
          cloudErr.message?.includes('Authentication Failed') ||
          cloudErr.message?.includes('Authentication service unavailable') ||
          cloudErr.message?.includes('Too many attempts') ||
          cloudErr.message?.includes('organization is suspended') ||
          cloudErr.message?.includes('organization has been removed')
        ) {
          throw cloudErr;
        }
        console.warn('judge_login RPC network notice, evaluating offline verifier:', cloudErr);
      }
    }

    // 2. OFFLINE VALIDATION: Salted PBKDF2-SHA256 local verifier (zero plaintext PIN stored)
    if (!authenticatedJudge) {
      const matched = await verifyOfflineJudgePin({
        cleanOrgId,
        cleanJudgeId,
        cleanPin,
        cleanEventId,
      });

      if (matched) {
        authenticatedJudge = matched;
        targetOrgId = matched.org_id;
      }
    }

    // 3. ZERO AUTO-CREATION: Strict Rejection if null or 0 rows
    if (!authenticatedJudge || !targetOrgId) {
      throw new Error('Authentication Failed: Invalid ID or PIN. Please request a new QR code.');
    }

    // Fetch assigned events for the authenticated judge
    let assignedEvents: SupabaseEvent[] = [];
    if (rpcAssignedEvents) {
      assignedEvents = rpcAssignedEvents;
    } else {
      try {
        const orgEvents = await dbService.getEvents(targetOrgId);
        assignedEvents = orgEvents.filter(
          (e) =>
            e.assigned_judges.includes(authenticatedJudge!.id) ||
            (authenticatedJudge!.assigned_events || []).includes(e.id) ||
            e.status === 'active'
        );
      } catch {
        const cachedEvents = dbService.getCachedEvents(targetOrgId);
        assignedEvents = cachedEvents.filter(
          (e) =>
            e.assigned_judges.includes(authenticatedJudge!.id) ||
            (authenticatedJudge!.assigned_events || []).includes(e.id) ||
            e.status === 'active'
        );
      }
    }

    return {
      judge: authenticatedJudge,
      assignedEvents,
      org: rpcOrg,
      sessionToken,
    };
  },

  /**
   * ARCHITECTURAL DIRECTIVE 2: ORGANISER SIGN-IN LOCKDOWN (Epic 15.7 Step B2 + Stage D2)
   * Secure database RPC authentication with bcrypt verification, brute-force lockout,
   * and server-issued session token.
   */
  async loginOrganiser(identifier: string, password: string): Promise<OrganiserAuthResult> {
    const cleanId = identifier.trim();
    const cleanPass = password.trim();

    if (!cleanId || !cleanPass) {
      throw new Error('Invalid Organization ID or Master Password.');
    }

    if (!isSupabaseConfigured() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      throw new Error('Organiser sign-in needs an internet connection.');
    }

    try {
      const deviceId = getOrCreateDeviceId();
      const deviceLabel = buildDeviceLabel();

      const { data, error } = await supabase.rpc('org_login_v2', {
        p_identifier: cleanId,
        p_password: cleanPass,
        p_device_id: deviceId,
        p_device_label: deviceLabel,
      });

      if (error) {
        throw error;
      }

      const res = data as any;
      if (!res || !res.ok) {
        const errCode = res?.error || res?.reason;
        if (errCode === 'session_limit') {
          const sessions: ActiveOrgSession[] = Array.isArray(res?.sessions) ? res.sessions : [];
          throw new SessionLimitError(sessions);
        }
        if (errCode === 'too_many_attempts') {
          throw new Error('Too many attempts. Try again in 15 minutes.');
        }
        if (errCode === 'org_deleted') {
          throw new Error('This organization has been removed.');
        }
        if (errCode === 'org_suspended') {
          const reason = typeof res?.detail === 'string' && res.detail.trim() ? `: ${res.detail.trim()}` : '';
          throw new Error(`This organization is suspended${reason}`);
        }
        throw new Error('Invalid Organization ID or Master Password.');
      }

      const foundOrg = { ...res.org };
      delete foundOrg.password;

      const currentOrgs = getHotCache<Organization[]>(STORAGE_KEYS.ORGS, []);
      await setIndexedDBCache(
        STORAGE_KEYS.ORGS,
        [foundOrg, ...currentOrgs.filter((o) => o.org_id.toUpperCase() !== foundOrg.org_id.toUpperCase())],
        true
      );

      return {
        org: foundOrg as Organization,
        sessionToken: typeof res.session_token === 'string' ? res.session_token : undefined,
        mustChange: Boolean(res.must_change),
      };
    } catch (err: any) {
      if (err instanceof SessionLimitError || err?.code === 'session_limit') {
        throw err;
      }
      if (
        err.message === 'Organiser sign-in needs an internet connection.' ||
        err.message === 'Too many attempts. Try again in 15 minutes.' ||
        err.message === 'Invalid Organization ID or Master Password.' ||
        err.message === 'This organization has been removed.' ||
        err.message?.startsWith('This organization is suspended')
      ) {
        throw err;
      }
      if (err.message?.includes('too_many_attempts')) {
        throw new Error('Too many attempts. Try again in 15 minutes.');
      }
      throw new Error('Invalid Organization ID or Master Password.');
    }
  },

  /**
   * Revokes one of the 3 active organiser sessions when a 4th device hits session_limit.
   * Server re-verifies identifier + password and shares brute-force throttling.
   */
  async evictSessionOnLimit(identifier: string, password: string, sessionId: string): Promise<void> {
    const cleanId = identifier.trim();
    const cleanPass = password.trim();

    if (!isSupabaseConfigured() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      throw new Error('Needs an internet connection to manage active sessions.');
    }

    const { data, error } = await supabase.rpc('org_session_revoke_on_limit', {
      p_identifier: cleanId,
      p_password: cleanPass,
      p_session_id: sessionId,
    });

    if (error) {
      throw new Error('Could not log out that device. Please try again.');
    }

    const res = data as any;
    if (!res || !res.ok) {
      const errCode = res?.error || res?.reason;
      if (errCode === 'too_many_attempts') {
        throw new Error('Too many attempts. Try again in 15 minutes.');
      }
      if (errCode === 'invalid_credentials') {
        throw new Error('Invalid Organization ID or Master Password.');
      }
      if (errCode === 'not_found') {
        // Already logged out or expired — safe to retry login
        return;
      }
      throw new Error('Could not log out that device. Please try again.');
    }
  },

  /**
   * ARCHITECTURAL DIRECTIVE 2: ORGANISER REGISTRATION LOCKDOWN (Epic 15.7 Step B2 + Stage D2)
   * Secure database RPC registration with bcrypt password hashing in org_secrets
   * and server-issued session token.
   */
  async registerOrganiser(name: string, email?: string, password?: string): Promise<OrganiserAuthResult> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error('Registration requires an active internet connection. Please connect to the network to create an organization.');
    }
    if (!isSupabaseConfigured()) {
      throw new Error('Database is not configured.');
    }

    const cleanName = name.trim();
    if (!cleanName) {
      throw new Error('Please enter a valid organisation name.');
    }

    const cleanEmail = email?.trim() || null;
    const cleanPassword = password?.trim() || 'password123';
    const newOrgId = generateOrgId();

    const { data, error } = await supabase.rpc('org_register', {
      p_org_id: newOrgId,
      p_name: cleanName,
      p_email: cleanEmail,
      p_password: cleanPassword,
    });

    if (error) {
      blackBox.recordError('security', `RPC org_register error: ${error.message}`, 'authService.registerOrganiser');
      if (error.code === '23505' || error.message?.includes('duplicate key') || error.message?.includes('unique constraint')) {
        throw new Error('Registration Failed: Organization ID or Email is already in use.');
      }
      throw new Error('Could not create the organisation. Please try again.');
    }

    const res = data as any;
    if (!res || !res.ok) {
      const errCode = res?.error || res?.reason;
      if (errCode === 'duplicate') {
        throw new Error('Registration Failed: Organization ID or Email is already in use.');
      }
      if (errCode === 'weak_password') {
        throw new Error('Registration Failed: Password must be at least 6 characters.');
      }
      if (errCode === 'invalid_input') {
        throw new Error('Registration Failed: Please check your organization name and password.');
      }
      blackBox.recordError('security', `RPC org_register rejected: ${JSON.stringify(res)}`, 'authService.registerOrganiser');
      throw new Error('Could not create the organisation. Please try again.');
    }

    const created: Organization = { ...res.org };
    delete (created as any).password;

    const cachedOrgs = getHotCache<Organization[]>(STORAGE_KEYS.ORGS, []);
    await setIndexedDBCache(
      STORAGE_KEYS.ORGS,
      [created, ...cachedOrgs.filter((o) => o.org_id !== created.org_id)],
      false
    );

    return {
      org: created,
      sessionToken: typeof res.session_token === 'string' ? res.session_token : undefined,
    };
  },

  /**
   * Revokes active session token in Supabase when signing out (best-effort).
   */
  async logoutSession(role: 'organiser' | 'judge', token?: string | null): Promise<void> {
    if (!token || !isSupabaseConfigured() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      return;
    }
    try {
      const rpcName = role === 'organiser' ? 'org_logout' : 'judge_logout';
      await supabase.rpc(rpcName, { p_token: token });
    } catch {
      // Best-effort revocation; local session is still cleared immediately
    }
  },

  /**
   * Lists active organiser sessions for the Account Modal (server checks token_hash).
   */
  async listOrgSessions(
    tokenOverride?: string | null
  ): Promise<{ ok: boolean; sessions: ActiveOrgSession[]; unauthorized?: boolean; error?: string }> {
    const token = (tokenOverride ?? getStoredSessionToken() ?? '').trim();
    if (!token) {
      return { ok: false, sessions: [], unauthorized: true, error: 'Session missing.' };
    }
    if (!isSupabaseConfigured() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      return { ok: false, sessions: [], error: 'Needs internet to load active sessions.' };
    }

    const { data, error } = await supabase.rpc('org_sessions_list', {
      p_token: token,
    });

    if (error) {
      return { ok: false, sessions: [], error: error.message || 'Could not load active sessions.' };
    }

    const res = data as any;
    if (!res || !res.ok) {
      if (res?.error === 'unauthorized') {
        eventBus.emit('session_expired', { role: 'organiser', reason: 'expired' });
        return { ok: false, sessions: [], unauthorized: true, error: 'Session expired.' };
      }
      return { ok: false, sessions: [], error: res?.error || 'Could not load active sessions.' };
    }

    return {
      ok: true,
      sessions: Array.isArray(res.sessions) ? (res.sessions as ActiveOrgSession[]) : [],
    };
  },

  /**
   * Terminates another active organiser session (server refuses current device).
   */
  async terminateOrgSession(sessionId: string, tokenOverride?: string | null): Promise<void> {
    const token = (tokenOverride ?? getStoredSessionToken() ?? '').trim();
    if (!token) {
      eventBus.emit('session_expired', { role: 'organiser', reason: 'missing' });
      throw new Error('Session expired. Please sign in again.');
    }
    if (!isSupabaseConfigured() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      throw new Error('Needs internet to terminate a session.');
    }

    const { data, error } = await supabase.rpc('org_session_terminate', {
      p_token: token,
      p_session_id: sessionId,
    });

    if (error) {
      throw new Error(error.message || 'Could not terminate session.');
    }

    const res = data as any;
    if (!res || !res.ok) {
      if (res?.error === 'unauthorized') {
        eventBus.emit('session_expired', { role: 'organiser', reason: 'expired' });
        throw new Error('Session expired. Please sign in again.');
      }
      if (res?.error === 'cannot_terminate_current') {
        throw new Error('This device cannot be terminated from its own session list.');
      }
      if (res?.error === 'not_found') {
        return;
      }
      throw new Error('Could not terminate session.');
    }
  },

  /**
   * Terminates all other active organiser sessions while keeping this device signed in.
   */
  async terminateOtherOrgSessions(tokenOverride?: string | null): Promise<number> {
    const token = (tokenOverride ?? getStoredSessionToken() ?? '').trim();
    if (!token) {
      eventBus.emit('session_expired', { role: 'organiser', reason: 'missing' });
      throw new Error('Session expired. Please sign in again.');
    }
    if (!isSupabaseConfigured() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      throw new Error('Needs internet to terminate other sessions.');
    }

    const { data, error } = await supabase.rpc('org_sessions_terminate_others', {
      p_token: token,
    });

    if (error) {
      throw new Error(error.message || 'Could not terminate other sessions.');
    }

    const res = data as any;
    if (!res || !res.ok) {
      if (res?.error === 'unauthorized') {
        eventBus.emit('session_expired', { role: 'organiser', reason: 'expired' });
        throw new Error('Session expired. Please sign in again.');
      }
      throw new Error('Could not terminate other sessions.');
    }

    return Number(res.terminated_count ?? 0);
  },

  /**
   * Changes master password and terminates all other active sessions (keeping current).
   */
  async changeOrganiserPassword(
    oldPassword: string,
    newPassword: string,
    tokenOverride?: string | null
  ): Promise<{ ok: true; terminatedOthers: number }> {
    const token = (tokenOverride ?? getStoredSessionToken() ?? '').trim();
    if (!token) {
      eventBus.emit('session_expired', { role: 'organiser', reason: 'missing' });
      throw new Error('Session expired. Please verify your credentials.');
    }
    if (!isSupabaseConfigured() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      throw new Error('Needs internet to update password.');
    }

    const { data, error } = await supabase.rpc('org_change_password_v2', {
      p_token: token,
      p_old: oldPassword.trim(),
      p_new: newPassword.trim(),
    });

    if (error) {
      throw error;
    }

    const res = data as any;
    if (!res || !res.ok) {
      const errCode = res?.error || res?.reason;
      if (errCode === 'unauthorized') {
        eventBus.emit('session_expired', { role: 'organiser', reason: 'expired' });
        const err = new Error('Session expired. Please sign in again.');
        (err as any).code = 'unauthorized';
        throw err;
      }
      if (errCode === 'too_many_attempts') {
        const err = new Error('too_many_attempts');
        (err as any).code = 'too_many_attempts';
        throw err;
      }
      if (errCode === 'weak_password') {
        const err = new Error('weak_password');
        (err as any).code = 'weak_password';
        throw err;
      }
      const err = new Error('invalid_credentials');
      (err as any).code = errCode || 'invalid_credentials';
      throw err;
    }

    return {
      ok: true,
      terminatedOthers: Number(res.terminated_others ?? 0),
    };
  },
};
