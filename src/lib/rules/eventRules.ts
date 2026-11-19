/**
 * Pure TypeScript pre-flight checklist and end-of-event rules (Phase 3 / 17.2.0).
 * Zero DOM, zero Supabase runtime, zero SQL dependencies.
 */
import type {
  RubricCriterion,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
} from '../supabaseTypes';
import type {
  EndEventCheckContext,
  EndEventCheckEvaluation,
  EndJudgeProgressItem,
  EndParticipantBallotItem,
  EndParticipantsWarningMeta,
  EventProgressContext,
  EventProgressJudgeChip,
  EventProgressJudgeInfo,
  EventProgressRow,
  EventProgressStatus,
  EventProgressSummary,
  PreFlightContext,
  PreFlightMissingFieldParticipantItem,
  PreFlightMissingFieldsMeta,
  PreFlightUnassignedJudgeItem,
  PreFlightUnassignedJudgesMeta,
  Rule,
  RuleResult,
} from './types';
import { buildEvaluation } from './participantRules';

function getEventRubric(event: SupabaseEvent): RubricCriterion[] {
  if (Array.isArray(event.rubric_schema) && event.rubric_schema.length > 0) {
    return event.rubric_schema;
  }
  if (Array.isArray(event.rubric) && event.rubric.length > 0) {
    return event.rubric;
  }
  return Array.isArray(event.rubric_schema) ? event.rubric_schema : [];
}

/**
 * Resolves event.assigned_judges against active org judges only (is_active !== false).
 * Deduplicates IDs and drops stale/deleted references.
 */
export function getActiveAssignedJudges(
  event: SupabaseEvent,
  orgJudges: SupabaseJudge[]
): SupabaseJudge[] {
  const activeJudgeById = new Map<string, SupabaseJudge>();
  for (const judge of orgJudges) {
    if (judge.is_active === false) continue;
    activeJudgeById.set(judge.id, judge);
  }

  const seen = new Set<string>();
  const resolved: SupabaseJudge[] = [];
  for (const judgeId of event.assigned_judges || []) {
    if (seen.has(judgeId)) continue;
    seen.add(judgeId);
    const active = activeJudgeById.get(judgeId);
    if (active) resolved.push(active);
  }
  return resolved;
}

/**
 * Resolves event.assigned_participants against active org participants only (is_active !== false).
 * Deduplicates IDs and drops stale/deleted references.
 */
export function getActiveEnrolledParticipants(
  event: SupabaseEvent,
  orgParticipants: SupabaseParticipant[]
): SupabaseParticipant[] {
  const activeParticipantById = new Map<string, SupabaseParticipant>();
  for (const participant of orgParticipants) {
    if (participant.is_active === false) continue;
    activeParticipantById.set(participant.id, participant);
  }

  const seen = new Set<string>();
  const resolved: SupabaseParticipant[] = [];
  for (const participantId of event.assigned_participants || []) {
    if (seen.has(participantId)) continue;
    seen.add(participantId);
    const active = activeParticipantById.get(participantId);
    if (active) resolved.push(active);
  }
  return resolved;
}

function isRubricStructurallyInvalid(rubric: RubricCriterion[]): string | null {
  if (!Array.isArray(rubric) || rubric.length === 0) {
    return 'No rubric criteria configured. Add at least one criterion before starting.';
  }

  for (let i = 0; i < rubric.length; i++) {
    const criterion = rubric[i];
    if (!criterion || !String(criterion.name ?? '').trim()) {
      return `Rubric criterion #${i + 1} is missing a name.`;
    }
    const maxMarks = Number(criterion.max_marks);
    if (!Number.isFinite(maxMarks) || maxMarks < 0) {
      return `Rubric criterion "${criterion.name.trim()}" has invalid max marks.`;
    }
  }

  return null;
}

// ==========================================
// PRE-FLIGHT RULES (BLOCK)
// ==========================================

export const preflightRubricInvalidRule: Rule<PreFlightContext> = (ctx) => {
  const rubric = getEventRubric(ctx.event);
  const error = isRubricStructurallyInvalid(rubric);
  if (!error) return null;

  return {
    id: 'preflight_rubric_invalid',
    level: 'block',
    title: 'Missing or invalid rubric',
    message: error,
  };
};

export const preflightNoJudgesRule: Rule<PreFlightContext> = (ctx) => {
  const activeAssigned = getActiveAssignedJudges(ctx.event, ctx.orgJudges);
  if (activeAssigned.length > 0) return null;

  return {
    id: 'preflight_no_judges',
    level: 'block',
    title: 'No judges assigned',
    message: 'Assign at least one active judge to this event before starting.',
  };
};

