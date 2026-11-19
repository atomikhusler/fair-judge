export const APP_VERSION = '16.10.3';

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
let latestRemoteBuildId: string | null = null;
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

export function getLatestRemoteBuildId(): string | null {
  return latestRemoteBuildId;
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

export interface VersionJsonCheckResult {
  updateReady: boolean;
  remoteBuildId: string | null;
  runningBuildId: string;
}

export async function checkVersionJsonForUpdate(): Promise<VersionJsonCheckResult> {
  const runningBuildId = getRunningBuildId();
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return { updateReady: isSilentUpdateReady(), remoteBuildId: latestRemoteBuildId, runningBuildId };
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { updateReady: isSilentUpdateReady(), remoteBuildId: latestRemoteBuildId, runningBuildId };
  }
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) {
      return { updateReady: isSilentUpdateReady(), remoteBuildId: latestRemoteBuildId, runningBuildId };
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType && !contentType.includes('json')) {
      return { updateReady: isSilentUpdateReady(), remoteBuildId: latestRemoteBuildId, runningBuildId };
    }
    const data = (await res.json()) as { version?: unknown; build_id?: unknown } | null;
    const remoteBuildId = typeof data?.build_id === 'string' ? data.build_id.trim() : '';
    if (remoteBuildId) {
      latestRemoteBuildId = remoteBuildId;
      if (remoteBuildId !== runningBuildId && !versionJsonUpdateReady) {
        versionJsonUpdateReady = true;
        notifyUpdateListeners();
      }
    }
  } catch {
    // Offline or non-JSON response: keep silent
  }
  return { updateReady: isSilentUpdateReady(), remoteBuildId: latestRemoteBuildId, runningBuildId };
}
