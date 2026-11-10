import React from 'react';

/**
 * Soft, Non-Blocking SWR Skeletons for Fair Judge
 * Matches exact card heights and zero-shift layout boundaries without blocking the screen.
 */

export function RosterSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="w-full space-y-2.5 p-4 animate-pulse select-none">
      <div className="h-4 w-32 bg-stone-200 dark:bg-zinc-800 rounded-lg mb-3" />
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="p-4 bg-white dark:bg-zinc-900 border border-stone-200/80 dark:border-zinc-800 rounded-2xl flex items-center justify-between shadow-xs"
        >
          <div className="flex items-center space-x-3.5 min-w-0 flex-1">
            <div className="w-11 h-11 rounded-2xl bg-stone-200 dark:bg-zinc-800 shrink-0" />
            <div className="space-y-2 min-w-0 flex-1 pr-4">
              <div className="h-4 w-3/4 bg-stone-200 dark:bg-zinc-800 rounded-md" />
              <div className="h-3 w-1/2 bg-stone-200/60 dark:bg-zinc-800/60 rounded-md" />
            </div>
          </div>
          <div className="w-16 h-8 rounded-xl bg-stone-200 dark:bg-zinc-800 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function TabSkeleton() {
  return (
    <div className="w-full flex-1 flex flex-col p-4 space-y-4 animate-pulse select-none max-w-lg mx-auto">
      <div className="flex items-center justify-between pb-2 border-b border-stone-200/60 dark:border-zinc-800">
        <div className="space-y-1.5">
          <div className="h-3 w-24 bg-stone-200 dark:bg-zinc-800 rounded" />
          <div className="h-5 w-40 bg-stone-200 dark:bg-zinc-800 rounded-lg" />
        </div>
        <div className="w-12 h-6 bg-stone-200 dark:bg-zinc-800 rounded-full" />
      </div>

      <div className="space-y-3">
        <div className="h-28 rounded-3xl bg-stone-100 dark:bg-zinc-900 border border-stone-200/70 dark:border-zinc-800 p-4 space-y-2.5">
          <div className="h-4 w-1/3 bg-stone-200 dark:bg-zinc-800 rounded" />
          <div className="h-6 w-2/3 bg-stone-200 dark:bg-zinc-800 rounded-lg" />
          <div className="h-3 w-1/2 bg-stone-200/60 dark:bg-zinc-800/60 rounded" />
        </div>

        <div className="h-28 rounded-3xl bg-stone-100 dark:bg-zinc-900 border border-stone-200/70 dark:border-zinc-800 p-4 space-y-2.5">
          <div className="h-4 w-1/4 bg-stone-200 dark:bg-zinc-800 rounded" />
          <div className="h-6 w-1/2 bg-stone-200 dark:bg-zinc-800 rounded-lg" />
          <div className="h-3 w-2/5 bg-stone-200/60 dark:bg-zinc-800/60 rounded" />
        </div>
      </div>
    </div>
  );
}

export default TabSkeleton;
