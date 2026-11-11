import React from 'react';

export function AuthFooter() {
  return (
    <footer className="text-[10px] uppercase tracking-widest text-zinc-600 dark:text-zinc-400 pb-6 text-center w-full flex items-center justify-center select-none relative z-10">
      <span>Engineered with Intent</span>
      <span className="animate-pulse text-emerald-600 dark:text-emerald-400 font-mono font-bold mx-1.5">
        &lt;/&gt;
      </span>
      <span className="font-semibold text-zinc-800 dark:text-zinc-200">
        Sahil Kumar Rout
      </span>
    </footer>
  );
}
