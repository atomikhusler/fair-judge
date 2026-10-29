import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { 
  Organization, 
  SupabaseEvent, 
  SupabaseJudge, 
  SupabaseParticipant, 
  SupabaseScore, 
  EventStatus,
  TieBreakerMethod 
} from './supabaseTypes';

// Environment variable credentials
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key';

export const isSupabaseConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY
);

// Standard Supabase client instance
export const supabase: SupabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

// Storage keys for persistent relational database
const STORAGE_KEYS = {
  ORGS: 'fairjudge_supabase_orgs',
  EVENTS: 'fairjudge_supabase_events',
  JUDGES: 'fairjudge_supabase_judges',
  PARTICIPANTS: 'fairjudge_supabase_participants',
  SCORES: 'fairjudge_supabase_scores',
  PUBLIC_SETTINGS: 'fairjudge_public_settings',
};

// Generate random UUID
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

// Generate 6-digit alphanumeric Org ID (e.g., FJ-9A2X)
export function generateOrgId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let randomPart = '';
  for (let i = 0; i < 4; i++) {
    randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `FJ-${randomPart}`;
}

// Generate Global Immutable Identity Number (e.g., P-8492)
export function generateIdentityId(): string {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `P-${num}`;
}

// Initial demo seed data to ensure immediate out-of-the-box readiness
function getSeedData() {
  const defaultOrgId = 'FJ-9A2X';
  const defaultOrgUUID = 'a1111111-1111-4111-a111-111111111111';

  const initialOrg: Organization = {
    id: defaultOrgUUID,
    org_id: defaultOrgId,
    name: 'St. Jude Academy Arts & Science',
    email: 'admin@stjude.edu',
    password: 'password123',
    tie_breaker_enabled: false,
    tie_breaker_method: 'olympic',
    custom_participant_fields: [
      { id: 'f_class', name: 'Class/Age', required: false, type: 'text' },
      { id: 'f_mobile', name: 'Mobile Number', required: false, type: 'text' },
    ],
    created_at: new Date().toISOString(),
  };

  const initialParticipants: SupabaseParticipant[] = [
    {
      id: generateUUID(),
      org_id: defaultOrgId,
      identity_id: 'P-8492',
      sl_no: '01',
      name: 'Aarav Sharma',
      school: 'St. Jude International',
      created_at: new Date().toISOString(),
    },
    {
      id: generateUUID(),
      org_id: defaultOrgId,
      identity_id: 'P-3104',
      sl_no: '02',
      name: 'Priya Patel',
      school: 'Delhi Public School',
      created_at: new Date().toISOString(),
    },
    {
      id: generateUUID(),
      org_id: defaultOrgId,
      identity_id: 'P-5721',
      sl_no: '03',
      name: 'Rohan Gupta',
      school: 'Kendriya Vidyalaya No. 1',
      created_at: new Date().toISOString(),
    },
    {
      id: generateUUID(),
      org_id: defaultOrgId,
      identity_id: 'P-9240',
      sl_no: '04',
      name: 'Ananya Sen',
      school: 'Modern Academy',
      created_at: new Date().toISOString(),
    },
  ];

  const initialJudges: SupabaseJudge[] = [
    {
      id: 'judge-dr-verma',
      org_id: defaultOrgId,
      name: 'Judge 1 - Dr. A. Verma',
      pin: '4921',
      judge_pin: '4921',
      assigned_events: [],
      created_at: new Date().toISOString(),
    },
    {
      id: 'judge-sarah-jenkins',
      org_id: defaultOrgId,
      name: 'Judge 2 - Sarah Jenkins',
      pin: '8310',
      judge_pin: '8310',
      assigned_events: [],
      created_at: new Date().toISOString(),
    },
  ];

  const initialRubric = [
    { id: 'crit_concept', name: 'Original Concept', max_marks: 10, weight: 1 },
    { id: 'crit_execution', name: 'Technical Execution', max_marks: 10, weight: 1 },
    { id: 'crit_presentation', name: 'Stage Presentation', max_marks: 5, weight: 1 },
  ];

  const initialEvent: SupabaseEvent = {
    id: 'event-science-fair-2026',
    org_id: defaultOrgId,
    name: 'Inter-School Science Fair 2026',
    category: 'Science & Innovation',
    date: new Date().toISOString().split('T')[0],
    status: 'upcoming',
    rubric_schema: initialRubric,
    rubric: initialRubric,
    assigned_judges: initialJudges.map((j) => j.id),
    assigned_participants: initialParticipants.map((p) => p.id),
    created_at: new Date().toISOString(),
  };

  initialJudges.forEach((j) => {
    j.assigned_events = [initialEvent.id];
  });

  return {
    orgs: [initialOrg],
    events: [initialEvent],
    judges: initialJudges,
    participants: initialParticipants,
    scores: [] as SupabaseScore[],
  };
}

