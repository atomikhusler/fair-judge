import React, { useEffect } from 'react';
import { MonitorSmartphone, LogOut, Loader2, X, AlertCircle } from 'lucide-react';
import { ActiveOrgSession } from '../../lib/authService';
import { formatSessionTimestamp } from '../../lib/deviceIdentity';

interface SessionLimitSheetProps {
  sessions: ActiveOrgSession[];
  busySessionId: string | null;
  errorMessage?: string;
  onEvictSession: (sessionId: string) => void;
  onCancel: () => void;
}

export function SessionLimitSheet({
  sessions,
  busySessionId,
  errorMessage,
  onEvictSession,
  onCancel,
}: SessionLimitSheetProps) {
  const isBusy = busySessionId !== null;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isBusy) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isBusy, onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="fj-session-limit-title"
      className="fixed inset-0 z-[960] flex items-center justify-center p-4 bg-black/75 dark:bg-black/85 animate-in fade-in duration-150 motion-reduce:animate-none"
      onClick={() => {
        if (!isBusy) onCancel();
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 motion-reduce:animate-none"
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-6 pb-4 border-b border-stone-100 dark:border-zinc-800/80">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-11 h-11 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0">
              <MonitorSmartphone className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h2
                id="fj-session-limit-title"
                className="text-base font-bold text-zinc-900 dark:text-white leading-tight"
              >
                Device limit reached (3 max)
              </h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">
                Log out one device to continue signing in here.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onCancel}
            disabled={isBusy}
            aria-label="Cancel sign in"
            className="min-w-[44px] min-h-[44px] -mr-2 -mt-2 rounded-xl flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 max-h-[60vh] overflow-y-auto overscroll-contain">
          {errorMessage && (
            <div
              role="alert"
              className="p-3 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{errorMessage}</span>
            </div>
          )}

          <div className="rounded-2xl border border-stone-200 dark:border-zinc-800 bg-stone-50 dark:bg-zinc-900/50 divide-y divide-stone-200 dark:divide-zinc-800 overflow-hidden">
            {sessions.map((s) => {
              const rowBusy = busySessionId === s.id;
              return (
                <div
                  key={s.id}
                  className="p-3.5 flex items-center justify-between gap-3 bg-white dark:bg-zinc-950"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                        {s.device_label || 'Unknown device'}
                      </span>
                      {s.is_same_device && (
                        <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 whitespace-nowrap shrink-0">
                          · This browser
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-zinc-600 dark:text-zinc-400 tabular-nums">
                      <span title={new Date(s.created_at).toLocaleString()}>
                        Signed in {formatSessionTimestamp(s.created_at)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span title={new Date(s.last_seen_at).toLocaleString()}>
                        Last seen {formatSessionTimestamp(s.last_seen_at)}
                      </span>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onEvictSession(s.id)}
                    className="min-h-[44px] px-3.5 rounded-xl bg-rose-700 hover:bg-rose-800 dark:bg-rose-700/90 dark:hover:bg-rose-700 text-white text-xs font-bold transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    {rowBusy ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>Logging out...</span>
                      </>
                    ) : (
                      <>
                        <LogOut className="w-3.5 h-3.5" />
                        <span>Log out</span>
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-5 pb-5 pt-2">
          <button
            type="button"
            disabled={isBusy}
            onClick={onCancel}
            className="w-full min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 border border-stone-200 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
