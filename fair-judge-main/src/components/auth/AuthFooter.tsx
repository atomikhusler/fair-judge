import React from 'react';
import { ShieldCheck, Sparkles } from 'lucide-react';

export function AuthFooter() {
  return (
    <footer className="w-full relative z-10 py-4 flex flex-col items-center justify-center text-center select-none">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-900/60 border border-zinc-800/80 backdrop-blur-md shadow-xs">
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-[11px] font-mono font-medium text-zinc-400">
          Zero-Trust Cryptographic Ledger
        </span>
        <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
      </div>
      <p className="text-[10px] text-zinc-600 mt-2 font-mono flex items-center gap-1">
        <span>Fair Judge</span>
        <span>•</span>
        <span>Offline-First PWA</span>
        <span>•</span>
        <Sparkles className="w-2.5 h-2.5 text-amber-400" />
        <span>AMOLED</span>
      </p>
    </footer>
  );
}
