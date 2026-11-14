import { isSupabaseConfigured, dbService } from '../supabase';
import { BackupPayload } from './format';
import { SupabaseEvent, SupabaseJudge, SupabaseParticipant, SupabaseScore } from '../supabaseTypes';

export async function collectOrganizationData(orgId: string): Promise<BackupPayload> {
  const cleanOrgId = orgId.trim().toUpperCase();

  let events: SupabaseEvent[] = [];
  let judges: SupabaseJudge[] = [];
  let participants: SupabaseParticipant[] = [];
  let scores: SupabaseScore[] = [];

  // Try live token-checked RPCs first if online
  if (isSupabaseConfigured() && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const [eventsRes, rosterRes, scoresRes] = await Promise.all([
        dbService.getEventsResult(cleanOrgId, true),
        dbService.getOrgRosterCredentialsResult(cleanOrgId, true),
        dbService.getOrgScoresResult(cleanOrgId, true),
      ]);

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

  // Defense in depth: Sanitize any sensitive tokens from export
  const cleanJudges = judges.map((j) => {
    const { current_session_token: _t, ...rest } = j as any;
    return rest as SupabaseJudge;
  });

  return {
    events,
    judges: cleanJudges,
    participants,
    scores,
  };
}
