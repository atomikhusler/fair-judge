import { useState, useEffect, useCallback, useRef } from 'react';
import { isSupabaseConfigured, supabase } from './supabase';

export type AnnouncementSeverity = 'info' | 'warning' | 'urgent' | 'critical';
export type AnnouncementAudience = 'all' | 'organisers' | 'judges' | 'org';

export interface PlatformAnnouncement {
  id: string;
  title: string;
  body: string;
  severity: AnnouncementSeverity;
  audience: AnnouncementAudience;
  target_org_id?: string | null;
  starts_at: string;
  ends_at?: string | null;
}

export interface StoredInboxAnnouncement extends PlatformAnnouncement {
  savedAt: number;
}

const DISMISS_PREFIX = 'fj_dismissed_notice_';
const INBOX_ARCHIVE_KEY = 'fj_notice_inbox_v1';
const READ_MAP_KEY = 'fj_notice_read_v1';
const DISMISSED_MAP_KEY = 'fj_notice_dismissed_v1';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export const NOTICES_UPDATED_EVENT = 'fj_notices_updated';

export function isCriticalSeverity(severity?: string | null): boolean {
  const s = (severity || '').toLowerCase();
  return s === 'urgent' || s === 'critical';
}

function readTimestampMap(key: string): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const pruned: Record<string, number> = {};
    for (const [id, ts] of Object.entries(parsed)) {
      if (typeof ts === 'number' && ts >= cutoff) {
        pruned[id] = ts;
      }
    }
    return pruned;
  } catch {
    return {};
  }
}

function writeTimestampMap(key: string, map: Record<string, number>): void {
  if (typeof window === 'undefined') return;
  try {
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const pruned: Record<string, number> = {};
    for (const [id, ts] of Object.entries(map)) {
      if (typeof ts === 'number' && ts >= cutoff) {
        pruned[id] = ts;
      }
    }
    localStorage.setItem(key, JSON.stringify(pruned));
  } catch {}
}

function emitNoticesUpdated(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(NOTICES_UPDATED_EVENT));
  }
}

export function isNoticeDismissed(id: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const map = readTimestampMap(DISMISSED_MAP_KEY);
    if (typeof map[id] === 'number') return true;
    return localStorage.getItem(`${DISMISS_PREFIX}${id}`) === '1';
  } catch {
    return false;
  }
}

export function dismissNotice(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    const map = readTimestampMap(DISMISSED_MAP_KEY);
    map[id] = Date.now();
    writeTimestampMap(DISMISSED_MAP_KEY, map);
    localStorage.setItem(`${DISMISS_PREFIX}${id}`, '1');
    emitNoticesUpdated();
  } catch {}
}

export function isNoticeRead(id: string): boolean {
  if (typeof window === 'undefined') return false;
  const map = readTimestampMap(READ_MAP_KEY);
  return typeof map[id] === 'number';
}

export function markNoticesRead(ids: string[]): void {
  if (typeof window === 'undefined' || ids.length === 0) return;
  try {
    const map = readTimestampMap(READ_MAP_KEY);
    const now = Date.now();
    let changed = false;
    for (const id of ids) {
      if (id && typeof map[id] !== 'number') {
        map[id] = now;
        changed = true;
      }
    }
    if (changed) {
      writeTimestampMap(READ_MAP_KEY, map);
      emitNoticesUpdated();
    }
  } catch {}
}

export function matchesAnnouncementAudience(
  item: PlatformAnnouncement,
  role: 'organiser' | 'judge',
  orgId?: string | null
): boolean {
  if (!item || !item.id) return false;
  const normalizedOrg = orgId?.trim().toUpperCase() || '';

  if (item.audience === 'all') return true;
  if (item.audience === 'organisers') return role === 'organiser';
  if (item.audience === 'judges') return role === 'judge';
  if (item.audience === 'org') {
    const target = (item.target_org_id || '').trim().toUpperCase();
    return Boolean(normalizedOrg && target && target === normalizedOrg);
  }
  return false;
}

function getAnnouncementSortMs(item: StoredInboxAnnouncement): number {
  const startMs = Date.parse(item.starts_at || '');
  if (!Number.isNaN(startMs)) return startMs;
  return item.savedAt || 0;
}

function loadInboxArchive(): StoredInboxAnnouncement[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(INBOX_ARCHIVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const valid = parsed.filter((item): item is StoredInboxAnnouncement => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') return false;
      const savedAt = typeof item.savedAt === 'number' ? item.savedAt : Date.now();
      return savedAt >= cutoff;
    });
    if (valid.length !== parsed.length) {
      localStorage.setItem(INBOX_ARCHIVE_KEY, JSON.stringify(valid));
    }
    return valid;
  } catch {
    return [];
  }
}

function upsertInboxArchive(rows: PlatformAnnouncement[]): StoredInboxAnnouncement[] {
  if (typeof window === 'undefined') return [];
  const existing = loadInboxArchive();
  const byId = new Map<string, StoredInboxAnnouncement>();
  const now = Date.now();
  const cutoff = now - THIRTY_DAYS_MS;

  for (const item of existing) {
    if (item.savedAt >= cutoff) {
      byId.set(item.id, item);
    }
  }

  for (const row of rows) {
    if (!row || !row.id) continue;
    const prev = byId.get(row.id);
    byId.set(row.id, {
      ...row,
      savedAt: prev?.savedAt ?? now,
    });
  }

  const merged = Array.from(byId.values())
    .filter((item) => item.savedAt >= cutoff)
    .sort((a, b) => getAnnouncementSortMs(b) - getAnnouncementSortMs(a));

  try {
    localStorage.setItem(INBOX_ARCHIVE_KEY, JSON.stringify(merged));
  } catch {}

  return merged;
}

