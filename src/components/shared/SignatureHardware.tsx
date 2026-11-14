import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Scale, 
  Check, 
  AlertTriangle, 
  XCircle, 
  Minus, 
  Send, 
  Download, 
  Trash2,
  ChevronRight
} from 'lucide-react';
import { APP_VERSION } from '../../config/version';
import { triggerHaptic } from '../../lib/haptics';
import { SupportReportModal } from './SupportReportModal';
import { 
  runSelfTest, 
  SelfTestRunResult, 
  SelfTestGroupResult, 
  getLastTestResult, 
  formatCheckedTimeAgo,
  generateSelfTestReport,
  downloadReportFile
} from '../../lib/selfTest';
import { getFailedMutations, getFailedScores, downloadDiagnosticLog } from '../../lib/offlineQueue';
import { blackBox } from '../../lib/blackBox';
import { buildFullBugLog } from '../../lib/bugLog';
import { downloadJson } from '../../lib/downloadUtils';
import { showToast } from '../common/ToastProvider';

export type HardwareRole = 'organiser' | 'judge';
export type SwitchPosition = 'sleep' | 'about' | 'test';

interface SignatureHardwareProps {
  role: HardwareRole;
}

const TOTAL_CHECKS = 39;

const GROUP_SHORT_CODES: Record<string, string> = {
  device_app: 'DEV',
  network_backend: 'NET',
  storage_offline: 'STR',
  data_integrity: 'INT',
  code_health: 'HLT',
  scoring_engine: 'SC',
};

const LINE_OPACITIES = [0.2, 0.3, 0.45, 0.6, 0.8, 1.0];

interface DiagnosticConsoleLine {
  id: string;
  groupShort: string;
  label: string;
  status: 'OK' | 'NOTICE' | 'FAIL' | 'SKIP';
  ms?: number;
}

// Module-level session memory
let hasAutoWokenInSession = false;
let sessionLastPosition: SwitchPosition = 'about';

export function resetSignatureHardwareSession(): void {
  hasAutoWokenInSession = false;
  sessionLastPosition = 'about';
}

const HARDWARE_KEYS: Array<{ id: SwitchPosition; label: string; ariaLabel: string }> = [
  { id: 'sleep', label: 'SLEEP', ariaLabel: 'Sleep' },
  { id: 'about', label: 'ABOUT', ariaLabel: 'About' },
  { id: 'test', label: 'TEST', ariaLabel: 'Run diagnostics' },
];

