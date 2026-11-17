export const APP_VERSION = '16.7.0';

export function getRunningBuildId(): string {
  return typeof __APP_BUILD_ID__ !== 'undefined' && __APP_BUILD_ID__ ? __APP_BUILD_ID__ : APP_VERSION;
}

/**
 * Compares two dot-separated numeric version strings part by part as integers.
 * Never compares as strings or by build_id. Returns 0 (fail-open) if malformed.
 */
export function compareVersionsNumeric(a: string, b: string): number {
  const parse = (raw: string): number[] | null => {
    const clean = String(raw || '').trim().replace(/^v/i, '');
    if (!/^\d+(\.\d+)*$/.test(clean)) return null;
    return clean.split('.').map((part) => Number.parseInt(part, 10));
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  const maxLen = Math.max(pa.length, pb.length);
  for (let i = 0; i < maxLen; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

let versionJsonUpdateReady = false;
let swWaitingUpdateReady = false;
const updateListeners = new Set<() => void>();

function notifyUpdateListeners(): void {
  updateListeners.forEach((cb) => {
    try {
      cb();
    } catch {}
  });
}

export function isSilentUpdateReady(): boolean {
  return versionJsonUpdateReady || swWaitingUpdateReady;
}

export function setSwWaitingReady(waiting: boolean): void {
  if (swWaitingUpdateReady === waiting) return;
  swWaitingUpdateReady = waiting;
  notifyUpdateListeners();
}

export function subscribeSilentUpdateReady(cb: () => void): () => void {
  updateListeners.add(cb);
  return () => {
    updateListeners.delete(cb);
  };
}

export async function checkVersionJsonForUpdate(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return isSilentUpdateReady();
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return isSilentUpdateReady();
  }
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return isSilentUpdateReady();
    const contentType = res.headers.get('content-type') || '';
    if (contentType && !contentType.includes('json')) {
      return isSilentUpdateReady();
    }
    const data = (await res.json()) as { version?: unknown; build_id?: unknown } | null;
    const remoteBuildId = typeof data?.build_id === 'string' ? data.build_id.trim() : '';
    const runningBuildId = getRunningBuildId();
    if (remoteBuildId && remoteBuildId !== runningBuildId) {
      if (!versionJsonUpdateReady) {
        versionJsonUpdateReady = true;
        notifyUpdateListeners();
      }
    }
  } catch {
    // Offline or non-JSON response: keep silent
  }
  return isSilentUpdateReady();
}
