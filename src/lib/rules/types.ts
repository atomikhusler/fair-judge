import type {
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
  TieBreakerMethod,
} from '../supabaseTypes';

export type RuleLevel = 'block' | 'warn' | 'info';

export type RuleId =
  | 'category_mismatch'
  | 'duplicate_participant_org'
  | 'duplicate_participant_event'
  | 'duplicate_participant_import'
  | 'missing_school_import'
  | 'missing_class_import'
  | 'missing_class_row'
  | 'preflight_rubric_invalid'
  | 'preflight_no_judges'
  | 'preflight_no_participants'
  | 'preflight_zero_criteria_marks'
  | 'preflight_missing_school_class'
  | 'preflight_judge_unassigned'
  | 'end_unscored_participants'
  | 'end_partial_participants'
  | 'tie_breaker_suggestion';

export interface RuleResult<TMeta = Record<string, unknown>> {
  id: RuleId;
  level: RuleLevel;
  title: string;
  message: string;
  meta?: TMeta;
}

export type Rule<TContext, TMeta = Record<string, unknown>> = (
  context: TContext
) => RuleResult<TMeta> | null;

export interface RuleEvaluation {
  results: RuleResult[];
  blocks: RuleResult[];
  warnings: RuleResult[];
  infos: RuleResult[];
  hasBlocks: boolean;
  hasWarnings: boolean;
}

export interface CategoryMismatchMeta {
  eventId: string;
  eventCategory: string;
  mismatchedParticipants: Array<{
    id: string;
    name: string;
    class_or_age: string;
  }>;
}

export interface DuplicateMatchItem {
  candidateName: string;
  candidateSchool: string;
  existingId?: string;
  existingIdentityId?: string;
  existingName: string;
  existingSchool: string;
  existingClassOrAge?: string;
  similarity: number;
  matchType: 'exact' | 'fuzzy';
  scope: 'event' | 'org' | 'import_file';
  rowNumber?: number;
}

export interface DuplicateParticipantMeta {
  matches: DuplicateMatchItem[];
}

export interface ImportRowWarningItem {
  rowNumber: number;
  name: string;
  field: 'school' | 'class_or_age' | 'duplicate';
  fieldLabel: string;
  level: RuleLevel;
  detail: string;
  duplicateMatch?: DuplicateMatchItem;
}

export interface EnrollmentBatchContext {
  event: SupabaseEvent;
  selectedParticipants: SupabaseParticipant[];
  alreadyEnrolledParticipants: SupabaseParticipant[];
  ignoreCategoryWarnings?: boolean;
}

export interface ParticipantSaveContext {
  candidate: {
    id?: string;
    name: string;
    school: string;
    class_or_age?: string;
  };
  existingParticipants: SupabaseParticipant[];
}

export interface ImportRowCandidate {
  rowNumber: number; // 1-based spreadsheet row (header = 1)
  name: string;
  school: string;
  class_or_age: string;
}

export interface ImportBatchContext {
  rows: ImportRowCandidate[];
  existingParticipants: SupabaseParticipant[];
  categoryLabel: string;
}

export interface ImportBatchEvaluation extends RuleEvaluation {
  rowWarnings: ImportRowWarningItem[];
  missingSchoolCount: number;
  missingClassCount: number;
  duplicateCount: number;
}

export interface ParticipantRowContext {
  participant: SupabaseParticipant;
  categoryLabel: string;
}

export interface PreFlightContext {
  event: SupabaseEvent;
  orgEvents: SupabaseEvent[];
  orgJudges: SupabaseJudge[];
  orgParticipants: SupabaseParticipant[];
}

export interface PreFlightMissingFieldParticipantItem {
  participant: SupabaseParticipant;
  id: string;
  name: string;
  missingSchool: boolean;
  missingClass: boolean;
}

export interface PreFlightMissingFieldsMeta {
  items: PreFlightMissingFieldParticipantItem[];
  missingSchoolCount: number;
  missingClassCount: number;
}

export interface PreFlightUnassignedJudgeItem {
  id: string;
  name: string;
  judgeCode?: string;
}

export interface PreFlightUnassignedJudgesMeta {
  judges: PreFlightUnassignedJudgeItem[];
}

export interface EndEventCheckContext {
  event: SupabaseEvent;
  orgJudges: SupabaseJudge[];
  orgParticipants: SupabaseParticipant[];
  eventScores: SupabaseScore[];
}

export interface EndMissingJudgeItem {
  id: string;
  name: string;
  judgeCode?: string;
}

