import React from 'react';
import { triggerHaptic } from '../../lib/haptics';

interface EmptyStateProps {
  icon: React.ReactNode;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  className?: string;
}

export function EmptyState({
  icon,
  message,
  actionLabel,
  onAction,
  actionDisabled = false,
  className = '',
}: EmptyStateProps) {
  return (
    <div
      className={`rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 px-6 py-10 flex flex-col items-center justify-center text-center gap-3 ${className}`}
    >
      <div className="w-11 h-11 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 flex items-center justify-center">
        {icon}
      </div>
      <p className="admin-body text-zinc-600 dark:text-zinc-400 max-w-xs">
        {message}
      </p>
      {actionLabel && onAction && (
        <button
          type="button"
          disabled={actionDisabled}
          onClick={() => {
            triggerHaptic('light');
            onAction();
          }}
          className="admin-press min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[14px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
