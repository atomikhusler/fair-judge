import React, { useState, useEffect, useRef } from 'react';
import { ShieldAlert, KeyRound, Eye, EyeOff, Loader2, LogOut, X } from 'lucide-react';
import { authService } from '../../lib/authService';
import { Organization, SupabaseJudge } from '../../lib/supabaseTypes';
import { StoredUserSession } from '../../lib/supabase';
import { getPendingCount } from '../../lib/offlineQueue';
import { sanitizeAuthError } from './authSanitizer';

export interface SessionReverifySuccessPayload {
  org?: Organization;
  judge?: SupabaseJudge;
  sessionToken: string;
  mustChange?: boolean;
}

interface SessionReverifyModalProps {
  session: StoredUserSession;
  reason: 'missing' | 'expired';
  onSuccess: (payload: SessionReverifySuccessPayload) => void;
  onDismiss: () => void;
  onSignOut: () => void;
}

export function SessionReverifyModal({
  session,
  reason,
  onSuccess,
  onDismiss,
  onSignOut,
}: SessionReverifyModalProps) {
  const [secret, setSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [pendingCount, setPendingCount] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const isJudge = session.role === 'judge';

  // Lock background body scroll and focus input on mount
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 30);

    getPendingCount()
      .then((count) => setPendingCount(count))
      .catch(() => {});

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSubmitting) {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [isSubmitting, onDismiss]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    setErrorMsg('');

    const cleanSecret = secret.trim();
    if (!cleanSecret) {
      setErrorMsg(isJudge ? 'Please enter your Judge PIN.' : 'Please enter your master password.');
      inputRef.current?.focus();
      return;
    }

    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setErrorMsg('Internet connection required to verify your session.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (isJudge) {
        const res = await authService.authenticateJudge({
          orgId: session.org.org_id,
          judgeId: session.judge?.id,
          pin: cleanSecret,
        });
        if (!res.sessionToken) {
          throw new Error('Could not obtain a server session token. Check your connection and try again.');
        }
        onSuccess({
          org: res.org,
          judge: res.judge,
          sessionToken: res.sessionToken,
        });
      } else {
        const res = await authService.loginOrganiser(session.org.org_id, cleanSecret);
        if (!res.sessionToken) {
          throw new Error('Could not obtain a server session token. Please try again.');
        }
        onSuccess({
          org: res.org,
          sessionToken: res.sessionToken,
          mustChange: res.mustChange,
        });
      }
    } catch (err: any) {
      const msg = sanitizeAuthError(err);
      setErrorMsg(msg);
      inputRef.current?.focus();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="fj-reverify-title"
      className="fixed inset-0 z-[950] flex items-center justify-center p-4 bg-black/75 dark:bg-black/85 animate-in fade-in duration-150 motion-reduce:animate-none"
    >
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 motion-reduce:animate-none">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-4 border-b border-stone-100 dark:border-zinc-900">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2
                id="fj-reverify-title"
                className="text-base font-bold text-slate-900 dark:text-zinc-100 truncate"
              >
                {reason === 'missing' ? 'Verify Session to Sync' : 'Session Expired'}
              </h2>
              <p className="text-xs text-slate-500 dark:text-zinc-400 mt-0.5 truncate">
                {isJudge
                  ? `Judge ${session.judge?.name || ''} · ${session.org.org_id}`
                  : `${session.org.name || 'Organisation'} · ${session.org.org_id}`}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onDismiss}
            disabled={isSubmitting}
            aria-label="Close verification dialog"
            className="min-w-[44px] min-h-[44px] -mr-2 -mt-2 rounded-xl flex items-center justify-center text-slate-400 hover:text-slate-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <p className="text-sm text-slate-600 dark:text-zinc-300 leading-relaxed">
            {reason === 'missing'
              ? 'This device signed in without an active server token. Re-enter your credentials to unlock cloud sync without losing your current work.'
              : 'Your secure session expired. Re-enter your credentials to continue without losing any edits.'}
          </p>

          {pendingCount > 0 && (
            <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/60 px-3.5 py-2.5 text-xs text-amber-800 dark:text-amber-300 font-medium">
              {pendingCount} pending change{pendingCount === 1 ? ' is' : 's are'} safely saved locally and will upload immediately after verification.
            </div>
          )}

          <div>
            <label
              htmlFor="fj-reverify-secret"
              className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-zinc-400 mb-1.5"
            >
              {isJudge ? 'Judge PIN' : 'Master Password'}
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 dark:text-zinc-500">
                <KeyRound className="w-4 h-4" />
              </div>
              <input
                ref={inputRef}
                id="fj-reverify-secret"
                type={showSecret ? 'text' : 'password'}
                inputMode={isJudge ? 'numeric' : 'text'}
                autoComplete={isJudge ? 'one-time-code' : 'current-password'}
                value={secret}
                onChange={(e) => {
                  setSecret(e.target.value);
                  if (errorMsg) setErrorMsg('');
                }}
                disabled={isSubmitting}
                placeholder={isJudge ? 'Enter your PIN' : 'Enter master password'}
                className="w-full min-h-[44px] pl-10 pr-12 py-2.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-slate-900 dark:text-zinc-100 placeholder:text-slate-400 dark:placeholder:text-zinc-500 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 disabled:opacity-60"
              />
              <button
                type="button"
                onClick={() => setShowSecret((prev) => !prev)}
                aria-label={showSecret ? 'Hide credential' : 'Show credential'}
                className="absolute inset-y-0 right-0 min-w-[44px] min-h-[44px] flex items-center justify-center text-slate-400 hover:text-slate-600 dark:text-zinc-500 dark:hover:text-zinc-300"
              >
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {errorMsg && (
            <div
              role="alert"
              className="rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60 px-3.5 py-2.5 text-xs font-medium text-rose-700 dark:text-rose-300"
            >
              {errorMsg}
            </div>
          )}

          <div className="flex flex-col sm:flex-row-reverse items-stretch sm:items-center gap-2.5 pt-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="min-h-[44px] flex-1 px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.99] text-white font-semibold text-sm flex items-center justify-center gap-2 transition-transform disabled:opacity-50"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Verifying...</span>
                </>
              ) : (
                <span>Verify &amp; Resume</span>
              )}
            </button>

            <button
              type="button"
              onClick={onSignOut}
              disabled={isSubmitting}
              className="min-h-[44px] px-4 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-stone-200 dark:border-zinc-800 text-slate-700 dark:text-zinc-300 font-semibold text-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign Out</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
