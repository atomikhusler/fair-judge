import React, { useEffect, useRef, useState } from 'react';
import { BackButton } from './BackButton';

interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  backLabel?: string;
  trailing?: React.ReactNode;
  compactOnly?: boolean;
  className?: string;
}

/**
 * LargeTitle (28/34) that collapses to a compact Title (17/22) on scroll
 * using an IntersectionObserver sentinel (zero scroll listeners).
 */
export function ScreenHeader({
  title,
  subtitle,
  onBack,
  backLabel = 'Back',
  trailing,
  compactOnly = false,
  className = '',
}: ScreenHeaderProps) {
  const [isCompact, setIsCompact] = useState(compactOnly);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (compactOnly) {
      setIsCompact(true);
      return;
    }

    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const scrolledPast = !entry.isIntersecting && entry.boundingClientRect.top < 80;
        setIsCompact(scrolledPast);
      },
      { threshold: 0 }
    );

    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [compactOnly]);

  if (compactOnly) {
    return (
      <header
        className={`sticky top-0 z-20 bg-zinc-50 dark:bg-zinc-950 border-b border-zinc-200 dark:border-zinc-800 pt-[max(env(safe-area-inset-top),0px)] ${className}`}
      >
        <div className="min-h-[52px] px-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {onBack && <BackButton onClick={onBack} label={backLabel} />}
            <h1 className="admin-title text-zinc-900 dark:text-zinc-100 truncate">
              {title}
            </h1>
          </div>
          {trailing && <div className="flex items-center gap-2 shrink-0">{trailing}</div>}
        </div>
      </header>
    );
  }

  return (
    <>
      {/* Sticky compact bar (appears when sentinel scrolls out of view) */}
      <div
        className={`sticky top-0 z-20 bg-zinc-50 dark:bg-zinc-950 pt-[max(env(safe-area-inset-top),0px)] ${
          isCompact ? 'border-b border-zinc-200 dark:border-zinc-800' : 'border-b border-transparent'
        } ${className}`}
      >
        <div className="min-h-[48px] px-4 md:px-0 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            {onBack && <BackButton onClick={onBack} label={backLabel} />}
            <span
              aria-hidden={!isCompact}
              className={`admin-title text-zinc-900 dark:text-zinc-100 truncate admin-opacity-fade ${
                isCompact ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            >
              {title}
            </span>
          </div>
          {trailing && <div className="flex items-center gap-2 shrink-0">{trailing}</div>}
        </div>
      </div>

      {/* Scroll sentinel + Large Title */}
      <div className="px-4 md:px-0 pt-1 pb-4">
        <div ref={sentinelRef} className="h-px w-full" aria-hidden="true" />
        <h1
          className={`admin-large-title text-zinc-900 dark:text-zinc-100 admin-opacity-fade ${
            isCompact ? 'opacity-0' : 'opacity-100'
          }`}
        >
          {title}
        </h1>
        {subtitle && (
          <p className="admin-caption text-zinc-500 dark:text-zinc-400 mt-1">
            {subtitle}
          </p>
        )}
      </div>
    </>
  );
}
