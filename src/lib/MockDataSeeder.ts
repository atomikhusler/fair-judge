import { Organization, SupabaseEvent, SupabaseJudge, SupabaseParticipant, SupabaseScore } from './supabaseTypes';
import { generateUUID, dbService } from './supabase';

const STORAGE_KEYS = {
  ORGS: 'fairjudge_supabase_orgs',
  EVENTS: 'fairjudge_supabase_events',
  JUDGES: 'fairjudge_supabase_judges',
  PARTICIPANTS: 'fairjudge_supabase_participants',
  SCORES: 'fairjudge_supabase_scores',
  ACTIVE_SESSION: 'fairjudge_active_session',
};

export interface MockSession {
  role: 'organiser' | 'judge';
  org: Organization;
  judge?: SupabaseJudge;
  event?: SupabaseEvent;
}

export const DEMO_DATA = {
  orgId: 'FJ-DANCE',
  orgName: 'National Performing Arts Guild',
  adminEmail: 'director@dancefest.org',
  judges: [
    {
      id: 'mock-j-1',
      judge_id: 'J-01',
      org_id: 'FJ-DANCE',
      name: 'Judge 1 - Elena Rostova',
      pin: '1234',
      judge_pin: '1234',
      assigned_events: ['mock-event-dance-fest'],
      created_at: new Date().toISOString(),
    },
    {
      id: 'mock-j-2',
      judge_id: 'J-02',
      org_id: 'FJ-DANCE',
      name: 'Judge 2 - Marcus Vance',
      pin: '5678',
      judge_pin: '5678',
      assigned_events: ['mock-event-dance-fest'],
      created_at: new Date().toISOString(),
    },
  ],
  participants: [
    {
      id: 'mock-p-1',
      org_id: 'FJ-DANCE',
      identity_id: 'P-8492',
      sl_no: '01',
      name: 'Rohan Deshmukh',
      school: 'Royal Academy of Rhythm',
      created_at: new Date().toISOString(),
    },
    {
      id: 'mock-p-2',
      org_id: 'FJ-DANCE',
      identity_id: 'P-3104',
      sl_no: '02',
      name: 'Maya Elizabeth',
      school: 'St. Teresa Contemporary Dance',
      created_at: new Date().toISOString(),
    },
    {
      id: 'mock-p-3',
      org_id: 'FJ-DANCE',
      identity_id: 'P-5721',
      sl_no: '03',
      name: 'Kavita Menon',
      school: 'Classical Heritage School',
      created_at: new Date().toISOString(),
    },
    {
      id: 'mock-p-4',
      org_id: 'FJ-DANCE',
      identity_id: 'P-9240',
      sl_no: '04',
      name: 'Aarav Sharma',
      school: 'Apex Arts Institute',
      created_at: new Date().toISOString(),
    },
  ],
  rubric: [
    { id: 'crit_choreo', name: 'Choreography & Musicality', max_marks: 10, weight: 1 },
    { id: 'crit_costume', name: 'Costume & Presentation', max_marks: 5, weight: 1 },
    { id: 'crit_sync', name: 'Rhythm & Synchronization', max_marks: 10, weight: 1 },
  ],
};

function seedDatabaseRecords(): {
  org: Organization;
  events: SupabaseEvent[];
  judges: SupabaseJudge[];
  participants: SupabaseParticipant[];
} {
  const org: Organization = {
    id: generateUUID(),
    org_id: DEMO_DATA.orgId,
    name: DEMO_DATA.orgName,
    email: DEMO_DATA.adminEmail,
    password: 'password123',
    tie_breaker_enabled: false,
    tie_breaker_method: 'olympic',
    created_at: new Date().toISOString(),
  };

  const activeEvent: SupabaseEvent = {
    id: 'mock-event-dance-fest',
    org_id: DEMO_DATA.orgId,
    name: 'Annual Dance Fest',
    category: 'Performing Arts',
    date: new Date().toISOString().split('T')[0],
    status: 'active',
    rubric_schema: DEMO_DATA.rubric,
    rubric: DEMO_DATA.rubric,
    assigned_judges: DEMO_DATA.judges.map((j) => j.id),
    assigned_participants: DEMO_DATA.participants.map((p) => p.id),
    created_at: new Date().toISOString(),
  };

  const draftEvent: SupabaseEvent = {
    id: 'mock-event-classical-showcase',
    org_id: DEMO_DATA.orgId,
    name: 'Classical Solo Showcase',
    category: 'Traditional Dance',
    date: new Date(Date.now() + 86400000).toISOString().split('T')[0],
    status: 'draft',
    rubric_schema: DEMO_DATA.rubric.slice(0, 2),
    rubric: DEMO_DATA.rubric.slice(0, 2),
    assigned_judges: [DEMO_DATA.judges[0].id],
    assigned_participants: [DEMO_DATA.participants[0].id, DEMO_DATA.participants[1].id],
    created_at: new Date().toISOString(),
  };

  const existingOrgsRaw = localStorage.getItem(STORAGE_KEYS.ORGS);
  let orgs: Organization[] = [];
  try {
    orgs = existingOrgsRaw ? JSON.parse(existingOrgsRaw) : [];
  } catch {}
  if (!orgs.some((o) => o.org_id === org.org_id)) {
    orgs.push(org);
  } else {
    orgs = orgs.map((o) => (o.org_id === org.org_id ? org : o));
  }

  localStorage.setItem(STORAGE_KEYS.ORGS, JSON.stringify(orgs));
  localStorage.setItem(STORAGE_KEYS.EVENTS, JSON.stringify([activeEvent, draftEvent]));
  localStorage.setItem(STORAGE_KEYS.JUDGES, JSON.stringify(DEMO_DATA.judges));
  localStorage.setItem(STORAGE_KEYS.PARTICIPANTS, JSON.stringify(DEMO_DATA.participants));

  return {
    org,
    events: [activeEvent, draftEvent],
    judges: DEMO_DATA.judges,
    participants: DEMO_DATA.participants,
  };
}

export function seedOrganiserDemo(): MockSession {
  const { org, events, judges } = seedDatabaseRecords();

  const session: MockSession = {
    role: 'organiser',
    org,
    judge: judges[0],
    event: events[0],
  };

  localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, JSON.stringify(session));

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('fairjudge_db_change', { detail: { table: 'all' } }));
    window.dispatchEvent(new CustomEvent('fairjudge_session_change'));
  }

  return session;
}

export function seedJudgeDemo(): MockSession {
  const { org, events, judges } = seedDatabaseRecords();

  const session: MockSession = {
    role: 'judge',
    org,
    judge: judges[0], // Elena Rostova
    event: events[0], // Annual Dance Fest
  };

  localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, JSON.stringify(session));

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('fairjudge_db_change', { detail: { table: 'all' } }));
    window.dispatchEvent(new CustomEvent('fairjudge_session_change'));
  }

  return session;
}

export function resetDemoData() {
  localStorage.removeItem(STORAGE_KEYS.SCORES);
  seedDatabaseRecords();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('fairjudge_db_change', { detail: { table: 'all' } }));
  }
}

export function wipeAllCompetitionData(orgId: string) {
  try {
    dbService.resetOrganizationData(orgId);
  } catch (err) {
    console.error('Error wiping data:', err);
  }
}

// Backward-compatible alias
export function runMockSeeder(): MockSession {
  return seedOrganiserDemo();
}

export function getStoredSession(): MockSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setStoredSession(session: MockSession | null) {
  try {
    if (!session) {
      localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
    } else {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, JSON.stringify(session));
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('fairjudge_session_change'));
    }
  } catch {}
}
