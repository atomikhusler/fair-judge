import React, { useState, useEffect } from 'react';
import { ShieldCheck, Eye, EyeOff, ChevronLeft, AlertCircle, Loader2, WifiOff } from 'lucide-react';
import { adminService } from './adminService';
import { touchLastActive } from './adminSession';
import { ThemeToggleButton } from '../lib/theme';
import { triggerHaptic } from '../lib/haptics';

interface SignInProps {
  onSignedIn: (admin: { email: string; userId: string }) => void;
  onExit: () => void;
  notice?: string | null;
}

export function SignIn({ onSignedIn, onExit, notice }: SignInProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!isOnline) {
      setError('Internet connection is required to sign in.');
      triggerHaptic('warning');
      return;
    }

    if (!email.trim() || !password) {
      setError('Enter both admin email and password.');
      triggerHaptic('warning');
      return;
    }

    setIsSubmitting(true);
    try {
      const admin = await adminService.signIn(email, password);
      touchLastActive();
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
    <div className="min-h-[100dvh] w-full flex flex-col justify-between bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {!isOnline && (
        <div
          role="status"
          className="w-full bg-orange-500/15 border-b border-orange-500/30 text-orange-800 dark:text-orange-300 admin-caption font-medium px-4 py-2 flex items-center justify-center gap-2"
        >
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          <span>Offline: admin actions are paused.</span>
        </div>
      )}

      <div className="flex-1 flex flex-col justify-between p-4 sm:p-6">
        {/* Top Bar */}
        <div className="w-full max-w-md mx-auto flex items-center justify-between pt-[max(env(safe-area-inset-top),0.5rem)] pb-4">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onExit();
            }}
            className="admin-press min-h-[44px] px-3 -ml-3 inline-flex items-center gap-1.5 text-[15px] font-medium text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
            <span className="whitespace-nowrap">Back to app</span>
          </button>

          <ThemeToggleButton />
        </div>

        {/* Sign-In Card */}
        <div className="w-full max-w-sm mx-auto flex-1 flex flex-col justify-center py-6">
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-2xl p-6 sm:p-7">
            <div className="flex items-center gap-3.5 mb-6">
              <div className="w-11 h-11 rounded-xl bg-violet-500/15 border border-violet-500/30 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-6 h-6" />
              </div>
              <div className="min-w-0">
                <h1 className="admin-title text-zinc-900 dark:text-zinc-100">
                  Platform Admin
                </h1>
                <p className="admin-caption text-zinc-500 dark:text-zinc-400">
                  Owner console access
                </p>
              </div>
            </div>

            {notice && !error && (
              <div
                role="status"
                className="mb-4 flex items-start gap-2.5 p-3 rounded-xl bg-orange-500/12 border border-orange-500/30 admin-caption text-orange-800 dark:text-orange-300"
              >
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{notice}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="admin-email"
                  className="block admin-caption font-semibold text-zinc-700 dark:text-zinc-300"
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
                  className="w-full min-h-[44px] px-3.5 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500/60"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="admin-password"
                  className="block admin-caption font-semibold text-zinc-700 dark:text-zinc-300"
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
                    className="w-full min-h-[44px] pl-3.5 pr-12 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-violet-500/60"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-0 top-0 bottom-0 min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 p-3 rounded-xl bg-red-500/12 border border-red-500/30 admin-caption text-red-700 dark:text-red-300"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={isSubmitting || !isOnline}
                className="admin-press w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-[15px] font-semibold inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
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

        <div className="pb-[max(env(safe-area-inset-bottom),0.5rem)] text-center admin-caption text-zinc-500 dark:text-zinc-400">
          Stays signed in on this device until 30 minutes of inactivity.
        </div>
      </div>
    </div>
  );
}
