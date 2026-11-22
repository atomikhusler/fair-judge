import {
  Organization,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
} from './supabaseTypes';

export type ProjectorSegment = 'leaderboard' | 'scoreboard' | 'events';
export type ProjectorOverscan = 0 | 2 | 4;

export interface BlindRankItem {
  event_id: string;
  participant_id: string;
  rank: number;
  judge_count: number;
}

export interface ProjectorSnapshot {
  org: Organization;
  events: SupabaseEvent[];
  judges: SupabaseJudge[];
  participants: SupabaseParticipant[];
  scores: SupabaseScore[];
  blindRanks: BlindRankItem[];
  scopedEventId: string | null;
  label: string | null;
  isBlank: boolean;
}

const PROJECTOR_PREF_KEYS = {
  SEGMENT: 'fj_projector_segment',
  SELECTED_EVENT_ID: 'fj_projector_selected_event_id',
  OVERSCAN: 'fj_projector_overscan',
} as const;

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string | null): void {
  try {
    if (value === null || value === '') {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, value);
    }
  } catch {}
}

export function getProjectorDisplayPrefs(): {
  segment: ProjectorSegment;
  selectedEventId: string;
  overscan: ProjectorOverscan;
} {
  const seg = safeGet(PROJECTOR_PREF_KEYS.SEGMENT);
  const segment: ProjectorSegment =
    seg === 'scoreboard' || seg === 'events' ? seg : 'leaderboard';
  const selectedEventId = safeGet(PROJECTOR_PREF_KEYS.SELECTED_EVENT_ID) || '';
  const ovRaw = Number(safeGet(PROJECTOR_PREF_KEYS.OVERSCAN));
  const overscan: ProjectorOverscan = ovRaw === 2 || ovRaw === 4 ? ovRaw : 0;
  return { segment, selectedEventId, overscan };
}

export function saveProjectorDisplayPrefs(prefs: {
  segment?: ProjectorSegment;
  selectedEventId?: string;
  overscan?: ProjectorOverscan;
}): void {
  if (prefs.segment !== undefined) safeSet(PROJECTOR_PREF_KEYS.SEGMENT, prefs.segment);
  if (prefs.selectedEventId !== undefined) {
    safeSet(PROJECTOR_PREF_KEYS.SELECTED_EVENT_ID, prefs.selectedEventId || null);
  }
  if (prefs.overscan !== undefined) {
    safeSet(PROJECTOR_PREF_KEYS.OVERSCAN, String(prefs.overscan));
  }
}