export const preflightNoParticipantsRule: Rule<PreFlightContext> = (ctx) => {
  const activeEnrolled = getActiveEnrolledParticipants(ctx.event, ctx.orgParticipants);
  if (activeEnrolled.length > 0) return null;

  return {
    id: 'preflight_no_participants',
    level: 'block',
    title: 'No participants enrolled',
    message: 'Enrol at least one active participant in this event before starting.',
  };
};

// ==========================================
// PRE-FLIGHT RULES (WARN)
// ==========================================

export const preflightZeroCriteriaMarksRule: Rule<PreFlightContext> = (ctx) => {
  const rubric = getEventRubric(ctx.event);
  if (isRubricStructurallyInvalid(rubric)) return null;

  const totalMarks = rubric.reduce((sum, c) => sum + (Number(c.max_marks) || 0), 0);
  const zeroCriteria = rubric
    .filter((c) => Number(c.max_marks) === 0)
    .map((c) => c.name.trim());

  if (totalMarks > 0 && zeroCriteria.length === 0) return null;

  const message =
    totalMarks <= 0
      ? 'This event has 0 total rubric marks across all criteria.'
      : zeroCriteria.length === 1
      ? `Criterion "${zeroCriteria[0]}" has 0 max marks.`
      : `${zeroCriteria.length} criteria have 0 max marks (${zeroCriteria.join(', ')}).`;

  return {
    id: 'preflight_zero_criteria_marks',
    level: 'warn',
    title: 'Zero criteria marks',
    message,
    meta: { totalMarks, zeroCriteria },
  };
};

export const preflightMissingSchoolClassRule: Rule<
  PreFlightContext,
  PreFlightMissingFieldsMeta
> = (ctx) => {
  const activeEnrolled = getActiveEnrolledParticipants(ctx.event, ctx.orgParticipants);
  if (activeEnrolled.length === 0) return null;

  const items: PreFlightMissingFieldParticipantItem[] = [];
  let missingSchoolCount = 0;
  let missingClassCount = 0;

  for (const participant of activeEnrolled) {
    const missingSchool = !String(participant.school ?? '').trim();
    const missingClass = !String(participant.class_or_age ?? '').trim();
    if (missingSchool) missingSchoolCount++;
    if (missingClass) missingClassCount++;
    if (missingSchool || missingClass) {
      items.push({
        participant,
        id: participant.id,
        name: participant.name,
        missingSchool,
        missingClass,
      });
    }
  }

  if (items.length === 0) return null;

  return {
    id: 'preflight_missing_school_class',
    level: 'warn',
    title:
      items.length === 1
        ? '1 participant missing school or class'
        : `${items.length} participants missing school or class`,
    message: `${missingSchoolCount} missing school · ${missingClassCount} missing class.`,
    meta: {
      items,
      missingSchoolCount,
      missingClassCount,
    },
  };
};

export const preflightJudgeUnassignedRule: Rule<
  PreFlightContext,
  PreFlightUnassignedJudgesMeta
> = (ctx) => {
  const activeJudges = ctx.orgJudges.filter((j) => j.is_active !== false);
  if (activeJudges.length === 0) return null;

  const activeOrUpcomingEventIds = new Set<string>();
  const assignedJudgeIds = new Set<string>();

  for (const evt of ctx.orgEvents) {
    const status = String(evt.status || '').toLowerCase();
    if (status === 'ended' || status === 'archived') continue;
    activeOrUpcomingEventIds.add(evt.id);
    for (const jId of evt.assigned_judges || []) {
      assignedJudgeIds.add(jId);
    }
  }

  // Ensure the target event itself is counted even if not yet present in orgEvents
  activeOrUpcomingEventIds.add(ctx.event.id);
  for (const jId of ctx.event.assigned_judges || []) {
    assignedJudgeIds.add(jId);
  }

  const unassigned: PreFlightUnassignedJudgeItem[] = [];
  for (const judge of activeJudges) {
    const hasAssignmentViaEvent = assignedJudgeIds.has(judge.id);
    const hasAssignmentViaJudge = (judge.assigned_events || []).some((evtId) =>
      activeOrUpcomingEventIds.has(evtId)
    );
    if (!hasAssignmentViaEvent && !hasAssignmentViaJudge) {
      unassigned.push({
        id: judge.id,
        name: judge.name,
        judgeCode: judge.judge_id,
      });
    }
  }

  if (unassigned.length === 0) return null;

  return {
    id: 'preflight_judge_unassigned',
    level: 'warn',
    title:
      unassigned.length === 1
        ? '1 judge has no event assignment'
        : `${unassigned.length} judges have no event assignment`,
    message:
      unassigned.length === 1
        ? `${unassigned[0].name} is not assigned to any open event.`
        : `${unassigned.length} active judges are not assigned to any open event.`,
    meta: { judges: unassigned },
  };
};

