import React from 'react';
import { ChevronRight } from 'lucide-react';
import { triggerHaptic } from '../../lib/haptics';

interface GroupedListProps {
  title?: string;
  footer?: string;
  children: React.ReactNode;
  className?: string;
}

export function GroupedList({ title, footer, children, className = '' }: GroupedListProps) {
  return (
    <section className={`space-y-2 ${className}`}>
      {title && (
        <h2 className="admin-caption font-semibold text-zinc-500 dark:text-zinc-400 px-4 sm:px-1">
          {title}
        </h2>
      )}
      <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-200 dark:divide-zinc-800 overflow-hidden">
        {children}
      </div>
      {footer && (
        <p className="admin-caption text-zinc-500 dark:text-zinc-400 px-4 sm:px-1">
          {footer}
        </p>
      )}
    </section>
  );
}

interface ListRowProps {
  leading?: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  chevron?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  highlighted?: boolean;
  animateIndex?: number;
  className?: string;
  ariaLabel?: string;
}

export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  chevron = false,
  onClick,
  disabled = false,
  danger = false,
  highlighted = false,
  animateIndex,
  className = '',
  ariaLabel,
}: ListRowProps) {
  const shouldAnimate = typeof animateIndex === 'number' && animateIndex >= 0 && animateIndex < 8;
  const animStyle = shouldAnimate
    ? ({ '--admin-row-index': animateIndex } as React.CSSProperties)
    : undefined;

  const content = (
    <>
      {highlighted && (
        <span
          aria-hidden="true"
          className="absolute inset-0 bg-violet-500 pointer-events-none admin-row-highlight"
        />
      )}
      <div className="relative flex items-center justify-between gap-3 w-full">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {leading && (
            <div
              className={`shrink-0 flex items-center justify-center ${
                danger ? 'text-red-500' : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              {leading}
            </div>
          )}
          <div className="min-w-0 flex-1 text-left">
            <div
              className={`admin-body font-medium truncate ${
                danger ? 'text-red-600 dark:text-red-400' : 'text-zinc-900 dark:text-zinc-100'
              }`}
            >
              {title}
            </div>
            {subtitle && (
              <div className="admin-caption text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                {subtitle}
              </div>
            )}
          </div>
        </div>

        {(trailing !== undefined || chevron) && (
          <div className="flex items-center gap-2 shrink-0">
            {trailing !== undefined && (
              <div className="admin-body text-zinc-500 dark:text-zinc-400 tabular-nums">
                {trailing}
              </div>
            )}
            {chevron && <ChevronRight className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />}
          </div>
        )}
      </div>
    </>
  );

  const baseClass = `relative w-full min-h-[56px] px-4 py-3 flex items-center ${
    shouldAnimate ? 'admin-row-enter' : ''
  } ${className}`;

  if (onClick) {
    return (
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        style={animStyle}
        onClick={() => {
          triggerHaptic('light');
          onClick();
        }}
        className={`${baseClass} admin-press text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/60 cursor-pointer`}
      >
        {content}
      </button>
    );
  }

  return (
    <div style={animStyle} className={baseClass}>
      {content}
    </div>
  );
}
