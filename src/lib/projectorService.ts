import { supabase, isSupabaseConfigured, getStoredSessionToken } from './supabase';
import {
  Organization,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
  EventStatus,
  TieBreakerMethod,
} from './supabaseTypes';

export type ProjectorSegment = 'leaderboard' | 'scoreboard' | 'events';
export type ProjectorOverscan = 0 | 2 | 4;

export const PROJECTOR_STORAGE_KEYS = {
  DEVICE_SECRET: 'fj_projector_device_secret',
  PAIRING_CODE: 'fj_projector_pairing_code',
  PAIRING_EXPIRES_AT: 'fj_projector_pairing_expires_at',
  VIEW_TOKEN: 'fj_projector_view_token',
  SCOPED_EVENT_ID: 'fj_projector_scoped_event_id',
  LABEL: 'fj_projector_label',
  SEGMENT: 'fj_projector_segment',
  SELECTED_EVENT_ID: 'fj_projector_selected_event_id',
  OVERSCAN: 'fj_projector_overscan',
} as const;

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

export interface ProjectorPairingItem {
  id: string;
  label: string;
  event_id: string | null;
  event_name: string | null;
  is_blank: boolean;
  is_online: boolean;
  created_at: string;
  approved_at: string | null;
  last_seen_at: string | null;
}

export interface RequestCodeResponse {
  ok: boolean;
  code?: string;
  deviceSecret?: string;
  expiresAt?: string;
  error?: string;
  message?: string;
}

export interface ClaimResponse {
  status: 'pending' | 'approved' | 'expired' | 'network_error';
  viewToken?: string;
  orgId?: string;
  eventId?: string | null;
  label?: string | null;
}

export interface FingerprintResponse {
  ok: boolean;
  version?: string;
  orgId?: string;
  eventId?: string | null;
  label?: string | null;
  isBlank?: boolean;
  error?: 'expired_or_revoked' | 'network_error';
}

export interface SnapshotResponse {
  ok: boolean;
  snapshot?: ProjectorSnapshot;
  error?: 'expired_or_revoked' | 'network_error';
}

export interface ApproveResponse {
  ok: boolean;
  pairingId?: string;
  orgId?: string;
  eventId?: string | null;
  label?: string;
  error?: string;
  message?: string;
  failCount?: number;
  lockedUntil?: string;
}

export interface ListPairingsResponse {
  ok: boolean;
  pairings: ProjectorPairingItem[];
  liveCount: number;
  error?: string;
  message?: string;
}

export interface UpdatePairingResponse {
  ok: boolean;
  pairingId?: string;
  label?: string;
  eventId?: string | null;
  isBlank?: boolean;
  error?: string;
  message?: string;
}

export interface RevokeResponse {
  ok: boolean;
  revokedCount?: number;
  error?: string;
  message?: string;
}

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

export function getStoredViewToken(): string | null {
  return safeGet(PROJECTOR_STORAGE_KEYS.VIEW_TOKEN);
}

export function saveApprovedPairing(params: {
  viewToken: string;
  eventId?: string | null;
  label?: string | null;
}): void {
  safeSet(PROJECTOR_STORAGE_KEYS.VIEW_TOKEN, params.viewToken);
  safeSet(PROJECTOR_STORAGE_KEYS.SCOPED_EVENT_ID, params.eventId || null);
  safeSet(PROJECTOR_STORAGE_KEYS.LABEL, params.label || null);
  safeSet(PROJECTOR_STORAGE_KEYS.DEVICE_SECRET, null);
  safeSet(PROJECTOR_STORAGE_KEYS.PAIRING_CODE, null);
  safeSet(PROJECTOR_STORAGE_KEYS.PAIRING_EXPIRES_AT, null);
}

export function clearApprovedPairing(): void {
  safeSet(PROJECTOR_STORAGE_KEYS.VIEW_TOKEN, null);
  safeSet(PROJECTOR_STORAGE_KEYS.SCOPED_EVENT_ID, null);
  safeSet(PROJECTOR_STORAGE_KEYS.LABEL, null);
  safeSet(PROJECTOR_STORAGE_KEYS.SELECTED_EVENT_ID, null);
}