// ==========================================
// END-OF-EVENT CHECK (WARN ONLY — NEVER BLOCK)
// ==========================================

export function evaluateEndEvent(ctx: EndEventCheckContext): EndEventCheckEvaluation {
  const assignedJudges = getActiveAssignedJudges(ctx.event, ctx.orgJudges);
  const enrolledParticipants = getActiveEnrolledParticipants(ctx.event, ctx.orgParticipants);

  const assignedJudgeIdSet = new Set(assignedJudges.map((j) => j.id));
  const enrolledParticipantIdSet = new Set(enrolledParticipants.map((p) => p.id));

  const validEventScores = ctx.eventScores.filter(
    (s) =>
      s.event_id === ctx.event.id &&
      assignedJudgeIdSet.has(s.judge_id) &&
      enrolledParticipantIdSet.has(s.participant_id)
  );

  // Deduplicate ballots per participant and per judge using Sets so duplicate rows count once
  const scoredJudgesByParticipant = new Map<string, Set<string>>();
  const scoredParticipantsByJudge = new Map<string, Set<string>>();

  for (const score of validEventScores) {
    let pSet = scoredJudgesByParticipant.get(score.participant_id);
    if (!pSet) {
      pSet = new Set<string>();
      scoredJudgesByParticipant.set(score.participant_id, pSet);
    }
    pSet.add(score.judge_id);

    let jSet = scoredParticipantsByJudge.get(score.judge_id);
    if (!jSet) {
      jSet = new Set<string>();
      scoredParticipantsByJudge.set(score.judge_id, jSet);
    }
    jSet.add(score.participant_id);
  }

  const unscoredParticipants: EndParticipantBallotItem[] = [];
  const partialParticipants: EndParticipantBallotItem[] = [];
  let completedBallots = 0;

  for (const participant of enrolledParticipants) {
    const scoredJudgeIds = scoredJudgesByParticipant.get(participant.id) ?? new Set<string>();
    const missingJudges = assignedJudges
      .filter((j) => !scoredJudgeIds.has(j.id))
      .map((j) => ({
        id: j.id,
        name: j.name,
        judgeCode: j.judge_id,
      }));

    completedBallots += scoredJudgeIds.size;

    const item: EndParticipantBallotItem = {
      participant,
      id: participant.id,
      name: participant.name,
      identityId: participant.identity_id,
      slNo: participant.sl_no,
      scoredCount: scoredJudgeIds.size,
      requiredCount: assignedJudges.length,
      missingJudges,
    };

    if (scoredJudgeIds.size === 0) {
      unscoredParticipants.push(item);
    } else if (missingJudges.length > 0) {
      partialParticipants.push(item);
    }
  }

  const perJudgeProgress: EndJudgeProgressItem[] = assignedJudges.map((judge) => ({
    judgeId: judge.id,
    judgeName: judge.name,
    judgeCode: judge.judge_id,
    scoredCount: scoredParticipantsByJudge.get(judge.id)?.size ?? 0,
    totalParticipants: enrolledParticipants.length,
  }));

  const results: RuleResult[] = [];

  if (unscoredParticipants.length > 0) {
    const meta: EndParticipantsWarningMeta = { participants: unscoredParticipants };
    results.push({
      id: 'end_unscored_participants',
      level: 'warn',
      title:
        unscoredParticipants.length === 1
          ? '1 unscored participant'
          : `${unscoredParticipants.length} unscored participants`,
      message:
        unscoredParticipants.length === 1
          ? '1 enrolled participant has no judge scores recorded.'
          : `${unscoredParticipants.length} enrolled participants have no judge scores recorded.`,
      meta: meta as unknown as Record<string, unknown>,
    });
  }

  if (partialParticipants.length > 0) {
    const meta: EndParticipantsWarningMeta = { participants: partialParticipants };
    results.push({
      id: 'end_partial_participants',
      level: 'warn',
      title:
        partialParticipants.length === 1
          ? '1 partially scored participant'
          : `${partialParticipants.length} partially scored participants`,
      message:
        partialParticipants.length === 1
          ? '1 participant is missing ballots from some assigned judges.'
          : `${partialParticipants.length} participants are missing ballots from some assigned judges.`,
      meta: meta as unknown as Record<string, unknown>,
    });
  }

  const totalBallots = enrolledParticipants.length * assignedJudges.length;

  return {
    ...buildEvaluation(results),
    completedBallots,
    totalBallots,
    totalParticipants: enrolledParticipants.length,
    totalJudges: assignedJudges.length,
    perJudgeProgress,
    unscoredParticipants,
    partialParticipants,
  };
}

