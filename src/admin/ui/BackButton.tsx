import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { triggerHaptic } from '../../lib/haptics';

interface BackButtonProps {
  onClick: () => void;
  label?: string;
  ariaLabel?: string;
  className?: string;
}

export function BackButton({
  onClick,
  label = 'Back',
  ariaLabel,
  className = '',
}: BackButtonProps) {
  return (
    <button
      type="button"
      onClick={() => {
        triggerHaptic('light');
        onClick();
      }}
      aria-label={ariaLabel || label}
      className={`admin-press min-h-[44px] min-w-[44px] px-2 -ml-2 rounded-xl inline-flex items-center gap-1 text-[15px] leading-[22px] font-medium text-violet-600 dark:text-violet-400 hover:bg-zinc-100 dark:hover:bg-zinc-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer shrink-0 ${className}`}
    >
      <ChevronLeft className="w-5 h-5 shrink-0" />
      <span className="whitespace-nowrap">{label}</span>
    </button>
  );
}
