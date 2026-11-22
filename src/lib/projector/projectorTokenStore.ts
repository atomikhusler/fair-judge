/**
 * Projector App Session & Display Preference Storage
 *
 * Security contract:
 * - Stores ONLY the single-event projector_token and safe display metadata.
 * - Uses sessionStorage (clears automatically when the browser tab/window closes).
 * - NEVER stores organiser passwords, organiser session tokens, judge PINs, or phone numbers.
 */

export interface StoredProjectorSession {
  token: string;
  orgId: string;
  orgName: string;
  eventId: string;
  eventName: string;
  eventCategory?: string;
  expiresAt: string;
  cursorVersion: number;
}

export type ProjectorDisplayTheme = 'dark' | 'light';
export type ProjectorLiveMode = 'leaderboard' | 'scoreboard';
export type ProjectorOverscanPercent = 0 | 2 | 4 | 6;

export interface ProjectorLocalSettings {
  theme: ProjectorDisplayTheme;
  liveMode: ProjectorLiveMode;
  hideScores: boolean;
  overscan: ProjectorOverscanPercent;
}

const SESSION_KEY = 'fj_projector_app_session_v1';
const SETTINGS_KEY = 'fj_projector_app_settings_v1';

const FORBIDDEN_SECRET_KEYS = new Set([
  'password',
  'org_password',
  'org_token',
  'organiser_token',
  'session_token',
  'current_session_token',
  'pin',
  'judge_pin',
  'mobile_number',
]);

const DEFAULT_SETTINGS: ProjectorLocalSettings = {
  theme: 'dark',
  liveMode: 'leaderboard',
  hideScores: false,
  overscan: 0,
};

function getSessionStorageSafe(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      return window.sessionStorage;
    }
    const g = globalThis as { sessionStorage?: Storage };
    return g.sessionStorage || null;
  } catch {
    return null;
  }
}

function sanitizeSession(raw: unknown): StoredProjectorSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const token = typeof obj.token === 'string' ? obj.token.trim() : '';
  const orgId = typeof obj.orgId === 'string' ? obj.orgId.trim() : '';
  const eventId = typeof obj.eventId === 'string' ? obj.eventId.trim() : '';
  const expiresAt = typeof obj.expiresAt === 'string' ? obj.expiresAt.trim() : '';

  if (!token || !orgId || !eventId || !expiresAt) return null;

  const cursorNum = Number(obj.cursorVersion ?? 0);
  return {
    token,
    orgId,
    orgName: typeof obj.orgName === 'string' ? obj.orgName : orgId,
    eventId,
    eventName: typeof obj.eventName === 'string' ? obj.eventName : 'Event',
    eventCategory: typeof obj.eventCategory === 'string' ? obj.eventCategory : '',
    expiresAt,
    cursorVersion: Number.isFinite(cursorNum) && cursorNum >= 0 ? Math.floor(cursorNum) : 0,
  };
}

export function loadProjectorSession(): StoredProjectorSession | null {
  const store = getSessionStorageSafe();
  if (!store) return null;
  try {
    const raw = store.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const clean = sanitizeSession(parsed);
    if (!clean) {
      store.removeItem(SESSION_KEY);
      return null;
    }
    const expMs = Date.parse(clean.expiresAt);
    if (Number.isFinite(expMs) && expMs <= Date.now()) {
      store.removeItem(SESSION_KEY);
      return null;
    }
    return clean;
  } catch {
    return null;
  }
}

export function saveProjectorSession(session: StoredProjectorSession): StoredProjectorSession {
  const clean: StoredProjectorSession = {
    token: session.token.trim(),
    orgId: session.orgId.trim(),
    orgName: session.orgName || session.orgId,
    eventId: session.eventId.trim(),
    eventName: session.eventName || 'Event',
    eventCategory: session.eventCategory || '',
    expiresAt: session.expiresAt,
    cursorVersion:
      Number.isFinite(session.cursorVersion) && session.cursorVersion >= 0
        ? Math.floor(session.cursorVersion)
        : 0,
  };

  // Defense-in-depth: strip any accidental forbidden keys before serialization
  const safePayload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(clean)) {
    if (!FORBIDDEN_SECRET_KEYS.has(k.toLowerCase())) {
      safePayload[k] = v;
    }
  }

  const store = getSessionStorageSafe();
  if (store) {
    try {
      store.setItem(SESSION_KEY, JSON.stringify(safePayload));
    } catch {
      // Ignore storage quota / private-mode write errors
    }
  }
  return clean;
}

export function updateProjectorCursor(cursorVersion: number, expiresAt?: string): void {
  const existing = loadProjectorSession();
  if (!existing) return;
  saveProjectorSession({
    ...existing,
    cursorVersion:
      Number.isFinite(cursorVersion) && cursorVersion >= 0
        ? Math.floor(cursorVersion)
        : existing.cursorVersion,
    expiresAt: expiresAt || existing.expiresAt,
  });
}

export function clearProjectorSession(): void {
  const store = getSessionStorageSafe();
  if (!store) return;
  try {
    store.removeItem(SESSION_KEY);
  } catch {
    // Ignore
  }
}

export function loadProjectorSettings(): ProjectorLocalSettings {
  const store = getSessionStorageSafe();
  if (!store) return { ...DEFAULT_SETTINGS };
  try {
    const raw = store.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ProjectorLocalSettings>;
    const overscanVal = parsed.overscan;
    const overscan: ProjectorOverscanPercent =
      overscanVal === 2 || overscanVal === 4 || overscanVal === 6 ? overscanVal : 0;
    return {
      theme: parsed.theme === 'light' ? 'light' : 'dark',
      liveMode: parsed.liveMode === 'scoreboard' ? 'scoreboard' : 'leaderboard',
      hideScores: Boolean(parsed.hideScores),
      overscan,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveProjectorSettings(
  patch: Partial<ProjectorLocalSettings>
): ProjectorLocalSettings {
  const next: ProjectorLocalSettings = {
    ...loadProjectorSettings(),
    ...patch,
  };
  const store = getSessionStorageSafe();
  if (store) {
    try {
      store.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      // Ignore
    }
  }
  return next;
}

export const PROJECTOR_TOKEN_STORAGE_KEYS = {
  SESSION: SESSION_KEY,
  SETTINGS: SETTINGS_KEY,
} as const;
