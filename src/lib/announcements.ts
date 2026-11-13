import { isSupabaseConfigured, supabase } from './supabase';

export type AnnouncementSeverity = 'info' | 'warning' | 'urgent';
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

const DISMISS_PREFIX = 'fj_dismissed_notice_';

export function isNoticeDismissed(id: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(`${DISMISS_PREFIX}${id}`) === '1';
  } catch {
    return false;
  }
}

export function dismissNotice(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`${DISMISS_PREFIX}${id}`, '1');
  } catch {}
}

export function filterAnnouncementsForClient(
  rows: PlatformAnnouncement[],
  role: 'organiser' | 'judge',
  orgId?: string | null
): PlatformAnnouncement[] {
  const normalizedOrg = orgId?.trim().toUpperCase() || '';

  return rows.filter((item) => {
    if (!item || !item.id || isNoticeDismissed(item.id)) return false;

    if (item.audience === 'all') return true;
    if (item.audience === 'organisers') return role === 'organiser';
    if (item.audience === 'judges') return role === 'judge';
    if (item.audience === 'org') {
      const target = (item.target_org_id || '').trim().toUpperCase();
      return Boolean(normalizedOrg && target && target === normalizedOrg);
    }
    return false;
  });
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
    return filterAnnouncementsForClient(data as PlatformAnnouncement[], role, cleanOrg);
  } catch {
    return [];
  }
}
