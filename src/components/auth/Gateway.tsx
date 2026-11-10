import React from 'react';
import { Scale, Gavel, Command } from 'lucide-react';

interface GatewayProps {
  onSelectRole: (role: 'organiser' | 'judge') => void;
}

export function Gateway({ onSelectRole }: GatewayProps) {
  return (
    <div className="w-full max-w-xl mx-auto flex flex-col items-center justify-center animate-in fade-in zoom-in-95 duration-200">
      {/* 1. Massive Centered App Logo & Brand Anchor (No Extra Descriptive Bloat) */}
      <div className="flex flex-col items-center justify-center text-center mb-10 md:mb-12">
        <div className="w-20 h-20 md:w-24 md:h-24 rounded-3xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shadow-2xl shadow-emerald-500/15 mb-4 transition-transform hover:scale-105 duration-300">
          <Scale className="w-10 h-10 md:w-12 md:h-12 stroke-[2.2]" />
        </div>
        <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white font-mono">
          Fair Judge
        </h1>
      </div>

      {/* 2. Side-by-Side Square/Rectangular Cards (grid-cols-2) */}
      <div className="grid grid-cols-2 gap-4 md:gap-6 w-full px-2 sm:px-0">
        {/* Card 1: Organiser */}
        <button
          type="button"
          onClick={() => onSelectRole('organiser')}
          className="group relative flex flex-col items-center justify-center aspect-square p-6 md:p-8 bg-zinc-900 border border-white/[0.05] border-t-white/5 hover:bg-zinc-800/80 hover:border-white/[0.1] transition-all duration-300 rounded-3xl cursor-pointer active:scale-[0.98] shadow-2xl"
        >
          <div className="w-14 h-14 md:w-16 md:h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mb-4 group-hover:scale-110 group-hover:bg-emerald-500/20 transition-all duration-300 shadow-lg shadow-emerald-500/10">
            <Command className="w-7 h-7 md:w-8 md:h-8 stroke-[2.2]" />
          </div>
          <span className="text-base md:text-lg font-bold text-white group-hover:text-emerald-400 transition-colors">
            Organiser
          </span>
          <span className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1 font-mono">
            Portal
          </span>
        </button>

        {/* Card 2: Judge */}
        <button
          type="button"
          onClick={() => onSelectRole('judge')}
          className="group relative flex flex-col items-center justify-center aspect-square p-6 md:p-8 bg-zinc-900 border border-white/[0.05] border-t-white/5 hover:bg-zinc-800/80 hover:border-white/[0.1] transition-all duration-300 rounded-3xl cursor-pointer active:scale-[0.98] shadow-2xl"
        >
          <div className="w-14 h-14 md:w-16 md:h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-4 group-hover:scale-110 group-hover:bg-amber-500/20 transition-all duration-300 shadow-lg shadow-amber-500/10">
            <Gavel className="w-7 h-7 md:w-8 md:h-8" />
          </div>
          <span className="text-base md:text-lg font-bold text-white group-hover:text-amber-400 transition-colors">
            Judge
          </span>
          <span className="text-[10px] uppercase tracking-widest text-zinc-500 mt-1 font-mono">
            Terminal
          </span>
        </button>
      </div>
    </div>
  );
}
