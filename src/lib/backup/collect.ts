import { isSupabaseConfigured, dbService, STORAGE_KEYS, normalizeOrg } from '../supabase';
import { getHotCache } from '../db/indexedDB';
import { BackupPayload, BackupSettings, WHITELISTED_SETTING_KEYS } from './format';
import { Organization, SupabaseEvent, SupabaseJudge, SupabaseParticipant, SupabaseScore } from '../supabaseTypes';

export function extractWhitelistedOrgSettings(org: Partial<Organization> | null | undefined): BackupSettings {
  const settings: BackupSettings = {};
  if (!org) return settings;

  for (const key of WHITELISTED_SETTING_KEYS) {
    const val = (org as any)[key];
    if (val !== undefined) {
      (settings as any)[key] = val;
    }
  }
  return settings;
}

export function inspectBackupSensitivity(payload: Pick<BackupPayload, 'judges' | 'participants'>): {
  hasPins: boolean;
  hasPhones: boolean;
  judgePinCount: number;
  participantPhoneCount: number;
} {
  const judgePinCount = (payload.judges || []).filter((j) =>
    Boolean((j.pin || j.judge_pin || '').trim())
  ).length;
  const participantPhoneCount = (payload.participants || []).filter((p) =>
    Boolean((p.mobile_number || '').trim())
  ).length;

  return {
    hasPins: judgePinCount > 0,
    hasPhones: participantPhoneCount > 0,
    judgePinCount,
    participantPhoneCount,
  };
}

export async function collectOrganizationData(
  orgIdOrOrg: string | Organization
): Promise<BackupPayload> {
  const providedOrg = typeof orgIdOrOrg === 'string' ? null : orgIdOrOrg;
  const cleanOrgId = (typeof orgIdOrOrg === 'string' ? orgIdOrOrg : orgIdOrOrg.org_id)
    .trim()
    .toUpperCase();

  let liveOrg: Organization | null = providedOrg;
  let events: SupabaseEvent[] = [];
  let judges: SupabaseJudge[] = [];
  let participants: SupabaseParticipant[] = [];
  let scores: SupabaseScore[] = [];

  // Try live token-checked RPCs first if online
  if (isSupabaseConfigured() && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const [orgRes, eventsRes, rosterRes, scoresRes] = await Promise.all([
        dbService.getOrganizationByOrgIdResult(cleanOrgId, true),
        dbService.getEventsResult(cleanOrgId, true),
        dbService.getOrgRosterCredentialsResult(cleanOrgId, true),
        dbService.getOrgScoresResult(cleanOrgId, true),
      ]);

      if (orgRes.ok && orgRes.data) liveOrg = orgRes.data;
      if (eventsRes.ok || eventsRes.data.length > 0) events = eventsRes.data;
      if (rosterRes.ok || rosterRes.data.judges.length > 0) judges = rosterRes.data.judges;
      if (rosterRes.ok || rosterRes.data.participants.length > 0) {
        participants = rosterRes.data.participants;
      }
      if (scoresRes.ok || scoresRes.data.length > 0) scores = scoresRes.data;
    } catch (err) {
      console.warn('Cloud collection notice, falling back to local mirror:', err);
    }
  }

  if (!liveOrg) {
    const cachedOrgs = getHotCache<Organization[]>(STORAGE_KEYS.ORGS, []);
    const found = cachedOrgs.find((o) => (o.org_id || '').trim().toUpperCase() === cleanOrgId);
    if (found) liveOrg = normalizeOrg(found);
  }

  // Fallback to local org-scoped cache if cloud returned 0 rows or was offline
  if (events.length === 0) {
    events = dbService.getCachedEvents(cleanOrgId);
  }
  if (judges.length === 0) {
    judges = dbService.getCachedJudges(cleanOrgId);
  }
  if (participants.length === 0) {
    participants = dbService.getCachedParticipants(cleanOrgId);
  }
  if (scores.length === 0) {
    const eventIds = new Set(events.map((e) => e.id));
    const orgCachedScores = dbService.getCachedScores(cleanOrgId);
    scores = eventIds.size > 0
      ? orgCachedScores.filter((s) => eventIds.has(s.event_id))
      : orgCachedScores;
  }

  // Defense in depth: Sanitize any sensitive session tokens from export
  const cleanJudges = judges.map((j) => {
    const { current_session_token: _t, ...rest } = j as any;
    return rest as SupabaseJudge;
  });

  const settings = extractWhitelistedOrgSettings(liveOrg);

  return {
    events,
    judges: cleanJudges,
    participants,
    scores,
    settings,
  };
}
