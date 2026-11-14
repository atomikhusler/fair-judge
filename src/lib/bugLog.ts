import { APP_VERSION } from '../config/version';
import { stampLocal, safeName, downloadJson } from './downloadUtils';
import { getStoredSession, isSupabaseConfigured, supabase } from './supabase';
import {
  runSelfTest,
  getLastTestResult,
  generateSelfTestReport,
  SelfTestRunResult,
  SelfTestReportJSON,
} from './selfTest';
import { blackBox, BlackBoxEntry } from './blackBox';
import { exportDiagnosticLog, getFailedMutations, getFailedScores } from './offlineQueue';

export interface BugLogSummary {
  verdict: string;
  counts: {
    ok: number;
    notice: number;
    problem: number;
    skipped: number;
  };
  topProblems: Array<{ code?: string; plain: string }>;
  errorCount: number;
  failedQueueCount: number;
}

export interface BugLogDevice {
  screen: string;
  userAgent: string;
  language: string;
  timezone: string;
  standalone: boolean;
  memory?: number;
}

export interface SanitizedFailedMutation {
  id: string;
  table: string;
  op: string;
  lastError: string;
  retryCount: number;
  createdAt: string;
}

export interface BugLogBundle {
  bundleVersion: string;
  downloadedAt: string;
  downloadedAtLocal: string;
  appVersion: string;
  role: 'organiser' | 'judge';
  orgCode: string;
  summary: BugLogSummary;
  report: SelfTestReportJSON;
  blackBox: BlackBoxEntry[];
  queue: Record<string, any>;
  failedMutations: SanitizedFailedMutation[];
  device: BugLogDevice;
  reportStale?: true;
  trimmedBlackBoxEntries?: number;
}

export function getBugLogFilename(orgCode: string): string {
  return `fairjudge-full-log_${safeName(orgCode)}_${stampLocal()}.json`;
}

/**
 * Builds the comprehensive unified bug log bundle.
 * Executes a fresh self-test run with a 20-second timeout.
 * If the fresh probe run times out or throws, falls back to the last memory report and flags `reportStale: true`.
 * Strictly redacts payloads, tokens, passwords, and raw score data.
 */
