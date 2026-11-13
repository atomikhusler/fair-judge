/**
 * Fair Judge Zero-Trust Authentication Service (Phase 14.4 + Epic 15.7 Stage D2)
 * Enforces strict server-verified credential validation with opaque session tokens.
 * Eliminates all automated insert/upsert fallbacks to prevent phantom duplicate accounts.
 */

import { supabase, isSupabaseConfigured, dbService } from './supabase';
import {
  Organization,
  SupabaseJudge,
  SupabaseEvent,
} from './supabaseTypes';
import { getHotCache, setIndexedDBCache } from './db/indexedDB';
import { STORAGE_KEYS, generateOrgId } from './supabase';
import { blackBox } from './blackBox';

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
}

export const authService = {
  /**
   * ARCHITECTURAL DIRECTIVE 1: JUDGE AUTHENTICATION LOCKDOWN
   * Prefers server-side `judge_login` RPC (mints judge_sessions token).
   * Falls back to read-only SELECT only if RPC is not yet deployed, and to
   * IndexedDB cache only when offline/unreachable.
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

    // 1. ONLINE VALIDATION: Server-side `judge_login` RPC first
    if (isSupabaseConfigured() && typeof navigator !== 'undefined' && navigator.onLine) {
      let useLegacySelectFallback = false;

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
            useLegacySelectFallback = true;
          } else {
            throw rpcError;
          }
        } else {
          const res = rpcData as any;
          if (!res || !res.ok || !res.judge) {
            throw new Error('Authentication Failed: Invalid ID or PIN. Please request a new QR code.');
          }

          const matchedJudge: SupabaseJudge = {
            ...res.judge,
            pin: res.judge.pin || cleanPin,
            judge_pin: res.judge.pin || cleanPin,
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

          const currentCached = getHotCache<SupabaseJudge[]>(STORAGE_KEYS.JUDGES, []);
          await setIndexedDBCache(
            STORAGE_KEYS.JUDGES,
            [matchedJudge, ...currentCached.filter((j) => j.id !== matchedJudge.id)],
            true
          );
        }
      } catch (cloudErr: any) {
        if (cloudErr.message?.includes('Authentication Failed')) {
          throw cloudErr;
        }
        console.warn('judge_login RPC notice, evaluating fallback:', cloudErr);
        if (!useLegacySelectFallback) {
          // Network or transient error: fall through to offline cache check below
        }
      }

      // Transitional fallback only when `judge_login` RPC is not yet deployed in Supabase
      if (!authenticatedJudge && useLegacySelectFallback) {
        try {
          let query = supabase.from('judges').select('*').eq('pin', cleanPin);
          if (cleanOrgId) {
            query = query.ilike('org_id', cleanOrgId);
          }

          const { data, error } = await query;

          if (!error && data && data.length > 0) {
            const match = data.find((j: any) => {
              const pinMatches =
                String(j.pin || '').trim().toLowerCase() === cleanPin.toLowerCase() ||
                String(j.judge_pin || '').trim().toLowerCase() === cleanPin.toLowerCase();
              if (!pinMatches) return false;

              if (cleanJudgeId) {
                const idMatches =
                  String(j.id || '').toLowerCase() === cleanJudgeId.toLowerCase() ||
                  String(j.judge_id || '').toLowerCase() === cleanJudgeId.toLowerCase() ||
                  String(j.name || '').toLowerCase() === cleanJudgeId.toLowerCase();
                if (!idMatches) return false;
              }

              if (cleanOrgId && String(j.org_id || '').toUpperCase() !== cleanOrgId) return false;

              if (cleanEventId) {
                const eventColMatches = String((j as any).event_id || '') === cleanEventId;
                const assignedArrayMatches = Array.isArray(j.assigned_events) && j.assigned_events.includes(cleanEventId);
                if (!eventColMatches && !assignedArrayMatches) return false;
              }
              return true;
            });

            if (match) {
              authenticatedJudge = {
                ...match,
                pin: cleanPin,
                judge_pin: cleanPin,
                assigned_events: Array.isArray(match.assigned_events) ? match.assigned_events : [],
              };
              targetOrgId = match.org_id;

              const currentCached = getHotCache<SupabaseJudge[]>(STORAGE_KEYS.JUDGES, []);
              if (!currentCached.some((j) => j.id === authenticatedJudge!.id)) {
                await setIndexedDBCache(STORAGE_KEYS.JUDGES, [authenticatedJudge, ...currentCached], true);
              }
            } else {
              throw new Error('Authentication Failed: Invalid ID or PIN. Please request a new QR code.');
            }
          } else if (!error && (!data || data.length === 0)) {
            throw new Error('Authentication Failed: Invalid ID or PIN. Please request a new QR code.');
          }
        } catch (legacyErr: any) {
          if (legacyErr.message?.includes('Authentication Failed')) {
            throw legacyErr;
          }
          console.warn('Zero-trust cloud verification network issue, evaluating local cache:', legacyErr);
        }
      }
    }

    // 2. OFFLINE / CACHE VALIDATION: Pure read-only check in IndexedDB / Hot Mirror
    if (!authenticatedJudge) {
      const allCachedJudges = getHotCache<SupabaseJudge[]>(STORAGE_KEYS.JUDGES, []);

      const match = allCachedJudges.find((j) => {
        const pinMatches =
          String(j.pin || '').trim().toLowerCase() === cleanPin.toLowerCase() ||
          String(j.judge_pin || '').trim().toLowerCase() === cleanPin.toLowerCase();
        if (!pinMatches) return false;

        if (cleanJudgeId) {
          const idMatches =
            String(j.id || '').toLowerCase() === cleanJudgeId.toLowerCase() ||
            String(j.judge_id || '').toLowerCase() === cleanJudgeId.toLowerCase() ||
            String(j.name || '').toLowerCase() === cleanJudgeId.toLowerCase();
          if (!idMatches) return false;
        }

        if (cleanOrgId && String(j.org_id || '').toUpperCase() !== cleanOrgId) return false;

        if (cleanEventId) {
          const eventColMatches = String((j as any).event_id || '') === cleanEventId;
          const assignedArrayMatches = Array.isArray(j.assigned_events) && j.assigned_events.includes(cleanEventId);
          if (!eventColMatches && !assignedArrayMatches) return false;
        }

        return true;
      });

      if (match) {
        authenticatedJudge = match;
        targetOrgId = match.org_id;
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
      const { data, error } = await supabase.rpc('org_login', {
        p_identifier: cleanId,
        p_password: cleanPass,
      });

      if (error) {
        throw error;
      }

      const res = data as any;
      if (!res || !res.ok) {
        const errCode = res?.error || res?.reason;
        if (errCode === 'too_many_attempts') {
          throw new Error('Too many attempts. Try again in 15 minutes.');
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
      };
    } catch (err: any) {
      if (
        err.message === 'Organiser sign-in needs an internet connection.' ||
        err.message === 'Too many attempts. Try again in 15 minutes.' ||
        err.message === 'Invalid Organization ID or Master Password.'
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
};
