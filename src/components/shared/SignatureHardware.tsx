import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Scale, Send, Power, Check, AlertTriangle, XCircle } from 'lucide-react';
import { APP_VERSION } from '../../config/version';
import { TELEGRAM_SUPPORT_URL } from '../../config/support';
import { triggerHaptic } from '../../lib/haptics';
import { BrandBadge } from './BrandBadge';
import {
  BugLogBundle,
  buildFullBugLog,
  buildSupportClipboardText,
  submitSupportReport,
  trimBugLogBundle,
} from '../../lib/bugLog';
import { downloadJson } from '../../lib/downloadUtils';
import { getStoredSession } from '../../lib/supabase';
import { showToast } from '../common/ToastProvider';
import {
  runSelfTest,
  SelfTestRunResult,
  SelfTestGroupResult,
  SelfTestCheckItem,
  getLastTestResult,
} from '../../lib/selfTest';
import {
  getPendingCount,
  getFailedMutations,
  getFailedScores,
  subscribeToQueueChanges,
} from '../../lib/offlineQueue';

export type HardwareRole = 'organiser' | 'judge';
export type ScreenState =
  | 'sleep'
  | 'booting'
  | 'about'
  | 'diagnostics'
  | 'reporting'
  | 'shutting_down';

const TOTAL_CHECKS = 39;
const GAUGE_RADIUS = 22;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;

interface SignatureHardwareProps {
  role: HardwareRole;
}

// Module-level session memory
let hasSessionPowerOn = false;

export function resetSignatureHardwareSession(): void {
  hasSessionPowerOn = false;
}

const aodTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZoneName: 'short',
});

function formatAodTime(date: Date): string {
  return aodTimeFormatter.format(date).replace(',', '').replace(/\s+/g, ' ').trim();
}

function buildInitialSummary(testResult: SelfTestRunResult | null): string {
  if (!testResult) return '';
  if (testResult.problemTotal === 0 && testResult.noticeTotal === 0) return '';

  const issues: string[] = [];
  for (const grp of testResult.groups) {
    for (const chk of grp.checks) {
      if (chk.status === 'problem' || chk.status === 'notice') {
        issues.push(`${chk.code || chk.label}: ${chk.plain}`);
      }
      if (issues.length >= 3) break;
    }
    if (issues.length >= 3) break;
  }

  const header = `Diagnostics: ${testResult.verdict} (${testResult.problemTotal} problem, ${testResult.noticeTotal} notice)`;
  return issues.length > 0 ? `${header}\n${issues.join('\n')}` : header;
}

