import { supabase, isSupabaseConfigured } from '../supabase';
import type { ActiveOrgSession } from '../authService';
import type {
  EventStatus,
  OrgTieRule,
  Organization,
  ProjectorTieRound,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
  TieBreakerMethod,
  TieRoundPlacement,
  TieRoundResultPayload,
  TieRoundRule,
  TieRoundStatus,
} from '../supabaseTypes';
import type { ProjectorEventState } from './projectorRanking';

export interface ProjectorEventSummary {
  id: string;
  name: string;
  category: string;
  status: EventStatus;
  date?: string;
}

export interface ProjectorLoginResult {
  ok: boolean;
  needsEventSelection?: boolean;
  sessionLimitReached?: boolean;
  sessions?: ActiveOrgSession[];
  events?: ProjectorEventSummary[];
  projectorToken?: string;
  expiresAt?: string;
  org?: {
    orgId: string;
    name: string;
  };
  event?: ProjectorEventSummary;
  error?: string;
  message?: string;
}

export interface ProjectorDeletionRecord {
  table_name: string;
  record_id: string;
  version: number;
}

export interface ProjectorChangesPayload {
  changed: boolean;
  cursor: number;
  expiresAt?: string;
  eventEnded?: boolean;
  org?: Organization | null;
  event?: SupabaseEvent | null;
  participants: SupabaseParticipant[];
  judges: SupabaseJudge[];
  scores: SupabaseScore[];
  tieRounds?: ProjectorTieRound[];
  deletions: ProjectorDeletionRecord[];
}

export interface ProjectorChangesResult {
  ok: boolean;
  error?:
    | 'expired'
    | 'replaced'
    | 'revoked'
    | 'event_ended'
    | 'network_error'
    | 'rpc_error'
    | 'not_configured';
  errorCode?: string;
  message?: string;
  payload?: ProjectorChangesPayload;
}

export type ProjectorRpcCaller = (
  fn: string,
  args: Record<string, unknown>
) => Promise<{ data: unknown; error: { code?: string; message?: string; details?: string } | null }>;

const TRANSPORT_ERROR_PATTERN =
  /failed to fetch|networkerror|load failed|fetcherror|network request failed|abort|timeout|timed out|offline|err_internet|err_network|socket hang up|econnrefused|enotfound/i;

export function classifyProjectorRpcError(
  error: { code?: string; message?: string; details?: string } | null | undefined
): { error: 'network_error' | 'rpc_error'; errorCode?: string; message: string } {
  const isOffline =
    typeof navigator !== 'undefined' && navigator.onLine === false;
  const code = typeof error?.code === 'string' ? error.code.trim() : '';
  const rawMessage = typeof error?.message === 'string' ? error.message.trim() : '';

  if (isOffline || !error || (!code && (!rawMessage || TRANSPORT_ERROR_PATTERN.test(rawMessage)))) {
    return {
      error: 'network_error',
      message: 'Connection interrupted. Retrying automatically...',
    };
  }

  return {
    error: 'rpc_error',
    errorCode: code || undefined,
    message: rawMessage || 'Database error while checking for scoreboard updates.',
  };
}

