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
  tie_breaker_enabled?: boolean; // Default false (off by default)
  tie_breaker_method?: TieBreakerMethod; // 'olympic' | 'shared' | 'manual'
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
  }; // JSONB
  score_data: Record<string, number>; // Compatibility alias
  total_score: number;
  created_at: string;
}

export type DashboardZone = 'roster' | 'events' | 'live' | 'settings';
