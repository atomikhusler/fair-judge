import React from 'react';
import { triggerHaptic } from '../../lib/haptics';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel = 'Filter options',
  disabled = false,
  className = '',
}: SegmentedProps<T>) {
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const count = Math.max(1, options.length);

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`relative grid p-1 rounded-xl bg-zinc-200/80 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-800 select-none ${className}`}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      {/* Single sliding thumb moved with translateX */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1 bottom-1 left-1 rounded-[10px] bg-white dark:bg-zinc-900 shadow-xs admin-slide-transform"
        style={{
          width: `calc((100% - 8px) / ${count})`,
          transform: `translateX(${activeIndex * 100}%)`,
        }}
      />

      {options.map((opt) => {
        const isActive = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            disabled={disabled}
            onClick={() => {
              if (!isActive) {
                triggerHaptic('light');
                onChange(opt.value);
              }
            }}
            className={`relative z-10 min-h-[44px] px-2 rounded-[10px] inline-flex items-center justify-center gap-1.5 text-[13px] font-semibold whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
              isActive
                ? 'text-zinc-900 dark:text-zinc-100'
                : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
            }`}
          >
            <span className="truncate">{opt.label}</span>
            {typeof opt.count === 'number' && opt.count > 0 && (
              <span className="admin-caption font-semibold tabular-nums text-zinc-500 dark:text-zinc-400">
                {opt.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
