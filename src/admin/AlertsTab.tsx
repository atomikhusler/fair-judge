import React, { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, Unlock, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import { adminService, AdminSecurityEvent } from './adminService';
import { Skel } from '../components/common/Skeletons';
import { showToast } from '../components/common/ToastProvider';
import { triggerHaptic } from '../lib/haptics';

interface AlertsTabProps {
  refreshNonce: number;
  onDataChanged: () => Promise<void>;
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AlertsTab({ refreshNonce, onDataChanged }: AlertsTabProps) {
  const [events, setEvents] = useState<AdminSecurityEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unlockingOrgId, setUnlockingOrgId] = useState<string | null>(null);

  const loadAlerts = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const list = await adminService.listSecurityEvents(50);
      setEvents(Array.isArray(list) ? list : []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load security alerts.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts, refreshNonce]);

  const handleUnlock = async (orgId: string) => {
    if (!orgId || unlockingOrgId) return;
    setUnlockingOrgId(orgId);
    try {
      const res = await adminService.unlockOrg(orgId);
      if (!res?.ok) {
        throw new Error('Could not unlock account.');
      }
      triggerHaptic('success');
      showToast(`Unlocked login throttle for ${orgId}.`, 'success');
      await Promise.all([loadAlerts(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Unlock failed.', 'error');
    } finally {
      setUnlockingOrgId(null);
    }
  };

  return (
    <div className="space-y-3.5">
      <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-zinc-900 dark:text-white">
            Security Alerts
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            Failed login lockouts triggered after 5 wrong password attempts.
          </p>
        </div>
        <span className="text-xs font-mono font-semibold text-zinc-600 dark:text-zinc-400 tabular-nums shrink-0">
          {isLoading && events.length === 0 ? <Skel w={36} h={14} /> : `${events.length} total`}
        </span>
      </div>

      {error && (
        <div className="bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-900/60 rounded-2xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs text-red-700 dark:text-red-300 min-w-0">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadAlerts()}
            className="min-h-[44px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 text-xs font-semibold shrink-0 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {isLoading && events.length === 0 && !error && (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 space-y-2"
            >
              <div className="flex items-center justify-between">
                <Skel w="48%" h={16} />
                <Skel w={72} h={14} />
              </div>
              <Skel w="68%" h={12} />
            </div>
          ))}
        </div>
      )}

      {!isLoading && !error && events.length === 0 && (
        <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-6 text-center space-y-1.5">
          <div className="w-10 h-10 rounded-xl bg-stone-100 dark:bg-zinc-800 text-emerald-500 flex items-center justify-center mx-auto mb-2">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <p className="text-sm font-semibold text-zinc-900 dark:text-white">
            No security alerts
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            Recent brute-force lockouts will appear here if any occur.
          </p>
        </div>
      )}

      {events.length > 0 && (
        <div className="space-y-2.5">
          {events.map((ev) => {
            const targetId = ev.org_id || '';
            const isLockedNow = Boolean(
              ev.still_locked_until && new Date(ev.still_locked_until).getTime() > Date.now()
            );
            const failsCount = typeof ev.detail?.fails === 'number' ? ev.detail.fails : 5;
            const isBusy = Boolean(targetId && unlockingOrgId === targetId);

            return (
              <div
                key={ev.id}
                className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <ShieldAlert
                      className={`w-4 h-4 shrink-0 ${
                        isLockedNow ? 'text-red-500' : 'text-amber-500'
                      }`}
                    />
                    <span className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                      {ev.org_name || targetId || 'Unknown identifier'}
                    </span>
                    {ev.org_name && targetId && (
                      <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400 shrink-0">
                        ({targetId})
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                    <span>{failsCount} failed attempts</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDateTime(ev.created_at)}</span>
                    {isLockedNow && ev.still_locked_until && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="text-red-600 dark:text-red-400 font-semibold">
                          Locked until{' '}
                          {new Date(ev.still_locked_until).toLocaleTimeString(undefined, {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {targetId && isLockedNow && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => void handleUnlock(targetId)}
                    className="min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 shrink-0 transition-colors cursor-pointer"
                  >
                    {isBusy ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Unlock className="w-3.5 h-3.5" />
                    )}
                    <span>Unlock</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
