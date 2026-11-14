const CLOCK_OFFSET_STORAGE_KEY = 'fj_server_clock_offset_ms';

let cachedOffsetMs: number | null = null;

function readPersistedOffset(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(CLOCK_OFFSET_STORAGE_KEY);
    if (!raw) return 0;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

export function getServerClockOffsetMs(): number {
  if (cachedOffsetMs === null) {
    cachedOffsetMs = readPersistedOffset();
  }
  return Number.isFinite(cachedOffsetMs) ? cachedOffsetMs : 0;
}

export function setServerClockOffsetMs(offsetMs: number): void {
  if (!Number.isFinite(offsetMs)) return;
  const rounded = Math.round(offsetMs);
  cachedOffsetMs = rounded;
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(CLOCK_OFFSET_STORAGE_KEY, String(rounded));
    } catch {}
  }
}

export function getServerNowMs(): number {
  return Date.now() + getServerClockOffsetMs();
}