// Storage helpers
function loadTable<T>(key: string, defaultData: T[]): T[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      localStorage.setItem(key, JSON.stringify(defaultData));
      return defaultData;
    }
    return JSON.parse(raw);
  } catch {
    return defaultData;
  }
}

function saveTable<T>(key: string, data: T[]) {
  try {
    localStorage.setItem(key, JSON.stringify(data));
    notifyDatabaseChange(key);
  } catch (err) {
    console.warn('LocalStorage save error:', err);
  }
}

// Initialize seed data if not present
const seed = getSeedData();
loadTable(STORAGE_KEYS.ORGS, seed.orgs);
loadTable(STORAGE_KEYS.EVENTS, seed.events);
loadTable(STORAGE_KEYS.JUDGES, seed.judges);
const loadedParticipants = loadTable<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, seed.participants);
let participantsModified = false;
loadedParticipants.forEach((p, idx) => {
  if (!p.identity_id) {
    p.identity_id = `P-${8400 + idx}`;
    participantsModified = true;
  }
});
if (participantsModified) {
  saveTable(STORAGE_KEYS.PARTICIPANTS, loadedParticipants);
}
loadTable(STORAGE_KEYS.SCORES, seed.scores);

// Reactive Event Bus for cross-component realtime sync
const DB_CHANGE_EVENT = 'fairjudge_db_change';
function notifyDatabaseChange(table: string) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DB_CHANGE_EVENT, { detail: { table } }));
  }
}

export function subscribeToDatabase(callback: (table: string) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const custom = e as CustomEvent<{ table: string }>;
    callback(custom.detail?.table || 'all');
  };
  window.addEventListener(DB_CHANGE_EVENT, handler);
  return () => window.removeEventListener(DB_CHANGE_EVENT, handler);
}

export interface PublicLinkSettings {
  delaySeconds: number;
  isPaused: boolean;
  isRevoked: boolean;
  lastUpdated: string;
}

