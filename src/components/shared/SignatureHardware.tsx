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
  ChevronRight,
  Code
} from 'lucide-react';
import { APP_VERSION } from '../../config/version';
import { TELEGRAM_SUPPORT_URL } from '../../config/support';
import { triggerHaptic } from '../../lib/haptics';
import { 
  runSelfTest, 
  SelfTestRunResult, 
  SelfTestGroupResult, 
  getLastTestResult, 
  formatCheckedTimeAgo,
  generateSelfTestReport,
  downloadReportFile
} from '../../lib/selfTest';
import { getFailedMutations } from '../../lib/offlineQueue';
import { blackBox } from '../../lib/blackBox';
import { showToast } from '../common/ToastProvider';

export type HardwareRole = 'organiser' | 'judge';
export type SwitchPosition = 'sleep' | 'about' | 'test';

interface SignatureHardwareProps {
  role: HardwareRole;
}

// Module-level session memory
let hasAutoWokenInSession = false;
let sessionLastPosition: SwitchPosition = 'about';

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

  // Clear Log Double-Tap Confirmation State
  const [confirmClearLog, setConfirmClearLog] = useState(false);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const autoWakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakePhaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Passive check: detect failed mutations for initial orange LED signal
  useEffect(() => {
    getFailedMutations()
      .then((muts) => {
        if (muts && muts.length > 0) {
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
        triggerHaptic('tick');

        wakePhaseTimerRef.current = setTimeout(() => {
          setWakeStage('awake');
        }, 240);
      }, 300);
    }

    return () => {
      if (autoWakeTimerRef.current) clearTimeout(autoWakeTimerRef.current);
      if (wakePhaseTimerRef.current) clearTimeout(wakePhaseTimerRef.current);
      if (abortControllerRef.current) abortControllerRef.current.abort();
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    };
  }, []);

  // Launch self-test when switching into 'test' position
  const launchSelfTest = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setTestRunning(true);
    setStreamedGroups([]);
    setExpandedGroupId(null);

    try {
      const result = await runSelfTest(role, controller.signal, (group) => {
        setStreamedGroups((prev) => {
          const filtered = prev.filter((g) => g.id !== group.id);
          return [...filtered, group];
        });
      });

      if (!controller.signal.aborted) {
        setTestResult(result);
        setTestRunning(false);
        setLastCheckedTime('Checked just now');

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
        setTestRunning(false);
      }

      if (newPos === 'sleep') {
        setWakeStage('sleeping');
        setAnnouncement('Terminal in sleep mode');
      } else if (newPos === 'about') {
        setWakeStage('blinking');
        setAnnouncement('Terminal awake: About Fair Judge');
        setTimeout(() => setWakeStage('awake'), 240);
      } else if (newPos === 'test') {
        setWakeStage('awake');
        setAnnouncement('Initiating Fair Judge hardware self-test');
        launchSelfTest();
      }
    },
    [position, launchSelfTest]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (position === 'test') handleSwitchChange('about');
      else if (position === 'about') handleSwitchChange('sleep');
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (position === 'sleep') handleSwitchChange('about');
      else if (position === 'about') handleSwitchChange('test');
    }
  };

  // 1. Send to Developer Action
  const handleSendToDeveloper = async () => {
    triggerHaptic('tick');
    if (!testResult) return;
    try {
      const { filename, jsonContent, summaryLines } = await generateSelfTestReport(role, testResult);
      // (1) Download file
      downloadReportFile(filename, jsonContent);

      // (2) Copy 3-line summary to clipboard
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(summaryLines);
        }
      } catch {}

      // (3) Open Telegram support URL
      window.open(TELEGRAM_SUPPORT_URL, '_blank', 'noopener,noreferrer');

      // (4) Toast
      showToast('Report saved. Attach it in the Telegram group.', 'success');
    } catch {
      showToast('Failed to generate diagnostic report', 'error');
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

  // Knob translation: 0% for sleep, 100% for about, 200% for test
  const knobTranslate = isSleep ? 'translate-x-0' : isAbout ? 'translate-x-full' : 'translate-x-[200%]';

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

          {/* ABOUT SCREEN STATE */}
          {isAbout && (
            <div
              className={`h-full flex flex-col items-center justify-center text-center space-y-2.5 my-auto transition-transform duration-300 motion-reduce:transition-none ${
                wakeStage === 'blinking' ? 'opacity-70 translate-y-1' : 'opacity-100 translate-y-0'
              }`}
            >
              {/* Logo Mark */}
              <div
                className={`w-12 h-12 rounded-2xl flex items-center justify-center border shadow-xs ${
                  role === 'organiser'
                    ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                    : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                }`}
              >
                <Scale className="w-6 h-6 stroke-[2.2]" />
              </div>

              {/* Title & Slogan */}
              <div className="space-y-0.5">
                <h2 className="text-lg font-black tracking-tight text-zinc-50">
                  Fair Judge
                </h2>
                <p className="text-[10px] tracking-[0.25em] uppercase font-mono text-zinc-400">
                  Judge Transparently
                </p>
              </div>

              {/* Developer Credit - Option B */}
              <div className="pt-2 flex flex-col items-center justify-center text-center max-w-[280px] mx-auto">
                <span className="text-[9px] font-bold tracking-[0.2em] uppercase text-zinc-400">
                  ENGINEERED WITH INTENT
                </span>
                <div className="flex items-center justify-center gap-1.5 mt-1 text-xs font-semibold text-zinc-200">
                  <Code className="w-3.5 h-3.5 text-emerald-400 shrink-0" strokeWidth={2.2} />
                  <span>Sahil Kumar Rout</span>
                  <Code className="w-3.5 h-3.5 text-emerald-400 shrink-0" strokeWidth={2.2} />
                </div>
              </div>
            </div>
          )}

          {/* TEST SCREEN STATE (Lines stream in + verdict) */}
          {isTest && (
            <div className="h-full flex flex-col justify-between py-0.5 animate-line-in text-zinc-50">
              {/* Thin Sweep Line */}
              <div className="w-full h-0.5 bg-gradient-to-r from-emerald-400 via-amber-400 to-emerald-400 animate-sweep rounded-full" />

              {/* Header */}
              <div className="flex items-center justify-between border-b border-white/10 pb-1.5 pt-1">
                <span className="text-[10px] font-mono font-bold tracking-wider text-zinc-200 uppercase">
                  FAIR JUDGE · SELF-TEST
                </span>
                <span className="text-[10px] font-mono text-zinc-400">
                  {testRunning ? 'RUNNING PROBES...' : testResult?.verdict || 'READY'}
                </span>
              </div>

              {/* Group Lines Area (Fixed Height reserved, inner scroll if needed) */}
              <div className="flex-1 overflow-y-auto py-1 space-y-1 pr-0.5">
                {displayedGroups.length === 0 && testRunning && (
                  <div className="flex items-center justify-center h-full text-[10px] font-mono text-zinc-400">
                    Probing system primitives...
                  </div>
                )}

                {displayedGroups.map((grp) => {
                  const isExpanded = expandedGroupId === grp.id;
                  return (
                    <button
                      key={grp.id}
                      type="button"
                      onClick={() => setExpandedGroupId(isExpanded ? null : grp.id)}
                      className={`w-full flex items-center justify-between px-2 py-1 rounded text-left transition-colors duration-150 cursor-pointer animate-line-in motion-reduce:transition-none ${
                        isExpanded ? 'bg-white/10 text-white' : 'hover:bg-white/5 text-zinc-300'
                      }`}
                    >
                      <div className="flex items-center space-x-1.5 truncate">
                        {grp.problemCount > 0 ? (
                          <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                        ) : grp.noticeCount > 0 ? (
                          <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0" />
                        ) : grp.skippedCount > 0 && grp.okCount === 0 ? (
                          <Minus className="w-3 h-3 text-zinc-400 shrink-0" />
                        ) : (
                          <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                        )}
                        <span className="text-[11px] font-mono truncate">{grp.label}</span>
                      </div>

                      <div className="flex items-center space-x-1 shrink-0 font-mono text-[10px]">
                        {grp.problemCount > 0 ? (
                          <span className="text-red-400 font-bold">{grp.problemCount} issue</span>
                        ) : grp.noticeCount > 0 ? (
                          <span className="text-amber-400">{grp.noticeCount} notice</span>
                        ) : (
                          <span className="text-emerald-400">{grp.okCount} pass</span>
                        )}
                        <ChevronRight className={`w-3 h-3 text-zinc-500 transition-transform motion-reduce:transition-none ${isExpanded ? 'rotate-90' : ''}`} />
                      </div>
                    </button>
                  );
                })}
              </div>

              {/* Bottom Verdict Line */}
              <div className="pt-1 border-t border-white/10 flex items-center justify-between text-[10px] font-mono">
                <span className="text-zinc-400">
                  {testRunning ? 'Parallel audit in flight...' : `Total: ${testResult?.groups.length || 0} suites`}
                </span>
                <span
                  className={`font-bold ${
                    testResult?.verdict === 'MAJOR'
                      ? 'text-red-400'
                      : testResult?.verdict === 'MINOR'
                      ? 'text-amber-400'
                      : 'text-emerald-400'
                  }`}
                >
                  {testResult?.verdict || 'AWAITING VERDICT'}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* CHIN */}
        <div className="pt-2 space-y-2">
          {/* Chin Row A: 3-Position Switch */}
          <div
            role="radiogroup"
            aria-label="Terminal Mode"
            tabIndex={0}
            onKeyDown={handleKeyDown}
            className="relative h-11 rounded-xl bg-zinc-200/90 dark:bg-zinc-950/90 border border-zinc-300 dark:border-white/10 shadow-inner flex items-center p-1 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 shadow-[0_0_12px_rgba(255,255,255,0.03)]"
          >
            {/* Sliding Small Pill/Dot Knob Indicator with Faint Glow */}
            <div
              className={`absolute top-1 left-1 bottom-1 w-[calc((100%-8px)/3)] flex items-center justify-center pointer-events-none transition-transform duration-350 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none ${knobTranslate}`}
              style={{ willChange: 'transform' }}
            >
              <div className="w-[calc(100%-4px)] h-7 rounded-lg bg-gradient-to-b from-white to-zinc-200 dark:from-zinc-100 dark:to-zinc-300 shadow-md border border-zinc-300/60 dark:border-zinc-400/50 shadow-[0_0_8px_rgba(255,255,255,0.2)]" />
            </div>

            {/* 3 Clickable Zones (Min 44px Tap Height, Press Scale 0.97, Never Clipped) */}
            <div className="grid grid-cols-3 relative z-10 w-full h-full">
              {(['sleep', 'about', 'test'] as const).map((pos) => {
                const isSelected = position === pos;
                return (
                  <button
                    key={pos}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => handleSwitchChange(pos)}
                    className={`h-full min-h-[44px] px-1 flex items-center justify-center text-[10px] font-mono font-bold tracking-wider uppercase transition-colors duration-150 cursor-pointer select-none rounded-lg active:scale-[0.97] transition-transform duration-75 ease-out will-change-transform ${
                      isSelected
                        ? 'text-zinc-900 font-extrabold'
                        : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
                    }`}
                  >
                    <span className="truncate px-0.5">{pos}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Chin Row B: LED Indicator & Version / Status */}
          <div className="flex items-center justify-between px-1 text-xs">
            {/* Left: LED indicator (Stacked dots, opacity crossfade only) */}
            <div className="flex items-center space-x-2">
              <div className="relative w-2.5 h-2.5 flex items-center justify-center">
                {/* 1. Sleep Breathing LED */}
                {isSleep && (
                  <span className="absolute inset-0 rounded-full bg-zinc-400 dark:bg-white animate-led-breathe shadow-xs" />
                )}

                {/* 2. Awake Steady White LED (or Orange if passive queue failed) */}
                {isAbout && (
                  <span
                    className={`absolute inset-0 rounded-full shadow-xs ${
                      hasFailedQueueItems && !testResult
                        ? 'bg-amber-500 opacity-95'
                        : 'bg-zinc-900 dark:bg-white opacity-90'
                    }`}
                  />
                )}

                {/* 3. Test Running Pulse White LED */}
                {isTest && testRunning && (
                  <span className="absolute inset-0 rounded-full bg-white animate-led-soft-pulse shadow-xs" />
                )}

                {/* 4. Test Done Verdict LED */}
                {isTest && !testRunning && testResult && (
                  <>
                    {testResult.verdict === 'ALL CLEAR' && (
                      <span className="absolute inset-0 rounded-full bg-emerald-500 opacity-100 shadow-xs" />
                    )}
                    {testResult.verdict === 'MINOR' && (
                      <span className="absolute inset-0 rounded-full bg-amber-500 animate-led-warning-pulse shadow-xs" />
                    )}
                    {testResult.verdict === 'MAJOR' && (
                      <span className="absolute inset-0 rounded-full bg-red-500 animate-led-warning-pulse shadow-xs" />
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
                <div className="sticky bottom-0 pt-2 pb-1 bg-white/95 dark:bg-zinc-900/95 border-t border-zinc-200/80 dark:border-zinc-800 space-y-1.5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                    {/* 1. Send to Developer */}
                    <button
                      type="button"
                      onClick={handleSendToDeveloper}
                      disabled={!testResult}
                      aria-label="Send diagnostic report to developer on Telegram"
                      className="min-h-[44px] px-2.5 py-2 rounded-xl bg-zinc-900 text-white dark:bg-white dark:text-zinc-950 font-mono font-bold text-[10px] uppercase tracking-wider flex items-center justify-center space-x-1.5 cursor-pointer disabled:opacity-40 active:scale-95 transition-transform motion-reduce:transform-none shadow-xs"
                    >
                      <Send className="w-3 h-3 shrink-0" />
                      <span className="truncate">Send to Dev</span>
                    </button>

                    {/* 2. Download Report */}
                    <button
                      type="button"
                      onClick={handleDownloadReport}
                      disabled={!testResult}
                      aria-label="Download diagnostic report JSON"
                      className="min-h-[44px] px-2.5 py-2 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 border border-zinc-300 dark:border-zinc-700 font-mono font-bold text-[10px] uppercase tracking-wider flex items-center justify-center space-x-1.5 cursor-pointer disabled:opacity-40 active:scale-95 transition-transform motion-reduce:transform-none shadow-xs"
                    >
                      <Download className="w-3 h-3 shrink-0" />
                      <span className="truncate">Download</span>
                    </button>

                    {/* 3. Clear Error Log (Tap twice to confirm) */}
                    <button
                      type="button"
                      onClick={handleClearErrorLog}
                      aria-label="Clear flight recorder error log (tap twice to confirm)"
                      className={`min-h-[44px] px-2 py-2 rounded-xl font-mono font-bold text-[10px] uppercase tracking-wider flex items-center justify-center space-x-1.5 cursor-pointer active:scale-95 transition-transform motion-reduce:transform-none border shadow-xs ${
                        confirmClearLog
                          ? 'bg-red-500 text-white border-red-600 animate-pulse'
                          : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      <Trash2 className="w-3 h-3 shrink-0" />
                      <span className="truncate">{confirmClearLog ? 'Confirm Clear' : 'Clear Log'}</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Caption below everything (normal font) */}
      <p className="text-center text-xs text-zinc-500 dark:text-zinc-400 mt-2.5 px-2 font-normal leading-relaxed">
        Scores save on this phone first, then sync when you're online.
      </p>
    </div>
  );
};