export const SignatureHardware: React.FC<SignatureHardwareProps> = ({ role }) => {
  // If not yet auto-woken in this session, start in 'sleep' and auto-wake; otherwise restore last position
  const [position, setPosition] = useState<SwitchPosition>(() => {
    return hasAutoWokenInSession ? sessionLastPosition : 'sleep';
  });

  const [wakeStage, setWakeStage] = useState<'sleeping' | 'blinking' | 'awake'>(() => {
    if (hasAutoWokenInSession && sessionLastPosition !== 'sleep') {
      return 'awake';
    }
    return 'sleeping';
  });

  const [announcement, setAnnouncement] = useState<string>('');
  const [hasFailedQueueItems, setHasFailedQueueItems] = useState(false);

  // Self-Test State
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<SelfTestRunResult | null>(() => getLastTestResult().result);
  const [lastCheckedTime, setLastCheckedTime] = useState<string | null>(() => formatCheckedTimeAgo(getLastTestResult().timestamp));
  const [streamedGroups, setStreamedGroups] = useState<SelfTestGroupResult[]>([]);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);

  // Diagnostic Console & Paced Stream State
  const [consoleLines, setConsoleLines] = useState<DiagnosticConsoleLine[]>([]);
  const [completedChecksCount, setCompletedChecksCount] = useState<number>(0);
  const queuedChecksRef = useRef<DiagnosticConsoleLine[]>([]);
  const pacingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isTestResolvingRef = useRef<boolean>(false);
  const [isDocVisible, setIsDocVisible] = useState(() =>
    typeof document !== 'undefined' ? !document.hidden : true
  );

  // Clear Log Double-Tap Confirmation State
  const [confirmClearLog, setConfirmClearLog] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Full Bug Log Download State
  const [isPreparingBugLog, setIsPreparingBugLog] = useState(false);
  const [savedBugLogFilename, setSavedBugLogFilename] = useState<string | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keycap physical press tracking & support report sheet
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const [isSupportModalOpen, setIsSupportModalOpen] = useState(false);

  const autoWakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakePhaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Lazy font loading for Geist
  useEffect(() => {
    if (position === 'about' && typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.load('300 12px Geist').catch(() => {});
    }
  }, [position]);

  // Tab visibility tracking & interval cleanup
  useEffect(() => {
    const handleVis = () => {
      const visible = typeof document !== 'undefined' ? !document.hidden : true;
      setIsDocVisible(visible);
      if (!visible && pacingIntervalRef.current) {
        clearInterval(pacingIntervalRef.current);
        pacingIntervalRef.current = null;
      }
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => {
      document.removeEventListener('visibilitychange', handleVis);
    };
  }, []);

  // Passive check: detect failed mutations or failed scores for initial orange LED signal
  useEffect(() => {
    Promise.all([
      getFailedMutations().catch(() => []),
      getFailedScores().catch(() => []),
    ])
      .then(([muts, failedScores]) => {
        if ((muts && muts.length > 0) || (failedScores && failedScores.length > 0)) {
          setHasFailedQueueItems(true);
        }
      })
      .catch(() => {});
  }, []);

  // Update "Checked N min ago" label upon open (no timers/polling)
  useEffect(() => {
    const { timestamp } = getLastTestResult();
    if (timestamp) {
      setLastCheckedTime(formatCheckedTimeAgo(timestamp));
    }
  }, []);

  // Auto-wake logic on first mount in this app session
  useEffect(() => {
    if (!hasAutoWokenInSession) {
      autoWakeTimerRef.current = setTimeout(() => {
        hasAutoWokenInSession = true;
        sessionLastPosition = 'about';
        setPosition('about');
        setWakeStage('blinking');

        wakePhaseTimerRef.current = setTimeout(() => {
          setWakeStage('awake');
        }, 240);
      }, 300);
    }

    return () => {
      if (autoWakeTimerRef.current) clearTimeout(autoWakeTimerRef.current);
      if (wakePhaseTimerRef.current) clearTimeout(wakePhaseTimerRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
      if (pacingIntervalRef.current) clearInterval(pacingIntervalRef.current);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // Launch self-test when switching into 'test' position
  const launchSelfTest = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (pacingIntervalRef.current) {
      clearInterval(pacingIntervalRef.current);
      pacingIntervalRef.current = null;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setTestRunning(true);
    setStreamedGroups([]);
    setExpandedGroupId(null);
    setConsoleLines([]);
    setCompletedChecksCount(0);
    queuedChecksRef.current = [];
    isTestResolvingRef.current = false;

    const isReducedMotion = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const startPacingInterval = () => {
      if (pacingIntervalRef.current !== null || isReducedMotion) return;
      pacingIntervalRef.current = setInterval(() => {
        if (queuedChecksRef.current.length > 0) {
          const nextLine = queuedChecksRef.current.shift()!;
          setConsoleLines((prev) => [...prev, nextLine]);
          setCompletedChecksCount((c) => Math.min(TOTAL_CHECKS, c + 1));
        } else if (isTestResolvingRef.current) {
          if (pacingIntervalRef.current) {
            clearInterval(pacingIntervalRef.current);
            pacingIntervalRef.current = null;
          }
          setTestRunning(false);
        }
      }, 70);
    };

    try {
      const result = await runSelfTest(
        role,
        controller.signal,
        (group) => {
          setStreamedGroups((prev) => {
            const filtered = prev.filter((g) => g.id !== group.id);
            return [...filtered, group];
          });
        },
        (chk, index) => {
          const groupShort = GROUP_SHORT_CODES[chk.group] || 'SYS';
          const status = chk.status === 'ok' ? 'OK' : chk.status === 'notice' ? 'NOTICE' : chk.status === 'problem' ? 'FAIL' : 'SKIP';
          const line: DiagnosticConsoleLine = {
            id: `${chk.id}_${index}`,
            groupShort,
            label: chk.label,
            status,
          };

          if (isReducedMotion) {
            setConsoleLines((prev) => [...prev, line]);
            setCompletedChecksCount((c) => Math.min(TOTAL_CHECKS, c + 1));
          } else {
            queuedChecksRef.current.push(line);
            startPacingInterval();
          }
        }
      );

      if (!controller.signal.aborted) {
        setTestResult(result);
        setLastCheckedTime('Checked just now');
        isTestResolvingRef.current = true;

        if (isReducedMotion) {
          setTestRunning(false);
          setCompletedChecksCount(TOTAL_CHECKS);
        } else if (queuedChecksRef.current.length === 0) {
          if (pacingIntervalRef.current) {
            clearInterval(pacingIntervalRef.current);
            pacingIntervalRef.current = null;
          }
          setTestRunning(false);
          setCompletedChecksCount(TOTAL_CHECKS);
        }

        // Verdict haptic pattern & screen reader announcement
        if (result.verdict === 'ALL CLEAR') {
          triggerHaptic('success');
          setAnnouncement('Self-test finished: All clear');
        } else {
          triggerHaptic('warning');
          setAnnouncement(`Self-test finished: ${result.problemTotal} problem(s), ${result.noticeTotal} notice(s)`);
        }
      }
    } catch (err: any) {
      if (err.message !== 'TEST_ABORTED') {
        if (pacingIntervalRef.current) {
          clearInterval(pacingIntervalRef.current);
          pacingIntervalRef.current = null;
        }
        setTestRunning(false);
      }
    }
  }, [role]);

  const handleSwitchChange = useCallback(
    (newPos: SwitchPosition) => {
      if (newPos === position) return;

      sessionLastPosition = newPos;
      hasAutoWokenInSession = true;
      setPosition(newPos);
      triggerHaptic('tick');

      // Closing results panel on switch movement
      setExpandedGroupId(null);

      // Abort any ongoing test if leaving 'test'
      if (position === 'test' && newPos !== 'test') {
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
        }
        if (pacingIntervalRef.current) {
          clearInterval(pacingIntervalRef.current);
          pacingIntervalRef.current = null;
        }
        setTestRunning(false);
      }

      if (wakePhaseTimerRef.current) {
        clearTimeout(wakePhaseTimerRef.current);
        wakePhaseTimerRef.current = null;
      }

      if (newPos === 'sleep') {
        setWakeStage('sleeping');
        setAnnouncement('Terminal in sleep mode');
      } else if (newPos === 'about') {
        setWakeStage('blinking');
        setAnnouncement('Terminal awake: About Fair Judge');
        wakePhaseTimerRef.current = setTimeout(() => {
          wakePhaseTimerRef.current = null;
          setWakeStage('awake');
        }, 240);
      } else if (newPos === 'test') {
        setWakeStage('awake');
        setAnnouncement('Initiating Fair Judge hardware self-test');
        launchSelfTest();
      }
    },
    [position, launchSelfTest]
  );

  // 3.6 Behaviour: tap SLEEP -> screen sleeps. Tap ABOUT -> wakes into About.
  // Tap TEST -> runs diagnostics. Tapping the already-lit ABOUT or lit TEST (when finished) returns to SLEEP.
  // Tapping TEST while a run is in progress is ignored (no re-entrancy).
  const handleKeyClick = useCallback(
    (key: SwitchPosition) => {
      if (key === 'sleep') {
        handleSwitchChange('sleep');
        return;
      }

      if (key === 'about') {
        if (position === 'about') {
          handleSwitchChange('sleep');
        } else {
          handleSwitchChange('about');
        }
        return;
      }

      if (key === 'test') {
        if (testRunning) {
          return;
        }
        if (position === 'test') {
          handleSwitchChange('sleep');
        } else {
          handleSwitchChange('test');
        }
        return;
      }
    },
    [position, testRunning, handleSwitchChange]
  );

  const handleKeyNav = (e: React.KeyboardEvent, currentKey: SwitchPosition) => {
    const keyOrder: SwitchPosition[] = ['sleep', 'about', 'test'];
    const currentIndex = keyOrder.indexOf(currentKey);

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = keyOrder[(currentIndex - 1 + keyOrder.length) % keyOrder.length];
      handleKeyClick(prev);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = keyOrder[(currentIndex + 1) % keyOrder.length];
      handleKeyClick(next);
    }
  };

  // 1. Send to Developer Action (opens C2+C3 Support Modal)
  const handleSendToDeveloper = () => {
    triggerHaptic('tick');
    setIsSupportModalOpen(true);
  };

  // 0. Primary Action: Full Bug Log Download
  const handleDownloadFullBugLog = async () => {
    triggerHaptic('tick');
    setIsPreparingBugLog(true);
    try {
      const { bundle, filename } = await buildFullBugLog(role);
      const savedName = downloadJson(filename, bundle);
      setSavedBugLogFilename(savedName);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setSavedBugLogFilename(null);
      }, 4000);
      showToast(`Saved: ${savedName}`, 'success');
    } catch {
      showToast('Failed to build full bug log', 'error');
    } finally {
      setIsPreparingBugLog(false);
    }
  };

  // 1. Queue Log Action
  const handleDownloadQueueLog = async () => {
    triggerHaptic('tick');
    try {
      const filename = await downloadDiagnosticLog();
      showToast(`Queue log saved: ${filename}`, 'info');
    } catch {
      showToast('Failed to export queue log', 'error');
    }
  };

  // 2. Download Report Action
  const handleDownloadReport = async () => {
    triggerHaptic('tick');
    if (!testResult) return;
    try {
      const { filename, jsonContent } = await generateSelfTestReport(role, testResult);
      downloadReportFile(filename, jsonContent);
      showToast('Diagnostic report saved to downloads', 'info');
    } catch {
      showToast('Failed to export report', 'error');
    }
  };

  // 3. Clear Error Log (Double-tap to confirm)
  const handleClearErrorLog = () => {
    triggerHaptic('tick');
    if (!confirmClearLog) {
      setConfirmClearLog(true);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      clearTimerRef.current = setTimeout(() => {
        setConfirmClearLog(false);
      }, 4000);
    } else {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      blackBox.clearLog();
      setConfirmClearLog(false);
      showToast('Flight recorder error log cleared', 'info');
    }
  };

  const isSleep = position === 'sleep';
  const isTest = position === 'test';
  const isAbout = position === 'about';

  // Active expanded group details for results panel
  const activeGroup = (testResult?.groups || streamedGroups).find((g) => g.id === expandedGroupId);

  // Group line ordering
  const displayedGroups = testRunning ? streamedGroups : testResult?.groups || streamedGroups;

  return (
    <div className="w-full max-w-sm mx-auto select-none pt-2 pb-1">
      {/* Visually Hidden Live Announcement Region */}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      {/* CHASSIS (Theme-Adaptive, Aria-Hidden laptop frame) */}
      <div 
        className="relative z-10 w-full rounded-2xl p-2 bg-gradient-to-b from-zinc-100 to-zinc-300 border border-zinc-300 shadow-sm dark:bg-zinc-900 dark:border-zinc-800 dark:border-t-white/10 dark:from-zinc-900 dark:to-zinc-900"
        aria-hidden="false"
      >
        {/* Top Bezel with 4px Webcam Dot */}
        <div className="flex items-center justify-center pb-1.5" aria-hidden="true">
          <div className="w-1 h-1 rounded-full bg-zinc-600/70 dark:bg-zinc-500" />
        </div>

        {/* OLED SCREEN (always dark background, fixed height) */}
        <div
          data-live={isAbout && isDocVisible ? 'true' : 'false'}
          className={`h-[220px] bg-zinc-950 rounded-xl border border-white/10 shadow-inner overflow-hidden relative flex flex-col justify-between p-3.5 transition-opacity duration-250 ease-out motion-reduce:transition-none ${
            isSleep ? 'opacity-[0.08]' : 'opacity-100'
          }`}
          style={{ willChange: 'opacity' }}
        >
          {/* Radial Ambient Backlight Layer */}
          <div
            className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.06),transparent_70%)]"
            aria-hidden="true"
          />

          {/* Top Backlight Bar & Separate Glow Layer */}
          <div
            className="absolute top-1 left-1/2 -translate-x-1/2 w-[60%] h-0.5 rounded-full bg-white/40 pointer-events-none z-10"
            aria-hidden="true"
          />
          <div
            className={`absolute top-0 left-1/2 -translate-x-1/2 w-[70%] h-3 bg-white/25 blur-[6px] rounded-full pointer-events-none transition-opacity duration-300 motion-reduce:transition-none ${
              isSleep ? 'opacity-0' : wakeStage === 'blinking' ? 'animate-wake-blink' : 'opacity-100'
            }`}
            aria-hidden="true"
          />

          {/* SLEEP SCREEN STATE OVERLAY */}
          {isSleep && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-20">
              <Scale className="w-12 h-12 text-zinc-500 opacity-15 stroke-[1.5]" aria-hidden="true" />
              <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-400 opacity-40 mt-3">
                Slide to wake
              </span>
            </div>
          )}

          {/* ABOUT SCREEN STATE (Restored App Identity + Developer Signature) */}
          {isAbout && (
            <div
              role="region"
              aria-label="Fair Judge — Judge Transparently. Engineered with intent by Sahil Kumar Rout"
              className={`relative h-full flex flex-col items-center justify-center text-center px-3 overflow-hidden select-none transition-transform duration-300 motion-reduce:transition-none ${
                wakeStage === 'blinking' ? 'opacity-70 translate-y-1' : 'opacity-100 translate-y-0'
              }`}
            >
              {/* Ambient Radial Glow */}
              <div
                className="absolute inset-0 pointer-events-none flex items-center justify-center fj-loop fj-ambient-glow"
                style={{
                  background: 'radial-gradient(circle at 50% 50%, rgba(52, 211, 153, 0.08) 0%, rgba(0, 0, 0, 0) 70%)',
                }}
              />

              {/* 1. APP BRANDING (Top Group) */}
              <div className="flex flex-col items-center justify-center">
                {/* Logo Mark: Scales tinted by role */}
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center border shadow-xs mb-1.5 ${
                    role === 'organiser'
                      ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                      : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                  }`}
                >
                  <Scale className="w-4 h-4 stroke-[2.2]" />
                </div>

                {/* App Name */}
                <h2 className="text-sm font-semibold tracking-tight text-zinc-100 leading-tight">
                  Fair Judge
                </h2>

                {/* Tagline */}
                <p className="text-[9px] tracking-[0.25em] uppercase font-mono text-zinc-400 mt-0.5">
                  JUDGE TRANSPARENTLY
                </p>
              </div>

              {/* Separator / Spacer */}
              <div className="my-2" />

              {/* 2. DEVELOPER SIGNATURE (Bottom Group) */}
              <div className="flex flex-col items-center justify-center">
                {/* Title: ENGINEERED WITH INTENT */}
                <div className="fj-word-rise font-normal text-[8.5px] uppercase tracking-[0.28em] text-zinc-500 fj-screen-font mb-1.5">
                  ENGINEERED WITH INTENT
                </div>

                {/* Hairline with 9 tiny ticks and 3px emerald scanner dot */}
                <div className="relative w-[180px] h-[5px] flex items-center justify-center">
                  {/* Hairline */}
                  <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-[1px] bg-gradient-to-r from-transparent via-zinc-500/60 to-transparent" />

                  {/* 9 tiny ticks */}
                  <div className="absolute inset-0 flex items-center justify-between px-3 pointer-events-none opacity-35">
                    {Array.from({ length: 9 }).map((_, i) => (
                      <span key={i} className="w-[1px] h-[3px] bg-zinc-400" />
                    ))}
                  </div>

                  {/* 3px emerald scanner dot */}
                  <div className="absolute top-1/2 -translate-y-1/2 left-0 w-[3px] h-[3px] rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.9)] fj-loop fj-scanner-dot pointer-events-none" />
                </div>

                {/* Staggered words & sheen light streak */}
                <div className="relative mt-1.5 flex items-baseline justify-center gap-1.5 overflow-hidden px-2 py-0.5">
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

                    {/* Light streak sweep across name */}
                    <div className="absolute inset-0 pointer-events-none fj-loop fj-light-streak w-[50%] bg-gradient-to-r from-transparent via-white/20 to-transparent -skew-x-12" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TEST SCREEN STATE (Diagnostics Console & Ring Gauge) */}
          {isTest && (
            <div className="h-full flex flex-col justify-between py-0.5 text-zinc-50 relative">
              {/* Scan Line: 1px emerald sweeping top to bottom while running */}
              {testRunning && (
                <div className="absolute inset-x-0 top-0 h-[1px] bg-emerald-400/50 pointer-events-none fj-loop fj-scan-line z-30" />
              )}

              {/* Header row: left DIAGNOSTICS; right {done}/{total} */}
              <div className="flex items-center justify-between pb-1 border-b border-white/10 select-none">
                <span className="fj-screen-font font-normal text-[10px] tracking-[0.3em] uppercase text-zinc-400">
                  DIAGNOSTICS
                </span>
                <span className="font-mono text-[10px] text-zinc-400 tabular-nums">
                  {completedChecksCount}/{TOTAL_CHECKS}
                </span>
              </div>

              {/* Center Row: Ring Gauge (left) + Console (right) */}
              <div className="flex items-center gap-2.5 flex-1 min-h-0 py-1.5">
                {/* Ring Gauge & Verdict under ring */}
                {(() => {
                  const progress = completedChecksCount / TOTAL_CHECKS;
                  const isNominal = testResult && testResult.problemTotal === 0 && testResult.noticeTotal === 0;
                  const isAttention = testResult && testResult.problemTotal === 0 && testResult.noticeTotal > 0;
                  const arcColor = testRunning
                    ? '#fbbf24'
                    : isNominal
                    ? '#34d399'
                    : isAttention
                    ? '#f59e0b'
                    : '#f87171';

                  return (
                    <div className="flex flex-col items-center justify-center shrink-0 w-[72px]">
                      <div className="relative w-16 h-16 flex items-center justify-center">
                        <svg className="w-16 h-16 -rotate-90 pointer-events-none" viewBox="0 0 64 64">
                          {/* 24 tick marks */}
                          {Array.from({ length: 24 }).map((_, i) => (
                            <line
                              key={i}
                              x1="32"
                              y1="2"
                              x2="32"
                              y2="4"
                              stroke="#71717a"
                              strokeWidth="1"
                              opacity="0.25"
                              transform={`rotate(${i * 15} 32 32)`}
                            />
                          ))}
                          {/* Track */}
                          <circle cx="32" cy="32" r="26" fill="none" stroke="#27272a" strokeWidth="3.5" />
                          {/* Progress arc (permitted stroke-dashoffset transition) */}
                          <circle
                            cx="32"
                            cy="32"
                            r="26"
                            fill="none"
                            stroke={arcColor}
                            strokeWidth="3.5"
                            strokeLinecap="round"
                            strokeDasharray="163.4"
                            strokeDashoffset={163.4 * (1 - (testRunning ? progress : 1))}
                            className="fj-gauge-arc"
                          />
                        </svg>
                        {/* Gauge center icon or percent */}
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          {testRunning ? (
                            <span className="text-[11px] font-mono font-bold text-zinc-200 tabular-nums">
                              {Math.round(progress * 100)}%
                            </span>
                          ) : isNominal ? (
                            <Check className="w-4 h-4 text-emerald-400 stroke-[2.5]" />
                          ) : isAttention ? (
                            <AlertTriangle className="w-4 h-4 text-amber-400 stroke-[2.5]" />
                          ) : (
                            <XCircle className="w-4 h-4 text-red-400 stroke-[2.5]" />
                          )}
                        </div>
                      </div>

                      {/* Verdict text under ring: Geist 500, 12px, tracking-[0.3em] uppercase */}
                      <span
                        className={`fj-screen-font font-medium text-[11px] tracking-[0.3em] uppercase mt-1 text-center truncate ${
                          testRunning
                            ? 'text-zinc-500'
                            : isNominal
                            ? 'text-emerald-400'
                            : isAttention
                            ? 'text-amber-400'
                            : 'text-red-400'
                        }`}
                      >
                        {testRunning ? 'PROBING' : isNominal ? 'NOMINAL' : isAttention ? 'ATTENTION' : 'CRITICAL'}
                      </span>
                    </div>
                  );
                })()}

                {/* Diagnostic Console: 6 lines x 16px, mono 10px, zinc-300, opacities [.2, .3, .45, .6, .8, 1] */}
                {(() => {
                  const visibleLines = consoleLines.slice(-6);
                  const opacities = LINE_OPACITIES.slice(LINE_OPACITIES.length - visibleLines.length);

                  return (
                    <div
                      className="flex-1 h-[96px] overflow-hidden flex flex-col justify-end bg-black/40 rounded-lg p-2 border border-white/5 font-mono text-[10px] leading-[15px] select-none"
                      aria-live="off"
                    >
                      {visibleLines.length === 0 && (
                        <div className="text-zinc-500 italic py-1">Initializing probes...</div>
                      )}
                      {visibleLines.map((line, idx) => {
                        const opacity = opacities[idx] ?? 1;
                        const isLatest = idx === visibleLines.length - 1;
                        return (
                          <div
                            key={line.id}
                            className="fj-console-line-in flex items-center justify-between text-zinc-300 truncate"
                            style={{ opacity }}
                          >
                            <span className="truncate pr-1">
                              › <span className="text-zinc-400">{line.groupShort}</span>.{line.label}
                            </span>
                            <span className="shrink-0 flex items-center gap-1 font-semibold">
                              <span
                                className={
                                  line.status === 'OK'
                                    ? 'text-emerald-400'
                                    : line.status === 'NOTICE'
                                    ? 'text-amber-400'
                                    : line.status === 'FAIL'
                                    ? 'text-red-400'
                                    : 'text-zinc-500'
                                }
                              >
                                {line.status}
                              </span>
                              {isLatest && testRunning && (
                                <span className="fj-cursor-blink text-emerald-400 font-bold">▌</span>
                              )}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* Bottom line: suites count and expand toggle */}
              <div className="pt-1 border-t border-white/10 flex items-center justify-between text-[10px] font-mono text-zinc-400">
                <span>
                  {testRunning ? 'Parallel audit in flight...' : `Total: ${testResult?.groups.length || 6} suites`}
                </span>
                {testResult && (
                  <button
                    type="button"
                    onClick={() => setExpandedGroupId(expandedGroupId ? null : testResult.groups[0]?.id || 'device_app')}
                    className="text-zinc-400 hover:text-white transition-colors cursor-pointer underline underline-offset-2"
                  >
                    {expandedGroupId ? 'Hide details' : 'View details'}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* CHIN */}
        <div className="pt-2 space-y-2">
          {/* Chin Row A: 3 Physical Keycaps */}
          <div
            role="radiogroup"
            aria-label="Laptop mode"
            className="flex items-center justify-center gap-[6px] py-1"
          >
            {HARDWARE_KEYS.map((k) => {
              const isSelected = position === k.id;
              const isPressed = pressedKey === k.id;
              return (
                <button
                  key={k.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  aria-label={k.ariaLabel}
                  onPointerDown={() => {
                    triggerHaptic('light');
                    setPressedKey(k.id);
                  }}
                  onPointerUp={() => setPressedKey(null)}
                  onPointerLeave={() => setPressedKey(null)}
                  onClick={() => handleKeyClick(k.id)}
                  onKeyDown={(e) => handleKeyNav(e, k.id)}
                  className="h-[44px] px-0.5 flex items-center justify-center bg-transparent border-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-200 dark:focus-visible:ring-offset-zinc-900 rounded-[8px]"
                >
                  <div
                    data-pressed={isPressed}
                    className="fj-keycap w-[52px] h-[28px] fj-keycap-face"
                  >
                    {/* Unpressed pre-rendered shadow */}
                    <div className="fj-keycap-shadow-rest" />
                    {/* Pressed pre-rendered shadow */}
                    <div className="fj-keycap-shadow-pressed" />

                    {/* Active LED indicator: 4px dot at top-centre with static glow */}
                    {k.id === 'about' && (
                      <span
                        className={`absolute top-[3px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.9)] transition-opacity duration-150 motion-reduce:transition-none pointer-events-none ${
                          isSelected ? 'opacity-100' : 'opacity-0'
                        }`}
                      />
                    )}

                    {k.id === 'test' && (
                      <div className="absolute top-[3px] left-1/2 -translate-x-1/2 w-1 h-1 pointer-events-none">
                        {/* 1. Amber while running */}
                        <span
                          className={`absolute inset-0 rounded-full bg-amber-400 shadow-[0_0_5px_rgba(251,191,36,0.9)] transition-opacity duration-150 motion-reduce:transition-none ${
                            isSelected && testRunning ? 'opacity-100' : 'opacity-0'
                          }`}
                        />
                        {/* 2. Green on nominal / clear */}
                        <span
                          className={`absolute inset-0 rounded-full bg-emerald-400 shadow-[0_0_5px_rgba(52,211,153,0.9)] transition-opacity duration-150 motion-reduce:transition-none ${
                            isSelected && !testRunning && testResult && (testResult.verdict === 'ALL CLEAR' || (testResult.problemTotal === 0 && testResult.noticeTotal === 0)) ? 'opacity-100' : 'opacity-0'
                          }`}
                        />
                        {/* 3. Orange on notice */}
                        <span
                          className={`absolute inset-0 rounded-full bg-amber-500 shadow-[0_0_5px_rgba(245,158,11,0.9)] transition-opacity duration-150 motion-reduce:transition-none ${
                            isSelected && !testRunning && testResult && (testResult.verdict === 'MINOR' || (testResult.problemTotal === 0 && testResult.noticeTotal > 0)) ? 'opacity-100' : 'opacity-0'
                          }`}
                        />
                        {/* 4. Red on problem */}
                        <span
                          className={`absolute inset-0 rounded-full bg-red-400 shadow-[0_0_5px_rgba(248,113,113,0.9)] transition-opacity duration-150 motion-reduce:transition-none ${
                            isSelected && !testRunning && testResult && (testResult.verdict === 'MAJOR' || testResult.problemTotal > 0) ? 'opacity-100' : 'opacity-0'
                          }`}
                        />
                      </div>
                    )}

                    {/* Legend text: 9px mono-ish uppercase, tracking-[0.14em], font-medium */}
                    <span
                      className={`text-[9px] font-mono tracking-[0.14em] uppercase transition-colors duration-150 motion-reduce:transition-none select-none ${
                        isSelected
                          ? 'text-zinc-900 dark:text-zinc-100 font-semibold'
                          : 'text-zinc-500 dark:text-zinc-400 font-medium'
                      } ${k.id !== 'sleep' ? 'pt-1' : ''}`}
                    >
                      {k.label}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Chin Row B: LED Indicator & Version / Status */}
          <div className="flex items-center justify-between px-1 text-xs">
            {/* Left: LED indicator (Stacked dots, opacity crossfade only) */}
            <div className="flex items-center space-x-2">
              <div className="relative w-2.5 h-2.5 flex items-center justify-center">
                {/* 1. Sleep Breathing LED */}
                {isSleep && (
                  <span className="absolute inset-0 rounded-full bg-zinc-400 dark:bg-white animate-led-breathe shadow-[0_0_5px_rgba(255,255,255,0.4)] ring-1 ring-zinc-400/20" />
                )}

                {/* 2. Awake Steady Emerald LED for READY (or Orange if passive queue failed) */}
                {isAbout && (
                  <span
                    className={`absolute inset-0 rounded-full ${
                      hasFailedQueueItems && !testResult
                        ? 'bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.85)] ring-1 ring-amber-500/30 opacity-95'
                        : 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.85)] ring-1 ring-emerald-500/30 opacity-95'
                    }`}
                  />
                )}

                {/* 3. Test Running Pulse White/Amber LED */}
                {isTest && testRunning && (
                  <span className="absolute inset-0 rounded-full bg-amber-400 animate-led-soft-pulse shadow-[0_0_6px_rgba(251,191,36,0.85)] ring-1 ring-amber-400/30" />
                )}

                {/* 4. Test Done Verdict LED */}
                {isTest && !testRunning && testResult && (
                  <>
                    {testResult.verdict === 'ALL CLEAR' && (
                      <span className="absolute inset-0 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.85)] ring-1 ring-emerald-500/30 opacity-100" />
                    )}
                    {testResult.verdict === 'MINOR' && (
                      <span className="absolute inset-0 rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.85)] ring-1 ring-amber-500/30 animate-led-warning-pulse" />
                    )}
                    {testResult.verdict === 'MAJOR' && (
                      <span className="absolute inset-0 rounded-full bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.85)] ring-1 ring-red-500/30 animate-led-warning-pulse" />
                    )}
                  </>
                )}
              </div>

              {/* Status or Checked Time Label */}
              <span className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                {isSleep
                  ? 'STANDBY'
                  : isTest
                  ? testRunning
                    ? 'RUNNING'
                    : testResult?.verdict || 'READY'
                  : lastCheckedTime || 'READY'}
              </span>
            </div>

            {/* Right: Version */}
            <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              FJ • v{APP_VERSION}
            </div>
          </div>
        </div>
      </div>

      {/* RESULTS PANEL (Slides out from behind chassis, overlaps ~8px, lower z-index) */}
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out motion-reduce:transition-none relative -mt-2 z-0 ${
          expandedGroupId && activeGroup
            ? 'grid-rows-[1fr] opacity-100'
            : 'grid-rows-[0fr] opacity-0 pointer-events-none'
        }`}
      >
        <div className="overflow-hidden">
          <div className="pt-4 pb-2 px-3 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-b-2xl shadow-md max-h-[50vh] overflow-y-auto space-y-2">
            {activeGroup && (
              <>
                <div className="flex items-center justify-between pb-2 border-b border-zinc-100 dark:border-zinc-800">
                  <span className="text-xs font-bold font-mono uppercase text-zinc-900 dark:text-zinc-100">
                    {activeGroup.label} Checks
                  </span>
                  <button
                    type="button"
                    onClick={() => setExpandedGroupId(null)}
                    className="text-[10px] font-mono text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 cursor-pointer min-h-[44px] flex items-center px-1"
                  >
                    Close
                  </button>
                </div>

                {/* Checks List */}
                <div className="space-y-1.5 pt-1">
                  {activeGroup.checks.map((chk) => (
                    <div
                      key={chk.id}
                      className="p-2 rounded-xl bg-zinc-50 dark:bg-zinc-950/60 border border-zinc-200/60 dark:border-zinc-800/60 space-y-0.5"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center space-x-1.5 font-medium text-zinc-900 dark:text-zinc-100">
                          {chk.status === 'ok' && <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
                          {chk.status === 'notice' && <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />}
                          {chk.status === 'problem' && <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />}
                          {chk.status === 'skipped' && <Minus className="w-3.5 h-3.5 text-zinc-400 shrink-0" />}
                          <span className="truncate">{chk.label}</span>
                        </div>
                        {chk.code && (
                          <span className="font-mono text-[10px] text-zinc-400 shrink-0 ml-2">
                            {chk.code}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-zinc-600 dark:text-zinc-400 pl-5">
                        {chk.plain}
                      </p>
                    </div>
                  ))}
                </div>

                {/* Sticky Action Footer */}
                <div className="sticky bottom-0 pt-2 pb-1 bg-white/95 dark:bg-zinc-900/95 border-t border-zinc-200/80 dark:border-zinc-800 space-y-2">
                  {/* Action Buttons: Physical Keycap Aesthetic (min-w 92px, h 30px, 10px uppercase legends) */}
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    {/* 1. Download full bug log (Primary keycap with thin emerald top edge) */}
                    <button
                      type="button"
                      onClick={handleDownloadFullBugLog}
                      disabled={isPreparingBugLog}
                      onPointerDown={() => {
                        triggerHaptic('light');
                        setPressedKey('buglog');
                      }}
                      onPointerUp={() => setPressedKey(null)}
                      onPointerLeave={() => setPressedKey(null)}
                      aria-label="Download full bug log bundle"
                      className="h-[44px] flex items-center justify-center bg-transparent border-0 cursor-pointer disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 rounded-[8px]"
                    >
                      <div
                        data-pressed={pressedKey === 'buglog'}
                        className="fj-keycap min-w-[92px] h-[30px] px-3.5 fj-keycap-face border-t border-emerald-500/80 dark:border-emerald-400"
                      >
                        <div className="fj-keycap-shadow-rest" />
                        <div className="fj-keycap-shadow-pressed" />
                        <div className="flex items-center space-x-1.5 z-10">
                          <Download className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                          <span className="text-[10px] font-mono font-medium tracking-[0.12em] uppercase text-zinc-900 dark:text-zinc-100 truncate">
                            {isPreparingBugLog ? 'Preparing…' : 'Full Bug Log'}
                          </span>
                        </div>
                      </div>
                    </button>

                    {/* 2. Send to Developer keycap */}
                    <button
                      type="button"
                      onClick={handleSendToDeveloper}
                      onPointerDown={() => {
                        triggerHaptic('light');
                        setPressedKey('send-dev');
                      }}
                      onPointerUp={() => setPressedKey(null)}
                      onPointerLeave={() => setPressedKey(null)}
                      aria-label="Send bug report and diagnostics to developer"
                      className="h-[44px] flex items-center justify-center bg-transparent border-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 rounded-[8px]"
                    >
                      <div
                        data-pressed={pressedKey === 'send-dev'}
                        className="fj-keycap min-w-[92px] h-[30px] px-3 fj-keycap-face"
                      >
                        <div className="fj-keycap-shadow-rest" />
                        <div className="fj-keycap-shadow-pressed" />
                        <div className="flex items-center space-x-1.5 z-10">
                          <Send className="w-3 h-3 text-zinc-600 dark:text-zinc-400 shrink-0" />
                          <span className="text-[10px] font-mono font-medium tracking-[0.12em] uppercase text-zinc-700 dark:text-zinc-300 truncate">
                            Send to Dev
                          </span>
                        </div>
                      </div>
                    </button>

                    {/* 3. Clear Log keycap (Double-tap to confirm) */}
                    <button
                      type="button"
                      onClick={handleClearErrorLog}
                      onPointerDown={() => {
                        triggerHaptic('light');
                        setPressedKey('clear-log');
                      }}
                      onPointerUp={() => setPressedKey(null)}
                      onPointerLeave={() => setPressedKey(null)}
                      aria-label="Clear flight recorder error log (tap twice to confirm)"
                      className="h-[44px] flex items-center justify-center bg-transparent border-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 rounded-[8px]"
                    >
                      <div
                        data-pressed={pressedKey === 'clear-log'}
                        className={`fj-keycap min-w-[92px] h-[30px] px-3 fj-keycap-face ${
                          confirmClearLog ? 'border-t border-red-500' : ''
                        }`}
                      >
                        <div className="fj-keycap-shadow-rest" />
                        <div className="fj-keycap-shadow-pressed" />
                        <div className="flex items-center space-x-1.5 z-10">
                          <Trash2
                            className={`w-3 h-3 shrink-0 ${
                              confirmClearLog ? 'text-red-500' : 'text-zinc-600 dark:text-zinc-400'
                            }`}
                          />
                          <span
                            className={`text-[10px] font-mono font-medium tracking-[0.12em] uppercase truncate ${
                              confirmClearLog
                                ? 'text-red-600 dark:text-red-400 font-bold'
                                : 'text-zinc-700 dark:text-zinc-300'
                            }`}
                          >
                            {confirmClearLog ? 'Confirm' : 'Clear Log'}
                          </span>
                        </div>
                      </div>
                    </button>
                  </div>

                  {savedBugLogFilename && (
                    <div
                      className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400 text-center py-0.5 truncate"
                      role="status"
                    >
                      Saved: {savedBugLogFilename}
                    </div>
                  )}

                  {/* Secondary Links for direct individual exports */}
                  <div className="flex items-center justify-center space-x-3 text-[10px] font-mono text-zinc-500 dark:text-zinc-400 pt-0.5">
                    <button
                      type="button"
                      onClick={handleDownloadReport}
                      disabled={!testResult}
                      className="hover:text-zinc-800 dark:hover:text-zinc-200 underline cursor-pointer disabled:opacity-40"
                    >
                      Diagnostic Report
                    </button>
                    <span>•</span>
                    <button
                      type="button"
                      onClick={handleDownloadQueueLog}
                      className="hover:text-zinc-800 dark:hover:text-zinc-200 underline cursor-pointer"
                    >
                      Queue Log
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Caption below everything (normal font, text-balance) */}
      <p className="text-center text-xs text-zinc-500 dark:text-zinc-400 mt-2.5 px-2 font-normal leading-relaxed text-balance max-w-[28ch] mx-auto">
        Scores save on this phone first, then sync when you're online.
      </p>

      <div className="flex justify-center mt-1">
        <button
          type="button"
          onClick={handleSendToDeveloper}
          className="min-h-[44px] px-3 inline-flex items-center gap-1.5 text-xs font-medium text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 cursor-pointer"
        >
          <Send className="w-3.5 h-3.5" />
          <span>Send bug report to developer</span>
        </button>
      </div>

      <SupportReportModal
        open={isSupportModalOpen}
        role={role}
        testResult={testResult}
        onClose={() => setIsSupportModalOpen(false)}
      />
    </div>
  );
};