// Isolated memoized AOD clock: 60s interval prevents re-rendering the hardware chassis
const HardwareClock = React.memo(function HardwareClock() {
  const [clockText, setClockText] = useState<string>(() => formatAodTime(new Date()));

  useEffect(() => {
    const intervalId = setInterval(() => {
      setClockText(formatAodTime(new Date()));
    }, 60_000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <time
      dateTime={clockText}
      className="font-mono text-zinc-500 tracking-[0.2em] text-lg tabular-nums mt-2"
    >
      {clockText}
    </time>
  );
});

export const SignatureHardware: React.FC<SignatureHardwareProps> = ({ role }) => {
  const [screenState, setScreenState] = useState<ScreenState>(() =>
    hasSessionPowerOn ? 'about' : 'sleep'
  );
  const [announcement, setAnnouncement] = useState<string>('');
  const [queueHealth, setQueueHealth] = useState<{ pending: number; failed: number }>({
    pending: 0,
    failed: 0,
  });

  const [testResult, setTestResult] = useState<SelfTestRunResult | null>(
    () => getLastTestResult().result
  );
  const [testRunning, setTestRunning] = useState(false);
  const [streamedGroups, setStreamedGroups] = useState<SelfTestGroupResult[]>([]);
  const [latestCheckLine, setLatestCheckLine] = useState<string>('Initializing hardware probes...');
  const [checksCompleted, setChecksCompleted] = useState<number>(0);

  const [telemetryStep, setTelemetryStep] = useState<'compose' | 'sent' | 'telegram'>('compose');
  const [reportSummary, setReportSummary] = useState<string>('');
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [preparingTelegram, setPreparingTelegram] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [telegramReason, setTelegramReason] = useState<string | null>(null);
  const [reportTicketId, setReportTicketId] = useState<string | null>(null);
  const [reportBundle, setReportBundle] = useState<{
    bundle: BugLogBundle;
    filename: string;
  } | null>(null);
  const [downloadedFilename, setDownloadedFilename] = useState<string | null>(null);
  const [copiedSummary, setCopiedSummary] = useState(false);

  const [isDocVisible, setIsDocVisible] = useState(() =>
    typeof document !== 'undefined' ? !document.hidden : true
  );
  const [shutdownOrigin, setShutdownOrigin] = useState<
    'booting' | 'about' | 'diagnostics' | 'reporting'
  >('about');
  const [bootVisible, setBootVisible] = useState(false);

  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootRafRef = useRef<number | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }
      if (bootRafRef.current !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(bootRafRef.current);
        bootRafRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  // Lazy font loading for Geist
  useEffect(() => {
    if (screenState !== 'sleep' && typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.load('300 12px Geist').catch(() => {});
    }
  }, [screenState]);

  // Tab visibility tracking
  useEffect(() => {
    const handleVis = () => {
      setIsDocVisible(typeof document !== 'undefined' ? !document.hidden : true);
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => {
      document.removeEventListener('visibilitychange', handleVis);
    };
  }, []);

  // Queue-aware LED state via getPendingCount & getFailedMutations (+ getFailedScores)
  const refreshQueueHealth = useCallback(async () => {
    try {
      const [pending, failedMuts, failedScores] = await Promise.all([
        getPendingCount().catch(() => 0),
        getFailedMutations().catch(() => []),
        getFailedScores().catch(() => []),
      ]);
      const failed = (failedMuts?.length || 0) + (failedScores?.length || 0);
      setQueueHealth({ pending, failed });
    } catch {
      // Keep previous state on transient read error
    }
  }, []);

  useEffect(() => {
    refreshQueueHealth();
    const unsubscribe = subscribeToQueueChanges(() => {
      refreshQueueHealth();
    });
    return () => {
      unsubscribe();
    };
  }, [refreshQueueHealth]);

  const clearTransitionTimer = useCallback(() => {
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    if (bootRafRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(bootRafRef.current);
      bootRafRef.current = null;
    }
  }, []);

  const abortRunningDiagnostics = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setTestRunning(false);
  }, []);

  const launchDiagnostics = useCallback(async () => {
    abortRunningDiagnostics();

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setTestRunning(true);
    setStreamedGroups([]);
    setChecksCompleted(0);
    setLatestCheckLine('Initializing hardware probes...');

    const startedAt = Date.now();
    const isReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    try {
      const result = await runSelfTest(
        role,
        controller.signal,
        (group) => {
          if (controller.signal.aborted) return;
          setStreamedGroups((prev) => {
            const filtered = prev.filter((g) => g.id !== group.id);
            return [...filtered, group];
          });
        },
        (chk: SelfTestCheckItem) => {
          if (controller.signal.aborted) return;
          setChecksCompleted((c) => c + 1);
          const tag =
            chk.status === 'ok'
              ? 'OK'
              : chk.status === 'notice'
              ? 'NOTE'
              : chk.status === 'problem'
              ? 'FAIL'
              : 'SKIP';
          setLatestCheckLine(`${chk.label} ... ${tag}`);
        }
      );

      if (controller.signal.aborted) return;

      // Ensure scanning line & cursor are briefly perceptible unless reduced motion is set
      const elapsed = Date.now() - startedAt;
      const minScanMs = isReducedMotion ? 0 : 650;
      if (elapsed < minScanMs) {
        await new Promise((resolve) => setTimeout(resolve, minScanMs - elapsed));
      }

      if (controller.signal.aborted) return;

      setTestResult(result);
      setTestRunning(false);
      abortControllerRef.current = null;

      if (result.verdict === 'ALL CLEAR') {
        triggerHaptic('success');
        setAnnouncement('Self-test finished: Systems nominal');
      } else {
        triggerHaptic('warning');
        setAnnouncement(
          `Self-test finished: ${result.problemTotal} problem(s), ${result.noticeTotal} notice(s)`
        );
      }
    } catch (err: any) {
      if (err?.message !== 'TEST_ABORTED' && !controller.signal.aborted) {
        setTestRunning(false);
        abortControllerRef.current = null;
      }
    }
  }, [role, abortRunningDiagnostics]);

  const triggerBoot = useCallback(() => {
    clearTransitionTimer();
    abortRunningDiagnostics();
    // Heavy physical thud on wake
    triggerHaptic('submit');
    hasSessionPowerOn = true;
    setBootVisible(false);
    setScreenState('booting');
    setAnnouncement('Booting Fair Judge terminal');

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reducedMotion || typeof requestAnimationFrame !== 'function') {
      setBootVisible(true);
    } else {
      bootRafRef.current = requestAnimationFrame(() => {
        bootRafRef.current = requestAnimationFrame(() => {
          bootRafRef.current = null;
          setBootVisible(true);
        });
      });
    }

    transitionTimerRef.current = setTimeout(() => {
      transitionTimerRef.current = null;
      setScreenState('about');
      setAnnouncement('Terminal awake: About Fair Judge');
    }, reducedMotion ? 80 : 1000);
  }, [clearTransitionTimer, abortRunningDiagnostics]);

  const triggerShutdown = useCallback(() => {
    clearTransitionTimer();
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    triggerHaptic('tick');
    hasSessionPowerOn = false;

    const origin: 'booting' | 'about' | 'diagnostics' | 'reporting' =
      screenState === 'reporting'
        ? 'reporting'
        : screenState === 'diagnostics'
        ? 'diagnostics'
        : screenState === 'booting'
        ? 'booting'
        : 'about';
    setShutdownOrigin(origin);
    setScreenState('shutting_down');
    setAnnouncement('Shutting down terminal');

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    transitionTimerRef.current = setTimeout(() => {
      transitionTimerRef.current = null;
      setTestRunning(false);
      setBootVisible(false);
      setScreenState('sleep');
      setAnnouncement('Terminal in sleep mode');
    }, reducedMotion ? 60 : 600);
  }, [clearTransitionTimer, screenState]);

  const handlePowerToggle = useCallback(() => {
    if (screenState === 'sleep') {
      triggerBoot();
    } else if (screenState !== 'shutting_down') {
      triggerShutdown();
    }
  }, [screenState, triggerBoot, triggerShutdown]);

  const handleNavigateAbout = useCallback(() => {
    if (screenState === 'about') return;
    triggerHaptic('light');
    abortRunningDiagnostics();
    setScreenState('about');
    setAnnouncement('About Fair Judge');
  }, [screenState, abortRunningDiagnostics]);

  const handleNavigateDiagnostics = useCallback(() => {
    if (testRunning) return;
    triggerHaptic('tick');
    setScreenState('diagnostics');
    setAnnouncement('Running hardware diagnostics');
    launchDiagnostics();
  }, [testRunning, launchDiagnostics]);

  const handleOpenReporting = useCallback(() => {
    clearTransitionTimer();
    abortRunningDiagnostics();
    hasSessionPowerOn = true;
    triggerHaptic('tick');
    setTelemetryStep('compose');
    setReportSummary(buildInitialSummary(testResult));
    setReportError(null);
    setTelegramReason(null);
    setReportTicketId(null);
    setReportBundle(null);
    setDownloadedFilename(null);
    setCopiedSummary(false);
    setScreenState('reporting');
    setAnnouncement('Telemetry report console');
  }, [clearTransitionTimer, abortRunningDiagnostics, testResult]);

  const handleSubmitTelemetry = useCallback(async () => {
    const trimmed = reportSummary.trim();
    if (!trimmed) {
      setReportError('Describe what happened before sending.');
      triggerHaptic('warning');
      return;
    }

    setReportError(null);
    setTelegramReason(null);
    setReportSubmitting(true);
    triggerHaptic('submit');

    const res = await submitSupportReport({
      role,
      summary: trimmed,
    });

    setReportSubmitting(false);
    setReportBundle({ bundle: res.bundle, filename: res.filename });

    if (res.ok) {
      triggerHaptic('success');
      setReportTicketId(res.id || null);
      setTelemetryStep('sent');
      showToast('Report sent to developer', 'success');
      return;
    }

    if (res.reason === 'invalid_summary') {
      triggerHaptic('warning');
      setReportError(res.message || 'Summary must be 1–2000 characters.');
      return;
    }

    triggerHaptic('warning');
    if (res.reason === 'offline') {
      setTelegramReason('Offline: save log JSON & send on Telegram.');
    } else if (res.reason === 'rate_limited') {
      setTelegramReason('Rate limit reached: send log via Telegram.');
    } else if (res.reason === 'not_configured') {
      setTelegramReason('Inbox unavailable: send log via Telegram.');
    } else {
      setTelegramReason('Direct send failed: use Telegram fallback.');
    }
    setTelemetryStep('telegram');
  }, [reportSummary, role]);

  const handleSwitchTelemetryTelegram = useCallback(async () => {
    triggerHaptic('light');
    setReportError(null);
    setTelegramReason(null);

    if (!reportBundle) {
      setPreparingTelegram(true);
      try {
        const built = await buildFullBugLog(role);
        setReportBundle({
          bundle: trimBugLogBundle(built.bundle),
          filename: built.filename,
        });
      } catch {
        // Proceed to Telegram handoff even if fresh bundle build fails
      } finally {
        setPreparingTelegram(false);
      }
    }

    setTelemetryStep('telegram');
  }, [reportBundle, role]);

  const handleDownloadTelemetryBundle = useCallback(async () => {
    triggerHaptic('tick');
    let target = reportBundle;
    if (!target) {
      setPreparingTelegram(true);
      try {
        const built = await buildFullBugLog(role);
        target = {
          bundle: trimBugLogBundle(built.bundle),
          filename: built.filename,
        };
        setReportBundle(target);
      } catch {
        showToast('Could not prepare diagnostic bundle', 'error');
        setPreparingTelegram(false);
        return;
      }
      setPreparingTelegram(false);
    }

    const saved = downloadJson(target.filename, target.bundle);
    setDownloadedFilename(saved);
    triggerHaptic('success');
    showToast(`Saved: ${saved}`, 'success');
  }, [reportBundle, role]);

  const handleCopyTelemetrySummary = useCallback(async () => {
    triggerHaptic('tick');
    const orgCode =
      reportBundle?.bundle.orgCode || getStoredSession()?.org?.org_id?.trim() || 'terminal';
    const text = buildSupportClipboardText({
      role,
      orgCode,
      summary: reportSummary.trim() || 'Diagnostic report attached.',
      verdict: reportBundle?.bundle.summary.verdict || testResult?.verdict,
    });
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        setCopiedSummary(true);
        triggerHaptic('success');
        return;
      }
    } catch {
      // Clipboard denied — notify cleanly
    }
    showToast('Clipboard unavailable — save JSON log instead', 'info');
  }, [reportBundle, role, reportSummary, testResult]);

  const topProblems = useMemo(() => {
    if (!testResult) return [];
    const items: Array<{ code?: string; label: string; plain: string; status: 'problem' | 'notice' }> = [];
    for (const grp of testResult.groups) {
      for (const chk of grp.checks) {
        if (chk.status === 'problem' || chk.status === 'notice') {
          items.push({
            code: chk.code,
            label: chk.label,
            plain: chk.plain,
            status: chk.status,
          });
        }
      }
    }
    return items;
  }, [testResult]);

  const verdictDisplay = useMemo(() => {
    if (!testResult) {
      return {
        headline: 'NO DATA',
        colorClass: 'text-zinc-400',
        countsText: '0 OK • 0 NOTICE • 0 FAULT',
      };
    }

    const okTotal = testResult.groups.reduce((acc, g) => acc + g.okCount, 0);
    const countsText = `${okTotal} OK • ${testResult.noticeTotal} NOTICE • ${testResult.problemTotal} FAULT`;

    if (testResult.verdict === 'ALL CLEAR') {
      return {
        headline: 'SYSTEMS NOMINAL',
        colorClass: 'text-emerald-400',
        countsText,
      };
    }
    if (testResult.verdict === 'MINOR') {
      return {
        headline: 'MINOR NOTICE',
        colorClass: 'text-amber-400',
        countsText,
      };
    }
    return {
      headline: 'CRITICAL FAULT',
      colorClass: 'text-red-400',
      countsText,
    };
  }, [testResult]);

  const isSleep = screenState === 'sleep';
  const isBooting = screenState === 'booting';
  const isAbout = screenState === 'about';
  const isDiagnostics = screenState === 'diagnostics';
  const isReporting = screenState === 'reporting';
  const isShuttingDown = screenState === 'shutting_down';
  const isAwake = !isSleep;
  const showBootLayer = isBooting || (isShuttingDown && shutdownOrigin === 'booting');
  const showAboutLayer = isAbout || (isShuttingDown && shutdownOrigin === 'about');
  const showDiagnosticsLayer =
    isDiagnostics || (isShuttingDown && shutdownOrigin === 'diagnostics');
  const showReportingLayer =
    isReporting || (isShuttingDown && shutdownOrigin === 'reporting');

  const gaugePct = testRunning
    ? Math.min(99, Math.round((checksCompleted / TOTAL_CHECKS) * 100))
    : testResult
    ? 100
    : 0;
  const gaugeOffset = GAUGE_CIRCUMFERENCE * (1 - gaugePct / 100);
  const displayedGroups = testRunning ? streamedGroups : testResult?.groups || [];
  const hasCriticalFaults = Boolean(
    testResult &&
      (testResult.verdict === 'MAJOR' ||
        (testResult.verdict as string) === 'CRITICAL' ||
        testResult.problemTotal > 0)
  );

  // Queue-Aware LED visual state:
  // Healthy (0 pending, 0 failed) -> emerald breathing
  // Syncing/Pending (>0 pending, 0 failed) -> amber breathing
  // Fault/Failed (>0 failed) -> red solid (no breathing)
  const ledClassName =
    queueHealth.failed > 0
      ? 'bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.85)]'
      : queueHealth.pending > 0
      ? 'bg-amber-400 fj-smart-led-breathe shadow-[0_0_6px_rgba(251,191,36,0.85)]'
      : 'bg-emerald-400 fj-smart-led-breathe shadow-[0_0_6px_rgba(52,211,153,0.85)]';

  const ledLabel =
    queueHealth.failed > 0
      ? `${queueHealth.failed} queue fault`
      : queueHealth.pending > 0
      ? `${queueHealth.pending} pending sync`
      : 'Queue healthy';

  return (
    <div className="w-full max-w-sm mx-auto select-none pt-2 pb-1">
      {/* Visually Hidden Live Announcement Region */}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      {/* CHASSIS (Theme-Adaptive, Machined Laptop Frame) */}
      <div
        className="relative z-10 w-full rounded-2xl px-2 pt-2 pb-0 bg-gradient-to-b from-zinc-100 to-zinc-300 border border-zinc-300 shadow-sm dark:bg-zinc-900 dark:border-zinc-800 dark:border-t-white/10 dark:from-zinc-900 dark:to-zinc-900"
        aria-hidden="false"
      >
        {/* Top Bezel with 4px Webcam Dot */}
        <div className="flex items-center justify-center pb-1.5" aria-hidden="true">
          <div className="w-1 h-1 rounded-full bg-zinc-600/70 dark:bg-zinc-500" />
        </div>

        {/* AMOLED SCREEN (always pitch-dark background, fixed height) */}
        <div
          data-live={
            (isAbout || isBooting || isDiagnostics || isReporting) && isDocVisible
              ? 'true'
              : 'false'
          }
          className="h-[220px] bg-black rounded-xl border border-white/10 shadow-inner overflow-hidden relative flex flex-col justify-between"
        >
          {/* SLEEP SCREEN STATE: AMOLED Always-On Display */}
          {isSleep && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none select-none z-20 animate-breathe-fade">
              <BrandBadge
                role={role}
                size="md"
                motion="still"
                className="opacity-20 scale-75 grayscale"
              />
              <HardwareClock />
            </div>
          )}

          {/* ACTIVE OLED SURFACE: 600ms realistic power-drain fade on shutdown */}
          {!isSleep && (
            <div
              className={`h-full flex flex-col justify-between transition-opacity duration-[600ms] ease-in-out motion-reduce:transition-none ${
                isShuttingDown ? 'opacity-0 pointer-events-none' : 'opacity-100'
              }`}
            >
              {/* SCREEN VIEWPORT */}
              <div className="flex-1 min-h-0 px-3.5 py-2.5 relative overflow-hidden">
                {/* BOOTING SCREEN STATE (300ms fade from black + tipping scale choreography) */}
                {showBootLayer && (
                  <div
                    className={`relative h-full flex flex-col items-center justify-center text-center px-3 overflow-hidden select-none transition-opacity duration-300 ease-out motion-reduce:transition-none ${
                      bootVisible ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    <div className="fj-vm-boot-badge">
                      <BrandBadge role={role} size="md" motion="rock" />
                    </div>
                    <div className="fj-vm-boot-text mt-2.5 flex flex-col items-center">
                      <h2 className="text-sm font-semibold tracking-tight text-zinc-100 leading-tight">
                        Fair Judge
                      </h2>
                      <p className="text-[9px] tracking-[0.25em] uppercase font-mono text-zinc-400 mt-0.5">
                        JUDGE TRANSPARENTLY
                      </p>
                      <span className="text-[8.5px] uppercase tracking-[0.22em] text-zinc-500 fj-screen-font mt-2">
                        By Sahil Kumar Rout
                      </span>
                    </div>
                  </div>
                )}

                {/* ABOUT SIGNATURE LAYER */}
                {showAboutLayer && (
                  <div
                    role="region"
                    aria-label="Fair Judge — Judge Transparently. Engineered with intent by Sahil Kumar Rout"
                    className="relative h-full flex flex-col items-center justify-center text-center px-3 overflow-hidden select-none"
                  >
                    {/* Ambient Radial Glow */}
                    <div
                      className="absolute inset-0 pointer-events-none flex items-center justify-center fj-loop fj-ambient-glow"
                      style={{
                        background:
                          'radial-gradient(circle at 50% 50%, rgba(52, 211, 153, 0.08) 0%, rgba(0, 0, 0, 0) 70%)',
                      }}
                    />

                    {/* 1. APP BRANDING (Top Group) */}
                    <div className="flex flex-col items-center justify-center">
                      <div
                        className={`w-7 h-7 rounded-xl flex items-center justify-center border shadow-xs mb-1 ${
                          role === 'organiser'
                            ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                            : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                        }`}
                      >
                        <Scale className="w-3.5 h-3.5 stroke-[2.2]" />
                      </div>

                      <h2 className="text-sm font-semibold tracking-tight text-zinc-100 leading-tight">
                        Fair Judge
                      </h2>

                      <p className="text-[9px] tracking-[0.25em] uppercase font-mono text-zinc-400 mt-0.5">
                        JUDGE TRANSPARENTLY
                      </p>
                    </div>

                    <div className="my-1" />

                    {/* 2. DEVELOPER SIGNATURE (Bottom Group) */}
                    <div className="flex flex-col items-center justify-center">
                      <div className="fj-word-rise font-normal text-[8.5px] uppercase tracking-[0.28em] text-zinc-500 fj-screen-font mb-1">
                        ENGINEERED WITH INTENT
                      </div>

                      {/* Hairline with 9 tiny ticks and 3px emerald scanner dot */}
                      <div className="relative w-[180px] h-[5px] flex items-center justify-center">
                        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[1px] bg-gradient-to-r from-transparent via-zinc-500/60 to-transparent" />
                        <div className="absolute inset-0 flex items-center justify-between px-3 pointer-events-none opacity-35">
                          {Array.from({ length: 9 }).map((_, i) => (
                            <span key={i} className="w-[1px] h-[3px] bg-zinc-400" />
                          ))}
                        </div>
                        <div className="absolute top-1/2 -translate-y-1/2 left-0 w-[3px] h-[3px] rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.9)] fj-loop fj-scanner-dot pointer-events-none" />
                      </div>

                      {/* Staggered words & sheen light streak */}
                      <div className="relative mt-1 flex items-baseline justify-center gap-1.5 overflow-hidden px-2 py-0.5">
                        <span
                          className="fj-word-rise text-[9px] text-zinc-500 font-normal fj-screen-font"
                          style={{ animationDelay: '100ms' }}
                        >
                          By
                        </span>
                        <div className="relative inline-flex items-center gap-1 overflow-hidden">
                          <span
                            className="fj-word-rise text-[12px] font-medium tracking-[0.16em] uppercase text-zinc-100 fj-screen-font"
                            style={{ animationDelay: '180ms' }}
                          >
                            SAHIL
                          </span>
                          <span
                            className="fj-word-rise text-[12px] font-medium tracking-[0.16em] uppercase text-zinc-100 fj-screen-font"
                            style={{ animationDelay: '260ms' }}
                          >
                            KUMAR
                          </span>
                          <span
                            className="fj-word-rise text-[12px] font-medium tracking-[0.16em] uppercase text-zinc-100 fj-screen-font"
                            style={{ animationDelay: '340ms' }}
                          >
                            ROUT
                          </span>
                          <div className="absolute inset-0 pointer-events-none fj-loop fj-light-streak w-[50%] bg-gradient-to-r from-transparent via-white/20 to-transparent -skew-x-12" />
                        </div>
                      </div>
                    </div>

                    {/* 3. THE GHOST TRIGGER */}
                    <button
                      type="button"
                      onClick={handleNavigateDiagnostics}
                      className="text-[10px] font-mono text-zinc-500 hover:text-emerald-400 transition-colors mt-6 cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60 rounded"
                    >
                      &gt;_ INITIATE DIAGNOSTICS
                    </button>
                  </div>
                )}

                {/* ENTERPRISE DIAGNOSTICS LAYER */}
                {showDiagnosticsLayer && (
                  <div className="relative h-full flex flex-col text-zinc-100 select-none overflow-hidden animate-in fade-in duration-200">
                    {testRunning && (
                      <div className="absolute inset-x-0 top-0 h-[1px] bg-emerald-400/70 pointer-events-none fj-loop fj-scan-line z-30" />
                    )}

                    {/* Top Terminal Navigation Bar */}
                    <div className="flex items-center justify-between pb-1.5 border-b border-white/10 font-mono text-[10px] shrink-0">
                      <button
                        type="button"
                        onClick={handleNavigateAbout}
                        className="text-zinc-400 hover:text-zinc-100 transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60 rounded"
                      >
                        &lt; Back
                      </button>
                      <span className="tracking-[0.16em] uppercase text-zinc-500">
                        {testRunning ? `SYS.SCAN • ${streamedGroups.length}/6` : 'SYS.DIAGNOSTICS'}
                      </span>
                      {testRunning ? (
                        <span className="text-emerald-400 tabular-nums">{checksCompleted}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={handleNavigateDiagnostics}
                          className="text-zinc-400 hover:text-emerald-400 transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/60 rounded"
                        >
                          Re-run
                        </button>
                      )}
                    </div>

                    {/* Circular SVG Percentage Gauge + Live/Verdict Readout */}
                    <div className="flex items-center gap-3 py-2 border-b border-white/10 shrink-0">
                      <div className="relative w-14 h-14 shrink-0 flex items-center justify-center">
                        <svg viewBox="0 0 56 56" className="w-14 h-14 -rotate-90" aria-hidden="true">
                          <circle
                            cx="28"
                            cy="28"
                            r={GAUGE_RADIUS}
                            fill="none"
                            stroke="rgba(255,255,255,0.08)"
                            strokeWidth="3.5"
                          />
                          <circle
                            cx="28"
                            cy="28"
                            r={GAUGE_RADIUS}
                            fill="none"
                            stroke={
                              testRunning
                                ? '#34d399'
                                : hasCriticalFaults
                                ? '#f87171'
                                : testResult?.verdict === 'MINOR'
                                ? '#fbbf24'
                                : '#34d399'
                            }
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            strokeDasharray={GAUGE_CIRCUMFERENCE}
                            strokeDashoffset={gaugeOffset}
                            className="fj-gauge-arc"
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          {testRunning ? (
                            <span className="font-mono text-[10px] font-bold tabular-nums text-emerald-400">
                              {gaugePct}%
                            </span>
                          ) : hasCriticalFaults ? (
                            <XCircle className="w-4 h-4 text-red-400" aria-hidden="true" />
                          ) : testResult?.verdict === 'MINOR' ? (
                            <AlertTriangle className="w-4 h-4 text-amber-400" aria-hidden="true" />
                          ) : (
                            <Check className="w-4 h-4 text-emerald-400" aria-hidden="true" />
                          )}
                        </div>
                      </div>

                      <div className="min-w-0 flex-1 font-mono">
                        {testRunning ? (
                          <>
                            <div className="text-[11px] font-semibold tracking-[0.12em] uppercase text-zinc-100 flex items-center gap-1">
                              <span>PROBING SYSTEMS</span>
                              <span className="fj-cursor-blink text-emerald-400" aria-hidden="true">
                                ▌
                              </span>
                            </div>
                            <p className="text-[9.5px] text-zinc-400 truncate mt-0.5">
                              &gt; {latestCheckLine}
                            </p>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={`text-[11px] font-bold tracking-[0.12em] uppercase truncate ${verdictDisplay.colorClass}`}
                              >
                                {verdictDisplay.headline}
                              </span>
                              <button
                                type="button"
                                onClick={handleOpenReporting}
                                className="shrink-0 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 cursor-pointer"
                              >
                                Report
                              </button>
                            </div>
                            <div className="text-[9.5px] text-zinc-400 tabular-nums mt-0.5 truncate">
                              {verdictDisplay.countsText}
                              {testResult ? ` • ${testResult.totalMs}ms` : ''}
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Comprehensive Scrolling Suite & Check Readout */}
                    <div className="flex-1 min-h-0 overflow-y-auto pt-1.5 pr-1 space-y-1.5 font-mono text-[9.5px] select-text">
                      {/* AUTO-SURFACED CRITICAL FAULTS BLOCK (Immediate visibility when MAJOR/CRITICAL) */}
                      {!testRunning && hasCriticalFaults && topProblems.length > 0 && (
                        <div className="rounded-md border border-red-500/60 bg-red-950/50 p-2 space-y-1">
                          <div className="text-[9px] font-bold uppercase tracking-[0.16em] text-red-400">
                            CRITICAL FAULTS ({topProblems.length})
                          </div>
                          {topProblems.map((prob, idx) => (
                            <div
                              key={`${prob.code || prob.label}_${idx}`}
                              className={prob.status === 'problem' ? 'text-red-300' : 'text-amber-300'}
                            >
                              <span className="font-semibold">
                                [{prob.status === 'problem' ? 'FAULT' : 'NOTICE'}]{' '}
                                {prob.code ? `${prob.code} ` : ''}
                                {prob.label}:
                              </span>{' '}
                              <span className="text-zinc-200">{prob.plain}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Detailed Check Suites */}
                      {displayedGroups.map((grp) => (
                        <div
                          key={grp.id}
                          className="rounded-md border border-white/10 bg-zinc-950/90 px-2 py-1.5 space-y-1"
                        >
                          <div className="flex items-center justify-between border-b border-white/5 pb-0.5">
                            <span className="text-zinc-200 font-semibold uppercase tracking-wider">
                              {grp.label}
                            </span>
                            <span
                              className={
                                grp.problemCount > 0
                                  ? 'text-red-400'
                                  : grp.noticeCount > 0
                                  ? 'text-amber-400'
                                  : 'text-emerald-400'
                              }
                            >
                              {grp.okCount}OK/{grp.noticeCount}N/{grp.problemCount}F
                            </span>
                          </div>
                          <div className="space-y-0.5">
                            {grp.checks.map((chk) => (
                              <div key={chk.id} className="flex items-start justify-between gap-2">
                                <span className="text-zinc-300 leading-snug">
                                  › {chk.label}
                                  {chk.status !== 'ok' && (
                                    <span className="block text-zinc-500 text-[8.5px] pl-2">
                                      {chk.plain}
                                    </span>
                                  )}
                                </span>
                                <span
                                  className={`shrink-0 font-semibold ${
                                    chk.status === 'ok'
                                      ? 'text-emerald-400'
                                      : chk.status === 'notice'
                                      ? 'text-amber-400'
                                      : chk.status === 'problem'
                                      ? 'text-red-400'
                                      : 'text-zinc-500'
                                  }`}
                                >
                                  {chk.status.toUpperCase()}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}

                      {testRunning && displayedGroups.length === 0 && (
                        <div className="text-zinc-500 py-2 text-center">
                          Awaiting first probe group...
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {showReportingLayer && (
                  <div className="relative flex flex-col h-full font-mono text-zinc-300 select-none overflow-hidden animate-in fade-in duration-200">
                    {/* Header Row */}
                    <div className="flex items-center justify-between pb-1 border-b border-white/10 shrink-0">
                      <button
                        type="button"
                        disabled={reportSubmitting || preparingTelegram}
                        onClick={() => {
                          triggerHaptic('light');
                          if (telemetryStep !== 'compose' && !reportTicketId) {
                            setTelemetryStep('compose');
                          } else {
                            setScreenState('diagnostics');
                          }
                        }}
                        className="text-[10px] text-zinc-400 hover:text-zinc-100 transition-colors cursor-pointer disabled:opacity-40"
                      >
                        &lt; Back
                      </button>
                      <span className="font-mono text-[10px] text-zinc-500 tracking-[0.16em] uppercase">
                        SYS.TELEMETRY
                      </span>
                    </div>

                    {telemetryStep === 'compose' && (
                      <>
                        <textarea
                          value={reportSummary}
                          onChange={(e) => {
                            setReportSummary(e.target.value);
                            if (reportError) setReportError(null);
                          }}
                          maxLength={2000}
                          disabled={reportSubmitting || preparingTelegram}
                          aria-label="Issue description"
                          placeholder="> Awaiting user context..."
                          className="flex-1 min-h-0 w-full bg-zinc-950/50 border border-zinc-800 rounded p-2 text-xs font-mono text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50 resize-none mt-2"
                        />

                        {reportError ? (
                          <div
                            role="alert"
                            className="text-[9px] font-mono text-red-400 truncate mt-1 shrink-0"
                          >
                            &gt; {reportError}
                          </div>
                        ) : (
                          <div className="text-[9px] text-zinc-600 font-mono truncate mt-1 shrink-0">
                            Attaching: Diagnostic Log, Sync Queue State...
                          </div>
                        )}

                        <div className="flex flex-col gap-1 mt-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={handleSubmitTelemetry}
                            disabled={reportSubmitting || preparingTelegram}
                            className="w-full py-1.5 text-xs font-mono font-semibold bg-emerald-600 hover:bg-emerald-500 text-zinc-950 rounded cursor-pointer disabled:opacity-50"
                          >
                            {reportSubmitting ? '[ TRANSMITTING... ]' : '[ SEND REPORT ]'}
                          </button>
                          <button
                            type="button"
                            onClick={handleSwitchTelemetryTelegram}
                            disabled={reportSubmitting || preparingTelegram}
                            className="w-full py-1.5 text-xs font-mono text-zinc-300 border border-zinc-800 hover:border-emerald-500/40 hover:text-emerald-300 rounded cursor-pointer disabled:opacity-50"
                          >
                            {preparingTelegram ? '[ PREPARING LOG... ]' : '[ SEND VIA TELEGRAM ]'}
                          </button>
                        </div>
                      </>
                    )}

                    {telemetryStep === 'sent' && (
                      <div className="flex-1 min-h-0 flex flex-col justify-between pt-2">
                        <div className="rounded border border-emerald-500/30 bg-emerald-950/30 p-2 space-y-1">
                          <div className="text-[11px] font-bold text-emerald-400 tracking-wider uppercase">
                            REPORT DELIVERED
                          </div>
                          <p className="text-[9.5px] text-zinc-300 leading-snug">
                            Diagnostic log and queue snapshot transmitted to developer inbox.
                          </p>
                          {reportTicketId && (
                            <div className="text-[9.5px] text-emerald-300">
                              REF #{reportTicketId.slice(0, 8).toUpperCase()}
                            </div>
                          )}
                        </div>

                        <div className="flex flex-col gap-1 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              triggerHaptic('light');
                              setScreenState('diagnostics');
                            }}
                            className="w-full py-1.5 text-xs font-mono font-semibold bg-emerald-600 hover:bg-emerald-500 text-zinc-950 rounded cursor-pointer"
                          >
                            [ DONE ]
                          </button>
                          <a
                            href={TELEGRAM_SUPPORT_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => triggerHaptic('light')}
                            className="w-full py-1.5 text-xs font-mono text-center text-zinc-300 border border-zinc-800 hover:border-emerald-500/40 hover:text-emerald-300 rounded no-underline"
                          >
                            [ OPEN TELEGRAM ]
                          </a>
                        </div>
                      </div>
                    )}

                    {telemetryStep === 'telegram' && (
                      <div className="flex-1 min-h-0 flex flex-col justify-between pt-2">
                        <div className="space-y-1">
                          <div className="text-[9.5px] text-amber-400 truncate">
                            {telegramReason || 'Save diagnostic JSON & attach in Telegram:'}
                          </div>
                          <button
                            type="button"
                            onClick={handleDownloadTelemetryBundle}
                            disabled={preparingTelegram}
                            className="w-full py-1.5 text-xs font-mono text-zinc-200 bg-zinc-950/70 border border-zinc-800 hover:border-emerald-500/40 rounded cursor-pointer disabled:opacity-50 truncate px-2"
                          >
                            {preparingTelegram
                              ? '[ PREPARING JSON... ]'
                              : downloadedFilename
                              ? `[ SAVED: ${downloadedFilename.slice(0, 22)} ]`
                              : '[ 1. SAVE DIAGNOSTIC JSON ]'}
                          </button>
                          <button
                            type="button"
                            onClick={handleCopyTelemetrySummary}
                            className="w-full py-1.5 text-xs font-mono text-zinc-300 border border-zinc-800 hover:border-emerald-500/40 rounded cursor-pointer"
                          >
                            {copiedSummary ? '[ SUMMARY COPIED ]' : '[ 2. COPY SUMMARY ]'}
                          </button>
                        </div>

                        <a
                          href={TELEGRAM_SUPPORT_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => triggerHaptic('light')}
                          className="w-full py-1.5 text-xs font-mono font-semibold text-center bg-emerald-600 hover:bg-emerald-500 text-zinc-950 rounded no-underline shrink-0"
                        >
                          [ 3. SEND VIA TELEGRAM ]
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* CHIN: Ultra-thin machined laptop bezel */}
        <div className="pt-2 pb-2 px-3 flex items-center justify-between">
          {/* Far Left: Model Text & Liquid Queue Indicator Pill */}
          <div className="flex flex-col items-start justify-center">
            <span className="font-mono text-[9.5px] leading-none tracking-wide text-zinc-500 dark:text-zinc-400">
              FJ • v{APP_VERSION}
            </span>
            <span
              title={ledLabel}
              aria-label={ledLabel}
              className={`mt-1.5 w-1.5 h-1.5 rounded-full pointer-events-none ${ledClassName}`}
            />
          </div>

          {/* Absolute Right: Tactile Physical Power Button (Boot / Shut Down) */}
          <button
            type="button"
            onClick={handlePowerToggle}
            aria-label={isSleep ? 'Power on hardware display' : 'Power off hardware display'}
            aria-pressed={isAwake}
            className="w-7 h-7 rounded-full bg-zinc-800 shadow-[inset_0_1px_1px_rgba(255,255,255,0.15),0_2px_4px_rgba(0,0,0,0.4)] border border-zinc-700 active:scale-[0.92] transition-transform motion-reduce:transition-none flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
          >
            <Power
              className={`w-3.5 h-3.5 text-zinc-400 transition-opacity duration-200 ${
                isAwake ? 'opacity-100' : 'opacity-75'
              }`}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>

      {/* Caption below everything (normal font, text-balance) */}
      <p className="text-center text-xs text-zinc-500 dark:text-zinc-400 mt-2.5 px-2 font-normal leading-relaxed text-balance max-w-[28ch] mx-auto">
        Scores save on this phone first, then sync when you're online.
      </p>

      <div className="flex justify-center mt-1">
        <button
          type="button"
          onClick={handleOpenReporting}
          className="min-h-[44px] px-3 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send bug report to developer</span>
        </button>
      </div>
    </div>
  );
};
