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
   * ARCHITECTURAL DIRECTIVE 2: ORGANISER SIGN-IN LOCKDOWN
   * Strict SELECT query matching org_id (or email) and password.
   * If no exact match exists, throws "Invalid Organization ID or Master Password."
   * NEVER attempts to register or create accounts during sign-in.
   */
  async loginOrganiser(identifier: string, password: string): Promise<Organization> {
    const cleanId = identifier.trim();
    const cleanPass = password.trim();

    if (!cleanId || !cleanPass) {
      throw new Error('Invalid Organization ID or Master Password.');
    }

    let foundOrg: Organization | null = null;

    // 1. Online: Strict SELECT query matching identifier AND password
    if (isSupabaseConfigured() && typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        let query = supabase.from('organizations').select('*');
        if (cleanId.includes('@')) {
          query = query.ilike('email', cleanId);
        } else {
          query = query.or(`org_id.ilike."${cleanId}",email.ilike."${cleanId}"`);
        }
        const { data, error } = await query.maybeSingle();

        if (!error && data) {
          // Strict password verification
          if (data.password === cleanPass) {
            foundOrg = data as Organization;

            // Cache the verified organization locally (read-only)
            const currentOrgs = getHotCache<Organization[]>(STORAGE_KEYS.ORGS, []);
            await setIndexedDBCache(
              STORAGE_KEYS.ORGS,
              [foundOrg, ...currentOrgs.filter((o) => o.org_id.toUpperCase() !== foundOrg!.org_id.toUpperCase())],
              true
            );
          } else {
            // Password mismatch: Halt immediately
            throw new Error('Invalid Organization ID or Master Password.');
          }
        } else if (!error && !data) {
          // Live Supabase database query executed with zero records: reject immediately
          throw new Error('Invalid Organization ID or Master Password.');
        }
      } catch (err: any) {
        if (err.message === 'Invalid Organization ID or Master Password.') {
          throw err;
        }
        console.warn('Online organiser query notice, checking offline cache:', err);
      }
    }

    // 2. Offline / Cached Fallback (Strict Read-Only)
    if (!foundOrg) {
      const orgs = getHotCache<Organization[]>(STORAGE_KEYS.ORGS, []);
      const lower = cleanId.toLowerCase();
      const match = orgs.find(
        (o) => (o.org_id.toLowerCase() === lower || (o.email && o.email.toLowerCase() === lower))
      );

      if (match) {
        if (match.password === cleanPass) {
          foundOrg = match;
        } else {
          throw new Error('Invalid Organization ID or Master Password.');
        }
      }
    }

    if (!foundOrg) {
      throw new Error('Invalid Organization ID or Master Password.');
    }

    return foundOrg;
  },

  /**
   * ARCHITECTURAL DIRECTIVE 2: ORGANISER REGISTRATION LOCKDOWN
   * Strict pre-flight SELECT to ensure org_id or email does not already exist.
   * If collision detected, halts and throws:
   * "Registration Failed: Organization ID or Email is already in use."
   * Only then performs a strict INSERT.
   */
  async registerOrganiser(name: string, email?: string, password?: string): Promise<Organization> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      throw new Error('Registration requires an active internet connection. Please connect to the network to create an organization.');
    }

    const cleanName = name.trim();
    if (!cleanName) {
      throw new Error('Please enter a valid organisation name.');
    }

    const cleanEmail = email?.trim() || undefined;
    const cleanPassword = password?.trim() || 'password123';
    const newOrgId = generateOrgId();
    const newOrgUuid = generateUUID();

    // 1. PRE-FLIGHT SELECT: Ensure org_id and email are completely unique
    if (isSupabaseConfigured()) {
      if (cleanEmail) {
        const { data: emailConflict } = await supabase
          .from('organizations')
          .select('id, email')
          .ilike('email', cleanEmail)
          .maybeSingle();

        if (emailConflict) {
          throw new Error('Registration Failed: Organization ID or Email is already in use.');
        }
      }

      const { data: orgIdConflict } = await supabase
        .from('organizations')
        .select('id, org_id')
        .ilike('org_id', newOrgId)
        .maybeSingle();

      if (orgIdConflict) {
        throw new Error('Registration Failed: Organization ID or Email is already in use.');
      }
    }

    // Also check local cache for conflict
    const cachedOrgs = getHotCache<Organization[]>(STORAGE_KEYS.ORGS, []);
    if (cleanEmail && cachedOrgs.some((o) => o.email && o.email.toLowerCase() === cleanEmail.toLowerCase())) {
      throw new Error('Registration Failed: Organization ID or Email is already in use.');
    }
    if (cachedOrgs.some((o) => o.org_id.toUpperCase() === newOrgId.toUpperCase())) {
      throw new Error('Registration Failed: Organization ID or Email is already in use.');
    }

    // 2. STRICT INSERT (No upsert)
    const insertPayload = {
      id: newOrgUuid,
      org_id: newOrgId,
      name: cleanName,
      email: cleanEmail,
      password: cleanPassword,
      verification_status: 'pending' as VerificationStatus,
      tie_breaker_enabled: false,
      tie_breaker_method: 'olympic' as TieBreakerMethod,
      custom_participant_fields: [],
      blind_judging_enabled: false,
      auto_advance_enabled: true,
      grace_period_enabled: false,
      isolated_jury_enabled: false,
    };

    if (isSupabaseConfigured()) {
      const { data, error } = await supabase
        .from('organizations')
        .insert([{ ...insertPayload, email: cleanEmail || null }])
        .select()
        .single();

      if (error) {
        if (error.code === '23505' || error.message?.includes('duplicate key') || error.message?.includes('unique constraint')) {
          throw new Error('Registration Failed: Organization ID or Email is already in use.');
        }
        throw new Error(`Registration Failed: ${error.message}`);
      }

      const created: Organization = {
        ...insertPayload,
        created_at: data?.created_at || new Date().toISOString(),
      };

      await setIndexedDBCache(
        STORAGE_KEYS.ORGS,
        [created, ...cachedOrgs.filter((o) => o.org_id !== created.org_id)],
        false
      );

      return created;
    } else {
      const created: Organization = {
        ...insertPayload,
        created_at: new Date().toISOString(),
      };

      await setIndexedDBCache(
        STORAGE_KEYS.ORGS,
        [created, ...cachedOrgs.filter((o) => o.org_id !== created.org_id)],
        false
      );

      return created;
    }
  },
};
