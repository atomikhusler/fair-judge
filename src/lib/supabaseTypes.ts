export type EventStatus = 'draft' | 'upcoming' | 'ready' | 'active' | 'paused' | 'ended' | 'archived';
export type TieBreakerMethod = 'olympic' | 'shared' | 'manual';
export type VerificationStatus = 'pending' | 'verified' | 'rejected';

export interface RubricCriterion {
  id: string;
  name: string;
  max_marks: number; // e.g. 5, 10, 20
  description?: string;
  weight?: number;
}

export interface CustomParticipantField {
  id: string;
  name: string;
  required: boolean;
  type?: 'text' | 'number';
}

export interface Organization {
  id: string; // UUID
  org_id: string; // 7-character system generated code (e.g. "FJ-A4X9")
  name: string;
  email?: string;
  verification_status?: VerificationStatus; // 'pending' | 'verified' | 'rejected'
  rejection_reason?: string | null;
  verified_at?: string | null;
  suspended?: boolean;
  suspended_reason?: string | null;
  deleted_at?: string | null;
  tie_breaker_enabled?: boolean; // Legacy field kept for compatibility (ties are always active)
  tie_breaker_method?: TieBreakerMethod; // Legacy column kept for migration compatibility
  tie_management_enabled?: boolean; // Legacy field kept for compatibility (no Settings switch)
  tie_rule?: OrgTieRule; // Legacy default rule field
  prize_places?: 3 | 5; // Number of prize places (3 or 5, default 3)
  score_one_by_one_enabled?: boolean; // Default OFF for Score One by One mode
  custom_participant_fields?: CustomParticipantField[];
  blind_judging_enabled?: boolean; // Default false (hide names & schools to prevent bias)
  auto_advance_enabled?: boolean; // Default true (auto-slide to next on submit)
  grace_period_enabled?: boolean; // Default false (allow 5-minute score edit window)
  isolated_jury_enabled?: boolean; // Default false (hide global rankings and queue counters)
  projector_blind_mode?: boolean; // Broadcast Control Room: Score Secrecy (server-enforced)
  projector_spotlight_mode?: boolean; // Broadcast Control Room: Spotlight / Focus Mode
  projector_ticker_text?: string; // Broadcast Control Room: Plain-text ticker (max 120 chars)
  projector_carousel_interval?: number; // Broadcast Control Room: Carousel interval (15-180s)
  projector_confetti_at?: string | null; // Broadcast Control Room: Last confetti trigger timestamp
  created_at: string;
}

export type OrgTieRule = 'countback' | 'olympic' | 'recompete';
export type TieRoundRule = 'countback' | 'olympic' | 'recompete' | 'shared';
export type TieAuditRule = TieRoundRule | 'absent';
export type TieRoundStatus = 'open' | 'closed' | 'published' | 'cancelled_stale';
export type AbsenceStatus = 'pending' | 'confirmed' | 'rejected';
export type TieAuditAction =
  | 'apply_countback'
  | 'apply_olympic'
  | 'open_recompete'
  | 'close_recompete'
  | 'publish_recompete'
  | 'reopen_recompete'
  | 'close_stale_round'
  | 'close_event_shared'
  | 'request_absent'
  | 'confirm_absent'
  | 'reject_absent';

export interface ParticipantAbsence {
  id: string;
  org_id: string;
  event_id: string;
  participant_id: string;
  requested_by_judge_id: string | null;
  status: AbsenceStatus;
  is_sealed: boolean;
  resolved_by?: string;
  requested_at: string;
  resolved_at: string | null;
  version?: number;
  updated_at?: string;
}

export interface TieRoundPlacement {
  participant_id: string;
  before_rank: number;
  after_rank: number;
  base_avg: number;
  ballot_count?: number;
  scores_desc?: number[];
  trimmed_avg?: number | null;
  grade_sum?: number;
  grade_count?: number;
}

export interface TieRoundResultPayload {
  rule?: TieRoundRule;
  tied_rank?: number;
  score_fingerprint?: string;
  resolved?: boolean;
  still_tied?: boolean;
  low_judge_warning?: boolean;
  submitted_judge_count?: number;
  total_grades?: number;
  placements?: TieRoundPlacement[];
}

