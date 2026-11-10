import React from 'react';

export function AuthFooter() {
  return (
    <footer className="text-[10px] uppercase tracking-widest text-zinc-400 pb-6 text-center w-full flex items-center justify-center select-none z-10">
      <span>Engineered with Intent</span>
      <span className="animate-pulse bg-gradient-to-r from-emerald-500 to-emerald-300 bg-clip-text text-transparent font-mono font-bold mx-1.5">
        &lt;/&gt;
      </span>
      <span className="bg-gradient-to-r from-zinc-400 via-zinc-100 to-zinc-400 bg-clip-text text-transparent animate-shimmer">
        Sahil Kumar Rout
      </span>
    </footer>
  );
}
