/**
 * Asynchronous IndexedDB Storage Engine for Fair Judge
 * Replaces synchronous localStorage to eliminate main-thread blocking on large datasets.
 * Features an in-memory hot mirror for zero-latency synchronous reads during React hydration.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { eventBus } from '../eventBus';
import { normalizeDbTableName } from '../dbTables';

export interface CacheEntry<T = any> {
  key: string;
  data: T;
  timestamp: number;
}

interface FairJudgeCacheDB extends DBSchema {
  cache_store: {
    key: string;
    value: CacheEntry;
    indexes: { 'by-timestamp': number };
  };
}

const DB_NAME = 'fairjudge_cache_db_v1';
const DB_VERSION = 1;

// 5-Minute SWR Cache Time-To-Live
export const CACHE_TTL_MS = 5 * 60 * 1000;

let dbPromise: Promise<IDBPDatabase<FairJudgeCacheDB>> | null = null;

// In-Memory Hot Mirror for instant synchronous read access without blocking or flicker
const hotMemoryCache: Map<string, CacheEntry> = new Map();
const cacheTimestamps: Map<string, number> = new Map();
let isInitialized = false;

/**
 * Initializes or returns the cached IndexedDB instance
 */
export function getCacheDB(): Promise<IDBPDatabase<FairJudgeCacheDB>> {
  if (!dbPromise) {
    dbPromise = openDB<FairJudgeCacheDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('cache_store')) {
          const store = db.createObjectStore('cache_store', { keyPath: 'key' });
          store.createIndex('by-timestamp', 'timestamp');
        }
      },
    });
  }
  return dbPromise;
}

const MAX_LOCAL_MIRROR_CHARS = 250_000;

/**
 * Primes the in-memory hot mirror from IndexedDB and migrates any legacy localStorage caches
 */
export async function initCacheStorage(): Promise<void> {
  if (isInitialized) return;

  try {
    const db = await getCacheDB();
    const allEntries = await db.getAll('cache_store');
    let hydratedNewData = false;

    allEntries.forEach((entry) => {
      const existing = hotMemoryCache.get(entry.key);
      // Never clobber fresh in-memory writes that occurred while IDB was opening
      if (!existing || (existing.timestamp === 0 && entry.data !== undefined)) {
        hotMemoryCache.set(entry.key, {
          key: entry.key,
          data: entry.data,
          // Restored cold entries are display-ready (0ms UI hydration) but not fresh for SWR skip
          timestamp: 0,
        });
        if (!existing) {
          hydratedNewData = true;
        }
      }
    });

    // Check for legacy localStorage data and migrate asynchronously
    const legacyKeys = [
      'fairjudge_supabase_events',
      'fairjudge_supabase_participants',
      'fairjudge_supabase_judges',
      'fairjudge_supabase_scores',
      'fairjudge_supabase_orgs',
    ];

    for (const key of legacyKeys) {
      try {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            if (!hotMemoryCache.has(key)) {
              await setIndexedDBCache(key, parsed, true);
              hydratedNewData = true;
            }
          }
        }
      } catch {
        // Safe skip
      }
    }

    isInitialized = true;
    if (hydratedNewData) {
      eventBus.emit('cache_updated', { table: 'all' });
    }
  } catch (err) {
    console.warn('Failed to initialize IndexedDB cache engine:', err);
    isInitialized = true;
  }
}

/**
 * Synchronously retrieves item from the hot in-memory cache
 */
export function getHotCache<T>(key: string, defaultVal: T): T {
  const entry = hotMemoryCache.get(key);
  if (entry && entry.data !== undefined) {
    return entry.data as T;
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed !== undefined && parsed !== null) {
        // Timestamp 0: gives instant display hydration on boot without faking SWR freshness
        hotMemoryCache.set(key, { key, data: parsed, timestamp: 0 });
        return parsed as T;
      }
    }
  } catch {}
  return defaultVal;
}

