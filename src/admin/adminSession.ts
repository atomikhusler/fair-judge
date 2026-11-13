export const ADMIN_AUTH_STORAGE_KEY = 'fj-admin-auth';
export const ADMIN_LAST_ACTIVE_KEY = 'fj_admin_last_active';
export const ADMIN_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const memoryFallback = new Map<string, string>();

export const safeAdminStorage = {
  getItem(key: string): string | null {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage.getItem(key);
      }
    } catch {
      // Blocked localStorage falls back to in-memory
    }
    return memoryFallback.get(key) ?? null;
  },
  setItem(key: string, value: string): void {
    memoryFallback.set(key, value);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(key, value);
      }
    } catch {
      // Blocked localStorage falls back to in-memory
    }
  },
  removeItem(key: string): void {
    memoryFallback.delete(key);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(key);
      }
    } catch {
      // Blocked localStorage falls back to in-memory
    }
  },
};

export function getLastActive(): number | null {
  const raw = safeAdminStorage.getItem(ADMIN_LAST_ACTIVE_KEY);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function touchLastActive(now: number = Date.now()): void {
  safeAdminStorage.setItem(ADMIN_LAST_ACTIVE_KEY, String(now));
}

export function isIdleExpired(now: number = Date.now()): boolean {
  const last = getLastActive();
  if (last === null) return true;
  return now - last > ADMIN_IDLE_TIMEOUT_MS;
}

export function clearAdminStorage(): void {
  // Clear memory fallback keys
  for (const key of Array.from(memoryFallback.keys())) {
    if (key.startsWith(ADMIN_AUTH_STORAGE_KEY) || key === ADMIN_LAST_ACTIVE_KEY) {
      memoryFallback.delete(key);
    }
  }

  // Clear localStorage keys matching fj-admin-auth* and fj_admin_last_active
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && (key.startsWith(ADMIN_AUTH_STORAGE_KEY) || key === ADMIN_LAST_ACTIVE_KEY)) {
          keysToRemove.push(key);
        }
      }
      for (const key of keysToRemove) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore storage access errors
  }
}
