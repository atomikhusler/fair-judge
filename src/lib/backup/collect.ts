import { supabase, isSupabaseConfigured, dbService } from '../supabase';
import { BackupPayload } from './format';
import { SupabaseEvent, SupabaseJudge, SupabaseParticipant, SupabaseScore } from '../supabaseTypes';

export async function collectOrganizationData(orgId: string): Promise<BackupPayload> {
  const cleanOrgId = orgId.trim().toUpperCase();

  let events: SupabaseEvent[] = [];
  let judges: SupabaseJudge[] = [];
  let participants: SupabaseParticipant[] = [];
  let scores: SupabaseScore[] = [];

  // Try live database first if online
  if (isSupabaseConfigured() && typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      const [eventsRes, judgesRes, participantsRes] = await Promise.all([
        supabase.from('events').select('*').ilike('org_id', cleanOrgId),
        supabase.from('judges').select('*').ilike('org_id', cleanOrgId),
        supabase.from('participants').select('*').ilike('org_id', cleanOrgId),
      ]);

      if (eventsRes.data) events = eventsRes.data as SupabaseEvent[];
      if (judgesRes.data) judges = judgesRes.data as SupabaseJudge[];
      if (participantsRes.data) participants = participantsRes.data as SupabaseParticipant[];

      // Collect scores for these events
      const eventIds = events.map((e) => e.id);
      if (eventIds.length > 0) {
        const { data: scoresData } = await supabase
          .from('scores')
          .select('*')
          .in('event_id', eventIds);
        if (scoresData) scores = scoresData as SupabaseScore[];
      }
    } catch (err) {
      console.warn('Cloud collection notice, falling back to local mirror:', err);
    }
  }

  // Fallback to local cache if cloud returned 0 rows or was offline
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
    const allCachedScores = dbService.getCachedScores();
    scores = allCachedScores.filter((s) => eventIds.has(s.event_id));
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
