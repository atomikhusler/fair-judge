/**
 * Asynchronous IndexedDB Storage Engine for Fair Judge
 * Replaces synchronous localStorage to eliminate main-thread blocking on large datasets.
 * Features an in-memory hot mirror for zero-latency synchronous reads during React hydration.
 */

import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { eventBus } from '../eventBus';

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

/**
 * Primes the in-memory hot mirror from IndexedDB and migrates any legacy localStorage caches
 */
export async function initCacheStorage(): Promise<void> {
  if (isInitialized) return;

  try {
    const db = await getCacheDB();
    const allEntries = await db.getAll('cache_store');
    allEntries.forEach((entry) => {
      hotMemoryCache.set(entry.key, entry);
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
            // Only migrate if not already in IndexedDB
            if (!hotMemoryCache.has(key)) {
              await setIndexedDBCache(key, parsed, true);
            }
          }
          // Remove from localStorage to free up synchronous quota
          localStorage.removeItem(key);
        }
      } catch (e) {
        // Safe skip
      }
    }

    isInitialized = true;
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
  return defaultVal;
}

/**
 * Check if the cached key is still fresh (younger than 5 minutes)
 */
export function isCacheFresh(key: string): boolean {
  const entry = hotMemoryCache.get(key);
  if (!entry || !entry.timestamp) return false;
  return Date.now() - entry.timestamp < CACHE_TTL_MS;
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

  // 2. Asynchronous write to IndexedDB
  try {
    const db = await getCacheDB();
    await db.put('cache_store', entry);
  } catch (err) {
    console.warn(`IndexedDB write warning for "${key}":`, err);
  }

  // 3. Emit EventBus update if not silent
  if (!silent) {
    let tableName = key.replace('fairjudge_supabase_', '');
    if (tableName === 'orgs') tableName = 'organizations';
    eventBus.emit('cache_updated', { table: tableName, data });
  }
}

/**
 * Asynchronously reads data from IndexedDB
 */
export async function getIndexedDBCache<T>(key: string, defaultVal: T): Promise<T> {
  // If in hot cache, return immediately
  const hot = hotMemoryCache.get(key);
  if (hot && hot.data !== undefined) {
    return hot.data as T;
  }

  try {
    const db = await getCacheDB();
    const entry = await db.get('cache_store', key);
    if (entry && entry.data !== undefined) {
      hotMemoryCache.set(key, entry);
      return entry.data as T;
    }
  } catch (err) {
    console.warn(`IndexedDB read warning for "${key}":`, err);
  }

  return defaultVal;
}

/**
 * Invalidate cache entry or entire cache
 */
export async function invalidateCache(key?: string): Promise<void> {
  if (key) {
    const entry = hotMemoryCache.get(key);
    if (entry) {
      entry.timestamp = 0;
      hotMemoryCache.set(key, entry);
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
