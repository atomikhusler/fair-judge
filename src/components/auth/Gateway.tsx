import React from 'react';
import { Scale, Building2, Gavel, ArrowRight, Shield } from 'lucide-react';

interface GatewayProps {
  onSelectRole: (role: 'organiser' | 'judge') => void;
}

export function Gateway({ onSelectRole }: GatewayProps) {
  return (
    <div className="w-full max-w-xl mx-auto flex flex-col items-center animate-in fade-in zoom-in-95 duration-200">
      {/* 1. Header with Centered Emerald Scale Logo & Typography */}
      <div className="flex flex-col items-center justify-center text-center mb-8">
        <div className="w-14 h-14 rounded-3xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shadow-xl shadow-emerald-500/10 mb-3 transition-transform hover:scale-105">
          <Scale className="w-7 h-7 stroke-[2.2]" />
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight text-white font-mono">
          Fair Judge
        </h1>
        <p className="text-xs font-medium text-emerald-400/90 tracking-wide mt-1.5 flex items-center gap-1.5">
          <Shield className="w-3.5 h-3.5 text-emerald-400" />
          <span>Competition Judging Terminal & Scoring Ledger</span>
        </p>
      </div>

      {/* 2. The 2 Cards (Glassmorphic Stack / Grid) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
        {/* Card 1: Organiser */}
        <button
          type="button"
          onClick={() => onSelectRole('organiser')}
          className="group relative bg-zinc-900/50 border border-zinc-800 hover:bg-zinc-800/50 hover:border-emerald-500/40 transition-all rounded-2xl p-6 text-left cursor-pointer active:scale-[0.98] shadow-xl flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between w-full mb-4">
              <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 group-hover:scale-105 transition-transform">
                <Building2 className="w-6 h-6" />
              </div>
              <div className="p-2 rounded-lg bg-zinc-800/60 text-zinc-400 group-hover:text-emerald-400 group-hover:bg-emerald-500/10 group-hover:translate-x-1 transition-all">
                <ArrowRight className="w-4 h-4" />
              </div>
            </div>
            <h2 className="text-lg font-bold text-white group-hover:text-emerald-400 transition-colors">
              I am an Organiser
            </h2>
            <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
              Create events and manage rosters.
            </p>
          </div>
          <div className="mt-5 pt-3 border-t border-zinc-800/60 flex items-center text-[11px] font-semibold text-emerald-400/80 group-hover:text-emerald-300">
            <span>Access Command Center</span>
          </div>
        </button>

        {/* Card 2: Judge */}
        <button
          type="button"
          onClick={() => onSelectRole('judge')}
          className="group relative bg-zinc-900/50 border border-zinc-800 hover:bg-zinc-800/50 hover:border-orange-500/40 transition-all rounded-2xl p-6 text-left cursor-pointer active:scale-[0.98] shadow-xl flex flex-col justify-between"
        >
          <div>
            <div className="flex items-center justify-between w-full mb-4">
              <div className="p-3 rounded-xl bg-orange-500/10 text-orange-400 border border-orange-500/20 group-hover:scale-105 transition-transform">
                <Gavel className="w-6 h-6" />
              </div>
              <div className="p-2 rounded-lg bg-zinc-800/60 text-zinc-400 group-hover:text-orange-400 group-hover:bg-orange-500/10 group-hover:translate-x-1 transition-all">
                <ArrowRight className="w-4 h-4" />
              </div>
            </div>
            <h2 className="text-lg font-bold text-white group-hover:text-orange-400 transition-colors">
              I am a Judge
            </h2>
            <p className="text-xs text-zinc-400 mt-1.5 leading-relaxed">
              Enter a PIN or scan a QR to score.
            </p>
          </div>
          <div className="mt-5 pt-3 border-t border-zinc-800/60 flex items-center text-[11px] font-semibold text-orange-400/80 group-hover:text-orange-300">
            <span>Enter Scoring Terminal</span>
          </div>
        </button>
      </div>

      <div className="mt-8 text-center">
        <p className="text-[11px] text-zinc-500 font-mono">
          Decentralized Offline-First Architecture • Ledger v14.2
        </p>
      </div>
    </div>
  );
}
