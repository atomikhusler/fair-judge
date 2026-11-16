import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Scale,
  Send,
  Power,
  Check,
  AlertTriangle,
  XCircle,
  ChevronLeft,
  ChevronRight,
  RotateCw,
  Activity,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { APP_VERSION } from '../../config/version';
import { TELEGRAM_SUPPORT_URL } from '../../config/support';
import { triggerHaptic } from '../../lib/haptics';
import {
  playSound,
  getSoundLevel,
  toggleSoundMute,
  SOUND_CHANGE_EVENT,
  SoundLevel,
} from '../../lib/sound';
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
});

const aodMetaFormatter = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  timeZoneName: 'short',
});

function formatAodClock(date: Date): { time: string; meta: string } {
  const time = aodTimeFormatter.format(date).trim();
  const meta = aodMetaFormatter.format(date).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  return { time, meta };
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
  const [clock, setClock] = useState<{ time: string; meta: string }>(() =>
    formatAodClock(new Date())
  );

  useEffect(() => {
    const intervalId = setInterval(() => {
      setClock(formatAodClock(new Date()));
    }, 60_000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="flex flex-col items-center mt-2">
      <time
        dateTime={clock.time}
        className="font-mono font-bold text-zinc-100 tracking-[0.12em] text-[28px] leading-none tabular-nums"
      >
        {clock.time}
      </time>
      <span className="font-mono font-semibold text-[10.5px] uppercase tracking-[0.16em] text-zinc-400 mt-1.5">
        {clock.meta}
      </span>
    </div>
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
  const [soundLevel, setSoundLevel] = useState<SoundLevel>(() => getSoundLevel());

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
    const syncSound = () => setSoundLevel(getSoundLevel());
    window.addEventListener(SOUND_CHANGE_EVENT, syncSound);
    return () => {
      window.removeEventListener(SOUND_CHANGE_EVENT, syncSound);
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

  // Lazy font loading for Geist (semibold + bold weights for OLED clarity)
  useEffect(() => {
    if (screenState !== 'sleep' && typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.load('600 12px Geist').catch(() => {});
      document.fonts.load('700 14px Geist').catch(() => {});
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
        playSound('success');
        setAnnouncement('Self-test finished: Systems nominal');
      } else {
        triggerHaptic('warning');
        playSound(result.problemTotal > 0 ? 'alert' : 'warning');
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
    // Heavy physical thud + chime on wake
    triggerHaptic('submit');
    playSound('boot');
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
    playSound('shutdown');
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

  const handleToggleSound = useCallback(() => {
    const next = toggleSoundMute();
    setSoundLevel(next);
    triggerHaptic('tick');
    if (next !== 'off') {
      playSound('tap');
    }
    setAnnouncement(next === 'off' ? 'Sound muted' : 'Sound enabled');
  }, []);

  const handleNavigateAbout = useCallback(() => {
    if (screenState === 'about') return;
    triggerHaptic('light');
    playSound('tap');
    abortRunningDiagnostics();
    setScreenState('about');
    setAnnouncement('About Fair Judge');
  }, [screenState, abortRunningDiagnostics]);

  const handleNavigateDiagnostics = useCallback(() => {
    if (testRunning) return;
    triggerHaptic('tick');
    playSound('tap');
    setScreenState('diagnostics');
    setAnnouncement('Running hardware diagnostics');
    launchDiagnostics();
  }, [testRunning, launchDiagnostics]);

  const handleOpenReporting = useCallback(() => {
    clearTransitionTimer();
    abortRunningDiagnostics();
    hasSessionPowerOn = true;
    triggerHaptic('tick');
    playSound('tap');
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
      playSound('success');
      setReportTicketId(res.id || null);
      setTelemetryStep('sent');
      showToast('Report sent to developer', 'success');
      return;
    }

    if (res.reason === 'invalid_summary') {
      triggerHaptic('warning');
      playSound('warning');
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
    playSound('success');
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
        playSound('success');
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

  const isMuted = soundLevel === 'off';
  const roleTag = role === 'organiser' ? 'ORGANISER' : 'JURY';
  const isOnlineClient = typeof navigator === 'undefined' ? true : navigator.onLine;
  const telemetryStepTag =
    telemetryStep === 'sent' ? 'SENT' : telemetryStep === 'telegram' ? '2/2' : '1/2';

  return (
    <div className="w-full max-w-sm mx-auto select-none pt-1 pb-1">
      {/* Visually Hidden Live Announcement Region */}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      {/* CHASSIS (Ultra-Slim Machined Frame) */}
      <div
        className="relative z-10 w-full rounded-[20px] px-[3px] pt-[3px] pb-0 bg-gradient-to-b from-zinc-200 to-zinc-300 border border-zinc-300/90 shadow-md dark:bg-zinc-900 dark:from-zinc-900 dark:to-zinc-950 dark:border-white/15"
        aria-hidden="false"
      >
        {/* Micro Top Bezel with Sensor Pill */}
        <div className="flex items-center justify-center gap-1.5 pt-[1px] pb-[3px]" aria-hidden="true">
          <div className="w-5 h-[2px] rounded-full bg-zinc-500/50 dark:bg-zinc-600/80" />
          <div className="w-1 h-1 rounded-full bg-zinc-600/80 dark:bg-zinc-400/80" />
        </div>

        {/* AMOLED SCREEN (pitch-dark edge-to-edge OLED viewport) */}
        <div
          data-live={
            (isAbout || isBooting || isDiagnostics || isReporting) && isDocVisible
              ? 'true'
              : 'false'
          }
          className="h-[276px] bg-black rounded-[15px] border border-white/12 shadow-inner overflow-hidden relative flex flex-col justify-between"
        >
          {/* SLEEP SCREEN STATE: Interactive Tap-to-Wake AMOLED AOD */}
          {isSleep && (
            <button
              type="button"
              onClick={triggerBoot}
              aria-label="Wake Fair Judge display"
              className="absolute inset-0 w-full h-full flex flex-col items-center justify-center px-4 select-none z-20 animate-breathe-fade active:scale-[0.99] transition-transform duration-150 motion-reduce:transition-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <BrandBadge
                role={role}
                size="md"
                motion="still"
                className="opacity-65 scale-90"
              />
              <HardwareClock />
              <span className="mt-3 text-[10px] font-mono font-semibold uppercase tracking-[0.18em] text-zinc-300">
                Tap screen to wake
              </span>
            </button>
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
                {/* BOOTING SCREEN STATE */}
                {showBootLayer && (
                  <div
                    className={`relative h-full flex flex-col items-center justify-center text-center px-3 overflow-hidden select-none transition-opacity duration-300 ease-out motion-reduce:transition-none ${
                      bootVisible ? 'opacity-100' : 'opacity-0'
                    }`}
                  >
                    <div className="fj-vm-boot-badge">
                      <BrandBadge role={role} size="md" motion="rock" />
                    </div>
                    <div className="fj-vm-boot-text mt-3 flex flex-col items-center">
                      <h2 className="text-base font-bold tracking-tight text-white leading-tight">
                        Fair Judge
                      </h2>
                      <p
                        className={`text-[10px] tracking-[0.22em] uppercase font-mono font-bold mt-1 ${
                          role === 'organiser' ? 'text-emerald-400' : 'text-amber-400'
                        }`}
                      >
                        JUDGE TRANSPARENTLY
                      </p>
                      <span className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-zinc-300 fj-screen-font mt-2.5">
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
                    className="relative h-full flex flex-col justify-between text-center overflow-hidden select-none"
                  >
                    {/* Ambient Radial Glow */}
                    <div
                      className="absolute inset-0 pointer-events-none flex items-center justify-center fj-loop fj-ambient-glow"
                      style={{
                        background:
                          role === 'organiser'
                            ? 'radial-gradient(circle at 50% 42%, rgba(52, 211, 153, 0.12) 0%, rgba(0, 0, 0, 0) 70%)'
                            : 'radial-gradient(circle at 50% 42%, rgba(251, 191, 36, 0.12) 0%, rgba(0, 0, 0, 0) 70%)',
                      }}
                    />

                    {/* Top Status Strip */}
                    <div className="relative z-10 flex items-center justify-between text-[10px] font-mono font-bold uppercase tracking-[0.14em] text-zinc-300 pb-1 border-b border-white/10">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${
                            isOnlineClient ? 'bg-emerald-400' : 'bg-amber-400'
                          }`}
                        />
                        <span>{isOnlineClient ? 'ONLINE' : 'OFFLINE'}</span>
                      </span>
                      <span className={role === 'organiser' ? 'text-emerald-300' : 'text-amber-300'}>
                        {roleTag}
                      </span>
                    </div>

                    {/* Center Brand + Developer Signature */}
                    <div className="relative z-10 flex-1 flex flex-col items-center justify-center py-1">
                      <div
                        className={`w-8 h-8 rounded-xl flex items-center justify-center border mb-1.5 ${
                          role === 'organiser'
                            ? 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300'
                            : 'bg-amber-500/15 border-amber-500/35 text-amber-300'
                        }`}
                      >
                        <Scale className="w-4 h-4 stroke-[2.2]" />
                      </div>

                      <h2 className="text-base font-bold tracking-tight text-white leading-tight">
                        Fair Judge
                      </h2>
                      <p className="text-[10px] tracking-[0.22em] uppercase font-mono font-bold text-zinc-300 mt-0.5">
                        JUDGE TRANSPARENTLY
                      </p>

                      <div className="fj-word-rise font-semibold text-[10px] uppercase tracking-[0.22em] text-zinc-400 fj-screen-font mt-3 mb-1">
                        ENGINEERED WITH INTENT
                      </div>

                      {/* Precision Hairline + Scanner Dot */}
                      <div className="relative w-[180px] h-[5px] flex items-center justify-center">
                        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[1px] bg-gradient-to-r from-transparent via-zinc-400/70 to-transparent" />
                        <div className="absolute inset-0 flex items-center justify-between px-3 pointer-events-none opacity-50">
                          {Array.from({ length: 9 }).map((_, i) => (
                            <span key={i} className="w-[1px] h-[3px] bg-zinc-300" />
                          ))}
                        </div>
                        <div className="absolute top-1/2 -translate-y-1/2 left-0 w-[3px] h-[3px] rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.9)] fj-loop fj-scanner-dot pointer-events-none" />
                      </div>

                      {/* Staggered Developer Signature */}
                      <div className="relative mt-1.5 flex items-baseline justify-center gap-1.5 overflow-hidden px-2 py-0.5">
                        <span
                          className="fj-word-rise text-[10.5px] text-zinc-300 font-semibold fj-screen-font"
                          style={{ animationDelay: '100ms' }}
                        >
                          By
                        </span>
                        <div className="relative inline-flex items-center gap-1 overflow-hidden">
                          <span
                            className="fj-word-rise text-[13px] font-bold tracking-[0.14em] uppercase text-white fj-screen-font"
                            style={{ animationDelay: '180ms' }}
                          >
                            SAHIL
                          </span>
                          <span
                            className="fj-word-rise text-[13px] font-bold tracking-[0.14em] uppercase text-white fj-screen-font"
                            style={{ animationDelay: '260ms' }}
                          >
                            KUMAR
                          </span>
                          <span
                            className="fj-word-rise text-[13px] font-bold tracking-[0.14em] uppercase text-white fj-screen-font"
                            style={{ animationDelay: '340ms' }}
                          >
                            ROUT
                          </span>
                          <div className="absolute inset-0 pointer-events-none fj-loop fj-light-streak w-[50%] bg-gradient-to-r from-transparent via-white/25 to-transparent -skew-x-12" />
                        </div>
                      </div>
                    </div>

                    {/* Bottom Tactile Action Dock */}
                    <div className="relative z-10 grid grid-cols-[1fr_auto] gap-2 pt-1 shrink-0">
                      <button
                        type="button"
                        onClick={handleNavigateDiagnostics}
                        className={`min-h-[44px] px-3 rounded-xl border text-[13px] font-semibold flex items-center justify-between gap-2 active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                          role === 'organiser'
                            ? 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/55 text-emerald-200'
                            : 'bg-amber-500/15 hover:bg-amber-500/25 border-amber-500/55 text-amber-200'
                        }`}
                      >
                        <span className="inline-flex items-center gap-1.5 truncate">
                          <Activity className="w-4 h-4 shrink-0" />
                          <span>Run Diagnostics</span>
                        </span>
                        <ChevronRight className="w-4 h-4 shrink-0" />
                      </button>

                      <button
                        type="button"
                        onClick={handleOpenReporting}
                        className="min-h-[44px] px-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-600 text-zinc-100 text-[13px] font-semibold inline-flex items-center gap-1.5 active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      >
                        <Send className="w-4 h-4 shrink-0" />
                        <span>Report</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* ENTERPRISE DIAGNOSTICS LAYER */}
                {showDiagnosticsLayer && (
                  <div className="relative h-full flex flex-col text-zinc-100 select-none overflow-hidden animate-in fade-in duration-200">
                    {testRunning && (
                      <div className="absolute inset-x-0 top-0 h-[1px] bg-emerald-400/75 pointer-events-none fj-loop fj-scan-line z-30" />
                    )}

                    {/* Top Terminal Navigation Bar */}
                    <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-white/12 shrink-0">
                      <button
                        type="button"
                        onClick={handleNavigateAbout}
                        className="min-h-[44px] px-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-600 text-zinc-100 text-[13px] font-semibold inline-flex items-center gap-1.5 active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      >
                        <ChevronLeft className="w-4 h-4 stroke-[2.2]" />
                        <span>Back</span>
                      </button>
                      <span className="font-mono text-xs font-bold tracking-[0.1em] uppercase text-zinc-100 truncate">
                        {testRunning ? `SYS.SCAN • ${streamedGroups.length}/6` : 'SYS.DIAGNOSTICS'}
                      </span>
                      {testRunning ? (
                        <span className="min-h-[44px] px-2.5 rounded-xl bg-zinc-900 border border-emerald-500/45 font-mono text-xs font-bold text-emerald-300 tabular-nums inline-flex items-center">
                          {checksCompleted}/{TOTAL_CHECKS}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={handleNavigateDiagnostics}
                          className="min-h-[44px] px-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-600 text-emerald-300 text-[13px] font-semibold inline-flex items-center gap-1.5 active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                        >
                          <RotateCw className="w-3.5 h-3.5" />
                          <span>Re-run</span>
                        </button>
                      )}
                    </div>

                    {/* Circular SVG Percentage Gauge + Verdict + Next Action */}
                    <div className="flex items-center gap-3 py-1.5 border-b border-white/12 shrink-0">
                      <div className="relative w-11 h-11 shrink-0 flex items-center justify-center">
                        <svg viewBox="0 0 56 56" className="w-11 h-11 -rotate-90" aria-hidden="true">
                          <circle
                            cx="28"
                            cy="28"
                            r={GAUGE_RADIUS}
                            fill="none"
                            stroke="rgba(255,255,255,0.12)"
                            strokeWidth="4"
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
                            strokeWidth="4"
                            strokeLinecap="round"
                            strokeDasharray={GAUGE_CIRCUMFERENCE}
                            strokeDashoffset={gaugeOffset}
                            className="fj-gauge-arc"
                          />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          {testRunning ? (
                            <span className="font-mono text-xs font-bold tabular-nums text-emerald-300">
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
                            <div className="text-xs font-bold tracking-[0.08em] uppercase text-white flex items-center gap-1">
                              <span>PROBING SYSTEMS</span>
                              <span className="fj-cursor-blink text-emerald-400" aria-hidden="true">
                                ▌
                              </span>
                            </div>
                            <p className="text-xs font-semibold text-zinc-200 truncate mt-0.5">
                              &gt; {latestCheckLine}
                            </p>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={`text-xs font-bold tracking-[0.08em] uppercase truncate ${verdictDisplay.colorClass}`}
                              >
                                {verdictDisplay.headline}
                              </span>
                              <button
                                type="button"
                                onClick={handleOpenReporting}
                                className="shrink-0 min-h-[44px] text-[13px] font-sans font-semibold px-3 rounded-xl border border-emerald-500/60 bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-200 inline-flex items-center gap-1 active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none cursor-pointer"
                              >
                                <span>Report</span>
                                <ChevronRight className="w-4 h-4 stroke-[2.2]" />
                              </button>
                            </div>
                            <div className="text-xs font-semibold text-zinc-200 tabular-nums mt-0.5 truncate">
                              {verdictDisplay.countsText}
                              {testResult ? ` • ${testResult.totalMs}ms` : ''}
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Comprehensive Scrolling Suite & Check Readout */}
                    <div className="flex-1 min-h-0 overflow-y-auto pt-1.5 pr-1 space-y-2 font-mono text-xs select-text">
                      {/* AUTO-SURFACED CRITICAL FAULTS BLOCK */}
                      {!testRunning && hasCriticalFaults && topProblems.length > 0 && (
                        <div className="rounded-lg border border-red-500/60 bg-red-950/60 p-2.5 space-y-1">
                          <div className="text-xs font-bold uppercase tracking-[0.12em] text-red-300">
                            CRITICAL FAULTS ({topProblems.length})
                          </div>
                          {topProblems.map((prob, idx) => (
                            <div
                              key={`${prob.code || prob.label}_${idx}`}
                              className={prob.status === 'problem' ? 'text-red-200' : 'text-amber-200'}
                            >
                              <span className="font-bold">
                                [{prob.status === 'problem' ? 'FAULT' : 'NOTICE'}]{' '}
                                {prob.code ? `${prob.code} ` : ''}
                                {prob.label}:
                              </span>{' '}
                              <span className="text-zinc-100 font-semibold">{prob.plain}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Detailed Check Suites */}
                      {displayedGroups.map((grp) => (
                        <div
                          key={grp.id}
                          className="rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-2 space-y-1.5"
                        >
                          <div className="flex items-center justify-between border-b border-zinc-800 pb-1">
                            <span className="text-zinc-100 font-bold uppercase tracking-wider">
                              {grp.label}
                            </span>
                            <span
                              className={`font-bold ${
                                grp.problemCount > 0
                                  ? 'text-red-300'
                                  : grp.noticeCount > 0
                                  ? 'text-amber-300'
                                  : 'text-emerald-300'
                              }`}
                            >
                              {grp.okCount}OK/{grp.noticeCount}N/{grp.problemCount}F
                            </span>
                          </div>
                          <div className="space-y-1">
                            {grp.checks.map((chk) => (
                              <div key={chk.id} className="flex items-start justify-between gap-2">
                                <span className="text-zinc-100 font-semibold leading-snug">
                                  › {chk.label}
                                  {chk.status !== 'ok' && (
                                    <span className="block text-zinc-200 text-xs font-semibold pl-2 mt-0.5">
                                      {chk.plain}
                                    </span>
                                  )}
                                </span>
                                <span
                                  className={`shrink-0 font-bold ${
                                    chk.status === 'ok'
                                      ? 'text-emerald-400'
                                      : chk.status === 'notice'
                                      ? 'text-amber-300'
                                      : chk.status === 'problem'
                                      ? 'text-red-400'
                                      : 'text-zinc-200'
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
                        <div className="text-zinc-200 font-semibold py-4 text-center">
                          Awaiting first probe group...
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* TELEMETRY / BUG REPORT LAYER */}
                {showReportingLayer && (
                  <div className="relative flex flex-col h-full text-zinc-100 select-none overflow-hidden animate-in fade-in duration-200">
                    {/* Header Row */}
                    <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-white/12 shrink-0">
                      <button
                        type="button"
                        disabled={reportSubmitting || preparingTelegram}
                        onClick={() => {
                          triggerHaptic('light');
                          playSound('tap');
                          if (telemetryStep !== 'compose' && !reportTicketId) {
                            setTelemetryStep('compose');
                          } else {
                            setScreenState('diagnostics');
                          }
                        }}
                        className="min-h-[44px] px-3 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-600 text-zinc-100 text-[13px] font-semibold inline-flex items-center gap-1.5 active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none cursor-pointer disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      >
                        <ChevronLeft className="w-4 h-4 stroke-[2.2]" />
                        <span>Back</span>
                      </button>
                      <span className="font-mono text-xs font-bold text-zinc-100 tracking-[0.12em] uppercase">
                        SYS.TELEMETRY
                      </span>
                      <span className="min-h-[44px] px-2.5 rounded-xl bg-zinc-900 border border-zinc-700 font-mono text-xs font-bold text-zinc-200 inline-flex items-center">
                        {telemetryStepTag}
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
                          placeholder="Describe what happened..."
                          className="flex-1 min-h-0 w-full bg-zinc-950 border border-zinc-700/80 rounded-xl p-2.5 text-xs font-mono text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:border-emerald-500/70 resize-none mt-2"
                        />

                        {reportError ? (
                          <div
                            role="alert"
                            className="text-[10.5px] font-semibold text-red-300 truncate mt-1.5 shrink-0"
                          >
                            {reportError}
                          </div>
                        ) : (
                          <div className="text-[10.5px] font-medium text-zinc-300 truncate mt-1.5 shrink-0">
                            Attaches diagnostic log &amp; sync queue state
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-2 mt-2 shrink-0">
                          <button
                            type="button"
                            onClick={handleSubmitTelemetry}
                            disabled={reportSubmitting || preparingTelegram}
                            className="min-h-[44px] px-3 text-[13px] font-bold bg-emerald-600 hover:bg-emerald-500 text-zinc-950 rounded-xl inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none"
                          >
                            <Send className="w-4 h-4" />
                            <span>{reportSubmitting ? 'Sending...' : 'Send Report'}</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              playSound('tap');
                              void handleSwitchTelemetryTelegram();
                            }}
                            disabled={reportSubmitting || preparingTelegram}
                            className="min-h-[44px] px-3 text-[13px] font-semibold text-zinc-100 bg-zinc-900 hover:bg-zinc-800 border border-zinc-600 hover:border-emerald-500/60 rounded-xl inline-flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50 active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none"
                          >
                            <span>{preparingTelegram ? 'Preparing...' : 'Telegram'}</span>
                            <ChevronRight className="w-4 h-4 stroke-[2.2]" />
                          </button>
                        </div>
                      </>
                    )}

                    {telemetryStep === 'sent' && (
                      <div className="flex-1 min-h-0 flex flex-col justify-between pt-2.5">
                        <div className="rounded-xl border border-emerald-500/40 bg-emerald-950/40 p-3 space-y-1.5">
                          <div className="text-xs font-bold text-emerald-300 tracking-wider uppercase flex items-center gap-1.5">
                            <Check className="w-4 h-4" />
                            <span>Report Delivered</span>
                          </div>
                          <p className="text-xs font-semibold text-zinc-200 leading-relaxed">
                            Diagnostic log and queue snapshot transmitted to developer inbox.
                          </p>
                          {reportTicketId && (
                            <div className="text-xs font-mono font-bold text-emerald-300">
                              REF #{reportTicketId.slice(0, 8).toUpperCase()}
                            </div>
                          )}
                        </div>

                        <div className="grid grid-cols-2 gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              triggerHaptic('light');
                              playSound('tap');
                              setScreenState('diagnostics');
                            }}
                            className="min-h-[44px] px-3 text-[13px] font-bold bg-emerald-600 hover:bg-emerald-500 text-zinc-950 rounded-xl cursor-pointer active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none"
                          >
                            Done
                          </button>
                          <a
                            href={TELEGRAM_SUPPORT_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => {
                              triggerHaptic('light');
                              playSound('tap');
                            }}
                            className="min-h-[44px] px-3 text-[13px] font-semibold text-center text-zinc-100 bg-zinc-900 hover:bg-zinc-800 border border-zinc-600 rounded-xl inline-flex items-center justify-center gap-1 no-underline active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none"
                          >
                            <span>Open Telegram</span>
                            <ChevronRight className="w-4 h-4 stroke-[2.2]" />
                          </a>
                        </div>
                      </div>
                    )}

                    {telemetryStep === 'telegram' && (
                      <div className="flex-1 min-h-0 flex flex-col justify-between pt-2">
                        <div className="space-y-1.5">
                          <div className="text-xs font-semibold text-amber-300 truncate">
                            {telegramReason || 'Save diagnostic JSON & attach in Telegram:'}
                          </div>
                          <button
                            type="button"
                            onClick={handleDownloadTelemetryBundle}
                            disabled={preparingTelegram}
                            className="w-full min-h-[44px] px-3 text-xs font-semibold text-zinc-100 bg-zinc-900 hover:bg-zinc-800 border border-zinc-600 hover:border-emerald-500/60 rounded-xl cursor-pointer disabled:opacity-50 truncate active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none"
                          >
                            {preparingTelegram
                              ? 'Preparing JSON...'
                              : downloadedFilename
                              ? `Saved: ${downloadedFilename.slice(0, 24)}`
                              : '1. Save Diagnostic JSON'}
                          </button>
                          <button
                            type="button"
                            onClick={handleCopyTelemetrySummary}
                            className="w-full min-h-[44px] px-3 text-xs font-semibold text-zinc-100 bg-zinc-900 hover:bg-zinc-800 border border-zinc-600 hover:border-emerald-500/60 rounded-xl cursor-pointer active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none"
                          >
                            {copiedSummary ? 'Summary Copied ✓' : '2. Copy Summary'}
                          </button>
                        </div>

                        <a
                          href={TELEGRAM_SUPPORT_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => {
                            triggerHaptic('light');
                            playSound('tap');
                          }}
                          className="w-full min-h-[44px] px-3 text-[13px] font-bold text-center bg-emerald-600 hover:bg-emerald-500 text-zinc-950 rounded-xl inline-flex items-center justify-center gap-1.5 no-underline shrink-0 active:scale-[0.98] transition-transform duration-75 ease-out motion-reduce:transition-none"
                        >
                          <span>3. Send via Telegram</span>
                          <ChevronRight className="w-4 h-4 stroke-[2.2]" />
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ULTRA-SLIM CHIN: Status, Sound/Mute Key & Power Key */}
        <div className="py-1.5 px-3 flex items-center justify-between">
          {/* Left: Model & Queue Indicator LED */}
          <div className="flex items-center gap-2">
            <span
              title={ledLabel}
              aria-label={ledLabel}
              className={`w-2 h-2 rounded-full pointer-events-none ${ledClassName}`}
            />
            <span className="font-mono text-[10px] font-bold leading-none tracking-wide text-zinc-700 dark:text-zinc-300">
              FJ • v{APP_VERSION}
            </span>
          </div>

          {/* Right: Hardware Sound/Mute Key + Power Key */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleToggleSound}
              aria-label={isMuted ? 'Unmute interface sounds' : 'Mute interface sounds'}
              aria-pressed={!isMuted}
              title={isMuted ? 'Sound muted (tap to unmute)' : 'Sound on (tap to mute)'}
              className="w-7 h-7 rounded-full bg-zinc-800 shadow-[inset_0_1px_1px_rgba(255,255,255,0.16),0_1px_3px_rgba(0,0,0,0.45)] border border-zinc-700 active:scale-[0.92] transition-transform motion-reduce:transition-none flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              {isMuted ? (
                <VolumeX className="w-3.5 h-3.5 text-zinc-400" aria-hidden="true" />
              ) : (
                <Volume2 className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
              )}
            </button>

            <button
              type="button"
              onClick={handlePowerToggle}
              aria-label={isSleep ? 'Power on hardware display' : 'Power off hardware display'}
              aria-pressed={isAwake}
              title={isSleep ? 'Power on display' : 'Sleep display'}
              className={`w-7 h-7 rounded-full bg-zinc-800 shadow-[inset_0_1px_1px_rgba(255,255,255,0.16),0_1px_3px_rgba(0,0,0,0.45)] border active:scale-[0.92] transition-transform motion-reduce:transition-none flex items-center justify-center cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                isAwake
                  ? role === 'organiser'
                    ? 'border-emerald-500/60'
                    : 'border-amber-500/60'
                  : 'border-zinc-700'
              }`}
            >
              <Power
                className={`w-3.5 h-3.5 transition-opacity duration-200 ${
                  isAwake
                    ? role === 'organiser'
                      ? 'text-emerald-400 opacity-100'
                      : 'text-amber-400 opacity-100'
                    : 'text-zinc-300 opacity-85'
                }`}
                aria-hidden="true"
              />
            </button>
          </div>
        </div>
      </div>

      {/* Caption below chassis */}
      <p className="text-center text-xs text-zinc-700 dark:text-zinc-300 mt-2.5 px-2 font-medium leading-relaxed text-balance max-w-[30ch] mx-auto">
        Scores save on this phone first, then sync when you&apos;re online.
      </p>

      <div className="flex justify-center mt-1">
        <button
          type="button"
          onClick={handleOpenReporting}
          className="min-h-[44px] px-3 inline-flex items-center gap-1.5 text-xs font-semibold text-zinc-700 hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-white cursor-pointer"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send bug report to developer</span>
        </button>
      </div>
    </div>
  );
};
