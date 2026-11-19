import type {
  CategoryMismatchMeta,
  DuplicateMatchItem,
  DuplicateParticipantMeta,
  EnrollmentBatchContext,
  ImportBatchContext,
  ImportBatchEvaluation,
  ImportRowWarningItem,
  ParticipantRowContext,
  ParticipantSaveContext,
  Rule,
  RuleEvaluation,
  RuleResult,
} from './types';
import {
  BLANK_SCHOOL_NAME_THRESHOLD,
  NAME_SIMILARITY_THRESHOLD,
  SCHOOL_SIMILARITY_THRESHOLD,
  boundedLevenshtein,
  charMask32,
  isUncategorizedEventCategory,
  matchNormalizedNameAndSchool,
  maxAllowedEditDistance,
  normalizeCategory,
  normalizeText,
  popcount32,
} from './fuzzy';

/**
 * Indexed entry used for fast exact + bucketed fuzzy duplicate lookup.
 * Target: 1,000 imported rows checked in < 20ms.
 */
interface IndexedParticipant {
  id?: string;
  identityId?: string;
  name: string;
  school: string;
  classOrAge?: string;
  normName: string;
  normSchool: string;
  nameMask?: number;
  scope: 'event' | 'org' | 'import_file';
  rowNumber?: number;
}

function areSchoolsCompatible(a: string, b: string): boolean {
  if (!a || !b || a === b) return true;
  const maxLen = a.length >= b.length ? a.length : b.length;
  const minLen = a.length <= b.length ? a.length : b.length;
  const maxDist = Math.floor((1 - SCHOOL_SIMILARITY_THRESHOLD + 1e-9) * maxLen);
  if (maxLen - minLen > maxDist) return false;
  return boundedLevenshtein(a, b, maxDist) <= maxDist;
}

class DuplicateIndex {
  private exactMap = new Map<string, IndexedParticipant>();
  private bySchoolAndLen = new Map<string, Map<number, IndexedParticipant[]>>();
  private byNameLen = new Map<number, IndexedParticipant[]>();
  private compatibleSchoolsCache = new Map<string, string[]>();

  add(entry: IndexedParticipant): void {
    if (!entry.normName) return;
    const mask = entry.nameMask ?? charMask32(entry.normName);
    entry.nameMask = mask;

    const exactKey = `${entry.normName}|${entry.normSchool}`;
    if (!this.exactMap.has(exactKey)) {
      this.exactMap.set(exactKey, entry);
    }

    const len = entry.normName.length;

    let schoolLenMap = this.bySchoolAndLen.get(entry.normSchool);
    if (!schoolLenMap) {
      schoolLenMap = new Map<number, IndexedParticipant[]>();
      this.bySchoolAndLen.set(entry.normSchool, schoolLenMap);
      // Incrementally update cached compatible school lists instead of wiping the whole cache
      for (const [cachedSchool, list] of this.compatibleSchoolsCache.entries()) {
        if (areSchoolsCompatible(cachedSchool, entry.normSchool)) {
          list.push(entry.normSchool);
        }
      }
    }
    const sBucket = schoolLenMap.get(len);
    if (sBucket) {
      sBucket.push(entry);
    } else {
      schoolLenMap.set(len, [entry]);
    }

    const lenList = this.byNameLen.get(len);
    if (lenList) {
      lenList.push(entry);
    } else {
      this.byNameLen.set(len, [entry]);
    }
  }

  private getCompatibleSchoolKeys(normSchool: string): string[] {
    const cached = this.compatibleSchoolsCache.get(normSchool);
    if (cached) return cached;

    const result: string[] = [];
    if (!normSchool) {
      for (const key of this.bySchoolAndLen.keys()) {
        result.push(key);
      }
    } else {
      for (const key of this.bySchoolAndLen.keys()) {
        if (areSchoolsCompatible(normSchool, key)) {
          result.push(key);
        }
      }
    }

    this.compatibleSchoolsCache.set(normSchool, result);
    return result;
  }