/**
 * Marks a logical cache key (e.g. per-org cacheKey) as freshly verified
 */
export function touchCacheTimestamp(key: string): void {
  const now = Date.now();
  cacheTimestamps.set(key, now);
  const entry = hotMemoryCache.get(key);
  if (entry) {
    entry.timestamp = now;
  }
}

/**
 * Check if the cached key is still fresh within this session (younger than 5 minutes)
 */
export function isCacheFresh(key: string): boolean {
  const ts = cacheTimestamps.get(key) ?? hotMemoryCache.get(key)?.timestamp ?? 0;
  if (!ts) return false;
  return Date.now() - ts < CACHE_TTL_MS;
}

/**
 * Checks if key exists in cache with non-empty content
 */
export function hasCachedKey(key: string): boolean {
  const entry = hotMemoryCache.get(key);
  if (!entry || !entry.data) return false;
  if (Array.isArray(entry.data)) return entry.data.length > 0;
  return true;
}

/**
 * Asynchronously writes data to IndexedDB while immediately updating hot in-memory mirror
 */
export async function setIndexedDBCache<T>(
  key: string,
  data: T,
  silent: boolean = false
): Promise<void> {
  const entry: CacheEntry<T> = {
    key,
    data,
    timestamp: Date.now(),
  };

  // 1. Immediate in-memory hot mirror write
  hotMemoryCache.set(key, entry);

  // Bounded synchronous backup in localStorage so large datasets never starve session/draft quota
  try {
    const serialized = JSON.stringify(data);
    if (serialized.length <= MAX_LOCAL_MIRROR_CHARS) {
      localStorage.setItem(key, serialized);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {}
  }

  // 2. Asynchronous write to IndexedDB
  try {
    const db = await getCacheDB();
    await db.put('cache_store', entry);
  } catch (err) {
    console.warn(`IndexedDB write warning for "${key}":`, err);
  }

  // 3. Emit EventBus update if not silent
  if (!silent) {
    const tableName = normalizeDbTableName(key);
    eventBus.emit('cache_updated', { table: tableName, data });
  }
}

/**
 * Asynchronously reads data from IndexedDB
 */
export async function getIndexedDBCache<T>(key: string, defaultVal: T): Promise<T> {
  const hot = hotMemoryCache.get(key);
  if (hot && hot.data !== undefined) {
    return hot.data as T;
  }

  try {
    const db = await getCacheDB();
    const entry = await db.get('cache_store', key);
    if (entry && entry.data !== undefined) {
      hotMemoryCache.set(key, { key: entry.key, data: entry.data, timestamp: 0 });
      return entry.data as T;
    }
  } catch (err) {
    console.warn(`IndexedDB read warning for "${key}":`, err);
  }

  return defaultVal;
}

/**
 * Invalidate cache entry (plus prefixed sub-keys) or entire cache
 */
export async function invalidateCache(key?: string): Promise<void> {
  if (key) {
    cacheTimestamps.delete(key);
    for (const trackedKey of cacheTimestamps.keys()) {
      if (trackedKey.startsWith(`${key}_`)) {
        cacheTimestamps.delete(trackedKey);
      }
    }
    for (const [hotKey, entry] of hotMemoryCache.entries()) {
      if (hotKey === key || hotKey.startsWith(`${key}_`)) {
        entry.timestamp = 0;
        hotMemoryCache.set(hotKey, entry);
      }
    }
    try {
      const db = await getCacheDB();
      const existing = await db.get('cache_store', key);
      if (existing) {
        existing.timestamp = 0;
        await db.put('cache_store', existing);
      }
    } catch {}
  } else {
    cacheTimestamps.clear();
    hotMemoryCache.forEach((entry, k) => {
      entry.timestamp = 0;
      hotMemoryCache.set(k, entry);
    });
    try {
      const db = await getCacheDB();
      const all = await db.getAll('cache_store');
      for (const item of all) {
        item.timestamp = 0;
        await db.put('cache_store', item);
      }
    } catch {}
  }
}