export async function fetchProjectorChanges(
  rpcCaller: ProjectorRpcCaller,
  token: string,
  sinceCursor: number
): Promise<ProjectorChangesResult> {
  try {
    const { data, error } = await rpcCaller('projector_changes', {
      p_token: token,
      p_since: Math.max(0, Math.floor(sinceCursor || 0)),
    });

    if (error) {
      return {
        ok: false,
        ...classifyProjectorRpcError(error),
      };
    }

    if (!data) {
      return {
        ok: false,
        error: 'network_error',
        message: 'No response received from server.',
      };
    }

    const res = data as any;
    if (!res.ok) {
      const code = String(res.error || 'revoked');
      if (code === 'replaced' || code === 'replaced_by_new_login') {
        return {
          ok: false,
          error: 'replaced',
          message: 'Another projector signed in for this organisation.',
        };
      }
      if (code === 'expired') {
        return {
          ok: false,
          error: 'expired',
          message: 'Projector session expired (8-hour limit). Sign in again to continue.',
        };
      }
      if (code === 'event_ended') {
        return {
          ok: false,
          error: 'event_ended',
          message: 'This event has ended.',
        };
      }
      return {
        ok: false,
        error: 'revoked',
        message: res.message || 'Projector session was ended by the organiser.',
      };
    }

    const payload: ProjectorChangesPayload = {
      changed: Boolean(res.changed),
      cursor: Number(res.cursor ?? sinceCursor ?? 0),
      expiresAt: typeof res.expires_at === 'string' ? res.expires_at : undefined,
      eventEnded: Boolean(res.event_ended),
      org: res.org ? normalizeOrg(res.org) : null,
      event: res.event ? normalizeEvent(res.event) : null,
      participants: Array.isArray(res.participants)
        ? res.participants.map(normalizeParticipant)
        : [],
      judges: Array.isArray(res.judges) ? res.judges.map(normalizeJudge) : [],
      scores: Array.isArray(res.scores) ? res.scores.map(normalizeScore) : [],
      tieRounds: Array.isArray(res.tie_rounds)
        ? res.tie_rounds.map(normalizeProjectorTieRound).filter((r: ProjectorTieRound) => Boolean(r.id))
        : [],
      deletions: Array.isArray(res.deletions) ? res.deletions : [],
    };

    return { ok: true, payload };
  } catch {
    return {
      ok: false,
      error: 'network_error',
      message: 'Network error while checking for updates.',
    };
  }
}

export interface ProjectorEndResult {
  ok: boolean;
  error?: string;
}

function normalizeOrgTieRule(raw: unknown): OrgTieRule {
  const val = String(raw || '').toLowerCase();
  if (val === 'olympic' || val === 'recompete') return val;
  return 'countback';
}

function normalizeOrg(raw: any): Organization | null {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: raw.org_id || '',
    org_id: raw.org_id || '',
    name: raw.name || 'Fair Judge Competition',
    tie_breaker_enabled: Boolean(raw.tie_breaker_enabled),
    tie_breaker_method: (raw.tie_breaker_method || 'olympic') as TieBreakerMethod,
    tie_management_enabled: Boolean(raw.tie_management_enabled),
    tie_rule: normalizeOrgTieRule(raw.tie_rule),
    blind_judging_enabled: false,
    projector_blind_mode: false,
    projector_spotlight_mode:
      raw.projector_spotlight_mode !== undefined ? Boolean(raw.projector_spotlight_mode) : true,
    projector_ticker_text:
      typeof raw.projector_ticker_text === 'string'
        ? raw.projector_ticker_text.slice(0, 120)
        : '',
    projector_carousel_interval: 60,
    projector_confetti_at: null,
    created_at: raw.created_at || new Date().toISOString(),
  };
}

function normalizeEvent(raw: any): SupabaseEvent | null {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const schema = Array.isArray(raw.rubric_schema) ? raw.rubric_schema : [];
  return {
    id: String(raw.id),
    org_id: String(raw.org_id || ''),
    name: String(raw.name || ''),
    category: typeof raw.category === 'string' ? raw.category : '',
    date: typeof raw.date === 'string' ? raw.date : undefined,
    status: (String(raw.status || 'draft').toLowerCase() as EventStatus) || 'draft',
    is_locked: Boolean(raw.is_locked),
    is_archived: Boolean(raw.is_archived),
    rubric_schema: schema,
    rubric: schema,
    assigned_judges: Array.isArray(raw.assigned_judges) ? raw.assigned_judges.map(String) : [],
    assigned_participants: Array.isArray(raw.assigned_participants)
      ? raw.assigned_participants.map(String)
      : [],
    participant_sl_numbers:
      raw.participant_sl_numbers && typeof raw.participant_sl_numbers === 'object'
        ? raw.participant_sl_numbers
        : {},
    created_at: String(raw.created_at || ''),
  };
}

function normalizeParticipant(raw: any): SupabaseParticipant {
  // Strictly strip mobile_number even if an older server ever returned it
  return {
    id: String(raw.id),
    org_id: String(raw.org_id || ''),
    identity_id: String(raw.identity_id || ''),
    sl_no: String(raw.sl_no || ''),
    name: String(raw.name || ''),
    school: String(raw.school || ''),
    class_or_age: raw.class_or_age,
    custom_values: raw.custom_values || {},
    is_active: raw.is_active !== false,
    created_at: String(raw.created_at || ''),
  };
}