  findMatches(
    candidateName: string,
    candidateSchool: string,
    excludeId?: string,
    maxResults: number = 3,
    preNormName?: string,
    preNormSchool?: string,
    preNameMask?: number
  ): DuplicateMatchItem[] {
    const normName = preNormName ?? normalizeText(candidateName);
    const normSchool = preNormSchool ?? normalizeText(candidateSchool);
    if (!normName) return [];

    const matches: DuplicateMatchItem[] = [];
    const seenIds = maxResults > 1 ? new Set<string>() : null;

    // 1. O(1) exact pre-indexed lookup
    const exactKey = `${normName}|${normSchool}`;
    const exactHit = this.exactMap.get(exactKey);
    if (exactHit && (!excludeId || exactHit.id !== excludeId)) {
      if (seenIds) {
        const dedupeKey =
          exactHit.id || `${exactHit.scope}:${exactHit.rowNumber ?? exactHit.normName}`;
        seenIds.add(dedupeKey);
      }
      matches.push({
        candidateName,
        candidateSchool,
        existingId: exactHit.id,
        existingIdentityId: exactHit.identityId,
        existingName: exactHit.name,
        existingSchool: exactHit.school,
        existingClassOrAge: exactHit.classOrAge,
        similarity: 1.0,
        matchType: 'exact',
        scope: exactHit.scope,
        rowNumber: exactHit.rowNumber,
      });
      if (matches.length >= maxResults) return matches;
    }

    // 2. Bucketed fuzzy scan: school+length buckets when schools are grouped, or length buckets when school is blank / highly fragmented
    const threshold = normSchool ? NAME_SIMILARITY_THRESHOLD : BLANK_SCHOOL_NAME_THRESHOLD;
    // Upper bound on length delta: maxLen * (1 - threshold) => when entry is longer than candidate,
    // entryLen <= floor(normName.length / threshold)
    const maxDownDist = maxAllowedEditDistance(normName.length, threshold);
    const maxUpLen =
      normName.length <= 5
        ? normName.length + 1
        : Math.floor(normName.length / threshold + 1e-9);
    const minLen = Math.max(1, normName.length - maxDownDist);
    const maxLen = maxUpLen;
    const maxPossibleDist = maxAllowedEditDistance(maxLen, threshold);
    const maxBitDiff = maxPossibleDist << 1;
    const candidateMask = preNameMask ?? charMask32(normName);

    const inspectBucket = (bucket: IndexedParticipant[] | undefined): boolean => {
      if (!bucket) return false;
      for (let i = 0; i < bucket.length; i++) {
        const entry = bucket[i];
        if (excludeId && entry.id === excludeId) continue;

        // O(1) exact bitmask rejection before full match check
        if (
          entry.nameMask !== undefined &&
          popcount32(candidateMask ^ entry.nameMask) > maxBitDiff
        ) {
          continue;
        }

        let dedupeKey = '';
        if (seenIds) {
          dedupeKey = entry.id || `${entry.scope}:${entry.rowNumber ?? entry.normName}`;
          if (seenIds.has(dedupeKey)) continue;
        }

        const hit = matchNormalizedNameAndSchool(
          normName,
          normSchool,
          entry.normName,
          entry.normSchool,
          candidateMask,
          entry.nameMask
        );
        if (hit) {
          if (seenIds) seenIds.add(dedupeKey);
          matches.push({
            candidateName,
            candidateSchool,
            existingId: entry.id,
            existingIdentityId: entry.identityId,
            existingName: entry.name,
            existingSchool: entry.school,
            existingClassOrAge: entry.classOrAge,
            similarity: hit.similarity,
            matchType: hit.matchType,
            scope: entry.scope,
            rowNumber: entry.rowNumber,
          });
          if (matches.length >= maxResults) return true;
        }
      }
      return false;
    };

    if (normSchool && this.bySchoolAndLen.size <= 150) {
      const schoolKeys = this.getCompatibleSchoolKeys(normSchool);
      for (let i = 0; i < schoolKeys.length; i++) {
        const lenMap = this.bySchoolAndLen.get(schoolKeys[i]);
        if (!lenMap) continue;
        for (let len = minLen; len <= maxLen; len++) {
          if (inspectBucket(lenMap.get(len))) return matches;
        }
      }
    } else {
      for (let len = minLen; len <= maxLen; len++) {
        if (inspectBucket(this.byNameLen.get(len))) return matches;
      }
    }

    return matches;
  }
}