export function getStoredPendingPairing(): {
  code: string;
  deviceSecret: string;
  expiresAt: string;
} | null {
  const code = safeGet(PROJECTOR_STORAGE_KEYS.PAIRING_CODE);
  const deviceSecret = safeGet(PROJECTOR_STORAGE_KEYS.DEVICE_SECRET);
  const expiresAt = safeGet(PROJECTOR_STORAGE_KEYS.PAIRING_EXPIRES_AT);
  if (!code || !deviceSecret || !expiresAt) return null;
  const expMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expMs) || expMs <= Date.now()) {
    clearPendingPairing();
    return null;
  }
  return { code, deviceSecret, expiresAt };
}

export function savePendingPairing(code: string, deviceSecret: string, expiresAt: string): void {
  safeSet(PROJECTOR_STORAGE_KEYS.PAIRING_CODE, code);
  safeSet(PROJECTOR_STORAGE_KEYS.DEVICE_SECRET, deviceSecret);
  safeSet(PROJECTOR_STORAGE_KEYS.PAIRING_EXPIRES_AT, expiresAt);
}

export function clearPendingPairing(): void {
  safeSet(PROJECTOR_STORAGE_KEYS.PAIRING_CODE, null);
  safeSet(PROJECTOR_STORAGE_KEYS.DEVICE_SECRET, null);
  safeSet(PROJECTOR_STORAGE_KEYS.PAIRING_EXPIRES_AT, null);
}

export function getProjectorDisplayPrefs(): {
  segment: ProjectorSegment;
  selectedEventId: string;
  overscan: ProjectorOverscan;
} {
  const seg = safeGet(PROJECTOR_STORAGE_KEYS.SEGMENT);
  const segment: ProjectorSegment =
    seg === 'scoreboard' || seg === 'events' ? seg : 'leaderboard';
  const selectedEventId = safeGet(PROJECTOR_STORAGE_KEYS.SELECTED_EVENT_ID) || '';
  const ovRaw = Number(safeGet(PROJECTOR_STORAGE_KEYS.OVERSCAN));
  const overscan: ProjectorOverscan = ovRaw === 2 || ovRaw === 4 ? ovRaw : 0;
  return { segment, selectedEventId, overscan };
}

export function saveProjectorDisplayPrefs(prefs: {
  segment?: ProjectorSegment;
  selectedEventId?: string;
  overscan?: ProjectorOverscan;
}): void {
  if (prefs.segment !== undefined) safeSet(PROJECTOR_STORAGE_KEYS.SEGMENT, prefs.segment);
  if (prefs.selectedEventId !== undefined) {
    safeSet(PROJECTOR_STORAGE_KEYS.SELECTED_EVENT_ID, prefs.selectedEventId || null);
  }
  if (prefs.overscan !== undefined) {
    safeSet(PROJECTOR_STORAGE_KEYS.OVERSCAN, String(prefs.overscan));
  }
}

