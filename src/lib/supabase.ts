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

// Environment variable credentials
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key';

export const isSupabaseConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL &&
  import.meta.env.VITE_SUPABASE_ANON_KEY &&
  !import.meta.env.VITE_SUPABASE_URL.includes('placeholder') &&
  !import.meta.env.VITE_SUPABASE_URL.includes('paste_your_url_here')
);

// Standard Supabase client instance
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

// Local cache keys (used only as an offline read-fallback & for session storage)
const STORAGE_KEYS = {
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
// LOCAL CACHE & REALTIME SYNC BUS
// ==========================================

function loadCache<T>(key: string, defaultData: T[] = []): T[] {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : defaultData;
  } catch {
    return defaultData;
  }
}

function saveCache<T>(key: string, data: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    notifyDatabaseChange(key);
  } catch (err) {
    console.warn('Local cache write warning:', err);
  }
}

const DB_CHANGE_EVENT = 'fairjudge_db_change';
function notifyDatabaseChange(table: string) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DB_CHANGE_EVENT, { detail: { table } }));
  }
}

// Global Supabase Realtime Channel
let realtimeChannel: RealtimeChannel | null = null;

function ensureRealtimeSubscription() {
  if (!isSupabaseConfigured || realtimeChannel || typeof window === 'undefined') return;

  realtimeChannel = supabase
    .channel('fairjudge-live-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'events' }, () => {
      notifyDatabaseChange('events');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'scores' }, () => {
      notifyDatabaseChange('scores');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'participants' }, () => {
      notifyDatabaseChange('participants');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'judges' }, () => {
      notifyDatabaseChange('judges');
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'organizations' }, () => {
      notifyDatabaseChange('organizations');
    })
    .subscribe();
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
  return {
    ...o,
    verification_status: (o.verification_status || 'pending') as VerificationStatus,
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
    status: ((e.status || 'draft').toLowerCase() as EventStatus),
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
}

// ==========================================
// PRODUCTION SUPABASE DATA SERVICE
// ==========================================

