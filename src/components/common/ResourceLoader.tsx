import React, { useEffect, useState, useMemo } from 'react';
import { Scale, ShieldCheck, Database, Loader2 } from 'lucide-react';

export interface ResourceLoaderProps {
  isLoading: boolean;
  progress: number; // 0 to 100
  statusText: string;
  title?: string;
  onComplete?: () => void;
  className?: string;
}

export function ResourceLoader({
  isLoading,
  progress,
  statusText,
  title = 'Fair Judge',
  onComplete,
  className = '',
}: ResourceLoaderProps) {
  const [internalProgress, setInternalProgress] = useState(progress);
  const [isRendered, setIsRendered] = useState(isLoading);
  const [isExiting, setIsExiting] = useState(false);
  const [isSuccessFlashed, setIsSuccessFlashed] = useState(false);

  // Smoothly sync internal progress, clamping between 0 and 100
  useEffect(() => {
    const clamped = Math.min(100, Math.max(0, progress));
    setInternalProgress(clamped);
  }, [progress]);

  // Lock body scrolling while the loader overlay is mounted and visible
  useEffect(() => {
    if (isRendered) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [isRendered]);

  // Handle completion lifecycle & exit transitions
  useEffect(() => {
    if (!isLoading && isRendered) {
      // Force progress to 100% when loading completes
      setInternalProgress(100);
      setIsSuccessFlashed(true);

      const exitTimer = setTimeout(() => {
        setIsExiting(true);
      }, 500);

      const unmountTimer = setTimeout(() => {
        setIsRendered(false);
        setIsExiting(false);
        setIsSuccessFlashed(false);
        if (onComplete) {
          onComplete();
        }
      }, 1200);

      return () => {
        clearTimeout(exitTimer);
        clearTimeout(unmountTimer);
      };
    } else if (isLoading) {
      setIsRendered(true);
      setIsExiting(false);
      if (internalProgress >= 100) {
        setIsSuccessFlashed(true);
      } else {
        setIsSuccessFlashed(false);
      }
    }
  }, [isLoading, isRendered, internalProgress, onComplete]);

  // Trigger success flash whenever progress reaches 100%
  useEffect(() => {
    if (internalProgress >= 100) {
      setIsSuccessFlashed(true);
    }
  }, [internalProgress]);

  if (!isRendered) {
    return null;
  }

  const isCompleted = internalProgress >= 100;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${title} is loading: ${statusText} (${Math.round(internalProgress)}%)`}
      className={`fixed inset-0 z-[200] flex flex-col items-center justify-center bg-zinc-950 backdrop-blur-md select-none overflow-hidden pb-safe transition-all duration-700 ease-in-out ${
        isExiting
          ? 'opacity-0 scale-[0.98] pointer-events-none'
          : 'opacity-100 scale-100 pointer-events-auto'
      } ${className}`}
    >
      {/* Ambient Luminescent Emerald Bloom */}
      <div
        className="absolute w-[420px] h-[420px] rounded-full bg-emerald-500/10 blur-[130px] pointer-events-none transition-opacity duration-1000"
        style={{ opacity: isCompleted ? 0.8 : 0.4 }}
      />

      <div className="relative flex flex-col items-center text-center px-6 max-w-sm w-full animate-in fade-in zoom-in-95 duration-500">
        {/* Brand Icon with Radiant Pulse-Ring */}
        <div className="relative flex items-center justify-center mb-5">
          {/* Outer Ping Ring */}
          <div
            className={`absolute -inset-3 rounded-3xl border border-emerald-500/30 pointer-events-none transition-all duration-500 ${
              isCompleted
                ? 'scale-110 border-emerald-400/50 opacity-0'
                : 'animate-ping opacity-25'
            }`}
          />

          {/* Secondary Soft Pulse */}
          <div
            className={`absolute -inset-1.5 rounded-2xl bg-emerald-500/15 pointer-events-none transition-all duration-500 ${
              isCompleted ? 'bg-emerald-400/25 scale-105' : 'animate-pulse'
            }`}
          />

          {/* Icon Box */}
          <div
            className={`w-16 h-16 rounded-2xl flex items-center justify-center transition-all duration-500 relative z-10 shadow-lg ${
              isCompleted
                ? 'bg-emerald-500/20 border-2 border-emerald-400 text-emerald-300 shadow-emerald-500/30 scale-105'
                : 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 shadow-emerald-500/20'
            }`}
          >
            {isCompleted ? (
              <ShieldCheck className="w-8 h-8 text-emerald-300 stroke-[2.3] transition-transform duration-300 scale-110" />
            ) : (
              <Scale className="w-8 h-8 text-emerald-400 stroke-[2.2] transition-transform duration-300" />
            )}
          </div>
        </div>

        {/* Brand Title */}
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-sans">
          {title}
        </h1>

        {/* Dynamic Status Subtitle */}
        <p className="text-xs sm:text-sm font-medium text-zinc-400 mt-2 flex items-center justify-center gap-2 tracking-wide min-h-[1.5rem]">
          {isCompleted ? (
            <span className="text-emerald-400 font-semibold flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              {statusText || 'Ready'}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-zinc-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400 shrink-0" />
              <span>{statusText || 'Initializing Shell...'}</span>
            </span>
          )}
        </p>

        {/* Progress Bar Container */}
        <div className="w-full max-w-xs mt-6">
          <div
            className="w-full h-2 bg-zinc-900 border border-zinc-800 rounded-full overflow-hidden relative shadow-inner"
            role="progressbar"
            aria-valuenow={Math.round(internalProgress)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            {/* Active Inner Indicator Line */}
            <div
              className={`h-full rounded-full transition-all duration-300 ease-out relative overflow-hidden ${
                isCompleted || isSuccessFlashed
                  ? 'bg-gradient-to-r from-emerald-400 to-teal-300 shadow-[0_0_12px_rgba(52,211,153,0.9)]'
                  : 'bg-emerald-500'
              }`}
              style={{ width: `${internalProgress}%` }}
            >
              {/* Shimmer Light Sweep across active indicator */}
              {!isCompleted && (
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent -translate-x-full animate-progress-shimmer pointer-events-none" />
              )}
            </div>
          </div>

          {/* Progress Sub-Bar Info Row */}
          <div className="flex items-center justify-between text-[11px] font-mono text-zinc-500 mt-2.5 px-0.5">
            <span className="flex items-center gap-1 text-zinc-400">
              <Database className="w-3 h-3 text-emerald-500/80" />
              <span>Offline Ledger</span>
            </span>
            <span
              className={`tabular-nums font-semibold transition-colors duration-300 ${
                isCompleted ? 'text-emerald-400' : 'text-zinc-300'
              }`}
            >
              {Math.round(internalProgress)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ResourceLoader;
