import { openDB, IDBPDatabase } from 'idb';

const DB_NAME = 'fairjudge_offline_db';
const DB_VERSION = 1;
const CACHE_STORE = 'hot_cache';
const QUEUE_STORE = 'offline_queue';

let dbPromise: Promise<IDBPDatabase> | null = null;
const hotMirror: Map<string, any> = new Map();
const cacheTimestamps: Map<string, number> = new Map();

export async function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(CACHE_STORE)) {
          db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          db.createObjectStore(QUEUE_STORE, { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

export async function initCacheStorage(): Promise<void> {
  try {
    const db = await getDB();
    const all = await db.getAll(CACHE_STORE);
    all.forEach((entry: any) => {
      if (entry && entry.key) {
        hotMirror.set(entry.key, entry.value);
        if (entry.timestamp) cacheTimestamps.set(entry.key, entry.timestamp);
      }
    });
  } catch (err) {
    console.warn('Cache storage hydration note:', err);
  }
}

export function getHotCache<T = any>(key: string, defaultValue?: T): T {
  if (hotMirror.has(key)) {
    return hotMirror.get(key) as T;
  }
  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        hotMirror.set(key, parsed);
        return parsed as T;
      }
    } catch {}
  }
  return (defaultValue !== undefined ? defaultValue : null) as unknown as T;
}

export function setIndexedDBCache(key: string, value: any, _silentOrTtl?: any): void {
  hotMirror.set(key, value);
  cacheTimestamps.set(key, Date.now());

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  getDB().then((db) => {
    db.put(CACHE_STORE, {
      key,
      value,
      timestamp: Date.now(),
    }).catch((err) => console.warn('IDB put error:', err));
  }).catch(() => {});
}

export function hasCachedKey(key: string): boolean {
  return hotMirror.has(key) || (typeof localStorage !== 'undefined' && localStorage.getItem(key) !== null);
}

export function isCacheFresh(key: string, maxAgeMs: number = 5 * 60 * 1000): boolean {
  const ts = cacheTimestamps.get(key);
  if (!ts) return false;
  return Date.now() - ts < maxAgeMs;
}

export function invalidateCache(key?: string): void {
  if (key) {
    hotMirror.delete(key);
    cacheTimestamps.delete(key);
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    getDB().then((db) => db.delete(CACHE_STORE, key).catch(() => {})).catch(() => {});
  } else {
    hotMirror.clear();
    cacheTimestamps.clear();
    getDB().then((db) => db.clear(CACHE_STORE).catch(() => {})).catch(() => {});
  }
}
