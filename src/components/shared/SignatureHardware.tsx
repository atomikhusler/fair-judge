import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Scale } from 'lucide-react';
import { APP_VERSION } from '../../config/version';
import { triggerHaptic } from '../../lib/haptics';

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
  const autoWakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wakePhaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    };
  }, []);

  const handleSwitchChange = useCallback(
    (newPos: SwitchPosition) => {
      if (newPos === position) return;

      sessionLastPosition = newPos;
      hasAutoWokenInSession = true;
      setPosition(newPos);
      triggerHaptic('tick');

      if (newPos === 'sleep') {
        setWakeStage('sleeping');
        setAnnouncement('Terminal in sleep mode');
      } else if (newPos === 'about') {
        setWakeStage('blinking');
        setAnnouncement('Terminal awake: About Fair Judge');
        setTimeout(() => setWakeStage('awake'), 240);
      } else {
        setWakeStage('awake');
        setAnnouncement('Terminal self-test mode');
      }
    },
    [position]
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

  const isSleep = position === 'sleep';
  const isTest = position === 'test';
  const isAbout = position === 'about';

  // Knob translation: 0% for sleep, 100% for about, 200% for test
  const knobTranslate = isSleep ? 'translate-x-0' : isAbout ? 'translate-x-full' : 'translate-x-[200%]';

  return (
    <div className="w-full max-w-sm mx-auto select-none pt-2 pb-1">
      {/* Accessibility Announcement */}
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>

      {/* CHASSIS */}
      <div
        className="relative z-10 w-full rounded-2xl p-2 bg-gradient-to-b from-zinc-100 to-zinc-300 border border-zinc-300 shadow-sm dark:bg-zinc-900 dark:border-zinc-800 dark:border-t-white/10 dark:from-zinc-900 dark:to-zinc-900"
      >
        {/* Top Bezel with 4px Webcam Dot */}
        <div className="flex items-center justify-center pb-1.5" aria-hidden="true">
          <div className="w-1 h-1 rounded-full bg-zinc-600/70 dark:bg-zinc-500" />
        </div>

        {/* OLED SCREEN (always dark background) */}
        <div
          className={`h-[220px] bg-zinc-950 rounded-xl border border-white/10 shadow-inner overflow-hidden relative flex flex-col justify-between p-3.5 transition-opacity duration-250 ease-out ${
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
            className={`absolute top-0 left-1/2 -translate-x-1/2 w-[70%] h-3 bg-white/25 blur-[6px] rounded-full pointer-events-none transition-opacity duration-300 ${
              isSleep ? 'opacity-0' : wakeStage === 'blinking' ? 'animate-wake-blink' : 'opacity-100'
            }`}
            aria-hidden="true"
          />

          {/* SLEEP SCREEN STATE OVERLAY */}
          {isSleep && (
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-20">
              <Scale
                className="w-12 h-12 text-zinc-500 opacity-15 stroke-[1.5]"
                aria-hidden="true"
              />
              <span className="text-[10px] uppercase font-mono tracking-widest text-zinc-400 opacity-40 mt-3">
                Slide to wake
              </span>
            </div>
          )}

          {/* ABOUT SCREEN STATE */}
          {isAbout && (
            <div
              className={`h-full flex flex-col items-center justify-center text-center space-y-2 py-2 transition-all duration-300 ${
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
                <p className="text-[10px] tracking-[0.25em] uppercase font-mono text-zinc-300">
                  Judge Transparently
                </p>
              </div>

              {/* Signature */}
              <div className="pt-2 text-[11px] font-mono text-zinc-300 tracking-wide">
                Engineered with intent. <span className="text-zinc-400">&lt;/&gt;</span> Sahil Kumar Rout
              </div>
            </div>
          )}

          {/* TEST SCREEN STATE (Phase 1 Header & Sweep) */}
          {isTest && (
            <div className="h-full flex flex-col justify-between py-1 animate-line-in">
              {/* Sweep Line */}
              <div className="w-full h-0.5 bg-gradient-to-r from-emerald-400 via-amber-400 to-emerald-400 animate-sweep rounded-full" />

              {/* Header */}
              <div className="flex items-center justify-between border-b border-white/10 pb-2">
                <span className="text-[11px] font-mono font-bold tracking-wider text-zinc-200 uppercase">
                  FAIR JUDGE · SELF-TEST
                </span>
                <span className="text-[10px] font-mono text-zinc-400">
                  READY
                </span>
              </div>

              {/* Phase 1 Test Terminal Placeholder */}
              <div className="my-auto text-center space-y-1 py-4">
                <div className="inline-flex items-center space-x-1.5 px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] font-mono text-zinc-300">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  <span>Engine Primed • Phase 1 Gate</span>
                </div>
                <p className="text-[11px] font-mono text-zinc-400">
                  Hardware switch and chassis active
                </p>
              </div>

              <div className="text-[10px] font-mono text-zinc-500 text-center">
                Switch to ABOUT or SLEEP to exit
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
            className="relative h-11 rounded-xl bg-zinc-200/90 dark:bg-zinc-950/90 border border-zinc-300 dark:border-white/10 shadow-inner flex items-center p-1 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
          >
            {/* Sliding 28px Knob Indicator */}
            <div
              className={`absolute top-1 left-1 bottom-1 w-[calc((100%-8px)/3)] flex items-center justify-center pointer-events-none transition-transform duration-350 ease-[cubic-bezier(0.32,0.72,0,1)] ${knobTranslate}`}
              style={{ willChange: 'transform' }}
            >
              <div className="w-7 h-7 rounded-lg bg-gradient-to-b from-white to-zinc-200 dark:from-zinc-100 dark:to-zinc-300 shadow-md border border-zinc-300/60 dark:border-zinc-400/50" />
            </div>

            {/* 3 Clickable Zones (Min 44px Tap Height) */}
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
                    className={`h-full min-h-[44px] flex items-center justify-center text-[10px] font-mono font-bold tracking-wider uppercase transition-colors duration-150 cursor-pointer select-none rounded-lg ${
                      isSelected
                        ? 'text-zinc-900 font-extrabold'
                        : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200'
                    }`}
                  >
                    {pos}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Chin Row B: LED Indicator & Version / Status */}
          <div className="flex items-center justify-between px-1 text-xs">
            {/* Left: LED indicator */}
            <div className="flex items-center space-x-2">
              <div className="relative w-2.5 h-2.5 flex items-center justify-center">
                {/* Sleep Breathing LED */}
                {isSleep && (
                  <span className="w-2 h-2 rounded-full bg-zinc-400 dark:bg-white animate-led-breathe shadow-xs" />
                )}
                {/* Awake Steady White LED */}
                {isAbout && (
                  <span className="w-2 h-2 rounded-full bg-zinc-900 dark:bg-white opacity-90 shadow-xs" />
                )}
                {/* Test Mode LED */}
                {isTest && (
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-led-soft-pulse shadow-xs" />
                )}
              </div>
              <span className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400">
                {isSleep ? 'STANDBY' : isTest ? 'TEST ACTIVE' : 'ONLINE'}
              </span>
            </div>

            {/* Right: Version */}
            <div className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
              FJ • v{APP_VERSION}
            </div>
          </div>
        </div>
      </div>

      {/* Caption below everything */}
      <p className="text-center text-[11px] text-zinc-500 dark:text-zinc-400 font-mono mt-2.5 px-2">
        Scores save on this phone first, then sync when you're online.
      </p>
    </div>
  );
};