function normalizeSnapshot(raw: any): ProjectorSnapshot {
  const rawOrg = raw?.org || {};
  const org: Organization = {
    id: rawOrg.org_id || '',
    org_id: rawOrg.org_id || '',
    name: rawOrg.name || 'Fair Judge Competition Stage',
    tie_breaker_enabled: Boolean(rawOrg.tie_breaker_enabled),
    tie_breaker_method: (rawOrg.tie_breaker_method || 'olympic') as TieBreakerMethod,
    blind_judging_enabled: Boolean(rawOrg.blind_judging_enabled),
    projector_blind_mode:
      rawOrg.projector_blind_mode !== undefined ? Boolean(rawOrg.projector_blind_mode) : false,
    projector_spotlight_mode:
      rawOrg.projector_spotlight_mode !== undefined
        ? Boolean(rawOrg.projector_spotlight_mode)
        : true,
    projector_ticker_text:
      typeof rawOrg.projector_ticker_text === 'string'
        ? rawOrg.projector_ticker_text.slice(0, 120)
        : '',
    projector_carousel_interval:
      typeof rawOrg.projector_carousel_interval === 'number'
        ? Math.max(15, Math.min(180, rawOrg.projector_carousel_interval))
        : 60,
    projector_confetti_at: rawOrg.projector_confetti_at || null,
    created_at: rawOrg.created_at || new Date().toISOString(),
  };

  const events: SupabaseEvent[] = (Array.isArray(raw?.events) ? raw.events : []).map((e: any) => {
    const schema = Array.isArray(e.rubric_schema) ? e.rubric_schema : [];
    return {
      ...e,
      status: (e.status?.toLowerCase() as EventStatus) || 'draft',
      is_locked: Boolean(e.is_locked),
      is_archived: Boolean(e.is_archived),
      rubric_schema: schema,
      rubric: schema,
      assigned_judges: Array.isArray(e.assigned_judges) ? e.assigned_judges : [],
      assigned_participants: Array.isArray(e.assigned_participants) ? e.assigned_participants : [],
      participant_sl_numbers: e.participant_sl_numbers || {},
    };
  });

  // Never include pin or current_session_token in projector state
  const judges: SupabaseJudge[] = (Array.isArray(raw?.judges) ? raw.judges : []).map((j: any) => ({
    id: j.id,
    org_id: j.org_id,
    name: j.name,
    judge_id: j.judge_id,
    pin: '',
    judge_pin: '',
    assigned_events: Array.isArray(j.assigned_events) ? j.assigned_events : [],
    current_session_token: null,
    created_at: j.created_at || '',
  }));

  // Never include mobile_number in projector state
  const participants: SupabaseParticipant[] = (
    Array.isArray(raw?.participants) ? raw.participants : []
  ).map((p: any) => ({
    id: p.id,
    org_id: p.org_id,
    identity_id: p.identity_id || '',
    sl_no: p.sl_no || '',
    name: p.name || '',
    school: p.school || '',
    class_or_age: p.class_or_age,
    custom_values: p.custom_values || {},
    created_at: p.created_at || '',
  }));

  const scores: SupabaseScore[] = (Array.isArray(raw?.scores) ? raw.scores : []).map((s: any) => {
    const hasNumericScore =
      (s.total_score !== undefined && s.total_score !== null) ||
      (s.score_payload !== undefined && s.score_payload !== null);
    if (!hasNumericScore) {
      // Server-enforced blind mode: preserve omitted point values without fabricating zeros
      return {
        id: s.id,
        event_id: s.event_id,
        judge_id: s.judge_id,
        participant_id: s.participant_id,
        created_at: s.created_at || '',
        total_score: undefined as unknown as number,
        score_data: undefined as unknown as Record<string, number>,
        score_payload: undefined as unknown as SupabaseScore['score_payload'],
      };
    }

    const criteria = s.score_payload?.criteria || {};
    const total = Number(s.total_score ?? s.score_payload?.total_score ?? 0);
    return {
      ...s,
      total_score: total,
      score_data: criteria,
      score_payload: s.score_payload || {
        criteria,
        total_score: total,
        submitted_at: s.created_at || new Date().toISOString(),
      },
    };
  });

  const blindRanks: BlindRankItem[] = (
    Array.isArray(raw?.blind_ranks) ? raw.blind_ranks : []
  ).map((r: any) => ({
    event_id: String(r.event_id || ''),
    participant_id: String(r.participant_id || ''),
    rank: Number(r.rank || 0),
    judge_count: Number(r.judge_count || 0),
  }));

  return {
    org,
    events,
    judges,
    participants,
    scores,
    blindRanks,
    scopedEventId: raw?.scoped_event_id || null,
    label: raw?.label || null,
    isBlank: Boolean(raw?.is_blank),
  };
}

