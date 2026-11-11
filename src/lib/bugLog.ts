import { APP_VERSION } from '../config/version';
import { stampLocal, safeName, downloadJson } from './downloadUtils';
import {
  runSelfTest,
  getLastTestResult,
  generateSelfTestReport,
  SelfTestRunResult,
  SelfTestReportJSON,
} from './selfTest';
import { blackBox, BlackBoxEntry } from './blackBox';
import { exportDiagnosticLog, getFailedMutations } from './offlineQueue';

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
  // 1. Resolve organization code safely
  let orgCode = 'terminal';
  if (typeof window !== 'undefined') {
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

  // 6. Gather failed mutations (STRICTLY NO PAYLOADS)
  let failedMutations: SanitizedFailedMutation[] = [];
  try {
    const rawFailed = await getFailedMutations();
    failedMutations = rawFailed.map((m) => ({
      id: m.id,
      table: m.table,
      op: m.operation,
      lastError: m.lastError || '',
      retryCount: m.retryCount || 0,
      createdAt: m.queuedAt,
    }));
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