function normalizeJudge(raw: any): SupabaseJudge {
  // Strictly zero out PIN and session token fields
  return {
    id: String(raw.id),
    org_id: String(raw.org_id || ''),
    name: String(raw.name || ''),
    judge_id: String(raw.judge_id || ''),
    pin: '',
    judge_pin: '',
    assigned_events: Array.isArray(raw.assigned_events) ? raw.assigned_events : [],
    is_active: raw.is_active !== false,
    current_session_token: null,
    created_at: String(raw.created_at || ''),
  };
}

function normalizeScore(raw: any): SupabaseScore {
  const total = Number(raw.total_score ?? 0);
  const createdAt = String(raw.created_at || '');
  return {
    id: String(raw.id),
    event_id: String(raw.event_id),
    judge_id: String(raw.judge_id),
    participant_id: String(raw.participant_id),
    total_score: Number.isFinite(total) ? total : 0,
    score_data: {},
    score_payload: {
      criteria: {},
      total_score: Number.isFinite(total) ? total : 0,
      submitted_at: createdAt,
    },
    created_at: createdAt,
  };
}

function normalizeTieRoundRule(raw: unknown): TieRoundRule {
  const val = String(raw || '').toLowerCase();
  if (val === 'countback' || val === 'olympic' || val === 'recompete' || val === 'shared') {
    return val;
  }
  return 'shared';
}

function normalizeTieRoundStatus(raw: unknown): TieRoundStatus {
  const val = String(raw || '').toLowerCase();
  if (val === 'open' || val === 'closed' || val === 'published' || val === 'cancelled_stale') {
    return val;
  }
  return 'cancelled_stale';
}

function sanitizeProjectorPlacement(raw: any): TieRoundPlacement | null {
  if (!raw || typeof raw !== 'object' || !raw.participant_id) return null;
  const out: TieRoundPlacement = {
    participant_id: String(raw.participant_id),
    before_rank: Number.isFinite(Number(raw.before_rank)) ? Number(raw.before_rank) : 1,
    after_rank: Number.isFinite(Number(raw.after_rank)) ? Number(raw.after_rank) : 1,
    base_avg: Number.isFinite(Number(raw.base_avg)) ? Number(raw.base_avg) : 0,
  };
  if (Number.isFinite(Number(raw.ballot_count))) out.ballot_count = Number(raw.ballot_count);
  if (Array.isArray(raw.scores_desc)) {
    out.scores_desc = raw.scores_desc.map(Number).filter(Number.isFinite);
  }
  if (raw.trimmed_avg === null || Number.isFinite(Number(raw.trimmed_avg))) {
    out.trimmed_avg = raw.trimmed_avg === null ? null : Number(raw.trimmed_avg);
  }
  if (Number.isFinite(Number(raw.grade_sum))) out.grade_sum = Number(raw.grade_sum);
  if (Number.isFinite(Number(raw.grade_count))) out.grade_count = Number(raw.grade_count);
  return out;
}

function sanitizeProjectorResultPayload(raw: any): TieRoundResultPayload {
  if (!raw || typeof raw !== 'object') return {};
  const out: TieRoundResultPayload = {};
  if (raw.rule !== undefined) out.rule = normalizeTieRoundRule(raw.rule);
  if (Number.isFinite(Number(raw.tied_rank))) out.tied_rank = Number(raw.tied_rank);
  if (typeof raw.score_fingerprint === 'string') out.score_fingerprint = raw.score_fingerprint;
  if (typeof raw.resolved === 'boolean') out.resolved = raw.resolved;
  if (typeof raw.still_tied === 'boolean') out.still_tied = raw.still_tied;
  if (typeof raw.low_judge_warning === 'boolean') out.low_judge_warning = raw.low_judge_warning;
  if (Number.isFinite(Number(raw.submitted_judge_count))) {
    out.submitted_judge_count = Number(raw.submitted_judge_count);
  }
  if (Number.isFinite(Number(raw.total_grades))) out.total_grades = Number(raw.total_grades);
  if (Array.isArray(raw.placements)) {
    out.placements = raw.placements
      .map(sanitizeProjectorPlacement)
      .filter((p: TieRoundPlacement | null): p is TieRoundPlacement => p !== null);
  }
  return out;
}