export const projectorService = {
  async requestCode(): Promise<RequestCodeResponse> {
    if (!isSupabaseConfigured()) {
      return {
        ok: false,
        error: 'not_configured',
        message: 'Supabase connection is not configured.',
      };
    }

    try {
      const { data, error } = await supabase.rpc('projector_request_code');
      if (error) {
        return {
          ok: false,
          error: error.code || 'rpc_error',
          message: error.message || 'Could not request a pairing code.',
        };
      }
      const res = data as any;
      if (!res || !res.ok) {
        return {
          ok: false,
          error: res?.error || 'request_failed',
          message: res?.message || 'Could not generate pairing code.',
        };
      }
      savePendingPairing(res.code, res.device_secret, res.expires_at);
      return {
        ok: true,
        code: res.code,
        deviceSecret: res.device_secret,
        expiresAt: res.expires_at,
      };
    } catch {
      return {
        ok: false,
        error: 'network_error',
        message: 'Unable to reach server. Retrying connection...',
      };
    }
  },

  async claim(deviceSecret: string): Promise<ClaimResponse> {
    if (!isSupabaseConfigured()) {
      return { status: 'network_error' };
    }
    try {
      const { data, error } = await supabase.rpc('projector_claim', {
        p_device_secret: deviceSecret,
      });
      if (error || !data) {
        return { status: 'network_error' };
      }
      const res = data as any;
      if (res.status === 'approved' && res.view_token) {
        saveApprovedPairing({
          viewToken: res.view_token,
          eventId: res.event_id || null,
          label: res.label || null,
        });
        return {
          status: 'approved',
          viewToken: res.view_token,
          orgId: res.org_id,
          eventId: res.event_id || null,
          label: res.label || null,
        };
      }
      if (res.status === 'expired') {
        clearPendingPairing();
        return { status: 'expired' };
      }
      return { status: 'pending' };
    } catch {
      return { status: 'network_error' };
    }
  },

  async fingerprint(viewToken: string): Promise<FingerprintResponse> {
    if (!isSupabaseConfigured()) {
      return { ok: false, error: 'network_error' };
    }
    try {
      const { data, error } = await supabase.rpc('projector_fingerprint', {
        p_view_token: viewToken,
      });
      if (error || !data) {
        return { ok: false, error: 'network_error' };
      }
      const res = data as any;
      if (!res.ok) {
        return { ok: false, error: 'expired_or_revoked' };
      }
      return {
        ok: true,
        version: res.version,
        orgId: res.org_id,
        eventId: res.event_id || null,
        label: res.label || null,
        isBlank: Boolean(res.is_blank),
      };
    } catch {
      return { ok: false, error: 'network_error' };
    }
  },

  async snapshot(viewToken: string): Promise<SnapshotResponse> {
    if (!isSupabaseConfigured()) {
      return { ok: false, error: 'network_error' };
    }
    try {
      const { data, error } = await supabase.rpc('projector_snapshot', {
        p_view_token: viewToken,
      });
      if (error || !data) {
        return { ok: false, error: 'network_error' };
      }
      const res = data as any;
      if (!res.ok) {
        return { ok: false, error: 'expired_or_revoked' };
      }
      return {
        ok: true,
        snapshot: normalizeSnapshot(res),
      };
    } catch {
      return { ok: false, error: 'network_error' };
    }
  },

  async approve(params: {
    orgId: string;
    code: string;
    eventId?: string | null;
    label?: string | null;
  }): Promise<ApproveResponse> {
    const token = getStoredSessionToken() || '';
    if (!token) {
      return {
        ok: false,
        error: 'unauthorized',
        message: 'Session expired. Please sign in again.',
      };
    }
    try {
      const { data, error } = await supabase.rpc('projector_approve', {
        p_token: token,
        p_org_id: params.orgId,
        p_code: params.code,
        p_event_id: params.eventId || null,
        p_label: params.label || null,
      });
      if (error) {
        return {
          ok: false,
          error: error.code || 'rpc_error',
          message: error.message || 'Could not pair screen.',
        };
      }
      const res = data as any;
      if (!res || !res.ok) {
        return {
          ok: false,
          error: res?.error || 'approve_failed',
          message: res?.message || 'Could not pair screen.',
          failCount: res?.fail_count,
          lockedUntil: res?.locked_until,
        };
      }
      return {
        ok: true,
        pairingId: res.pairing_id,
        orgId: res.org_id,
        eventId: res.event_id || null,
        label: res.label || 'Projector Screen',
      };
    } catch {
      return {
        ok: false,
        error: 'network_error',
        message: 'Network error while pairing screen.',
      };
    }
  },

  async list(orgId: string): Promise<ListPairingsResponse> {
    const token = getStoredSessionToken() || '';
    if (!token || !isSupabaseConfigured()) {
      return { ok: false, pairings: [], liveCount: 0, error: 'unauthorized' };
    }
    try {
      const { data, error } = await supabase.rpc('projector_list', {
        p_token: token,
        p_org_id: orgId,
      });
      if (error || !data) {
        return { ok: false, pairings: [], liveCount: 0, error: 'network_error' };
      }
      const res = data as any;
      if (!res.ok) {
        return {
          ok: false,
          pairings: [],
          liveCount: 0,
          error: res.error,
          message: res.message,
        };
      }
      const pairings: ProjectorPairingItem[] = (
        Array.isArray(res.pairings) ? res.pairings : []
      ).map((p: any) => ({
        id: p.id,
        label: p.label || 'Projector Screen',
        event_id: p.event_id || null,
        event_name: p.event_name || null,
        is_blank: Boolean(p.is_blank),
        is_online:
          p.is_online !== undefined
            ? Boolean(p.is_online)
            : Boolean(
                p.last_seen_at &&
                  Date.now() - new Date(p.last_seen_at).getTime() <= 60000
              ),
        created_at: p.created_at,
        approved_at: p.approved_at || null,
        last_seen_at: p.last_seen_at || null,
      }));
      const liveCount =
        typeof res.live_count === 'number'
          ? res.live_count
          : pairings.filter((p) => p.is_online).length;
      return {
        ok: true,
        pairings,
        liveCount,
      };
    } catch {
      return { ok: false, pairings: [], liveCount: 0, error: 'network_error' };
    }
  },

  async update(params: {
    orgId: string;
    pairingId: string;
    label?: string | null;
    eventId?: string | null;
    setEvent?: boolean;
    isBlank?: boolean;
  }): Promise<UpdatePairingResponse> {
    const token = getStoredSessionToken() || '';
    if (!token || !isSupabaseConfigured()) {
      return { ok: false, error: 'unauthorized', message: 'Session expired.' };
    }
    try {
      const { data, error } = await supabase.rpc('projector_update', {
        p_token: token,
        p_org_id: params.orgId,
        p_pairing_id: params.pairingId,
        p_label: params.label !== undefined ? params.label : null,
        p_event_id: params.eventId !== undefined ? params.eventId : null,
        p_set_event: Boolean(params.setEvent),
        p_is_blank: params.isBlank !== undefined ? params.isBlank : null,
      });
      if (error || !data) {
        return {
          ok: false,
          error: error?.code || 'network_error',
          message: error?.message || 'Could not update screen.',
        };
      }
      const res = data as any;
      if (!res.ok) {
        return {
          ok: false,
          error: res.error || 'update_failed',
          message: res.message || 'Could not update screen.',
        };
      }
      return {
        ok: true,
        pairingId: res.pairing_id,
        label: res.label,
        eventId: res.event_id ?? null,
        isBlank: Boolean(res.is_blank),
      };
    } catch {
      return { ok: false, error: 'network_error', message: 'Network error while updating screen.' };
    }
  },

  async revoke(orgId: string, pairingId?: string | null): Promise<RevokeResponse> {
    const token = getStoredSessionToken() || '';
    if (!token) {
      return { ok: false, error: 'unauthorized', message: 'Session expired.' };
    }
    try {
      const { data, error } = await supabase.rpc('projector_revoke', {
        p_token: token,
        p_org_id: orgId,
        p_pairing_id: pairingId || null,
      });
      if (error || !data) {
        return { ok: false, error: 'network_error', message: 'Network error while revoking.' };
      }
      const res = data as any;
      if (!res.ok) {
        return { ok: false, error: res.error, message: res.message || 'Revoke failed.' };
      }
      return { ok: true, revokedCount: res.revoked_count ?? 0 };
    } catch {
      return { ok: false, error: 'network_error', message: 'Network error while revoking.' };
    }
  },
};
