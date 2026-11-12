import { STORAGE_KEYS } from './supabase';
import { getHotCache, setIndexedDBCache } from './db/indexedDB';
import { getOfflineDB } from './offlineQueue';
import { blackBox } from './blackBox';
import { Organization } from './supabaseTypes';

/**
 * On-boot password scrubber (Epic 15.7 Step B2)
 * Purges any legacy plaintext passwords stored in hot cache, IndexedDB,
 * session storage, and offline mutation queues.
 */
export async function scrubCachedPasswords(): Promise<number> {
  let scrubbedCount = 0;

  try {
    // 1. Scrub hot cache and IndexedDB cached organizations
    const cachedOrgs = getHotCache<Organization[]>(STORAGE_KEYS.ORGS, []);
    let orgsModified = false;
    const cleanOrgs = cachedOrgs.map((org: any) => {
      if (org && org.password) {
        scrubbedCount++;
        orgsModified = true;
        const { password: _p, ...rest } = org;
        return rest as Organization;
      }
      return org;
    });
    if (orgsModified) {
      await setIndexedDBCache(STORAGE_KEYS.ORGS, cleanOrgs, true);
    }

    // 2. Scrub active session in localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION);
        if (raw) {
          const session = JSON.parse(raw);
          if (session?.org?.password) {
            scrubbedCount++;
            delete session.org.password;
            localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, JSON.stringify(session));
          }
        }
      } catch {}
    }

    // 3. Scrub pending_mutations in offlineQueue
    try {
      const db = await getOfflineDB();
      const allMutations = await db.getAll('pending_mutations');
      for (const mut of allMutations) {
        if (mut.table === 'organizations' && mut.payload && mut.payload.password) {
          scrubbedCount++;
          delete mut.payload.password;
          await db.put('pending_mutations', mut);
        }
      }
    } catch {}

    if (scrubbedCount > 0) {
      blackBox.recordError('security', `scrubbed ${scrubbedCount} cached passwords`, 'authScrubber');
    }
  } catch (err) {
    console.warn('Scrubber warning:', err);
  }

  return scrubbedCount;
}
