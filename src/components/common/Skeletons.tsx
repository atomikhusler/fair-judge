import React from 'react';

/**
 * Battery-Friendly, Non-Looping Skeletons for Fair Judge (Epic 15.7 Step A4)
 * - `Skel`: targeted inline-block value placeholder (appears after 150ms, single 1.2s sweep, then still).
 * - `TabProgressFallback`: 2px top progress line replacing full-page tab skeleton.
 * - `RosterSkeleton` & `TabSkeleton`: animate-pulse removed, styled with .fj-skel.
 */

export interface SkelProps {
  w?: string | number;
  h?: string | number;
  className?: string;
  rounded?: string;
}

export const Skel: React.FC<SkelProps> = ({
  w = '6rem',
  h = '1em',
  className = '',
  rounded = 'rounded-md',
}) => {
  return (
    <span
      className={`fj-skel ${rounded} ${className}`}
      style={{
        width: typeof w === 'number' ? `${w}px` : w,
        height: typeof h === 'number' ? `${h}px` : h,
      }}
      aria-hidden="true"
    />
  );
};

export function TabProgressFallback() {
  return (
    <div className="w-full h-0.5 relative overflow-hidden bg-transparent">
      <div className="fj-top-progress h-full bg-emerald-500 w-full" />
    </div>
  );
}

export function RosterSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="w-full space-y-2.5 p-4 select-none">
      <div className="h-4 w-32 fj-skel rounded-lg mb-3" />
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="p-4 bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 rounded-2xl flex items-center justify-between shadow-xs"
        >
          <div className="flex items-center space-x-3.5 min-w-0 flex-1">
            <div className="w-11 h-11 rounded-2xl fj-skel shrink-0" />
            <div className="space-y-2 min-w-0 flex-1 pr-4">
              <div className="h-4 w-3/4 fj-skel rounded-md" />
              <div className="h-3 w-1/2 fj-skel rounded-md" />
            </div>
          </div>
          <div className="w-16 h-8 rounded-xl fj-skel shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function TabSkeleton() {
  return (
    <div className="w-full flex-1 flex flex-col p-4 space-y-4 select-none max-w-lg mx-auto">
      <div className="flex items-center justify-between pb-2 border-b border-stone-200/60 dark:border-zinc-800">
        <div className="space-y-1.5">
          <div className="h-3 w-24 fj-skel rounded" />
          <div className="h-5 w-40 fj-skel rounded-lg" />
        </div>
        <div className="w-12 h-6 fj-skel rounded-full" />
      </div>

      <div className="space-y-3">
        <div className="h-28 rounded-3xl bg-stone-100 dark:bg-zinc-900 border border-stone-200/70 dark:border-zinc-800 p-4 space-y-2.5">
          <div className="h-4 w-1/3 fj-skel rounded" />
          <div className="h-6 w-2/3 fj-skel rounded-lg" />
          <div className="h-3 w-1/2 fj-skel rounded" />
        </div>

        <div className="h-28 rounded-3xl bg-stone-100 dark:bg-zinc-900 border border-stone-200/70 dark:border-zinc-800 p-4 space-y-2.5">
          <div className="h-4 w-1/4 fj-skel rounded" />
          <div className="h-6 w-1/2 fj-skel rounded-lg" />
          <div className="h-3 w-2/5 fj-skel rounded" />
        </div>
      </div>
    </div>
  );
}

export default TabSkeleton;