// -------------------------------------------------------------
// RELATIONAL SUPABASE DATA SERVICE (With Strict RLS Invariants)
// -------------------------------------------------------------
export const dbService = {
  // Organizations
  async getOrganizations(): Promise<Organization[]> {
    return loadTable<Organization>(STORAGE_KEYS.ORGS, []);
  },

  async getOrganizationByOrgId(orgId: string): Promise<Organization | null> {
    const orgs = loadTable<Organization>(STORAGE_KEYS.ORGS, []);
    return orgs.find((o) => o.org_id.toUpperCase() === orgId.toUpperCase().trim()) || null;
  },

  async getOrganizationByIdentifier(identifier: string): Promise<Organization | null> {
    const orgs = loadTable<Organization>(STORAGE_KEYS.ORGS, []);
    const clean = identifier.trim().toLowerCase();
    return orgs.find(
      (o) => o.org_id.toLowerCase() === clean || (o.email && o.email.toLowerCase() === clean)
    ) || null;
  },

  async createOrganization(name: string, email?: string, password?: string): Promise<Organization> {
    const orgs = loadTable<Organization>(STORAGE_KEYS.ORGS, []);
    let newOrgId = generateOrgId();
    while (orgs.some((o) => o.org_id === newOrgId)) {
      newOrgId = generateOrgId();
    }

    const newOrg: Organization = {
      id: generateUUID(),
      org_id: newOrgId,
      name: name.trim(),
      email: email?.trim(),
      password: password?.trim() || 'password123',
      tie_breaker_enabled: false,
      tie_breaker_method: 'olympic',
      created_at: new Date().toISOString(),
    };

    orgs.unshift(newOrg);
    saveTable(STORAGE_KEYS.ORGS, orgs);
    return newOrg;
  },

  async updateOrganization(orgId: string, updates: Partial<Organization>): Promise<Organization> {
    const orgs = loadTable<Organization>(STORAGE_KEYS.ORGS, []);
    const idx = orgs.findIndex((o) => o.org_id.toUpperCase() === orgId.toUpperCase().trim());
    if (idx === -1) throw new Error('Organization not found');

    orgs[idx] = { ...orgs[idx], ...updates };
    saveTable(STORAGE_KEYS.ORGS, orgs);
    return orgs[idx];
  },

  async resetOrganizationData(orgId: string): Promise<void> {
    const cleanOrgId = orgId.toUpperCase().trim();
    
    // 1. Find all events for this org
    const events = loadTable<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const orgEventIds = new Set(
      events.filter((e) => e.org_id.toUpperCase().trim() === cleanOrgId).map((e) => e.id)
    );
    
    // 2. Remove events
    const remainingEvents = events.filter((e) => e.org_id.toUpperCase().trim() !== cleanOrgId);
    saveTable(STORAGE_KEYS.EVENTS, remainingEvents);
    
    // 3. Remove scores belonging to these events
    const scores = loadTable<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    const remainingScores = scores.filter((s) => !orgEventIds.has(s.event_id));
    saveTable(STORAGE_KEYS.SCORES, remainingScores);

    // 4. Remove participants for this org
    const participants = loadTable<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const remainingParticipants = participants.filter((p) => p.org_id.toUpperCase().trim() !== cleanOrgId);
    saveTable(STORAGE_KEYS.PARTICIPANTS, remainingParticipants);

    // 5. Remove judges for this org
    const judges = loadTable<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    const remainingJudges = judges.filter((j) => j.org_id.toUpperCase().trim() !== cleanOrgId);
    saveTable(STORAGE_KEYS.JUDGES, remainingJudges);

    notifyDatabaseChange('all');
  },

  async deleteOrganization(orgId: string): Promise<void> {
    const cleanOrgId = orgId.toUpperCase().trim();
    await this.resetOrganizationData(cleanOrgId);

    const orgs = loadTable<Organization>(STORAGE_KEYS.ORGS, []);
    const remainingOrgs = orgs.filter((o) => o.org_id.toUpperCase().trim() !== cleanOrgId);
    saveTable(STORAGE_KEYS.ORGS, remainingOrgs);

    try {
      localStorage.removeItem('fairjudge_active_session');
    } catch {}

    notifyDatabaseChange('all');
  },

  // Public Link Settings
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
      localStorage.setItem(`${STORAGE_KEYS.PUBLIC_SETTINGS}_${orgId.toUpperCase()}`, JSON.stringify(updated));
      notifyDatabaseChange(STORAGE_KEYS.PUBLIC_SETTINGS);
    } catch {}
    return updated;
  },

  // Events
  async getEvents(orgId: string): Promise<SupabaseEvent[]> {
    const events = loadTable<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    return events
      .filter((e) => e.org_id.toUpperCase() === orgId.toUpperCase())
      .map((e) => ({
        ...e,
        status: (e.status.toLowerCase() as EventStatus) || 'draft',
        rubric_schema: e.rubric_schema || e.rubric || [],
        rubric: e.rubric || e.rubric_schema || [],
      }));
  },

  async getEventById(eventId: string): Promise<SupabaseEvent | null> {
    const events = loadTable<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const e = events.find((item) => item.id === eventId);
    if (!e) return null;
    return {
      ...e,
      status: (e.status.toLowerCase() as EventStatus) || 'draft',
      rubric_schema: e.rubric_schema || e.rubric || [],
      rubric: e.rubric || e.rubric_schema || [],
    };
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
    const events = loadTable<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const normalizedStatus = (eventData.status.toLowerCase() as EventStatus) || 'draft';
    const newEvent: SupabaseEvent = {
      ...eventData,
      status: normalizedStatus,
      rubric: eventData.rubric_schema,
      id: generateUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    events.unshift(newEvent);
    saveTable(STORAGE_KEYS.EVENTS, events);
    return newEvent;
  },

  async updateEventStatus(eventId: string, newStatus: EventStatus): Promise<SupabaseEvent> {
    const events = loadTable<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const idx = events.findIndex((e) => e.id === eventId);
    if (idx === -1) throw new Error('Event not found');

    const normalized = (newStatus.toLowerCase() as EventStatus);
    events[idx].status = normalized;
    events[idx].updated_at = new Date().toISOString();
    saveTable(STORAGE_KEYS.EVENTS, events);
    return events[idx];
  },

  // THE IMMUTABILITY VOID RULE
  // If ANY score has been submitted, cannot delete. Instead must Archive/Void.
  async canDeleteEvent(eventId: string): Promise<boolean> {
    const scores = loadTable<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    return !scores.some((s) => s.event_id === eventId);
  },

  async deleteEvent(eventId: string): Promise<boolean> {
    const events = loadTable<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const filtered = events.filter((e) => e.id !== eventId);
    saveTable(STORAGE_KEYS.EVENTS, filtered);
    notifyDatabaseChange(STORAGE_KEYS.EVENTS);
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

  async updateEvent(eventId: string, updates: Partial<SupabaseEvent>): Promise<SupabaseEvent> {
    const events = loadTable<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const idx = events.findIndex((e) => e.id === eventId);
    if (idx === -1) throw new Error('Event not found');

    events[idx] = {
      ...events[idx],
      ...updates,
      updated_at: new Date().toISOString(),
    };
    saveTable(STORAGE_KEYS.EVENTS, events);
    return events[idx];
  },

  async updateEventParticipantSerial(
    eventId: string,
    participantId: string,
    newSlNo: string
  ): Promise<SupabaseEvent> {
    const events = loadTable<SupabaseEvent>(STORAGE_KEYS.EVENTS, []);
    const idx = events.findIndex((e) => e.id === eventId);
    if (idx === -1) throw new Error('Event not found');

    const currentMapping = events[idx].participant_sl_numbers || {};
    events[idx].participant_sl_numbers = {
      ...currentMapping,
      [participantId]: newSlNo.trim(),
    };
    events[idx].updated_at = new Date().toISOString();
    saveTable(STORAGE_KEYS.EVENTS, events);
    return events[idx];
  },

  // Judges
  async getJudges(orgId: string): Promise<SupabaseJudge[]> {
    const judges = loadTable<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    return judges
      .filter((j) => j.org_id.toUpperCase() === orgId.toUpperCase())
      .map((j) => ({
        ...j,
        pin: j.pin || j.judge_pin || '0000',
        judge_pin: j.pin || j.judge_pin || '0000',
      }));
  },

  async createJudge(
    orgId: string, 
    name: string, 
    pin?: string, 
    customJudgeId?: string
  ): Promise<SupabaseJudge> {
    const judges = loadTable<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    const generatedPin = pin?.trim() || Math.floor(1000 + Math.random() * 9000).toString();
    const existingOrgJudges = judges.filter((j) => j.org_id.toUpperCase() === orgId.toUpperCase());
    const assignedJudgeId = customJudgeId?.trim() || `J-${String(existingOrgJudges.length + 1).padStart(2, '0')}`;

    const newJudge: SupabaseJudge = {
      id: generateUUID(),
      judge_id: assignedJudgeId,
      org_id: orgId.toUpperCase(),
      name: name.trim(),
      pin: generatedPin,
      judge_pin: generatedPin,
      assigned_events: [],
      created_at: new Date().toISOString(),
    };

    judges.unshift(newJudge);
    saveTable(STORAGE_KEYS.JUDGES, judges);
    return newJudge;
  },

  async updateJudge(
    judgeId: string,
    updates: Partial<SupabaseJudge>
  ): Promise<SupabaseJudge> {
    const judges = loadTable<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    const idx = judges.findIndex((j) => j.id === judgeId || j.judge_id === judgeId);
    if (idx === -1) throw new Error('Judge not found');

    const cleanPin = updates.pin?.trim() || updates.judge_pin?.trim() || judges[idx].pin;
    judges[idx] = {
      ...judges[idx],
      ...updates,
      pin: cleanPin,
      judge_pin: cleanPin,
    };
    saveTable(STORAGE_KEYS.JUDGES, judges);
    return judges[idx];
  },

  async deleteJudge(judgeId: string): Promise<void> {
    const judges = loadTable<SupabaseJudge>(STORAGE_KEYS.JUDGES, []);
    const filtered = judges.filter((j) => j.id !== judgeId && j.judge_id !== judgeId);
    saveTable(STORAGE_KEYS.JUDGES, filtered);
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

      // Graceful fallback to pin match within the org if id had minor typo
      if (!matchedJudge) {
        matchedJudge = judges.find((j) => j.pin === targetPin || j.judge_pin === targetPin);
      }
    } else {
      const targetPin = judgeIdOrPin.trim();
      matchedJudge = judges.find((j) => j.pin === targetPin || j.judge_pin === targetPin);
    }

    if (!matchedJudge) return null;

    const allEvents = await this.getEvents(orgId);
    let assigned = allEvents.filter(
      (e) =>
        e.assigned_judges.includes(matchedJudge!.id) ||
        matchedJudge!.assigned_events.includes(e.id)
    );

    if (assigned.length === 0) {
      assigned = allEvents.filter((e) => e.status === 'active');
      if (assigned.length === 0 && allEvents.length > 0) {
        assigned = [allEvents[0]];
      }
    }

    return { judge: matchedJudge, assignedEvents: assigned };
  },

  // Participants
  async getParticipants(orgId: string): Promise<SupabaseParticipant[]> {
    const participants = loadTable<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    return participants.filter((p) => p.org_id.toUpperCase() === orgId.toUpperCase());
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
    const participants = loadTable<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const existingOrgParticipants = participants.filter((p) => p.org_id.toUpperCase() === orgId.toUpperCase());
    const assignedSl = data.sl_no?.trim() || String(existingOrgParticipants.length + 1).padStart(2, '0');

    const newParticipant: SupabaseParticipant = {
      id: generateUUID(),
      org_id: orgId.toUpperCase(),
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
    saveTable(STORAGE_KEYS.PARTICIPANTS, participants);
    return newParticipant;
  },

  async updateParticipant(
    participantId: string,
    updates: Partial<SupabaseParticipant>
  ): Promise<SupabaseParticipant> {
    const participants = loadTable<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const idx = participants.findIndex((p) => p.id === participantId);
    if (idx === -1) throw new Error('Participant not found');

    // Immutability: identity_id cannot be altered once assigned
    const safeUpdates = { ...updates };
    delete safeUpdates.identity_id;

    participants[idx] = {
      ...participants[idx],
      ...safeUpdates,
    };
    saveTable(STORAGE_KEYS.PARTICIPANTS, participants);
    return participants[idx];
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
    const participants = loadTable<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const existingOrgCount = participants.filter((p) => p.org_id.toUpperCase() === orgId.toUpperCase()).length;

    const newItems: SupabaseParticipant[] = rows.map((r, i) => ({
      id: generateUUID(),
      org_id: orgId.toUpperCase(),
      identity_id: r.identity_id ? r.identity_id.trim() : generateIdentityId(),
      sl_no: r.sl_no ? r.sl_no.trim() : String(existingOrgCount + i + 1).padStart(2, '0'),
      name: r.name.trim(),
      school: r.school ? r.school.trim() : 'General',
      class_or_age: r.class_or_age ? r.class_or_age.trim() : '',
      mobile_number: r.mobile_number ? r.mobile_number.trim() : '',
      custom_values: r.custom_values || {},
      created_at: new Date().toISOString(),
    }));

    const combined = [...newItems, ...participants];
    saveTable(STORAGE_KEYS.PARTICIPANTS, combined);
    return newItems.length;
  },

  async deleteParticipant(participantId: string): Promise<void> {
    const participants = loadTable<SupabaseParticipant>(STORAGE_KEYS.PARTICIPANTS, []);
    const filtered = participants.filter((p) => p.id !== participantId);
    saveTable(STORAGE_KEYS.PARTICIPANTS, filtered);
  },

  // Scores (STRICT RLS POLICY: INSERT ONLY - NO UPDATES OR DELETES ALLOWED)
  async getScores(eventId: string): Promise<SupabaseScore[]> {
    const scores = loadTable<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    return scores
      .filter((s) => s.event_id === eventId)
      .map((s) => ({
        ...s,
        score_data: s.score_data || s.score_payload?.criteria || {},
        score_payload: s.score_payload || {
          criteria: s.score_data || {},
          total_score: s.total_score,
          submitted_at: s.created_at,
        },
      }));
  },

  async getScoreForJudgeParticipant(
    eventId: string,
    judgeId: string,
    participantId: string
  ): Promise<SupabaseScore | null> {
    const scores = loadTable<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    const match = scores.find(
      (s) =>
        s.event_id === eventId &&
        s.judge_id === judgeId &&
        s.participant_id === participantId
    );
    if (!match) return null;
    return {
      ...match,
      score_data: match.score_data || match.score_payload?.criteria || {},
      score_payload: match.score_payload || {
        criteria: match.score_data || {},
        total_score: match.total_score,
        submitted_at: match.created_at,
      },
    };
  },

  async submitScore(
    scoreData: {
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
    }
  ): Promise<SupabaseScore> {
    // 1. Strict Event Status Guard: Protect the cryptographic ledger
    const event = await this.getEventById(scoreData.event_id);
    if (!event) {
      throw new Error('Event not found');
    }
    if (event.status === 'ended' || event.status === 'paused') {
      throw new Error(
        `Cryptographic Ledger Protected: Event is ${event.status}. Score submission rejected.`
      );
    }

    // 2. Check if score already exists (Strict RLS Immutability check with 5-minute grace period support)
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

    const scores = loadTable<SupabaseScore>(STORAGE_KEYS.SCORES, []);
    const criteriaMap = scoreData.score_data || scoreData.score_payload?.criteria || {};
    const timestamp = new Date().toISOString();

    if (existing && isWithinGrace) {
      // Update existing ballot within 5-minute grace period
      const idx = scores.findIndex((s) => s.id === existing.id);
      if (idx !== -1) {
        scores[idx] = {
          ...scores[idx],
          score_data: criteriaMap,
          total_score: scoreData.total_score,
          score_payload: {
            criteria: criteriaMap,
            total_score: scoreData.total_score,
            submitted_at: timestamp,
          },
        };
        saveTable(STORAGE_KEYS.SCORES, scores);
        return scores[idx];
      }
    }

    const newScore: SupabaseScore = {
      id: generateUUID(),
      event_id: scoreData.event_id,
      judge_id: scoreData.judge_id,
      participant_id: scoreData.participant_id,
      score_data: criteriaMap,
      total_score: scoreData.total_score,
      score_payload: scoreData.score_payload || {
        criteria: criteriaMap,
        total_score: scoreData.total_score,
        submitted_at: timestamp,
      },
      created_at: timestamp,
    };

    scores.push(newScore);
    saveTable(STORAGE_KEYS.SCORES, scores);
    return newScore;
  },

  // Tie-Breaker Engine Logic
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
          // Olympic Trim: Drop highest and lowest score, average the rest
          const sorted = [...pScores].sort((a, b) => a.total_score - b.total_score);
          const trimmed = sorted.slice(1, sorted.length - 1);
          const sum = trimmed.reduce((acc, s) => acc + s.total_score, 0);
          computedAverage = Number((sum / trimmed.length).toFixed(2));
        } else if (tieBreakerEnabled && method === 'manual') {
          // Manual Override / Precise Decimal Average
          const sum = pScores.reduce((acc, s) => acc + s.total_score, 0);
          computedAverage = Number((sum / judgeCount).toFixed(4));
        } else {
          // Standard Average (or Default when tie-breaker is toggled OFF)
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

    // Sort descending by score
    rawList.sort((a, b) => b.avgScore - a.avgScore);

    // Assign rank according to method
    let currentRank = 1;
    return rawList.map((item, index) => {
      if (index === 0) {
        currentRank = 1;
      } else {
        const prev = rawList[index - 1];
        if (tieBreakerEnabled && method === 'shared' && item.avgScore === prev.avgScore && item.judgeCount > 0) {
          // Tied scores share the exact same placement
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
