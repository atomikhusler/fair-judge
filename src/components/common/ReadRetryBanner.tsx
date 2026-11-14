import React from 'react';
import { WifiOff, RotateCw } from 'lucide-react';

interface ReadRetryBannerProps {
  message?: string | null;
  isRetrying?: boolean;
  onRetry: () => void;
  className?: string;
}

export function ReadRetryBanner({
  message,
  isRetrying = false,
  onRetry,
  className = '',
}: ReadRetryBannerProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`w-full px-3.5 py-2.5 rounded-2xl bg-amber-500/10 border border-amber-500/25 text-amber-800 dark:text-amber-300 flex items-center justify-between gap-3 ${className}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <WifiOff className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <p className="text-xs font-semibold truncate">
          {message || 'Showing cached data. Connection timed out or unavailable.'}
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        disabled={isRetrying}
        className="min-h-[36px] px-3 py-1 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-black text-xs font-bold shrink-0 inline-flex items-center gap-1.5 transition-opacity motion-reduce:transition-none cursor-pointer"
      >
        <RotateCw className={`w-3.5 h-3.5 ${isRetrying ? 'animate-spin motion-reduce:animate-none' : ''}`} />
        <span>{isRetrying ? 'Retrying...' : 'Retry'}</span>
      </button>
    </div>
  );
}
