import React, { useState, useEffect } from 'react';

export type BrandBadgeSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type BrandBadgeRole = 'organiser' | 'judge';
export type BrandBadgeMotion = 'still' | 'damped' | 'rock';

export interface TippingScaleIconProps {
  motion?: BrandBadgeMotion;
  className?: string;
  strokeWidth?: number;
}

export function TippingScaleIcon({
  motion = 'still',
  className = 'w-10 h-10 md:w-12 md:h-12',
  strokeWidth = 2.2,
}: TippingScaleIconProps) {
  const [dampedSettled, setDampedSettled] = useState(false);

  useEffect(() => {
    setDampedSettled(false);
  }, [motion]);

  const beamClassName =
    motion === 'damped'
      ? `fj-scale-beam fj-scale-damped${dampedSettled ? ' fj-motion-settled' : ''}`
      : motion === 'rock'
        ? 'fj-scale-beam fj-scale-rock'
        : undefined;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {/* Static center vertical pillar & base */}
      <path d="M12 3v18" />
      <path d="M7 21h10" />
      {/* Horizontal beam & pans pivoting around fulcrum (12, 5) */}
      <g
        className={beamClassName}
        onAnimationEnd={motion === 'damped' ? () => setDampedSettled(true) : undefined}
      >
        <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
        <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
        <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      </g>
    </svg>
  );
}

const SIZE_STYLES: Record<BrandBadgeSize, { container: string; icon: string }> = {
  xs: {
    container: 'w-7 h-7 rounded-xl shadow-sm',
    icon: 'w-4 h-4',
  },
  sm: {
    container: 'w-9 h-9 rounded-xl shadow-sm',
    icon: 'w-5 h-5',
  },
  md: {
    container: 'w-16 h-16 rounded-2xl shadow-xl',
    icon: 'w-8 h-8',
  },
  lg: {
    container: 'w-20 h-20 md:w-24 md:h-24 rounded-3xl shadow-2xl',
    icon: 'w-10 h-10 md:w-12 md:h-12',
  },
  xl: {
    container: 'w-24 h-24 md:w-28 md:h-28 rounded-3xl shadow-2xl',
    icon: 'w-12 h-12 md:w-14 md:h-14',
  },
};

const ROLE_STYLES: Record<BrandBadgeRole, string> = {
  organiser:
    'bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 dark:text-emerald-400 shadow-emerald-500/15',
  judge:
    'bg-amber-500/10 border border-amber-500/20 text-amber-500 dark:text-amber-400 shadow-amber-500/15',
};

export interface BrandBadgeProps {
  size?: BrandBadgeSize;
  role?: BrandBadgeRole;
  motion?: BrandBadgeMotion;
  strokeWidth?: number;
  className?: string;
  iconClassName?: string;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  onAnimationEnd?: React.AnimationEventHandler<HTMLDivElement>;
  'aria-label'?: string;
}

export function BrandBadge({
  size = 'lg',
  role = 'organiser',
  motion = 'still',
  strokeWidth = 2.2,
  className = '',
  iconClassName = '',
  onClick,
  onAnimationEnd,
  'aria-label': ariaLabel,
}: BrandBadgeProps) {
  const sizeSpec = SIZE_STYLES[size];
  const roleSpec = ROLE_STYLES[role];

  return (
    <div
      onClick={onClick}
      onAnimationEnd={onAnimationEnd}
      aria-label={ariaLabel}
      className={`flex items-center justify-center select-none shrink-0 ${sizeSpec.container} ${roleSpec} ${className}`.trim()}
    >
      <TippingScaleIcon
        motion={motion}
        strokeWidth={strokeWidth}
        className={`${sizeSpec.icon} relative z-10 ${iconClassName}`.trim()}
      />
    </div>
  );
}
