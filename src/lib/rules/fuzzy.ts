/**
 * Pure string normalization & Levenshtein fuzzy matching utilities for the rules engine.
 * Zero DOM, zero Supabase, zero SQL dependencies.
 */

export const NAME_SIMILARITY_THRESHOLD = 0.82;
export const SHORT_NAME_MAX_LENGTH = 5;
export const SHORT_NAME_MAX_DISTANCE = 1;
export const SCHOOL_SIMILARITY_THRESHOLD = 0.85;
export const BLANK_SCHOOL_NAME_THRESHOLD = 0.90;

function needsNfkc(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) > 127) return true;
  }
  return false;
}

export function normalizeCategory(raw?: string | null): string {
  const s = String(raw ?? '');
  return (needsNfkc(s) ? s.normalize('NFKC') : s)
    .trim()
    .toLowerCase()
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ');
}

export function isUncategorizedEventCategory(raw?: string | null): boolean {
  const norm = normalizeCategory(raw);
  return norm === '' || norm === 'general';
}

export function normalizeText(raw?: string | null): string {
  const s = String(raw ?? '');
  return (needsNfkc(s) ? s.normalize('NFKC') : s)
    .trim()
    .toLowerCase()
    .replace(/[.,/_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

let scratchPrev = new Int32Array(128);
let scratchCurr = new Int32Array(128);

function ensureScratch(size: number): void {
  if (scratchPrev.length < size) {
    const nextSize = Math.max(size, scratchPrev.length * 2);
    scratchPrev = new Int32Array(nextSize);
    scratchCurr = new Int32Array(nextSize);
  }
}

/**
 * Computes a 32-bit character-presence bitmask for a normalized string.
 * Any k Levenshtein edits can toggle at most 2*k bits, so popcount(mA ^ mB) > 2*k
 * is a mathematically exact (zero false negatives) O(1) lower bound rejection.
 */
export function charMask32(normStr: string): number {
  let mask = 0;
  for (let i = 0; i < normStr.length; i++) {
    mask |= 1 << (normStr.charCodeAt(i) & 31);
  }
  return mask;
}

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Zero-allocation banded Levenshtein distance for already-normalized strings.
 * Returns the exact edit distance if <= maxDist, or maxDist + 1 if it exceeds maxDist.
 */
export function boundedLevenshtein(a: string, b: string, maxDist: number): number {
  if (a === b) return 0;
  const aLen = a.length;
  const bLen = b.length;
  if (Math.abs(aLen - bLen) > maxDist) return maxDist + 1;
  if (maxDist <= 0) return maxDist + 1;
  if (aLen === 0) return bLen <= maxDist ? bLen : maxDist + 1;
  if (bLen === 0) return aLen <= maxDist ? aLen : maxDist + 1;

  const short = aLen <= bLen ? a : b;
  const long = aLen <= bLen ? b : a;
  const sLen = short.length;
  const lLen = long.length;

  ensureScratch(sLen + 1);
  let prev = scratchPrev;
  let curr = scratchCurr;
  const inf = maxDist + 1;

  const initEnd = Math.min(sLen, maxDist);
  for (let j = 0; j <= initEnd; j++) prev[j] = j;
  for (let j = initEnd + 1; j <= sLen; j++) prev[j] = inf;

  for (let i = 1; i <= lLen; i++) {
    const jStart = i - maxDist > 1 ? i - maxDist : 1;
    const jEnd = i + maxDist < sLen ? i + maxDist : sLen;

    curr[0] = i <= maxDist ? i : inf;
    if (jStart > 1) curr[jStart - 1] = inf;

    let rowMin = curr[0];
    const longCode = long.charCodeAt(i - 1);

    for (let j = jStart; j <= jEnd; j++) {
      const cost = longCode === short.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      const val = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }

    if (jEnd < sLen) curr[jEnd + 1] = inf;
    if (rowMin > maxDist) return inf;

    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[sLen] <= maxDist ? prev[sLen] : inf;
}

/**
 * Space-efficient two-row Levenshtein edit distance (O(min(m, n)) memory).
 */
export function levenshteinDistance(s1: string, s2: string): number {
  const a = s1.toLowerCase().trim();
  const b = s2.toLowerCase().trim();
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Keep shorter string as the inner row for lower allocation
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  const sLen = short.length;
  const lLen = long.length;

  ensureScratch(sLen + 1);
  let prev = scratchPrev;
  let curr = scratchCurr;
  for (let j = 0; j <= sLen; j++) prev[j] = j;

  for (let i = 1; i <= lLen; i++) {
    curr[0] = i;
    const longCode = long.charCodeAt(i - 1);
    for (let j = 1; j <= sLen; j++) {
      const cost = longCode === short.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }

  return prev[sLen];
}

export function calculateSimilarity(s1: string, s2: string): number {
  const a = s1.toLowerCase().trim();
  const b = s2.toLowerCase().trim();
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshteinDistance(a, b);
  return 1.0 - dist / maxLen;
}

export function maxAllowedEditDistance(len: number, threshold: number): number {
  if (len <= SHORT_NAME_MAX_LENGTH) return SHORT_NAME_MAX_DISTANCE;
  return Math.floor((1 - threshold + 1e-9) * len);
}

export interface NameSchoolMatch {
  similarity: number;
  matchType: 'exact' | 'fuzzy';
}

/**
 * Evaluates whether two normalized (name, school) pairs match under the 17.1.0 spec:
 * - Name similarity >= 0.82 (or >= 0.90 when either school is blank)
 * - Short names (<= 5 chars): edit distance must be <= 1
 * - School: exact match or similarity >= 0.85 (when both schools are present)
 */
export function matchNormalizedNameAndSchool(
  normNameA: string,
  normSchoolA: string,
  normNameB: string,
  normSchoolB: string,
  maskNameA?: number,
  maskNameB?: number
): NameSchoolMatch | null {
  if (!normNameA || !normNameB) return null;

  if (normNameA === normNameB && normSchoolA === normSchoolB) {
    return { similarity: 1.0, matchType: 'exact' };
  }

  const eitherSchoolBlank = !normSchoolA || !normSchoolB;
  const nameThreshold = eitherSchoolBlank
    ? BLANK_SCHOOL_NAME_THRESHOLD
    : NAME_SIMILARITY_THRESHOLD;

  const maxLen = normNameA.length >= normNameB.length ? normNameA.length : normNameB.length;
  const minLen = normNameA.length <= normNameB.length ? normNameA.length : normNameB.length;

  let allowedDist = Math.floor((1 - nameThreshold + 1e-9) * maxLen);
  if (minLen <= SHORT_NAME_MAX_LENGTH && allowedDist > SHORT_NAME_MAX_DISTANCE) {
    allowedDist = SHORT_NAME_MAX_DISTANCE;
  }

  // Fast O(1) length-difference rejection before DP
  if (maxLen - minLen > allowedDist) return null;

  // Fast O(1) exact bitmask lower-bound rejection before DP
  if (maskNameA !== undefined && maskNameB !== undefined) {
    if (popcount32(maskNameA ^ maskNameB) > (allowedDist << 1)) return null;
  }

  const nameDist = boundedLevenshtein(normNameA, normNameB, allowedDist);
  if (nameDist > allowedDist) return null;

  const nameSim = maxLen === 0 ? 1.0 : 1.0 - nameDist / maxLen;
  if (nameSim < nameThreshold) return null;

  if (!eitherSchoolBlank && normSchoolA !== normSchoolB) {
    const sMax =
      normSchoolA.length >= normSchoolB.length ? normSchoolA.length : normSchoolB.length;
    const sMin =
      normSchoolA.length <= normSchoolB.length ? normSchoolA.length : normSchoolB.length;
    const maxSchoolDist = Math.floor((1 - SCHOOL_SIMILARITY_THRESHOLD + 1e-9) * sMax);
    if (sMax - sMin > maxSchoolDist) return null;

    const schoolDist = boundedLevenshtein(normSchoolA, normSchoolB, maxSchoolDist);
    if (schoolDist > maxSchoolDist) return null;
    const schoolSim = sMax === 0 ? 1.0 : 1.0 - schoolDist / sMax;
    if (schoolSim < SCHOOL_SIMILARITY_THRESHOLD) return null;
  }

  return {
    similarity: nameSim,
    matchType: normNameA === normNameB && normSchoolA === normSchoolB ? 'exact' : 'fuzzy',
  };
}
