import { STORAGE_KEYS, getStoredSession } from './supabase';
import { getHotCache, setIndexedDBCache } from './db/indexedDB';
import { scrubOfflineOutboxSecrets } from './offlineQueue';
import { blackBox } from './blackBox';
import { Organization, SupabaseJudge, SupabaseParticipant } from './supabaseTypes';

/**
 * On-boot secret & PII scrubber (Epic 15.7 Step B2 + Epic 15.12 Phase 3)
 * Purges legacy plaintext passwords, judge session tokens, judge-device PINs,
 * and judge-device participant phone numbers from hot cache, IndexedDB,
 * active session storage, and offline mutation queues.
 */
export async function scrubCachedPasswords(): Promise<number> {
  let scrubbedCount = 0;

  try {
    const activeRole = getStoredSession()?.role || null;

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

    // 2. Scrub cached judges (always strip current_session_token; strip PIN unless organiser)
    const cachedJudges = getHotCache<SupabaseJudge[]>(STORAGE_KEYS.JUDGES, []);
    let judgesModified = false;
    const cleanJudges = cachedJudges.map((j: any) => {
      if (!j || typeof j !== 'object') return j;
      let dirty = false;
      const next: any = { ...j };
      if (next.current_session_token) {
        next.current_session_token = null;
        dirty = true;
      }
      if (activeRole !== 'organiser' && (next.pin || next.judge_pin)) {
        next.pin = '';
        next.judge_pin = '';
        dirty = true;
      }
      if (dirty) {
        scrubbedCount++;
        judgesModified = true;
      }
      return next as SupabaseJudge;
    });
    if (judgesModified) {
      await setIndexedDBCache(STORAGE_KEYS.JUDGES, cleanJudges, true);
    }

    // 3. Scrub participant mobile_number on judge devices
    if (activeRole === 'judge') {
      const cachedParticipants = getHotCache<SupabaseParticipant[]>(STORAGE_KEYS.PARTICIPANTS, []);
      let partsModified = false;
      const cleanParticipants = cachedParticipants.map((p: any) => {
        if (p && p.mobile_number) {
          scrubbedCount++;
          partsModified = true;
          const { mobile_number: _m, ...rest } = p;
          return rest as SupabaseParticipant;
        }
        return p;
      });
      if (partsModified) {
        await setIndexedDBCache(STORAGE_KEYS.PARTICIPANTS, cleanParticipants, true);
      }
    }

    // 4. Scrub active session in localStorage
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION);
        if (raw) {
          const session = JSON.parse(raw);
          let sessionDirty = false;
          if (session?.org?.password) {
            scrubbedCount++;
            delete session.org.password;
            sessionDirty = true;
          }
          if (session?.judge) {
            if (session.judge.pin || session.judge.judge_pin || session.judge.current_session_token) {
              scrubbedCount++;
              session.judge.pin = '';
              session.judge.judge_pin = '';
              session.judge.current_session_token = null;
              sessionDirty = true;
            }
          }
          if (sessionDirty) {
            localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, JSON.stringify(session));
          }
        }
      } catch {}
    }

    // 5. Scrub organization passwords inside unified outbox store
    scrubbedCount += await scrubOfflineOutboxSecrets();

    if (scrubbedCount > 0) {
      blackBox.recordError('security', `scrubbed ${scrubbedCount} cached secrets/PII`, 'authScrubber');
    }
  } catch (err) {
    console.warn('Scrubber warning:', err);
  }

  return scrubbedCount;
}
