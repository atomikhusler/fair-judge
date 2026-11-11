/**
 * Black Box Recorder (Epic 15.4)
 * Passive flight recorder capturing uncaught errors, rejection events, chunk load issues,
 * console.error logs, and React ErrorBoundary catches.
 * Strict redaction (emails, phone numbers, tokens, URL query params). Ring buffer cap: 30.
 */

export interface BlackBoxEntry {
  t: number; // Timestamp
  type: 'uncaught' | 'unhandledrejection' | 'preload' | 'console_error' | 'boundary';
  msg: string; // <= 200 chars, redacted
  frame: string; // First stack frame or location
  count: number;
}

const STORAGE_KEY = 'fj_blackbox_v1';
const MAX_ENTRIES = 30;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

let entries: BlackBoxEntry[] = [];
let isInstalled = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let originalConsoleError: ((...args: any[]) => void) | null = null;
let isInternalLogging = false;

/**
 * Sanitizes and redacts sensitive strings before recording.
 * Removes emails, 7+ digit numbers, tokens >= 20 chars, and URL queries.
 */
export function redactMessage(raw: string): string {
  if (!raw) return 'Unknown error';
  let str = String(raw);

  // Redact URL query strings (?key=val&...)
  str = str.replace(/\?[^\s"'>]+/g, '?[REDACTED]');

  // Redact emails
  str = str.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');

  // Redact tokens and long hex/base64 strings >= 20 chars
  str = str.replace(/\b[a-zA-Z0-9_-]{20,}\b/g, '[TOKEN]');

  // Redact 7+ digit numbers (phone numbers, account IDs)
  str = str.replace(/\b\d{7,}\b/g, '[NUM]');

  // Cap at 200 characters
  if (str.length > 200) {
    str = str.slice(0, 197) + '...';
  }

  return str.trim();
}

/**
 * Extracts the first relevant stack frame from an error stack or string.
 */
function extractFirstFrame(error: any): string {
  if (error && error.stack && typeof error.stack === 'string') {
    const lines = error.stack.split('\n');
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line && !line.includes('blackBox.ts')) {
        return line.slice(0, 100);
      }
    }
  }
  return 'unknown:0:0';
}

/**
 * Loads entries from localStorage during initialization
 */
function loadFromStorage(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        entries = parsed.slice(-MAX_ENTRIES);
      }
    }
  } catch {}
}

/**
 * Persists entries to localStorage with debouncing for high-frequency logs.
 */
function schedulePersist(immediate = false): void {
  if (typeof window === 'undefined') return;

  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {}
  };

  if (immediate) {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    save();
  } else {
    if (!persistTimer) {
      persistTimer = setTimeout(() => {
        persistTimer = null;
        save();
      }, 500);
    }
  }
}

/**
 * Records an error event into the ring buffer.
 */
export function recordError(
  type: BlackBoxEntry['type'],
  errorOrMsg: any,
  overrideFrame?: string
): void {
  let rawMsg = '';
  let frame = overrideFrame || '';

  if (typeof errorOrMsg === 'string') {
    rawMsg = errorOrMsg;
  } else if (errorOrMsg && typeof errorOrMsg === 'object') {
    rawMsg = errorOrMsg.message || errorOrMsg.name || JSON.stringify(errorOrMsg);
    if (!frame) {
      frame = extractFirstFrame(errorOrMsg);
    }
  } else {
    rawMsg = String(errorOrMsg);
  }

  const redacted = redactMessage(rawMsg);
  const now = Date.now();

  // Deduplicate identical type + message within 10-minute window
  const existingIndex = entries.findIndex(
    (e) => e.type === type && e.msg === redacted && now - e.t < DEDUPE_WINDOW_MS
  );

  if (existingIndex >= 0) {
    entries[existingIndex].count += 1;
    entries[existingIndex].t = now;
  } else {
    const entry: BlackBoxEntry = {
      t: now,
      type,
      msg: redacted,
      frame: frame || 'root',
      count: 1,
    };
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) {
      entries.shift();
    }
  }

  // Crash-prone errors persist synchronously
  const isUrgent = type === 'boundary' || type === 'uncaught' || type === 'preload';
  schedulePersist(isUrgent);
}

/**
 * Installs window error listeners and console.error interception.
 * Must be executed once before rendering the application.
 */
export function install(): void {
  if (isInstalled || typeof window === 'undefined') return;
  isInstalled = true;

  loadFromStorage();

  // 1. Window uncaught errors
  window.addEventListener('error', (event: ErrorEvent) => {
    recordError('uncaught', event.error || event.message, `${event.filename}:${event.lineno}:${event.colno}`);
  });

  // 2. Unhandled promise rejections
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    recordError('unhandledrejection', event.reason);
  });

  // 3. Vite chunk preload failures
  window.addEventListener('vite:preloadError', (event: any) => {
    recordError('preload', event.payload || 'Failed to fetch dynamically imported module');
  });

  // 4. Intercept console.error without recursive loops
  if (console && console.error) {
    originalConsoleError = console.error.bind(console);
    console.error = (...args: any[]) => {
      if (originalConsoleError) {
        originalConsoleError(...args);
      }
      if (!isInternalLogging) {
        try {
          isInternalLogging = true;
          const msg = args.map((a) => (typeof a === 'string' ? a : a?.message || '')).join(' ');
          recordError('console_error', msg || 'console.error invocation');
        } catch {
        } finally {
          isInternalLogging = false;
        }
      }
    };
  }
}

/**
 * Returns recorded entries from the ring buffer
 */
export function getEntries(): BlackBoxEntry[] {
  return [...entries];
}

/**
 * Returns aggregated statistics for the self-test engine (last 24 hours)
 */
export function getCodeHealthSummary(): {
  total24h: number;
  problemCount: number;
  noticeCount: number;
  topMessages: { msg: string; count: number; timeAgo: string }[];
} {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = entries.filter((e) => e.t >= oneDayAgo);

  let problemCount = 0;
  let noticeCount = 0;

  for (const e of recent) {
    if (e.type === 'uncaught' || e.type === 'boundary' || e.type === 'preload') {
      problemCount += e.count;
    } else {
      noticeCount += e.count;
    }
  }

  // Top 3 messages by count
  const sorted = [...recent].sort((a, b) => b.count - a.count).slice(0, 3);
  const topMessages = sorted.map((e) => {
    const diffMin = Math.floor((Date.now() - e.t) / 60000);
    const timeAgo = diffMin < 1 ? 'just now' : diffMin === 1 ? '1 min ago' : `${diffMin} min ago`;
    return {
      msg: e.msg,
      count: e.count,
      timeAgo,
    };
  });

  return {
    total24h: problemCount + noticeCount,
    problemCount,
    noticeCount,
    topMessages,
  };
}

/**
 * Clears the error ring buffer from memory and localStorage
 */
export function clearLog(): void {
  entries = [];
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }
}

export const blackBox = {
  install,
  recordError,
  getEntries,
  getCodeHealthSummary,
  clearLog,
  redactMessage,
};