export interface TieRound {
  id: string;
  org_id: string;
  event_id: string;
  group_key: string;
  tied_rank: number;
  tied_participant_ids: string[];
  rule: TieRoundRule;
  status: TieRoundStatus;
  is_stale: boolean;
  score_fingerprint: string;
  preview_payload: Record<string, unknown>;
  result_payload: TieRoundResultPayload;
  reopen_count: number;
  last_reopen_reason: string;
  opened_at: string;
  closed_at: string | null;
  published_at: string | null;
  version: number;
  updated_at: string;
  submitted_judge_count?: number;
  completed_judge_count?: number;
  expected_judge_count?: number;
}

export interface TieRoundGrade {
  id: string;
  org_id?: string;
  round_id: string;
  event_id: string;
  judge_id: string;
  participant_id: string;
  grade: number; // Strict integer 1..5 (E=1, D=2, C=3, B=4, A=5)
  submitted_at: string;
  version: number;
  updated_at?: string;
}

export interface ProjectorTieRound {
  id: string;
  event_id: string;
  group_key: string;
  tied_rank: number;
  tied_participant_ids: string[];
  rule: TieRoundRule;
  status: TieRoundStatus;
  is_stale: boolean;
  score_fingerprint: string;
  result_payload: TieRoundResultPayload;
  published_at: string | null;
  version: number;
}

export interface TieAuditEntry {
  id: string;
  org_id: string;
  event_id: string | null;
  event_name: string;
  round_id: string | null;
  group_key: string;
  action: TieAuditAction;
  rule: TieAuditRule;
  actor_label: string;
  preview_json: Record<string, unknown>;
  result_json: Record<string, unknown>;
  outcome: string;
  reason: string;
  created_at: string;
}

export interface SupabaseEvent {
  id: string; // UUID
  org_id: string; // Organization ID (foreign key)
  name: string;
  category?: string;
  date?: string;
  status: EventStatus;
  is_locked?: boolean; // Roster Lock flag (Epic 15.2)
  is_archived?: boolean; // Inbox Zero Archive flag (Phase 13.9)
  started_at?: string | null; // ISO timestamp when session was started
  elapsed_seconds?: number; // total accumulated seconds
  rubric_schema: RubricCriterion[]; // JSONB
  rubric: RubricCriterion[]; // Compatibility alias
  assigned_judges: string[]; // Judge IDs
  assigned_participants: string[]; // Participant IDs
  participant_sl_numbers?: Record<string, string>; // Event-specific serial numbers: participantId -> "01", "B-03"
  score_one_by_one?: boolean; // Per-event Score One by One mode (default OFF)
  current_participant_id?: string | null; // Active participant when score_one_by_one is ON
  created_at: string;
  updated_at?: string;
}

export interface SupabaseJudge {
  id: string; // UUID or unique ID
  org_id: string;
  name: string;
  judge_id?: string; // Formatted Judge ID code (e.g. "J-01")
  pin: string; // 4-digit code (e.g. "4921")
  judge_pin: string; // Compatibility alias
  assigned_events: string[]; // Event IDs
  current_session_token?: string | null; // Single-device active session lock token
  is_active?: boolean; // Soft-delete flag (Phase 13.6)
  created_at: string;
}

export interface SupabaseParticipant {
  id: string; // UUID
  org_id: string;
  identity_id: string; // Global Identity Number: e.g. "P-8492" (auto-generated, immutable)
  sl_no: string; // Performance order per event: e.g. "01", "02"
  name: string;
  school: string; // School/Institution
  class_or_age?: string; // Default Field: Class/Age
  mobile_number?: string; // Default Field: Mobile Number
  custom_values?: Record<string, string>; // Dynamic custom fields
  is_active?: boolean; // Soft-delete flag (Phase 13.6)
  created_at: string;
}

export interface SupabaseScore {
  id: string; // UUID
  event_id: string;
  judge_id: string;
  participant_id: string;
  score_payload: {
    criteria: Record<string, number>;
    total_score: number;
    submitted_at: string;
    client_uuid?: string;
  }; // JSONB
  score_data: Record<string, number>; // Compatibility alias
  total_score: number;
  created_at: string;
}

export type DashboardZone = 'roster' | 'events' | 'live' | 'settings';
