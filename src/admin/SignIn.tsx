import React, { useState } from 'react';
import { ShieldCheck, Eye, EyeOff, ChevronLeft, AlertCircle, Loader2 } from 'lucide-react';
import { adminService } from './adminService';
import { ThemeToggleButton } from '../lib/theme';
import { triggerHaptic } from '../lib/haptics';

interface SignInProps {
  onSignedIn: (admin: { email: string; userId: string }) => void;
  onExit: () => void;
}

export function SignIn({ onSignedIn, onExit }: SignInProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email.trim() || !password) {
      setError('Enter both admin email and password.');
      triggerHaptic('warning');
      return;
    }

    setIsSubmitting(true);
    try {
      const admin = await adminService.signIn(email, password);
      setPassword('');
      triggerHaptic('success');
      onSignedIn(admin);
    } catch (err: any) {
      triggerHaptic('warning');
      setError(err?.message || 'Sign-in failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-[100dvh] w-full flex flex-col justify-between bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 p-4 sm:p-6">
      {/* Top Bar */}
      <div className="w-full max-w-md mx-auto flex items-center justify-between pt-[max(env(safe-area-inset-top),0.5rem)] pb-4">
        <button
          type="button"
          onClick={() => {
            triggerHaptic('tick');
            onExit();
          }}
          className="min-h-[44px] px-3 -ml-3 inline-flex items-center gap-1.5 text-sm font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white rounded-xl transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          <span className="whitespace-nowrap">Back to app</span>
        </button>

        <ThemeToggleButton />
      </div>

      {/* Sign-In Card */}
      <div className="w-full max-w-sm mx-auto flex-1 flex flex-col justify-center py-6">
        <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-3xl p-6 sm:p-7 shadow-sm">
          <div className="flex items-center gap-3.5 mb-6">
            <div className="w-11 h-11 rounded-2xl bg-violet-500/15 border border-violet-500/30 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold tracking-tight text-zinc-900 dark:text-white">
                Platform Admin
              </h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Owner console access
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="admin-email"
                className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300"
              >
                Admin email
              </label>
              <input
                id="admin-email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@domain.com"
                disabled={isSubmitting}
                className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-violet-500"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="admin-password"
                className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="admin-password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter admin password"
                  disabled={isSubmitting}
                  className="w-full min-h-[44px] pl-3.5 pr-12 py-2.5 rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-violet-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-0 top-0 bottom-0 min-w-[44px] flex items-center justify-center text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="flex items-start gap-2.5 p-3 rounded-xl bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full min-h-[46px] px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-60 text-white text-sm font-semibold inline-flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Verifying...</span>
                </>
              ) : (
                <span>Sign in</span>
              )}
            </button>
          </form>
        </div>
      </div>

      <div className="pb-[max(env(safe-area-inset-bottom),0.5rem)] text-center text-[11px] text-zinc-400 dark:text-zinc-600">
        Session stays in memory only
      </div>
    </div>
  );
}