// ==========================================
// EVENT PROGRESS VIEW (PHASE 4 / 17.3.0)
// ==========================================

function parseScoreTimestamp(score: { created_at?: string; score_payload?: { submitted_at?: string } }): number {
  const raw = score.created_at || score.score_payload?.submitted_at || '';
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

export function computeEventProgress(ctx: EventProgressContext): EventProgressSummary {
  const activeAssignedJudges = getActiveAssignedJudges(ctx.event, ctx.orgJudges);
  const activeEnrolledParticipants = getActiveEnrolledParticipants(ctx.event, ctx.orgParticipants);

  const statusLower = String(ctx.event.status || '').toLowerCase();
  const isEnded = statusLower === 'ended' || statusLower === 'archived';

  const assignedJudges: EventProgressJudgeInfo[] = activeAssignedJudges.map((judge, idx) => ({
    judgeId: judge.id,
    code: judge.judge_id?.trim() || `J${idx + 1}`,
    name: judge.name,
  }));

  const assignedJudgeIdSet = new Set(assignedJudges.map((j) => j.judgeId));
  const enrolledParticipantIdSet = new Set(activeEnrolledParticipants.map((p) => p.id));

  // Deduplicate scores per (participant_id, judge_id): latest created_at wins
  const latestScoreByParticipantJudge = new Map<
    string,
    { score: (typeof ctx.eventScores)[number]; ts: number; idx: number }
  >();

  for (let idx = 0; idx < ctx.eventScores.length; idx++) {
    const score = ctx.eventScores[idx];
    if (score.event_id !== ctx.event.id) continue;
    if (!assignedJudgeIdSet.has(score.judge_id)) continue;
    if (!enrolledParticipantIdSet.has(score.participant_id)) continue;

    const key = `${score.participant_id}::${score.judge_id}`;
    const ts = parseScoreTimestamp(score);
    const existing = latestScoreByParticipantJudge.get(key);
    if (!existing || ts > existing.ts || (ts === existing.ts && idx >= existing.idx)) {
      latestScoreByParticipantJudge.set(key, { score, ts, idx });
    }
  }

  let scored = 0;
  let partial = 0;
  let upcoming = 0;
  let absent = 0;
  let completedBallots = 0;

  const slMap = ctx.event.participant_sl_numbers || {};
  const requiredCount = assignedJudges.length;

  const rows: EventProgressRow[] = activeEnrolledParticipants.map((participant, idx) => {
    let rawSum = 0;
    let scoredCount = 0;

    const judgeStates: EventProgressJudgeChip[] = assignedJudges.map((judge) => {
      const entry = latestScoreByParticipantJudge.get(`${participant.id}::${judge.judgeId}`);
      if (entry) {
        scoredCount++;
        rawSum += Number(entry.score.total_score) || 0;
        return {
          judgeId: judge.judgeId,
          code: judge.code,
          name: judge.name,
          scored: true,
        };
      }
      return {
        judgeId: judge.judgeId,
        code: judge.code,
        name: judge.name,
        scored: false,
      };
    });

    completedBallots += scoredCount;

    let status: EventProgressStatus;
    if (requiredCount > 0 && scoredCount === requiredCount) {
      status = 'scored';
      scored++;
    } else if (scoredCount > 0) {
      status = 'partial';
      partial++;
    } else if (isEnded) {
      status = 'absent';
      absent++;
    } else {
      status = 'upcoming';
      upcoming++;
    }

    const orderNumber =
      String(slMap[participant.id] ?? '').trim() ||
      String(participant.sl_no ?? '').trim() ||
      String(idx + 1).padStart(2, '0');

    return {
      participant,
      id: participant.id,
      orderNumber,
      status,
      totalScore: Number(rawSum.toFixed(2)),
      scoredCount,
      requiredCount,
      judgeStates,
    };
  });

  return {
    isEnded,
    assignedJudges,
    rows,
    counts: {
      total: activeEnrolledParticipants.length,
      scored,
      partial,
      upcoming,
      absent,
      completedBallots,
      totalBallots: activeEnrolledParticipants.length * requiredCount,
    },
  };
}
