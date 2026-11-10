import React, { useState } from 'react';
import { 
  Database, 
  KeyRound, 
  Globe, 
  CheckCircle2, 
  AlertCircle, 
  Save, 
  X, 
  ExternalLink,
  ShieldAlert,
  RotateCcw
} from 'lucide-react';
import { 
  getSupabaseCredentials, 
  setSupabaseCredentials, 
  clearSupabaseCredentials,
  isSupabaseConfigured 
} from '../../lib/supabase';
import { showToast } from '../common/ToastProvider';

interface SuperAdminSetupModalProps {
  isFirstBoot?: boolean;
  onClose?: () => void;
  onConfigured?: () => void;
}

export function SuperAdminSetupModal({
  isFirstBoot = false,
  onClose,
  onConfigured,
}: SuperAdminSetupModalProps) {
  const current = getSupabaseCredentials();
  const [supabaseUrl, setSupabaseUrl] = useState(current.url || '');
  const [supabaseAnonKey, setSupabaseAnonKey] = useState(current.anonKey || '');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const cleanUrl = supabaseUrl.trim().replace(/\/+$/, '');
    const cleanKey = supabaseAnonKey.trim();

    if (!cleanUrl) {
      setError('Please enter your Supabase Project URL.');
      return;
    }

    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      setError('Supabase URL must begin with https:// (e.g., https://xyz.supabase.co).');
      return;
    }

    if (!cleanKey) {
      setError('Please enter your Supabase Anon / Public API Key.');
      return;
    }

    if (cleanKey.length < 20) {
      setError('Anon Key appears too short. Please verify your Supabase API key.');
      return;
    }

    setIsSaving(true);
    try {
      setSupabaseCredentials(cleanUrl, cleanKey);
      showToast('Supabase configuration saved. Initializing...', 'success');

      if (onConfigured) {
        onConfigured();
      } else {
        setTimeout(() => {
          window.location.reload();
        }, 300);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to save configuration to localStorage.');
      setIsSaving(false);
    }
  };

  const handleReset = () => {
    if (confirm('Clear stored Supabase credentials from this browser?')) {
      clearSupabaseCredentials();
      setSupabaseUrl('');
      setSupabaseAnonKey('');
      showToast('Credentials cleared.', 'info');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-3xl p-6 md:p-8 shadow-2xl shadow-black relative overflow-hidden text-zinc-100">
        {/* Subtle emerald radial glow */}
        <div className="absolute top-0 right-0 w-72 h-72 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none -mr-20 -mt-20" />

        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-zinc-800/80 mb-5 relative z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shadow-md shadow-emerald-500/10">
              <Database className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white tracking-tight">Super Admin Setup</h2>
                {isFirstBoot && (
                  <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold tracking-widest uppercase bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                    Required
                  </span>
                )}
              </div>
              <p className="text-xs text-zinc-400 mt-0.5">
                Database & Cloud Ledger Credential Injection
              </p>
            </div>
          </div>

          {!isFirstBoot && onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Explainer Note */}
        <div className="p-3.5 bg-zinc-900/70 border border-zinc-800/80 rounded-2xl mb-5 text-xs text-zinc-300 leading-relaxed space-y-2 relative z-10">
          <div className="flex items-center gap-2 text-emerald-400 font-semibold text-[11px] uppercase tracking-wider">
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>Serverless Sandbox Storage</span>
          </div>
          <p className="text-zinc-400">
            Fair Judge requires active Supabase credentials to enforce strict cloud-first registration and multi-device sync. In this serverless preview environment, credentials are saved securely in your browser's <code className="text-emerald-400 font-mono text-[11px]">localStorage</code>.
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSave} className="space-y-4 relative z-10">
          {/* Supabase URL */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1.5">
              Supabase Project URL
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                <Globe className="w-4 h-4" />
              </div>
              <input
                type="text"
                placeholder="https://your-project.supabase.co"
                value={supabaseUrl}
                onChange={(e) => setSupabaseUrl(e.target.value)}
                required
                className="w-full h-11 pl-10 pr-4 bg-zinc-900/80 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 transition-all rounded-xl text-xs font-mono text-white placeholder-zinc-500 outline-none"
              />
            </div>
          </div>

          {/* Supabase Anon Key */}
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1.5">
              Supabase Anon / Public API Key
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                <KeyRound className="w-4 h-4" />
              </div>
              <input
                type="password"
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
                value={supabaseAnonKey}
                onChange={(e) => setSupabaseAnonKey(e.target.value)}
                required
                className="w-full h-11 pl-10 pr-4 bg-zinc-900/80 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 transition-all rounded-xl text-xs font-mono text-white placeholder-zinc-500 outline-none"
              />
            </div>
            <p className="text-[10px] text-zinc-500 mt-1">
              Found in Supabase Dashboard → Project Settings → API → Project API Keys.
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-start gap-2 animate-in fade-in duration-200">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}

          {/* Action Buttons */}
          <div className="pt-2 flex flex-col sm:flex-row gap-2.5">
            <button
              type="submit"
              disabled={isSaving}
              className="flex-1 h-11 bg-emerald-600 hover:bg-emerald-500 active:scale-[0.99] text-white font-bold text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg shadow-emerald-600/25 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{isSaving ? 'Saving...' : 'Save Configuration & Connect'}</span>
            </button>

            {!isFirstBoot && (
              <button
                type="button"
                onClick={handleReset}
                className="px-4 h-11 bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-red-400 border border-zinc-800 rounded-xl text-xs font-medium transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset</span>
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