export function buildEvaluation(results: RuleResult[]): RuleEvaluation {
  const blocks: RuleResult[] = [];
  const warnings: RuleResult[] = [];
  const infos: RuleResult[] = [];

  for (const res of results) {
    if (res.level === 'block') blocks.push(res);
    else if (res.level === 'warn') warnings.push(res);
    else infos.push(res);
  }

  return {
    results: [...blocks, ...warnings, ...infos],
    blocks,
    warnings,
    infos,
    hasBlocks: blocks.length > 0,
    hasWarnings: warnings.length > 0,
  };
}

export function isCategoryMatch(
  eventCategory: string | undefined,
  participantClass: string | undefined
): boolean {
  if (isUncategorizedEventCategory(eventCategory)) return true;
  const normPart = normalizeCategory(participantClass);
  if (!normPart) return false;
  return normPart === normalizeCategory(eventCategory);
}

/**
 * Rule 1 (Warn): Category mismatch on enrolment.
 * - Uncategorized ("", "General") events never mismatch.
 * - Blank participant class NEVER produces a mismatch (handled as Info only).
 */
export const categoryMismatchRule: Rule<EnrollmentBatchContext, CategoryMismatchMeta> = (ctx) => {
  if (ctx.ignoreCategoryWarnings) return null;
  if (isUncategorizedEventCategory(ctx.event.category)) return null;

  const normEventCat = normalizeCategory(ctx.event.category);
  const mismatchedParticipants: CategoryMismatchMeta['mismatchedParticipants'] = [];

  for (const p of ctx.selectedParticipants) {
    const normPartCat = normalizeCategory(p.class_or_age);
    if (!normPartCat) continue; // Blank class is an Info note, never a mismatch
    if (normPartCat !== normEventCat) {
      mismatchedParticipants.push({
        id: p.id,
        name: p.name,
        class_or_age: (p.class_or_age || '').trim(),
      });
    }
  }

  if (mismatchedParticipants.length === 0) return null;

  const eventCategory = (ctx.event.category || '').trim();
  return {
    id: 'category_mismatch',
    level: 'warn',
    title:
      mismatchedParticipants.length === 1
        ? 'Category Mismatch'
        : `${mismatchedParticipants.length} Category Mismatches`,
    message:
      mismatchedParticipants.length === 1
        ? `${mismatchedParticipants[0].name} (${mismatchedParticipants[0].class_or_age}) does not match event category "${eventCategory}".`
        : `${mismatchedParticipants.length} selected participants do not match event category "${eventCategory}".`,
    meta: {
      eventId: ctx.event.id,
      eventCategory,
      mismatchedParticipants,
    },
  };
};

/**
 * Info note when selected participants have blank class on a categorized event (never a mismatch).
 */
export const blankClassEnrollmentInfoRule: Rule<EnrollmentBatchContext> = (ctx) => {
  if (isUncategorizedEventCategory(ctx.event.category)) return null;
  const blankCount = ctx.selectedParticipants.filter((p) => !normalizeCategory(p.class_or_age)).length;
  if (blankCount === 0) return null;

  return {
    id: 'missing_class_row',
    level: 'info',
    title: 'Missing class',
    message:
      blankCount === 1
        ? '1 selected participant has no class set.'
        : `${blankCount} selected participants have no class set.`,
    meta: { blankCount },
  };
};