export interface EndParticipantBallotItem {
  participant: SupabaseParticipant;
  id: string;
  name: string;
  identityId?: string;
  slNo?: string;
  scoredCount: number;
  requiredCount: number;
  missingJudges: EndMissingJudgeItem[];
}

export interface EndJudgeProgressItem {
  judgeId: string;
  judgeName: string;
  judgeCode?: string;
  scoredCount: number;
  totalParticipants: number;
}

export interface EndParticipantsWarningMeta {
  participants: EndParticipantBallotItem[];
}

export interface EndEventCheckEvaluation extends RuleEvaluation {
  completedBallots: number;
  totalBallots: number;
  totalParticipants: number;
  totalJudges: number;
  perJudgeProgress: EndJudgeProgressItem[];
  unscoredParticipants: EndParticipantBallotItem[];
  partialParticipants: EndParticipantBallotItem[];
}

export type EventProgressStatus = 'scored' | 'partial' | 'upcoming' | 'absent';

export interface EventProgressJudgeInfo {
  judgeId: string;
  code: string;
  name: string;
}

export interface EventProgressJudgeChip {
  judgeId: string;
  code: string;
  name: string;
  scored: boolean;
}

export interface EventProgressRow {
  participant: SupabaseParticipant;
  id: string;
  orderNumber: string;
  status: EventProgressStatus;
  totalScore: number;
  scoredCount: number;
  requiredCount: number;
  judgeStates: EventProgressJudgeChip[];
}

export interface EventProgressCounts {
  total: number;
  scored: number;
  partial: number;
  upcoming: number;
  absent: number;
  completedBallots: number;
  totalBallots: number;
}

export interface EventProgressContext {
  event: SupabaseEvent;
  orgJudges: SupabaseJudge[];
  orgParticipants: SupabaseParticipant[];
  eventScores: SupabaseScore[];
}

export interface EventProgressSummary {
  isEnded: boolean;
  assignedJudges: EventProgressJudgeInfo[];
  rows: EventProgressRow[];
  counts: EventProgressCounts;
}

export interface DedupedEventData {
  event: SupabaseEvent;
  activeJudges: SupabaseJudge[];
  activeParticipants: SupabaseParticipant[];
  activeJudgeById: Map<string, SupabaseJudge>;
  activeParticipantById: Map<string, SupabaseParticipant>;
  deduplicatedScores: SupabaseScore[];
  scoresByParticipant: Map<string, SupabaseScore[]>;
}

export type TieBreakerResolutionMethod =
  | 'olympic'
  | 'precision_4dp'
  | 'shared'
  | 'manual_required';

export interface TieBreakerStandingInput {
  participant: SupabaseParticipant;
  ballotCount: number;
  averageScore: number;
  rank: number;
  isTied: boolean;
}

export interface TieBreakerContext {
  event: SupabaseEvent;
  standings: TieBreakerStandingInput[];
  deduplicatedEventScores: SupabaseScore[];
  activeAssignedJudgesCount: number;
  tieBreakerEnabled: boolean;
  tieBreakerMethod?: TieBreakerMethod;
  blindJudgingEnabled?: boolean;
}

export interface TieBreakerSuggestedEntry {
  participant: SupabaseParticipant;
  displayName: string;
  suggestedRank: number;
  suggestedScore: number;
}

export interface TieBreakerSuggestionItem {
  id: string;
  eventId: string;
  rank: number;
  tiedAverageScore: number;
  resolution: TieBreakerResolutionMethod;
  entries: TieBreakerSuggestedEntry[];
  level: 'info';
}

export type EvaluateEnrollmentRules = (ctx: EnrollmentBatchContext) => RuleEvaluation;
export type EvaluateParticipantSaveRules = (ctx: ParticipantSaveContext) => RuleEvaluation;
export type EvaluateImportBatchRules = (ctx: ImportBatchContext) => ImportBatchEvaluation;
export type EvaluateParticipantRowRules = (ctx: ParticipantRowContext) => RuleResult[];
export type EvaluatePreFlightRules = (ctx: PreFlightContext) => RuleEvaluation;
export type EvaluateEndEventRules = (ctx: EndEventCheckContext) => EndEventCheckEvaluation;
export type ComputeEventProgress = (ctx: EventProgressContext) => EventProgressSummary;
export type ComputeEventTieBreakerSuggestions = (
  ctx: TieBreakerContext
) => TieBreakerSuggestionItem[];