export async function buildFullBugLog(
  role: 'organiser' | 'judge' = 'organiser'
): Promise<{ bundle: BugLogBundle; filename: string }> {
  // 1. Resolve organization code safely (active session first, then localStorage)
  let orgCode = getStoredSession()?.org?.org_id?.trim() || 'terminal';
  if (orgCode === 'terminal' && typeof window !== 'undefined') {
    try {
      orgCode =
        localStorage.getItem('fairjudge_last_org_id') ||
        localStorage.getItem('fairjudge_org_code') ||
        'terminal';
    } catch {}
  }

  // 2. Fresh self-test run with 20s timeout
  let reportStale = false;
  let testResult: SelfTestRunResult | null = null;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    try {
      abortController.abort();
    } catch {}
  }, 20000);

  try {
    testResult = await runSelfTest(role, abortController.signal);
  } catch {
    reportStale = true;
    const fallbackMemory = getLastTestResult().result;
    if (fallbackMemory) {
      testResult = fallbackMemory;
    } else {
      testResult = {
        verdict: 'MINOR',
        completedAt: new Date().toISOString(),
        totalMs: 0,
        groups: [],
        noticeTotal: 0,
        problemTotal: 0,
      };
    }
  } finally {
    clearTimeout(timeoutId);
  }

  // Safety fallback if testResult is somehow still null
  const activeTestResult: SelfTestRunResult = testResult || {
    verdict: 'MINOR',
    completedAt: new Date().toISOString(),
    totalMs: 0,
    groups: [],
    noticeTotal: 0,
    problemTotal: 0,
  };

  // 3. Generate sanitized SelfTest report structure
  const reportOutput = await generateSelfTestReport(role, activeTestResult);
  const report = reportOutput.report;

  // 4. Gather black-box entries (pre-sanitized by flight recorder)
  const bbEntries = blackBox.getEntries();

  // 5. Gather diagnostic queue log (already redacted by exportDiagnosticLog)
  let queueLog: Record<string, any> = {};
  try {
    queueLog = await exportDiagnosticLog();
  } catch {
    queueLog = { error: 'Failed to export offline queue diagnostics' };
  }

  // 6. Gather failed mutations & failed score ballots (STRICTLY NO PAYLOADS)
  let failedMutations: SanitizedFailedMutation[] = [];
  try {
    const [rawFailed, rawFailedScores] = await Promise.all([
      getFailedMutations().catch(() => []),
      getFailedScores().catch(() => []),
    ]);
    failedMutations = [
      ...rawFailed.map((m) => ({
        id: m.id,
        table: m.table,
        op: m.operation,
        lastError: m.lastError || '',
        retryCount: m.retryCount || 0,
        createdAt: m.queuedAt,
      })),
      ...rawFailedScores.map((s) => ({
        id: s.id,
        table: 'scores',
        op: 'UPSERT',
        lastError: s.lastError || 'Server rejected ballot',
        retryCount: s.retryCount || 0,
        createdAt: s.queuedAt,
      })),
    ];
  } catch {
    failedMutations = [];
  }

  // 7. Extract top problems
  const topProblems: Array<{ code?: string; plain: string }> = [];
  for (const group of activeTestResult.groups) {
    for (const chk of group.checks) {
      if (chk.status === 'problem' || chk.status === 'notice') {
        topProblems.push({
          code: chk.code,
          plain: chk.plain,
        });
      }
    }
  }

  // 8. Device environment
  const isStandalone =
    typeof window !== 'undefined'
      ? window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as any).standalone === true
      : false;

  const device: BugLogDevice = {
    screen:
      typeof window !== 'undefined'
        ? `${window.screen.width}x${window.screen.height}`
        : 'unknown',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    language: typeof navigator !== 'undefined' ? navigator.language : 'en',
    timezone:
      typeof Intl !== 'undefined' && Intl.DateTimeFormat
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        : 'UTC',
    standalone: isStandalone,
    memory:
      typeof navigator !== 'undefined'
        ? (navigator as any).deviceMemory
        : undefined,
  };

  // 9. Summary block
  const summary: BugLogSummary = {
    verdict: activeTestResult.verdict,
    counts: report.counts,
    topProblems,
    errorCount: bbEntries.length,
    failedQueueCount: failedMutations.length,
  };

  const now = new Date();
  const bundle: BugLogBundle = {
    bundleVersion: '1.0.0',
    downloadedAt: now.toISOString(),
    downloadedAtLocal: stampLocal(now),
    appVersion: APP_VERSION,
    role,
    orgCode,
    summary,
    report,
    blackBox: bbEntries,
    queue: queueLog,
    failedMutations,
    device,
    ...(reportStale ? { reportStale: true } : {}),
  };

  const filename = getBugLogFilename(orgCode);
  return { bundle, filename };
}

/**
 * Convenience helper to build and immediately trigger the download of the full bug log bundle.
 * Returns the downloaded filename.
 */
export async function downloadFullBugLog(
  role: 'organiser' | 'judge' = 'organiser'
): Promise<string> {
  const { bundle, filename } = await buildFullBugLog(role);
  return downloadJson(filename, bundle);
}

const MAX_SUPPORT_REPORT_BYTES = 280_000;

function byteLength(obj: unknown): number {
  const str = JSON.stringify(obj);
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).length;
  }
  return str.length * 2;
}

/**
 * Ensures the sanitized bug log bundle fits safely under Supabase's 300 KB JSONB limit
 * by trimming the oldest flight-recorder entries first, then truncating queue arrays if needed.
 */
