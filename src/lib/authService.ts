/**
 * Fair Judge Zero-Trust Authentication Service (Phase 14.4)
 * Enforces strict, read-only credential validation.
 * Eliminates all automated insert/upsert fallbacks to prevent phantom duplicate accounts.
 */

import { supabase, isSupabaseConfigured, dbService } from './supabase';
import { 
  Organization, 
  SupabaseJudge, 
  SupabaseEvent,
  VerificationStatus,
  TieBreakerMethod
} from './supabaseTypes';
import { getHotCache, setIndexedDBCache } from './db/indexedDB';
import { STORAGE_KEYS, generateUUID, generateOrgId } from './supabase';
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
}

export const authService = {
  /**
   * ARCHITECTURAL DIRECTIVE 1: JUDGE AUTHENTICATION LOCKDOWN
   * Strict Read-Only credential validation.
   * Pure SELECT query matching (event_id/org_id, judge_id, pin).
   * ZERO auto-creation or upsert fallback.
   * Rejection: Throws "Authentication Failed: Invalid ID or PIN. Please request a new QR code."
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

    // 1. ONLINE VALIDATION: Pure Supabase SELECT query
    if (isSupabaseConfigured() && typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        let query = supabase.from('judges').select('*');

        // Match pin (checking both pin and legacy judge_pin)
        query = query.or(`pin.eq.${cleanPin},judge_pin.eq.${cleanPin}`);

        // If specific judgeId provided, strictly match
        if (cleanJudgeId) {
          query = query.or(`id.eq.${cleanJudgeId},judge_id.ilike.${cleanJudgeId}`);
        }

        // If orgId provided, filter by organization
        if (cleanOrgId) {
          query = query.ilike('org_id', cleanOrgId);
        }

        // If eventId provided, match event_id column if present or filter later
        if (cleanEventId) {
          try {
            // Check if column event_id exists or query directly
            query = query.or(`event_id.eq.${cleanEventId},assigned_events.cs.{"${cleanEventId}"}`);
          } catch {
            // Safe fallback if column not yet added
          }
        }

        const { data, error } = await query;

        if (!error && data && data.length > 0) {
          // Precise in-memory confirmation of strict read-only match
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

            if (cleanOrgId) {
              if (String(j.org_id || '').toUpperCase() !== cleanOrgId) return false;
            }

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

            // Cache the verified judge locally for offline read resilience (read-only cache)
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
      } catch (cloudErr: any) {
        if (cloudErr.message?.includes('Authentication Failed')) {
          throw cloudErr;
        }
        console.warn('Zero-trust cloud verification network issue, evaluating local cache:', cloudErr);
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

        if (cleanOrgId) {
          if (String(j.org_id || '').toUpperCase() !== cleanOrgId) return false;
        }

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
    try {
      const orgEvents = await dbService.getEvents(targetOrgId);
      assignedEvents = orgEvents.filter(
        (e) =>
          e.assigned_judges.includes(authenticatedJudge!.id) ||
          (authenticatedJudge!.assigned_events || []).includes(e.id) ||
          e.status === 'active'
      );
    } catch {
      // Safe fallback from cached events
      const cachedEvents = dbService.getCachedEvents(targetOrgId);
      assignedEvents = cachedEvents.filter(
        (e) =>
          e.assigned_judges.includes(authenticatedJudge!.id) ||
          (authenticatedJudge!.assigned_events || []).includes(e.id) ||
          e.status === 'active'
      );
    }

    return {
      judge: authenticatedJudge,
      assignedEvents,
    };
  },

  /**
   * ARCHITECTURAL DIRECTIVE 2: ORGANISER SIGN-IN LOCKDOWN (Epic 15.7 Step B2)
   * Secure database RPC authentication with bcrypt verification and brute-force lockout.
   * Eliminates all client-side password comparisons and plaintext password exposure.
   * Organiser sign-in strictly requires an active internet connection.
   */
  async loginOrganiser(identifier: string, password: string): Promise<Organization> {
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

      // Cache verified organization locally (read-only, no password)
      const currentOrgs = getHotCache<Organization[]>(STORAGE_KEYS.ORGS, []);
      await setIndexedDBCache(
        STORAGE_KEYS.ORGS,
        [foundOrg, ...currentOrgs.filter((o) => o.org_id.toUpperCase() !== foundOrg.org_id.toUpperCase())],
        true
      );

      return foundOrg as Organization;
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
   * ARCHITECTURAL DIRECTIVE 2: ORGANISER REGISTRATION LOCKDOWN (Epic 15.7 Step B2)
   * Secure database RPC registration with bcrypt password hashing in org_secrets.
   */
  async registerOrganiser(name: string, email?: string, password?: string): Promise<Organization> {
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

    return created;
  },
};
