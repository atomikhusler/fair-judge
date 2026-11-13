import React, { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, Unlock, AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import { adminService, AdminSecurityEvent } from './adminService';
import { EmptyState, GroupedList, ListRow, Skel, StatusChip, showAdminToast } from './ui';
import { triggerHaptic } from '../lib/haptics';

interface AlertsTabProps {
  refreshNonce: number;
  isOnline: boolean;
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

export function AlertsTab({ refreshNonce, isOnline, onDataChanged }: AlertsTabProps) {
  const [events, setEvents] = useState<AdminSecurityEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unlockingOrgId, setUnlockingOrgId] = useState<string | null>(null);

  const loadAlerts = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const list = await adminService.listSecurityEvents(50);
      setEvents(Array.isArray(list) ? list : []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load alerts.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAlerts();
  }, [loadAlerts, refreshNonce]);

  const handleUnlock = async (orgId: string) => {
    if (!orgId || unlockingOrgId || !isOnline) return;
    setUnlockingOrgId(orgId);
    try {
      const res = await adminService.unlockOrg(orgId);
      if (!res?.ok) {
        throw new Error('Could not unlock account.');
      }
      triggerHaptic('success');
      showAdminToast(`Unlocked ${orgId}.`, { tone: 'success' });
      await Promise.all([loadAlerts(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Unlock failed.', { tone: 'error' });
    } finally {
      setUnlockingOrgId(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="admin-caption text-zinc-500 dark:text-zinc-400 px-1">
        Accounts lock for 15 minutes after 5 wrong passwords.
      </p>

      {error && (
        <EmptyState
          icon={<AlertTriangle className="w-5 h-5 text-red-500" />}
          message={error}
          actionLabel="Retry"
          onAction={() => void loadAlerts()}
          actionDisabled={!isOnline}
        />
      )}

      {isLoading && events.length === 0 && !error && (
        <GroupedList>
          {Array.from({ length: 3 }).map((_, i) => (
            <ListRow
              key={i}
              leading={<Skel w={20} h={20} rounded="rounded-full" />}
              title={<Skel w="52%" h={15} />}
              subtitle={<Skel w="68%" h={12} />}
              trailing={<Skel w={72} h={36} rounded="rounded-xl" />}
            />
          ))}
        </GroupedList>
      )}

      {!isLoading && !error && events.length === 0 && (
        <EmptyState
          icon={<CheckCircle2 className="w-5 h-5 text-green-500" />}
          message="No locked accounts right now."
        />
      )}

      {!error && events.length > 0 && (
        <GroupedList>
          {events.map((ev) => {
            const targetId = ev.org_id || '';
            const isLockedNow = Boolean(
              ev.still_locked_until && new Date(ev.still_locked_until).getTime() > Date.now()
            );
            const failsCount = typeof ev.detail?.fails === 'number' ? ev.detail.fails : 5;
            const isBusy = Boolean(targetId && unlockingOrgId === targetId);

            return (
              <ListRow
                key={ev.id}
                leading={
                  <ShieldAlert
                    className={`w-5 h-5 ${isLockedNow ? 'text-red-500' : 'text-orange-500'}`}
                  />
                }
                title={
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <span className="truncate">{ev.org_name || targetId || 'Unknown'}</span>
                    {ev.org_name && targetId && (
                      <span className="admin-caption font-mono text-zinc-500 dark:text-zinc-400 shrink-0">
                        {targetId}
                      </span>
                    )}
                  </span>
                }
                subtitle={
                  isLockedNow && ev.still_locked_until
                    ? `${failsCount} failed attempts · Locked until ${new Date(
                        ev.still_locked_until
                      ).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                    : `${failsCount} failed attempts · ${formatDateTime(ev.created_at)}`
                }
                trailing={
                  targetId && isLockedNow ? (
                    <button
                      type="button"
                      disabled={isBusy || !isOnline}
                      onClick={() => {
                        triggerHaptic('light');
                        void handleUnlock(targetId);
                      }}
                      className="admin-press min-h-[44px] px-3.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-[13px] font-semibold inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Unlock className="w-3.5 h-3.5" />
                      )}
                      <span>Unlock</span>
                    </button>
                  ) : (
                    <StatusChip tone="neutral" label="Expired" />
                  )
                }
              />
            );
          })}
        </GroupedList>
      )}
    </div>
  );
}