function normalizeProjectorTieRound(raw: any): ProjectorTieRound {
  // Strictly allowlist the 12 public projector fields; drop all private/audit/grade fields
  const tiedRankNum = Number(raw?.tied_rank ?? 1);
  const versionNum = Number(raw?.version ?? 1);
  return {
    id: String(raw?.id || ''),
    event_id: String(raw?.event_id || ''),
    group_key: String(raw?.group_key || ''),
    tied_rank: Number.isFinite(tiedRankNum) ? tiedRankNum : 1,
    tied_participant_ids: Array.isArray(raw?.tied_participant_ids)
      ? raw.tied_participant_ids.map((id: unknown) => String(id))
      : [],
    rule: normalizeTieRoundRule(raw?.rule),
    status: normalizeTieRoundStatus(raw?.status),
    is_stale: Boolean(raw?.is_stale),
    score_fingerprint: String(raw?.score_fingerprint || ''),
    result_payload: sanitizeProjectorResultPayload(raw?.result_payload),
    published_at: typeof raw?.published_at === 'string' ? raw.published_at : null,
    version: Number.isFinite(versionNum) ? versionNum : 1,
  };
}

function isProjectorRetainedTieRound(round: ProjectorTieRound): boolean {
  if (!round || !round.id || round.is_stale) return false;
  if (round.status === 'published') return true;
  if (round.status === 'open' && round.rule === 'recompete') return true;
  return false;
}

function upsertById<T extends { id: string }>(
  existing: T[],
  incoming: T[],
  deletedIds: Set<string>
): T[] {
  const map = new Map<string, T>();
  for (const item of existing) {
    if (!deletedIds.has(item.id)) {
      map.set(item.id, item);
    }
  }
  for (const item of incoming) {
    if (!deletedIds.has(item.id)) {
      map.set(item.id, item);
    }
  }
  return Array.from(map.values());
}

/**
 * Pure cursor-delta merge: combines incoming changed rows and deletion tombstones
 * into the existing in-memory event state without re-downloading unchanged records.
 * Retains only published tie rounds (including 'shared') and open re-compete rounds;
 * ignores cancelled_stale / closed rounds and never stores grades or audit rows.
 */
export function mergeProjectorDelta(
  prev: ProjectorEventState,
  delta: ProjectorChangesPayload
): ProjectorEventState {
  if (!delta.changed && !delta.eventEnded) {
    return prev;
  }

  const deletedParticipants = new Set<string>();
  const deletedJudges = new Set<string>();
  const deletedScores = new Set<string>();
  const deletedTieRounds = new Set<string>();

  for (const d of delta.deletions || []) {
    const tbl = String(d.table_name || '').toLowerCase();
    const id = String(d.record_id || '');
    if (!id) continue;
    if (tbl === 'participants') deletedParticipants.add(id);
    else if (tbl === 'judges') deletedJudges.add(id);
    else if (tbl === 'scores') deletedScores.add(id);
    else if (tbl === 'tie_rounds') deletedTieRounds.add(id);
  }

  const nextParticipants = upsertById(
    prev.participants,
    delta.participants,
    deletedParticipants
  ).filter((p) => p.is_active !== false);

  const nextJudges = upsertById(prev.judges, delta.judges, deletedJudges).filter(
    (j) => j.is_active !== false
  );

  const nextScores = upsertById(prev.scores, delta.scores, deletedScores);

  const mergedTieRounds = upsertById(
    prev.tieRounds || [],
    delta.tieRounds || [],
    deletedTieRounds
  );
  const nextTieRounds = mergedTieRounds.filter(isProjectorRetainedTieRound);

  return {
    org: delta.org || prev.org,
    event: delta.event || prev.event,
    participants: nextParticipants,
    judges: nextJudges,
    scores: nextScores,
    tieRounds: nextTieRounds,
  };
}

export const applyProjectorChanges = mergeProjectorDelta;

function getDefaultDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'Projector PC';
  const ua = navigator.userAgent || '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Macintosh|Mac OS/.test(ua)
      ? 'macOS'
      : /Linux/.test(ua)
        ? 'Linux'
        : 'PC';
  return `Projector (${browser} on ${os})`;
}

export const projectorAppService = {
  async login(params: {
    identifier: string;
    password: string;
    eventId?: string | null;
    deviceLabel?: string;
    revokeSessionId?: string | null;
  }): Promise<ProjectorLoginResult> {
    if (!isSupabaseConfigured()) {
      return {
        ok: false,
        error: 'not_configured',
        message: 'Database connection is not configured.',
      };
    }

    try {
      const { data, error } = await supabase.rpc('projector_login', {
        p_identifier: params.identifier.trim(),
        p_password: params.password,
        p_event_id: params.eventId || null,
        p_device_label: (params.deviceLabel || getDefaultDeviceLabel()).slice(0, 64),
        p_revoke_session_id: params.revokeSessionId || null,
      });

      if (error) {
        const msg = (error.message || '').toLowerCase();
        if (
          error.code === 'PGRST202' ||
          error.code === '42883' ||
          msg.includes('projector_login')
        ) {
          return {
            ok: false,
            error: 'rpc_unavailable',
            message: 'Projector App SQL (17.6.0) is not deployed in Supabase yet.',
          };
        }
        return {
          ok: false,
          error: error.code || 'rpc_error',
          message: error.message || 'Unable to sign in.',
        };
      }

      const res = data as any;
      if (!res || !res.ok) {
        if (res?.error === 'session_limit_reached') {
          return {
            ok: false,
            sessionLimitReached: true,
            sessions: Array.isArray(res.sessions) ? (res.sessions as ActiveOrgSession[]) : [],
            error: 'session_limit_reached',
            message:
              res.message ||
              'All 3 organisation device slots are in use. Log out one device to continue.',
          };
        }
        return {
          ok: false,
          error: res?.error || res?.reason || 'login_failed',
          message: res?.message || 'Invalid organisation ID or password.',
        };
      }

      if (res.needs_event_selection) {
        const events: ProjectorEventSummary[] = (Array.isArray(res.events) ? res.events : []).map(
          (e: any) => ({
            id: String(e.id),
            name: String(e.name || 'Untitled Event'),
            category: String(e.category || ''),
            status: (String(e.status || 'draft').toLowerCase() as EventStatus) || 'draft',
            date: typeof e.date === 'string' ? e.date : undefined,
          })
        );
        return {
          ok: true,
          needsEventSelection: true,
          org: {
            orgId: String(res.org?.org_id || ''),
            name: String(res.org?.name || ''),
          },
          events,
        };
      }

      return {
        ok: true,
        projectorToken: String(res.projector_token || ''),
        expiresAt: String(res.expires_at || ''),
        org: {
          orgId: String(res.org?.org_id || ''),
          name: String(res.org?.name || ''),
        },
        event: {
          id: String(res.event?.id || ''),
          name: String(res.event?.name || ''),
          category: String(res.event?.category || ''),
          status: (String(res.event?.status || 'active').toLowerCase() as EventStatus) || 'active',
        },
      };
    } catch {
      return {
        ok: false,
        error: 'network_error',
        message: 'Unable to reach server. Check your internet connection and try again.',
      };
    }
  },

  async fetchChanges(token: string, sinceCursor: number): Promise<ProjectorChangesResult> {
    if (!isSupabaseConfigured()) {
      return { ok: false, error: 'not_configured', message: 'Database not configured.' };
    }
    return fetchProjectorChanges(
      async (fn, args) => {
        const { data, error } = await supabase.rpc(fn, args);
        return { data, error };
      },
      token,
      sinceCursor
    );
  },

  async endSession(token: string): Promise<ProjectorEndResult> {
    if (!isSupabaseConfigured() || !token) {
      return { ok: true };
    }
    try {
      const { data, error } = await supabase.rpc('projector_end', {
        p_token: token,
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      return { ok: Boolean((data as any)?.ok ?? true) };
    } catch {
      return { ok: false, error: 'network_error' };
    }
  },
};