export function filterAnnouncementsForClient(
  rows: PlatformAnnouncement[],
  role: 'organiser' | 'judge',
  orgId?: string | null
): PlatformAnnouncement[] {
  return rows.filter(
    (item) =>
      matchesAnnouncementAudience(item, role, orgId) &&
      isCriticalSeverity(item.severity) &&
      !isNoticeDismissed(item.id)
  );
}

export function getInboxAnnouncementsForClient(
  role: 'organiser' | 'judge',
  orgId?: string | null
): {
  inboxNotices: StoredInboxAnnouncement[];
  unreadCount: number;
} {
  const archive = loadInboxArchive();
  const readMap = readTimestampMap(READ_MAP_KEY);

  const inboxNotices = archive
    .filter((item) => {
      if (!matchesAnnouncementAudience(item, role, orgId)) return false;
      // Info / warning go straight to bell; critical moves to bell once dismissed
      if (isCriticalSeverity(item.severity) && !isNoticeDismissed(item.id)) {
        return false;
      }
      return true;
    })
    .sort((a, b) => getAnnouncementSortMs(b) - getAnnouncementSortMs(a));

  const unreadCount = inboxNotices.filter((item) => typeof readMap[item.id] !== 'number').length;

  return { inboxNotices, unreadCount };
}

/**
 * Fetches currently active announcements once (no polling, no realtime).
 * Returns [] cleanly when offline or unconfigured.
 */
export async function fetchActiveAnnouncements(
  role: 'organiser' | 'judge',
  orgId?: string | null
): Promise<PlatformAnnouncement[]> {
  if (!isSupabaseConfigured()) return [];
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return [];

  try {
    const cleanOrg = orgId?.trim() || null;
    const { data, error } = await supabase.rpc('get_active_announcements', {
      p_org_id: cleanOrg,
    });
    if (error || !Array.isArray(data)) return [];
    const matched = (data as PlatformAnnouncement[]).filter((item) =>
      matchesAnnouncementAudience(item, role, cleanOrg)
    );
    upsertInboxArchive(matched);
    emitNoticesUpdated();
    return filterAnnouncementsForClient(matched, role, cleanOrg);
  } catch {
    return [];
  }
}

/**
 * Hook for Organiser & Judge UIs:
 * - Fetches only on app open & resume (visibilitychange visible / online), zero polling.
 * - Info/warning announcements go straight to the bell inbox with unread count.
 * - Critical ('urgent'/'critical') announcements show as a banner once until dismissed,
 *   then move into the bell inbox and stay unread until opened.
 */
export function useAnnouncements(role: 'organiser' | 'judge', orgId?: string | null) {
  const [activeRows, setActiveRows] = useState<PlatformAnnouncement[]>([]);
  const [inboxState, setInboxState] = useState(() => getInboxAnnouncementsForClient(role, orgId));
  const lastFetchAtRef = useRef<number>(0);

  const syncLocalInbox = useCallback(() => {
    setInboxState(getInboxAnnouncementsForClient(role, orgId));
  }, [role, orgId]);

  const refresh = useCallback(
    async (force = false) => {
      const now = Date.now();
      if (!force && now - lastFetchAtRef.current < 3000) return;
      lastFetchAtRef.current = now;

      if (!isSupabaseConfigured() || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        syncLocalInbox();
        return;
      }

      try {
        const cleanOrg = orgId?.trim() || null;
        const { data, error } = await supabase.rpc('get_active_announcements', {
          p_org_id: cleanOrg,
        });
        if (!error && Array.isArray(data)) {
          const matched = (data as PlatformAnnouncement[]).filter((item) =>
            matchesAnnouncementAudience(item, role, cleanOrg)
          );
          upsertInboxArchive(matched);
          setActiveRows(matched);
          setInboxState(getInboxAnnouncementsForClient(role, cleanOrg));
        }
      } catch {
        syncLocalInbox();
      }
    },
    [role, orgId, syncLocalInbox]
  );

  // Initial fetch on open + reload if role/org changes
  useEffect(() => {
    syncLocalInbox();
    void refresh(true);
  }, [syncLocalInbox, refresh]);

  // Fetch on app resume (visibilitychange visible / online) — zero polling
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void refresh();
      }
    };
    const handleOnline = () => {
      void refresh();
    };
    const handleLocalUpdate = () => {
      syncLocalInbox();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('online', handleOnline);
    window.addEventListener(NOTICES_UPDATED_EVENT, handleLocalUpdate);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener(NOTICES_UPDATED_EVENT, handleLocalUpdate);
    };
  }, [refresh, syncLocalInbox]);

  const bannerNotices = filterAnnouncementsForClient(activeRows, role, orgId);

  const dismissBanner = useCallback(
    (id: string) => {
      dismissNotice(id);
      syncLocalInbox();
    },
    [syncLocalInbox]
  );

  const markInboxAsRead = useCallback(
    (ids: string[]) => {
      markNoticesRead(ids);
      syncLocalInbox();
    },
    [syncLocalInbox]
  );

  return {
    bannerNotices,
    inboxNotices: inboxState.inboxNotices,
    unreadCount: inboxState.unreadCount,
    dismissBanner,
    markInboxAsRead,
    refreshAnnouncements: () => refresh(true),
  };
}
