import type {
  EndEventCheckContext,
  EndEventCheckEvaluation,
  EnrollmentBatchContext,
  EvaluateEndEventRules,
  EvaluateEnrollmentRules,
  EvaluateImportBatchRules,
  EvaluateParticipantRowRules,
  EvaluateParticipantSaveRules,
  EvaluatePreFlightRules,
  ImportBatchContext,
  ImportBatchEvaluation,
  ParticipantRowContext,
  ParticipantSaveContext,
  PreFlightContext,
  Rule,
  RuleEvaluation,
  RuleResult,
} from './types';
import {
  blankClassEnrollmentInfoRule,
  buildEvaluation,
  categoryMismatchRule,
  duplicateInEventRule,
  duplicateInOrgRule,
  evaluateImportBatch,
  isCategoryMatch,
  missingClassRowRule,
} from './participantRules';
import {
  computeEventProgress,
  evaluateEndEvent,
  getActiveAssignedJudges,
  getActiveEnrolledParticipants,
  preflightJudgeUnassignedRule,
  preflightMissingSchoolClassRule,
  preflightNoJudgesRule,
  preflightNoParticipantsRule,
  preflightRubricInvalidRule,
  preflightZeroCriteriaMarksRule,
} from './eventRules';

export function runRules<TContext>(
  context: TContext,
  rules: Array<Rule<TContext, any>>
): RuleEvaluation {
  const results: RuleResult[] = [];
  for (const rule of rules) {
    const res = rule(context);
    if (res) results.push(res);
  }
  return buildEvaluation(results);
}

export const evaluateEnrollmentRules: EvaluateEnrollmentRules = (
  ctx: EnrollmentBatchContext
): RuleEvaluation => {
  return runRules(ctx, [
    categoryMismatchRule,
    duplicateInEventRule,
    blankClassEnrollmentInfoRule,
  ]);
};

export const evaluateParticipantSaveRules: EvaluateParticipantSaveRules = (
  ctx: ParticipantSaveContext
): RuleEvaluation => {
  return runRules(ctx, [duplicateInOrgRule]);
};

export const evaluateImportBatchRules: EvaluateImportBatchRules = (
  ctx: ImportBatchContext
): ImportBatchEvaluation => {
  return evaluateImportBatch(ctx);
};

export const evaluateParticipantRowRules: EvaluateParticipantRowRules = (
  ctx: ParticipantRowContext
): RuleResult[] => {
  return runRules(ctx, [missingClassRowRule]).results;
};

export const evaluatePreFlightRules: EvaluatePreFlightRules = (
  ctx: PreFlightContext
): RuleEvaluation => {
  return runRules(ctx, [
    preflightRubricInvalidRule,
    preflightNoJudgesRule,
    preflightNoParticipantsRule,
    preflightZeroCriteriaMarksRule,
    preflightMissingSchoolClassRule,
    preflightJudgeUnassignedRule,
  ]);
};

export const evaluateEndEventRules: EvaluateEndEventRules = (
  ctx: EndEventCheckContext
): EndEventCheckEvaluation => {
  return evaluateEndEvent(ctx);
};

export * from './types';
export * from './fuzzy';
export {
  isCategoryMatch,
  categoryMismatchRule,
  blankClassEnrollmentInfoRule,
  duplicateInEventRule,
  duplicateInOrgRule,
  missingClassRowRule,
  getActiveAssignedJudges,
  getActiveEnrolledParticipants,
  preflightRubricInvalidRule,
  preflightNoJudgesRule,
  preflightNoParticipantsRule,
  preflightZeroCriteriaMarksRule,
  preflightMissingSchoolClassRule,
  preflightJudgeUnassignedRule,
  evaluateEndEvent,
  computeEventProgress,
};
