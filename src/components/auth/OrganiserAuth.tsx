import React, { useState } from 'react';
import { ChevronLeft, Building2, KeyRound, ArrowRight, ShieldCheck, Plus } from 'lucide-react';
import { Organization } from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';
import { SuperAdminSetupModal } from './SuperAdminSetupModal';

interface OrganiserAuthProps {
  onOrganiserLogin: (org: Organization) => void;
  onBack: () => void;
}

export function OrganiserAuth({ onOrganiserLogin, onBack }: OrganiserAuthProps) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [showSetupModal, setShowSetupModal] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = identifier.trim();
    const cleanPass = password.trim();

    if (!cleanId) {
      setErrorMessage('Please enter your Organization ID or Registered Email.');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');

    try {
      const org = await dbService.getOrganizationByIdentifier(cleanId);
      if (!org) {
        setErrorMessage('Organization not found. Please verify your ID or create a new organization.');
        setIsLoading(false);
        return;
      }

      // If org has password configured, verify it
      if (org.password && cleanPass) {
        if (org.password !== cleanPass) {
          setErrorMessage('Invalid Master Password. Please try again.');
          setIsLoading(false);
          return;
        }
      }

      onOrganiserLogin(org);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Authentication failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto flex flex-col items-center">
      {/* Top Header Row with Glassmorphic Circular Back Button */}
      <div className="w-full flex items-center justify-between mb-6">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to Gateway"
          className="w-10 h-10 rounded-full bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800 flex items-center justify-center text-zinc-400 hover:text-white backdrop-blur-md active:scale-95 transition-all cursor-pointer shadow-sm"
        >
          <ChevronLeft className="w-5 h-5 stroke-[2.2]" />
        </button>

        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-900/40 border border-zinc-800/80 text-[11px] font-mono font-medium text-emerald-400">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Organiser Console</span>
        </div>
      </div>

      {/* Main Glass Card */}
      <div className="w-full rounded-3xl bg-zinc-900/80 dark:bg-zinc-950/80 border border-zinc-800/80 backdrop-blur-xl p-6 sm:p-8 shadow-2xl relative">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto mb-3 shadow-sm">
            <Building2 className="w-6 h-6 stroke-[2.2]" />
          </div>
          <h2 className="text-xl font-black text-white tracking-tight">Organiser Sign-In</h2>
          <p className="text-xs text-zinc-400 mt-1">Access the competition command center & audit ledger</p>
        </div>

        {errorMessage && (
          <div className="mb-5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-medium text-center animate-fade-in">
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-mono font-bold text-zinc-400 uppercase tracking-wider mb-1.5">
              Organization ID or Email
            </label>
            <div className="relative">
              <input
                type="text"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="e.g. TECH-FEST-2026"
                autoComplete="username"
                className="w-full h-12 px-4 rounded-xl bg-zinc-900/90 border border-zinc-800 text-white placeholder-zinc-500 text-sm font-medium focus:outline-hidden focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20 transition-all font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-mono font-bold text-zinc-400 uppercase tracking-wider mb-1.5">
              Master Password
            </label>
            <div className="relative">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full h-12 px-4 rounded-xl bg-zinc-900/90 border border-zinc-800 text-white placeholder-zinc-500 text-sm font-medium focus:outline-hidden focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20 transition-all"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full h-12 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold text-sm shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 active:scale-[0.97] transition-all cursor-pointer disabled:opacity-50 mt-2"
          >
            {isLoading ? (
              <div className="w-5 h-5 rounded-full border-2 border-black/30 border-t-black animate-spin" />
            ) : (
              <>
                <span>Enter Command Center</span>
                <ArrowRight className="w-4 h-4 stroke-[2.5]" />
              </>
            )}
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-zinc-800/80 flex items-center justify-between">
          <span className="text-xs text-zinc-500">Need a new organization?</span>
          <button
            type="button"
            onClick={() => setShowSetupModal(true)}
            className="text-xs font-bold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 active:scale-95 transition-all cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
            <span>Setup New Org</span>
          </button>
        </div>
      </div>

      {showSetupModal && (
        <SuperAdminSetupModal
          onClose={() => setShowSetupModal(false)}
          onConfigured={() => setShowSetupModal(false)}
        />
      )}
    </div>
  );
}