/**
 * Rule 2 (Warn): Duplicate participant check during event enrolment.
 * Compares selected participants against already-enrolled participants AND against each other.
 */
export const duplicateInEventRule: Rule<EnrollmentBatchContext, DuplicateParticipantMeta> = (ctx) => {
  const index = new DuplicateIndex();

  for (const p of ctx.alreadyEnrolledParticipants) {
    if (p.is_active === false) continue;
    index.add({
      id: p.id,
      identityId: p.identity_id,
      name: p.name,
      school: p.school || '',
      classOrAge: p.class_or_age,
      normName: normalizeText(p.name),
      normSchool: normalizeText(p.school),
      scope: 'event',
    });
  }

  const matches: DuplicateMatchItem[] = [];

  for (const selected of ctx.selectedParticipants) {
    const found = index.findMatches(selected.name, selected.school || '', selected.id, 1);
    if (found.length > 0) {
      matches.push(found[0]);
    }
    // Also index this selected participant so intra-batch duplicates are caught
    index.add({
      id: selected.id,
      identityId: selected.identity_id,
      name: selected.name,
      school: selected.school || '',
      classOrAge: selected.class_or_age,
      normName: normalizeText(selected.name),
      normSchool: normalizeText(selected.school),
      scope: 'event',
    });
  }

  if (matches.length === 0) return null;

  return {
    id: 'duplicate_participant_event',
    level: 'warn',
    title:
      matches.length === 1
        ? 'Possible Duplicate in Event'
        : `${matches.length} Possible Duplicates in Event`,
    message:
      matches.length === 1
        ? `${matches[0].candidateName} closely matches ${matches[0].existingName}.`
        : `${matches.length} selected participants closely match existing entries in this event.`,
    meta: { matches },
  };
};

/**
 * Rule 3 (Warn): Duplicate participant check on manual save (org-wide).
 * Excludes candidate.id so editing the same record never self-matches.
 */
export const duplicateInOrgRule: Rule<ParticipantSaveContext, DuplicateParticipantMeta> = (ctx) => {
  const index = new DuplicateIndex();

  for (const p of ctx.existingParticipants) {
    if (p.is_active === false) continue;
    if (ctx.candidate.id && p.id === ctx.candidate.id) continue;
    index.add({
      id: p.id,
      identityId: p.identity_id,
      name: p.name,
      school: p.school || '',
      classOrAge: p.class_or_age,
      normName: normalizeText(p.name),
      normSchool: normalizeText(p.school),
      scope: 'org',
    });
  }

  const matches = index.findMatches(
    ctx.candidate.name,
    ctx.candidate.school || '',
    ctx.candidate.id,
    3
  );

  if (matches.length === 0) return null;

  return {
    id: 'duplicate_participant_org',
    level: 'warn',
    title: 'Possible Duplicate Participant',
    message: `"${ctx.candidate.name}" closely matches existing participant "${matches[0].existingName}".`,
    meta: { matches },
  };
};

/**
 * Rule 4 (Info): Missing class badge on participant row.
 */
export const missingClassRowRule: Rule<ParticipantRowContext> = (ctx) => {
  if (normalizeCategory(ctx.participant.class_or_age)) return null;
  return {
    id: 'missing_class_row',
    level: 'info',
    title: 'No class',
    message: `Missing ${ctx.categoryLabel || 'Class'}`,
  };
};

/**
 * Batch evaluator for Excel import: missing school, missing class, and org + intra-file duplicates.
 */
