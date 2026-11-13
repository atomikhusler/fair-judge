import React from 'react';

export type StatusTone = 'ok' | 'waiting' | 'problem' | 'neutral';

interface StatusChipProps {
  tone: StatusTone;
  label: string;
  pulseAttention?: boolean;
  className?: string;
}

const TONE_MAP: Record<
  StatusTone,
  { dot: string; text: string; bg: string; srPrefix: string }
> = {
  ok: {
    dot: 'bg-green-500',
    text: 'text-green-700 dark:text-green-400',
    bg: 'bg-green-500/12 border-green-500/25',
    srPrefix: 'Status ok:',
  },
  waiting: {
    dot: 'bg-orange-500',
    text: 'text-orange-700 dark:text-orange-400',
    bg: 'bg-orange-500/12 border-orange-500/25',
    srPrefix: 'Status waiting:',
  },
  problem: {
    dot: 'bg-red-500',
    text: 'text-red-700 dark:text-red-400',
    bg: 'bg-red-500/12 border-red-500/25',
    srPrefix: 'Status problem:',
  },
  neutral: {
    dot: 'bg-zinc-500',
    text: 'text-zinc-700 dark:text-zinc-300',
    bg: 'bg-zinc-500/12 border-zinc-500/25',
    srPrefix: 'Status:',
  },
};

export function StatusChip({
  tone,
  label,
  pulseAttention = false,
  className = '',
}: StatusChipProps) {
  const styles = TONE_MAP[tone];

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border admin-caption font-semibold whitespace-nowrap shrink-0 ${styles.bg} ${styles.text} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${styles.dot} ${
          pulseAttention ? 'admin-attention-pulse' : ''
        }`}
      />
      <span className="sr-only">{styles.srPrefix} </span>
      <span>{label}</span>
    </span>
  );
}