export const dbService = {
  // ------------------------------------------
  // 1. ORGANIZATIONS
  // ------------------------------------------
  async getOrganizations(): Promise<Organization[]> {
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('organizations')
        .select('*')
        .order('created_at', { ascending: false });
      if (!error && data) {
        const normalized = data.map(normalizeOrg);
        saveCache(STORAGE_KEYS.ORGS, normalized);
        return normalized;
      }
    }
    return loadCache<Organization>(STORAGE_KEYS.ORGS, []).map(normalizeOrg);
  },

  async getOrganizationByOrgId(orgId: string): Promise<Organization | null> {
    const cleanOrgId = orgId.trim().toUpperCase();
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('organizations')
        .select('*')
        .ilike('org_id', cleanOrgId)
        .maybeSingle();
      if (!error && data) return normalizeOrg(data);
      if (error) console.error('Supabase getOrganizationByOrgId error:', error);
    }
    const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
    const found = orgs.find((o) => o.org_id.toUpperCase() === cleanOrgId);
    return found ? normalizeOrg(found) : null;
  },

  async getOrganizationByIdentifier(identifier: string): Promise<Organization | null> {
    const clean = identifier.trim();
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('organizations')
        .select('*')
        .or(`org_id.ilike.${clean},email.ilike.${clean}`)
        .maybeSingle();
      if (!error && data) return normalizeOrg(data);
      if (error) console.error('Supabase getOrganizationByIdentifier error:', error);
    }
    const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
    const lower = clean.toLowerCase();
    const found = orgs.find(
      (o) => o.org_id.toLowerCase() === lower || (o.email && o.email.toLowerCase() === lower)
    );
    return found ? normalizeOrg(found) : null;
  },

  async createOrganization(name: string, email?: string, password?: string): Promise<Organization> {
    let newOrgId = generateOrgId();

    if (isSupabaseConfigured) {
      // Ensure unique Org ID in cloud
      const existing = await this.getOrganizationByOrgId(newOrgId);
      if (existing) newOrgId = generateOrgId();

      const payload = {
        org_id: newOrgId,
        name: name.trim(),
        email: email?.trim() || null,
        password: password?.trim() || 'password123',
        verification_status: 'pending' as VerificationStatus,
        tie_breaker_enabled: false,
        tie_breaker_method: 'olympic',
        custom_participant_fields: [],
        blind_judging_enabled: false,
        auto_advance_enabled: true,
        grace_period_enabled: false,
        isolated_jury_enabled: false,
      };

      const { data, error } = await supabase
        .from('organizations')
        .insert([payload])
        .select()
        .single();

      if (error) throw new Error(error.message);
      const created = normalizeOrg(data);

      const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
      saveCache(STORAGE_KEYS.ORGS, [created, ...orgs.filter((o) => o.org_id !== created.org_id)]);
      return created;
    }

    // Fallback if .env not configured
    const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
    const newOrg: Organization = {
      id: generateUUID(),
      org_id: newOrgId,
      name: name.trim(),
      email: email?.trim(),
      password: password?.trim() || 'password123',
      verification_status: 'pending',
      tie_breaker_enabled: false,
      tie_breaker_method: 'olympic',
      created_at: new Date().toISOString(),
    };
    orgs.unshift(newOrg);
    saveCache(STORAGE_KEYS.ORGS, orgs);
    return newOrg;
  },

  async updateOrganization(orgId: string, updates: Partial<Organization>): Promise<Organization> {
    const cleanOrgId = orgId.trim().toUpperCase();

    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('organizations')
        .update(updates)
        .ilike('org_id', cleanOrgId)
        .select()
        .single();

      if (error) throw new Error(error.message);
      const updated = normalizeOrg(data);

      const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
      saveCache(
        STORAGE_KEYS.ORGS,
        orgs.map((o) => (o.org_id.toUpperCase() === cleanOrgId ? updated : o))
      );
      return updated;
    }

    const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
    const idx = orgs.findIndex((o) => o.org_id.toUpperCase() === cleanOrgId);
    if (idx === -1) throw new Error('Organization not found');
    orgs[idx] = normalizeOrg({ ...orgs[idx], ...updates });
    saveCache(STORAGE_KEYS.ORGS, orgs);
    return orgs[idx];
  },

  async resetOrganizationData(orgId: string): Promise<void> {
    const cleanOrgId = orgId.toUpperCase().trim();

    if (isSupabaseConfigured) {
      // Events cascade-delete scores in PostgreSQL automatically
      await Promise.all([
        supabase.from('events').delete().ilike('org_id', cleanOrgId),
        supabase.from('participants').delete().ilike('org_id', cleanOrgId),
        supabase.from('judges').delete().ilike('org_id', cleanOrgId),
      ]);
    }

    // Also clear local cache for this org
    const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const orgEventIds = new Set(
      events.filter((e) => e.org_id.toUpperCase().trim() === cleanOrgId).map((e) => e.id)
    );
    saveCache(
      STORAGE_KEYS.EVENTS,
      events.filter((e) => e.org_id.toUpperCase().trim() !== cleanOrgId)
    );

    const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    saveCache(
      STORAGE_KEYS.SCORES,
      scores.filter((s) => !orgEventIds.has(s.event_id))
    );

    const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    saveCache(
      STORAGE_KEYS.PARTICIPANTS,
      participants.filter((p) => p.org_id.toUpperCase().trim() !== cleanOrgId)
    );

    const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    saveCache(
      STORAGE_KEYS.JUDGES,
      judges.filter((j) => j.org_id.toUpperCase().trim() !== cleanOrgId)
    );

    notifyDatabaseChange('all');
  },

  async deleteOrganization(orgId: string): Promise<void> {
    const cleanOrgId = orgId.toUpperCase().trim();

    if (isSupabaseConfigured) {
      const { error } = await supabase
        .from('organizations')
        .delete()
        .ilike('org_id', cleanOrgId);
      if (error) throw new Error(error.message);
    }

    await this.resetOrganizationData(cleanOrgId);
    const orgs = loadCache<Organization>(STORAGE_KEYS.ORGS, []);
    saveCache(
      STORAGE_KEYS.ORGS,
      orgs.filter((o) => o.org_id.toUpperCase().trim() !== cleanOrgId)
    );
    setStoredSession(null);
    notifyDatabaseChange('all');
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
  // 3. EVENTS
  // ------------------------------------------
  async getEvents(orgId: string): Promise<SupabaseEvent[]> {
    const cleanOrgId = orgId.trim().toUpperCase();
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('events')
        .select('*')
        .ilike('org_id', cleanOrgId)
        .order('created_at', { ascending: false });

      if (!error && data) {
        const normalized = data.map(normalizeEvent);
        saveCache(STORAGE_KEYS.EVENTS, normalized);
        return normalized;
      }
      if (error) console.error('Supabase getEvents error:', error);
    }

    const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    return events
      .filter((e) => e.org_id.toUpperCase() === cleanOrgId)
      .map(normalizeEvent);
  },

  async getEventById(eventId: string): Promise<SupabaseEvent | null> {
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('events')
        .select('*')
        .eq('id', eventId)
        .maybeSingle();

      if (!error && data) return normalizeEvent(data);
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
    const normalizedStatus = (eventData.status?.toLowerCase() as EventStatus) || 'draft';

    if (isSupabaseConfigured) {
      const payload = {
        org_id: eventData.org_id.toUpperCase().trim(),
        name: eventData.name.trim(),
        category: eventData.category?.trim() || 'General',
        date: eventData.date || new Date().toISOString().split('T')[0],
        status: normalizedStatus,
        rubric_schema: eventData.rubric_schema || [],
        assigned_judges: eventData.assigned_judges || [],
        assigned_participants: eventData.assigned_participants || [],
        participant_sl_numbers: {},
      };

      const { data, error } = await supabase
        .from('events')
        .insert([payload])
        .select()
        .single();

      if (error) throw new Error(error.message);
      const created = normalizeEvent(data);
      const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
      saveCache(STORAGE_KEYS.EVENTS, [created, ...events]);
      return created;
    }

    const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const newEvent: SupabaseEvent = normalizeEvent({
      ...eventData,
      id: generateUUID(),
      status: normalizedStatus,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    events.unshift(newEvent);
    saveCache(STORAGE_KEYS.EVENTS, events);
    return newEvent;
  },

  async updateEventStatus(eventId: string, newStatus: EventStatus): Promise<SupabaseEvent> {
    const normalized = (newStatus.toLowerCase() as EventStatus);
    return this.updateEvent(eventId, { status: normalized });
  },

  async updateEvent(eventId: string, updates: Partial<SupabaseEvent>): Promise<SupabaseEvent> {
    if (isSupabaseConfigured) {
      // Clean out UI-only compatibility alias 'rubric' before sending to PostgreSQL
      const dbUpdates: Record<string, any> = {
        ...updates,
        updated_at: new Date().toISOString(),
      };
      if (dbUpdates.rubric && !dbUpdates.rubric_schema) {
        dbUpdates.rubric_schema = dbUpdates.rubric;
      }
      delete dbUpdates.rubric;

      const { data, error } = await supabase
        .from('events')
        .update(dbUpdates)
        .eq('id', eventId)
        .select()
        .single();

      if (error) throw new Error(error.message);
      const updated = normalizeEvent(data);
      const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
      saveCache(
        STORAGE_KEYS.EVENTS,
        events.map((e) => (e.id === eventId ? updated : e))
      );
      return updated;
    }

    const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const idx = events.findIndex((e) => e.id === eventId);
    if (idx === -1) throw new Error('Event not found');
    events[idx] = normalizeEvent({
      ...events[idx],
      ...updates,
      updated_at: new Date().toISOString(),
    });
    saveCache(STORAGE_KEYS.EVENTS, events);
    return events[idx];
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
    if (isSupabaseConfigured) {
      const { count, error } = await supabase
        .from('scores')
        .select('*', { count: 'exact', head: true })
        .eq('event_id', eventId);

      if (!error) return (count ?? 0) === 0;
    }
    const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    return !scores.some((s) => s.event_id === eventId);
  },

  async deleteEvent(eventId: string): Promise<boolean> {
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('events').delete().eq('id', eventId);
      if (error) throw new Error(error.message);
    }
    const events = loadCache<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    saveCache(
      STORAGE_KEYS.EVENTS,
      events.filter((e) => e.id !== eventId)
    );
    return true;
  },

  async deleteOrArchiveEvent(eventId: string): Promise<{ action: 'deleted' | 'archived' }> {
    const canDelete = await this.canDeleteEvent(eventId);
    if (canDelete) {
      await this.deleteEvent(eventId);
      return { action: 'deleted' };
    } else {
      await this.updateEventStatus(eventId, 'archived');
      return { action: 'archived' };
    }
  },

  // ------------------------------------------
  // 4. JUDGES (WITH SINGLE-DEVICE SESSION LOCK)
  // ------------------------------------------
  async getJudges(orgId: string): Promise<SupabaseJudge[]> {
    const cleanOrgId = orgId.trim().toUpperCase();
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('judges')
        .select('*')
        .ilike('org_id', cleanOrgId)
        .order('created_at', { ascending: false });

      if (!error && data) {
        const normalized = data.map(normalizeJudge);
        saveCache(STORAGE_KEYS.JUDGES, normalized);
        return normalized;
      }
      if (error) console.error('Supabase getJudges error:', error);
    }

    const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    return judges
      .filter((j) => j.org_id.toUpperCase() === cleanOrgId)
      .map(normalizeJudge);
  },

  async getJudgeById(judgeId: string): Promise<SupabaseJudge | null> {
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('judges')
        .select('*')
        .eq('id', judgeId)
        .maybeSingle();

      if (!error && data) return normalizeJudge(data);
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
    const generatedPin = pin?.trim() || Math.floor(1000 + Math.random() * 9000).toString();

    if (isSupabaseConfigured) {
      let assignedJudgeId = customJudgeId?.trim();
      if (!assignedJudgeId) {
        const { count } = await supabase
          .from('judges')
          .select('*', { count: 'exact', head: true })
          .ilike('org_id', cleanOrgId);
        assignedJudgeId = `J-${String((count || 0) + 1).padStart(2, '0')}`;
      }

      const { data, error } = await supabase
        .from('judges')
        .insert([
          {
            org_id: cleanOrgId,
            name: name.trim(),
            judge_id: assignedJudgeId,
            pin: generatedPin,
            assigned_events: [],
            current_session_token: null,
          },
        ])
        .select()
        .single();

      if (error) throw new Error(error.message);
      const created = normalizeJudge(data);
      const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
      saveCache(STORAGE_KEYS.JUDGES, [created, ...judges]);
      return created;
    }

    const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    const existingOrgJudges = judges.filter((j) => j.org_id.toUpperCase() === cleanOrgId);
    const assignedJudgeId =
      customJudgeId?.trim() || `J-${String(existingOrgJudges.length + 1).padStart(2, '0')}`;

    const newJudge = normalizeJudge({
      id: generateUUID(),
      judge_id: assignedJudgeId,
      org_id: cleanOrgId,
      name: name.trim(),
      pin: generatedPin,
      assigned_events: [],
      current_session_token: null,
      created_at: new Date().toISOString(),
    });
    judges.unshift(newJudge);
    saveCache(STORAGE_KEYS.JUDGES, judges);
    return newJudge;
  },

  async updateJudge(judgeId: string, updates: Partial<SupabaseJudge>): Promise<SupabaseJudge> {
    const cleanPin = updates.pin?.trim() || updates.judge_pin?.trim();

    if (isSupabaseConfigured) {
      const dbUpdates: Record<string, any> = { ...updates };
      if (cleanPin) dbUpdates.pin = cleanPin;
      delete dbUpdates.judge_pin; // Not a SQL column

      const { data, error } = await supabase
        .from('judges')
        .update(dbUpdates)
        .eq('id', judgeId)
        .select()
        .single();

      if (error) throw new Error(error.message);
      const updated = normalizeJudge(data);
      const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
      saveCache(
        STORAGE_KEYS.JUDGES,
        judges.map((j) => (j.id === judgeId ? updated : j))
      );
      return updated;
    }

    const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    const idx = judges.findIndex((j) => j.id === judgeId || j.judge_id === judgeId);
    if (idx === -1) throw new Error('Judge not found');
    judges[idx] = normalizeJudge({
      ...judges[idx],
      ...updates,
      pin: cleanPin || judges[idx].pin,
    });
    saveCache(STORAGE_KEYS.JUDGES, judges);
    return judges[idx];
  },

  async deleteJudge(judgeId: string): Promise<void> {
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('judges').delete().eq('id', judgeId);
      if (error) throw new Error(error.message);
    }
    const judges = loadCache<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    saveCache(
      STORAGE_KEYS.JUDGES,
      judges.filter((j) => j.id !== judgeId && j.judge_id !== judgeId)
    );
  },

  async verifyJudgeCredentials(
    orgId: string,
    judgeIdOrPin: string,
    pinOrEventId?: string
  ): Promise<{ judge: SupabaseJudge; assignedEvents: SupabaseEvent[] } | null> {
    const judges = await this.getJudges(orgId);
    let matchedJudge: SupabaseJudge | undefined;

    if (pinOrEventId && pinOrEventId.trim()) {
      const targetJudgeId = judgeIdOrPin.trim().toLowerCase();
      const targetPin = pinOrEventId.trim();

      matchedJudge = judges.find((j) => {
        const idMatches =
          j.id.toLowerCase() === targetJudgeId ||
          (j.judge_id && j.judge_id.toLowerCase() === targetJudgeId) ||
          j.name.toLowerCase().includes(targetJudgeId);
        const pinMatches = j.pin === targetPin || j.judge_pin === targetPin;
        return idMatches && pinMatches;
      });
    } else {
      const targetPin = judgeIdOrPin.trim();
      matchedJudge = judges.find((j) => j.pin === targetPin || j.judge_pin === targetPin);
    }

    if (!matchedJudge) return null;

    // SINGLE-DEVICE SESSION LOCK: Claim active session token on login
    const newSessionToken = `jtok_${generateUUID()}`;
    setLocalJudgeDeviceToken(newSessionToken);
    try {
      matchedJudge = await this.updateJudge(matchedJudge.id, {
        current_session_token: newSessionToken,
      });
    } catch (err) {
      console.warn('Could not persist judge session token:', err);
      matchedJudge = { ...matchedJudge, current_session_token: newSessionToken };
    }

    const allEvents = await this.getEvents(orgId);
    let assigned = allEvents.filter(
      (e) =>
        e.assigned_judges.includes(matchedJudge!.id) ||
        matchedJudge!.assigned_events.includes(e.id)
    );

    if (assigned.length === 0) {
      assigned = allEvents.filter((e) => e.status === 'active');
    }

    return { judge: matchedJudge, assignedEvents: assigned };
  },

  // Verifies if this device still holds the active session lock for the judge
  async verifyActiveJudgeSession(judgeId: string): Promise<boolean> {
    const localToken = getLocalJudgeDeviceToken();
    if (!localToken) return true; // Legacy session fallback

    if (isSupabaseConfigured && (typeof navigator === 'undefined' || navigator.onLine)) {
      const remoteJudge = await this.getJudgeById(judgeId);
      if (
        remoteJudge &&
        remoteJudge.current_session_token &&
        remoteJudge.current_session_token !== localToken
      ) {
        return false;
      }
    }
    return true;
  },

  // ------------------------------------------
  // 5. PARTICIPANTS
  // ------------------------------------------
  async getParticipants(orgId: string): Promise<SupabaseParticipant[]> {
    const cleanOrgId = orgId.trim().toUpperCase();
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('participants')
        .select('*')
        .ilike('org_id', cleanOrgId)
        .order('created_at', { ascending: false });

      if (!error && data) {
        saveCache(STORAGE_KEYS.PARTICIPANTS, data);
        return data;
      }
      if (error) console.error('Supabase getParticipants error:', error);
    }

    const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    return participants.filter((p) => p.org_id.toUpperCase() === cleanOrgId);
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

    if (isSupabaseConfigured) {
      let assignedSl = data.sl_no?.trim();
      if (!assignedSl) {
        const { count } = await supabase
          .from('participants')
          .select('*', { count: 'exact', head: true })
          .ilike('org_id', cleanOrgId);
        assignedSl = String((count || 0) + 1).padStart(2, '0');
      }

      const payload = {
        org_id: cleanOrgId,
        identity_id: data.identity_id?.trim() || generateIdentityId(),
        sl_no: assignedSl,
        name: data.name.trim(),
        school: data.school?.trim() || 'General',
        class_or_age: data.class_or_age?.trim() || '',
        mobile_number: data.mobile_number?.trim() || '',
        custom_values: data.custom_values || {},
      };

      const { data: created, error } = await supabase
        .from('participants')
        .insert([payload])
        .select()
        .single();

      if (error) throw new Error(error.message);
      const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
      saveCache(STORAGE_KEYS.PARTICIPANTS, [created, ...participants]);
      return created;
    }

    const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const existingOrgParticipants = participants.filter(
      (p) => p.org_id.toUpperCase() === cleanOrgId
    );
    const assignedSl =
      data.sl_no?.trim() || String(existingOrgParticipants.length + 1).padStart(2, '0');

    const newParticipant: SupabaseParticipant = {
      id: generateUUID(),
      org_id: cleanOrgId,
      identity_id: data.identity_id?.trim() || generateIdentityId(),
      sl_no: assignedSl,
      name: data.name.trim(),
      school: data.school?.trim() || 'General',
      class_or_age: data.class_or_age?.trim() || '',
      mobile_number: data.mobile_number?.trim() || '',
      custom_values: data.custom_values || {},
      created_at: new Date().toISOString(),
    };
    participants.unshift(newParticipant);
    saveCache(STORAGE_KEYS.PARTICIPANTS, participants);
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

    if (isSupabaseConfigured) {
      const { count } = await supabase
        .from('participants')
        .select('*', { count: 'exact', head: true })
        .ilike('org_id', cleanOrgId);
      const startCount = count || 0;

      const usedIds = new Set<string>();
      const makeUniqueIdentityId = (provided?: string) => {
        let candidate = provided?.trim() || generateIdentityId();
        while (usedIds.has(candidate)) {
          candidate = generateIdentityId();
        }
        usedIds.add(candidate);
        return candidate;
      };

      const payloads = rows.map((r, i) => ({
        org_id: cleanOrgId,
        identity_id: makeUniqueIdentityId(r.identity_id),
        sl_no: r.sl_no ? r.sl_no.trim() : String(startCount + i + 1).padStart(2, '0'),
        name: r.name.trim(),
        school: r.school ? r.school.trim() : 'General',
        class_or_age: r.class_or_age ? r.class_or_age.trim() : '',
        mobile_number: r.mobile_number ? r.mobile_number.trim() : '',
        custom_values: r.custom_values || {},
      }));

      const { data, error } = await supabase
        .from('participants')
        .insert(payloads)
        .select();

      if (error) throw new Error(error.message);
      const inserted = data || [];
      const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
      saveCache(STORAGE_KEYS.PARTICIPANTS, [...inserted, ...participants]);
      return inserted.length;
    }

    const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const existingOrgCount = participants.filter(
      (p) => p.org_id.toUpperCase() === cleanOrgId
    ).length;

    const newItems: SupabaseParticipant[] = rows.map((r, i) => ({
      id: generateUUID(),
      org_id: cleanOrgId,
      identity_id: r.identity_id ? r.identity_id.trim() : generateIdentityId(),
      sl_no: r.sl_no ? r.sl_no.trim() : String(existingOrgCount + i + 1).padStart(2, '0'),
      name: r.name.trim(),
      school: r.school ? r.school.trim() : 'General',
      class_or_age: r.class_or_age ? r.class_or_age.trim() : '',
      mobile_number: r.mobile_number ? r.mobile_number.trim() : '',
      custom_values: r.custom_values || {},
      created_at: new Date().toISOString(),
    }));

    saveCache(STORAGE_KEYS.PARTICIPANTS, [...newItems, ...participants]);
    return newItems.length;
  },

  async updateParticipant(
    participantId: string,
    updates: Partial<SupabaseParticipant>
  ): Promise<SupabaseParticipant> {
    const safeUpdates = { ...updates };
    delete safeUpdates.identity_id;

    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('participants')
        .update(safeUpdates)
        .eq('id', participantId)
        .select()
        .single();

      if (error) throw new Error(error.message);
      const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
      saveCache(
        STORAGE_KEYS.PARTICIPANTS,
        participants.map((p) => (p.id === participantId ? data : p))
      );
      return data;
    }

    const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const idx = participants.findIndex((p) => p.id === participantId);
    if (idx === -1) throw new Error('Participant not found');
    participants[idx] = { ...participants[idx], ...safeUpdates };
    saveCache(STORAGE_KEYS.PARTICIPANTS, participants);
    return participants[idx];
  },

  async deleteParticipant(participantId: string): Promise<void> {
    if (isSupabaseConfigured) {
      const { error } = await supabase.from('participants').delete().eq('id', participantId);
      if (error) throw new Error(error.message);
    }
    const participants = loadCache<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    saveCache(
      STORAGE_KEYS.PARTICIPANTS,
      participants.filter((p) => p.id !== participantId)
    );
  },

  // ------------------------------------------
  // 6. SCORES (THE CRYPTOGRAPHIC LEDGER)
  // ------------------------------------------
  async getScores(eventId: string): Promise<SupabaseScore[]> {
    if (isSupabaseConfigured) {
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
        saveCache(STORAGE_KEYS.SCORES, [...existingCache, ...normalized]);
        return normalized;
      }
      if (error) console.error('Supabase getScores error:', error);
    }

    const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    return scores.filter((s) => s.event_id === eventId).map(normalizeScore);
  },

  async getAllScores(): Promise<SupabaseScore[]> {
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('scores')
        .select('*')
        .order('created_at', { ascending: true });

      if (!error && data) {
        const normalized = data.map(normalizeScore);
        saveCache(STORAGE_KEYS.SCORES, normalized);
        return normalized;
      }
      if (error) console.error('Supabase getAllScores error:', error);
    }

    return loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []).map(normalizeScore);
  },

  async getScoreForJudgeParticipant(
    eventId: string,
    judgeId: string,
    participantId: string
  ): Promise<SupabaseScore | null> {
    if (isSupabaseConfigured) {
      const { data, error } = await supabase
        .from('scores')
        .select('*')
        .eq('event_id', eventId)
        .eq('judge_id', judgeId)
        .eq('participant_id', participantId)
        .maybeSingle();

      if (!error && data) return normalizeScore(data);
    }

    const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    const match = scores.find(
      (s) =>
        s.event_id === eventId &&
        s.judge_id === judgeId &&
        s.participant_id === participantId
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
    // 1. Strict Event Status Guard
    const event = await this.getEventById(scoreData.event_id);
    if (!event) {
      throw new Error('Event not found');
    }
    if (event.status === 'ended' || event.status === 'paused') {
      throw new Error(
        `Cryptographic Ledger Protected: Event is ${event.status}. Score submission rejected.`
      );
    }

    // 2. Single-Device Session Lock Guard
    const isSessionValid = await this.verifyActiveJudgeSession(scoreData.judge_id);
    if (!isSessionValid) {
      setStoredSession(null);
      throw new Error(
        'SESSION_TERMINATED: Your judge account was logged into on another device. Score rejected.'
      );
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

    if (isSupabaseConfigured) {
      if (existing && isWithinGrace) {
        const { data, error } = await supabase
          .from('scores')
          .update({
            total_score: scoreData.total_score,
            score_payload: payloadJson,
          })
          .eq('id', existing.id)
          .select()
          .single();

        if (error) throw new Error(error.message);
        const updated = normalizeScore(data);
        const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
        saveCache(
          STORAGE_KEYS.SCORES,
          scores.map((s) => (s.id === existing.id ? updated : s))
        );
        return updated;
      }

      const { data, error } = await supabase
        .from('scores')
        .insert([
          {
            event_id: scoreData.event_id,
            judge_id: scoreData.judge_id,
            participant_id: scoreData.participant_id,
            total_score: scoreData.total_score,
            score_payload: payloadJson,
          },
        ])
        .select()
        .single();

      if (error) throw new Error(error.message);
      const created = normalizeScore(data);
      const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
      saveCache(STORAGE_KEYS.SCORES, [...scores, created]);
      return created;
    }

    // Local fallback
    const scores = loadCache<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    if (existing && isWithinGrace) {
      const idx = scores.findIndex((s) => s.id === existing.id);
      if (idx !== -1) {
        scores[idx] = normalizeScore({
          ...scores[idx],
          score_data: criteriaMap,
          total_score: scoreData.total_score,
          score_payload: payloadJson,
        });
        saveCache(STORAGE_KEYS.SCORES, scores);
        return scores[idx];
      }
    }

    const newScore = normalizeScore({
      id: generateUUID(),
      event_id: scoreData.event_id,
      judge_id: scoreData.judge_id,
      participant_id: scoreData.participant_id,
      score_data: criteriaMap,
      total_score: scoreData.total_score,
      score_payload: payloadJson,
      created_at: timestamp,
    });
    scores.push(newScore);
    saveCache(STORAGE_KEYS.SCORES, scores);
    return newScore;
  },

  // ------------------------------------------
  // 7. TIE-BREAKER ENGINE LOGIC
  // ------------------------------------------
  calculateRankings(
    participants: SupabaseParticipant[],
    scores: SupabaseScore[],
    assignedJudgesCount: number,
    method: TieBreakerMethod = 'olympic',
    tieBreakerEnabled: boolean = false
  ) {
    const rawList = participants.map((p) => {
      const pScores = scores.filter((s) => s.participant_id === p.id);
      const judgeCount = pScores.length;

      let computedAverage = 0;
      if (judgeCount > 0) {
        if (tieBreakerEnabled && method === 'olympic' && judgeCount >= 3) {
          const sorted = [...pScores].sort((a, b) => a.total_score - b.total_score);
          const trimmed = sorted.slice(1, sorted.length - 1);
          const sum = trimmed.reduce((acc, s) => acc + s.total_score, 0);
          computedAverage = Number((sum / trimmed.length).toFixed(2));
        } else if (tieBreakerEnabled && method === 'manual') {
          const sum = pScores.reduce((acc, s) => acc + s.total_score, 0);
          computedAverage = Number((sum / judgeCount).toFixed(4));
        } else {
          const sum = pScores.reduce((acc, s) => acc + s.total_score, 0);
          computedAverage = Number((sum / judgeCount).toFixed(2));
        }
      }

      return {
        ...p,
        judgeCount,
        pScores,
        avgScore: computedAverage,
      };
    });

    rawList.sort((a, b) => b.avgScore - a.avgScore);

    let currentRank = 1;
    return rawList.map((item, index) => {
      if (index === 0) {
        currentRank = 1;
      } else {
        const prev = rawList[index - 1];
        const isTied =
          item.avgScore === prev.avgScore && item.judgeCount > 0 && prev.judgeCount > 0;
        if (!tieBreakerEnabled || method === 'shared') {
          if (!isTied) {
            currentRank = index + 1;
          }
        } else {
          currentRank = index + 1;
        }
      }
      return {
        ...item,
        rank: item.judgeCount > 0 ? currentRank : 0,
      };
    });
  },
};