export function evaluateImportBatch(ctx: ImportBatchContext): ImportBatchEvaluation {
  const index = new DuplicateIndex();

  for (const p of ctx.existingParticipants) {
    if (p.is_active === false) continue;
    index.add({
      id: p.id,
      identityId: p.identity_id,
      name: p.name,
      school: p.school || '',
      classOrAge: p.class_or_age,
      normName: normalizeText(p.name),
      normSchool: normalizeText(p.school),
      scope: 'org',
    });
  }

  const rowWarnings: ImportRowWarningItem[] = [];
  let missingSchoolCount = 0;
  let missingClassCount = 0;
  let duplicateCount = 0;
  const classLabel = ctx.categoryLabel || 'Class';

  for (let i = 0; i < ctx.rows.length; i++) {
    const row = ctx.rows[i];
    const displayName = row.name.trim() || '(Unnamed row)';
    const cleanSchool = row.school.trim();
    const cleanClass = row.class_or_age.trim();

    if (!cleanSchool) {
      missingSchoolCount++;
      rowWarnings.push({
        rowNumber: row.rowNumber,
        name: displayName,
        field: 'school',
        fieldLabel: 'School',
        level: 'warn',
        detail: 'Missing school — will be left blank.',
      });
    }

    if (!cleanClass) {
      missingClassCount++;
      rowWarnings.push({
        rowNumber: row.rowNumber,
        name: displayName,
        field: 'class_or_age',
        fieldLabel: classLabel,
        level: 'warn',
        detail: `Missing ${classLabel.toLowerCase()}.`,
      });
    }

    const cleanName = row.name.trim();
    if (cleanName) {
      const normName = normalizeText(cleanName);
      const normSchool = normalizeText(cleanSchool);
      const nameMask = charMask32(normName);

      const dupMatches = index.findMatches(
        cleanName,
        cleanSchool,
        undefined,
        1,
        normName,
        normSchool,
        nameMask
      );
      if (dupMatches.length > 0) {
        const hit = dupMatches[0];
        duplicateCount++;
        const sourceDetail =
          hit.scope === 'import_file' && hit.rowNumber
            ? `Matches Row ${hit.rowNumber} ("${hit.existingName}"${hit.existingSchool ? ` · ${hit.existingSchool}` : ''})`
            : `Matches existing "${hit.existingName}"${hit.existingIdentityId ? ` (${hit.existingIdentityId})` : ''}${hit.existingSchool ? ` · ${hit.existingSchool}` : ''}`;

        rowWarnings.push({
          rowNumber: row.rowNumber,
          name: displayName,
          field: 'duplicate',
          fieldLabel: hit.matchType === 'exact' ? 'Duplicate' : 'Possible duplicate',
          level: 'warn',
          detail: sourceDetail,
          duplicateMatch: hit,
        });
      }

      // Add row into index to detect intra-file duplicates in subsequent rows
      index.add({
        name: cleanName,
        school: cleanSchool,
        classOrAge: cleanClass,
        normName,
        normSchool,
        nameMask,
        scope: 'import_file',
        rowNumber: row.rowNumber,
      });
    }
  }

  const summaryResults: RuleResult[] = [];
  if (missingSchoolCount > 0) {
    summaryResults.push({
      id: 'missing_school_import',
      level: 'warn',
      title: 'Missing school',
      message: `${missingSchoolCount} ${missingSchoolCount === 1 ? 'row has' : 'rows have'} no school.`,
      meta: { count: missingSchoolCount },
    });
  }
  if (missingClassCount > 0) {
    summaryResults.push({
      id: 'missing_class_import',
      level: 'warn',
      title: `Missing ${classLabel.toLowerCase()}`,
      message: `${missingClassCount} ${missingClassCount === 1 ? 'row has' : 'rows have'} no ${classLabel.toLowerCase()}.`,
      meta: { count: missingClassCount },
    });
  }
  if (duplicateCount > 0) {
    summaryResults.push({
      id: 'duplicate_participant_import',
      level: 'warn',
      title: 'Possible duplicates',
      message: `${duplicateCount} ${duplicateCount === 1 ? 'row matches' : 'rows match'} an existing or earlier participant.`,
      meta: { count: duplicateCount },
    });
  }

  return {
    ...buildEvaluation(summaryResults),
    rowWarnings,
    missingSchoolCount,
    missingClassCount,
    duplicateCount,
  };
}