export function trimBugLogBundle(bundle: BugLogBundle, maxBytes: number = MAX_SUPPORT_REPORT_BYTES): BugLogBundle {
  const copy: BugLogBundle = {
    ...bundle,
    blackBox: [...bundle.blackBox],
    failedMutations: [...bundle.failedMutations],
  };

  if (byteLength(copy) <= maxBytes) return copy;

  // Determine chronological order (trim oldest entries while preserving most recent)
  let removed = 0;
  // Drop in batches so even large logs converge in a few steps
  while (copy.blackBox.length > 0 && byteLength(copy) > maxBytes) {
    const dropCount = Math.max(1, Math.ceil(copy.blackBox.length * 0.25));
    // blackBox entries are chronological (oldest first) -> drop from front
    copy.blackBox.splice(0, dropCount);
    removed += dropCount;
    copy.trimmedBlackBoxEntries = removed;
  }

  if (byteLength(copy) > maxBytes && copy.failedMutations.length > 20) {
    copy.failedMutations = copy.failedMutations.slice(-20);
  }

  if (byteLength(copy) > maxBytes) {
    copy.queue = {
      truncated: true,
      note: 'Queue details omitted to fit support upload limit.',
      failedQueueCount: copy.summary.failedQueueCount,
    };
  }

  return copy;
}

export function buildSupportClipboardText(params: {
  role: 'organiser' | 'judge';
  orgCode: string;
  summary: string;
  verdict?: string;
}): string {
  return [
    `Fair Judge v${APP_VERSION} (${params.role})`,
    `Org: ${params.orgCode || 'terminal'}`,
    params.verdict ? `Diagnostics: ${params.verdict}` : null,
    `Issue: ${params.summary.trim()}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export type SupportSubmitFailureReason =
  | 'offline'
  | 'not_configured'
  | 'rate_limited'
  | 'invalid_summary'
  | 'org_not_found'
  | 'rpc_error';

export interface SupportSubmitResult {
  ok: boolean;
  id?: string;
  createdAt?: string;
  reason?: SupportSubmitFailureReason;
  message?: string;
  bundle: BugLogBundle;
  filename: string;
  effectiveOrgId: string | null;
}

/**
 * Builds + trims the diagnostic bundle and submits a support report via public.support_submit().
 * Never throws: returns a structured result with the built bundle so offline/error callers can
 * smoothly fall back to manual Telegram attachment without rebuilding diagnostics.
 */
export async function submitSupportReport(params: {
  role: 'organiser' | 'judge';
  summary: string;
}): Promise<SupportSubmitResult> {
  const { bundle: rawBundle, filename } = await buildFullBugLog(params.role);
  const bundle = trimBugLogBundle(rawBundle);

  const sessionOrgId = getStoredSession()?.org?.org_id?.trim() || null;
  const fallbackOrgId =
    bundle.orgCode && bundle.orgCode !== 'terminal' && bundle.orgCode !== 'public'
      ? bundle.orgCode.trim()
      : null;
  const effectiveOrgId = sessionOrgId || fallbackOrgId;
  const rpcRole: 'organiser' | 'judge' | 'public' = effectiveOrgId ? params.role : 'public';

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return {
      ok: false,
      reason: 'offline',
      message: 'You appear to be offline.',
      bundle,
      filename,
      effectiveOrgId,
    };
  }

  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'Cloud support endpoint is not configured.',
      bundle,
      filename,
      effectiveOrgId,
    };
  }

  try {
    const { data, error } = await supabase.rpc('support_submit', {
      p_org_id: effectiveOrgId,
      p_role: rpcRole,
      p_app_version: APP_VERSION,
      p_summary: params.summary.trim().slice(0, 2000),
      p_report: bundle,
    });

    if (error) {
      return {
        ok: false,
        reason: 'rpc_error',
        message: error.message || 'Could not deliver report right now.',
        bundle,
        filename,
        effectiveOrgId,
      };
    }

    const res = data as any;
    if (!res?.ok) {
      const code = String(res?.error || '');
      const reason: SupportSubmitFailureReason =
        code === 'rate_limited'
          ? 'rate_limited'
          : code === 'invalid_summary'
          ? 'invalid_summary'
          : code === 'org_not_found'
          ? 'org_not_found'
          : 'rpc_error';
      return {
        ok: false,
        reason,
        message: res?.message || 'Could not submit report.',
        bundle,
        filename,
        effectiveOrgId,
      };
    }

    return {
      ok: true,
      id: res.id,
      createdAt: res.created_at,
      bundle,
      filename,
      effectiveOrgId,
    };
  } catch (err: any) {
    return {
      ok: false,
      reason: 'rpc_error',
      message: err?.message || 'Network error while sending report.',
      bundle,
      filename,
      effectiveOrgId,
    };
  }
}
