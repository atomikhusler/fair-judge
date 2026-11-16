import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ShieldAlert, Unlock, AlertTriangle, Loader2, CheckCircle2, Trash2 } from 'lucide-react';
import { adminService, AdminSecurityEvent } from './adminService';
import {
  BottomSheet,
  EmptyState,
  GroupedList,
  ListRow,
  Segmented,
  Skel,
  StatusChip,
  showAdminToast,
} from './ui';
import { triggerHaptic } from '../lib/haptics';
import { playSound } from '../lib/sound';

interface AlertsTabProps {
  refreshNonce: number;
  isOnline: boolean;
  onDataChanged: () => Promise<void>;
}

type AlertFilter = 'all' | 'locked' | 'expired';

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

function isEventLockedNow(ev: AdminSecurityEvent): boolean {
  return Boolean(ev.still_locked_until && new Date(ev.still_locked_until).getTime() > Date.now());
}

export function AlertsTab({ refreshNonce, isOnline, onDataChanged }: AlertsTabProps) {
  const [events, setEvents] = useState<AdminSecurityEvent[]>([]);
  const [filter, setFilter] = useState<AlertFilter>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [unlockingOrgId, setUnlockingOrgId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmClearMode, setConfirmClearMode] = useState<'expired' | 'all' | null>(null);
  const [isClearing, setIsClearing] = useState(false);

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

  const counts = useMemo(() => {
    let locked = 0;
    let expired = 0;
    for (const ev of events) {
      if (isEventLockedNow(ev)) locked += 1;
      else expired += 1;
    }
    return { all: events.length, locked, expired };
  }, [events]);

  const filteredEvents = useMemo(() => {
    if (filter === 'locked') return events.filter(isEventLockedNow);
    if (filter === 'expired') return events.filter((ev) => !isEventLockedNow(ev));
    return events;
  }, [events, filter]);

  const handleUnlock = async (orgId: string) => {
    if (!orgId || unlockingOrgId || !isOnline) return;
    setUnlockingOrgId(orgId);
    try {
      const res = await adminService.unlockOrg(orgId);
      if (!res?.ok) {
        throw new Error('Could not unlock account.');
      }
      triggerHaptic('success');
      playSound('success');
      showAdminToast(`Unlocked ${orgId}.`, { tone: 'success' });
      await Promise.all([loadAlerts(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast(err?.message || 'Unlock failed.', { tone: 'error' });
    } finally {
      setUnlockingOrgId(null);
    }
  };

  const handleDeleteEvent = async (ev: AdminSecurityEvent) => {
    if (!isOnline || deletingId !== null || isClearing) return;
    setDeletingId(ev.id);
    try {
      const res = await adminService.deleteSecurityEvent(ev.id);
      if (!res?.ok) {
        throw new Error('Could not delete alert.');
      }
      setEvents((prev) => prev.filter((item) => item.id !== ev.id));
      triggerHaptic('success');
      playSound('success');
      showAdminToast('Alert deleted.', { tone: 'success' });
      await onDataChanged();
    } catch (err: any) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast(err?.message || 'Delete failed.', { tone: 'error' });
    } finally {
      setDeletingId(null);
    }
  };

  const handleConfirmClear = async () => {
    if (!confirmClearMode || !isOnline || isClearing) return;
    setIsClearing(true);
    try {
      const res = await adminService.clearSecurityEvents(confirmClearMode);
      if (!res?.ok) {
        throw new Error('Could not clear alerts.');
      }
      const deletedCount = res.deleted_count ?? 0;
      setConfirmClearMode(null);
      triggerHaptic('success');
      playSound('success');
      showAdminToast(
        deletedCount > 0 ? `Cleared ${deletedCount} alert(s).` : 'No matching alerts to clear.',
        { tone: 'success' }
      );
      await Promise.all([loadAlerts(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast(err?.message || 'Failed to clear alerts.', { tone: 'error' });
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <p className="admin-caption text-zinc-600 dark:text-zinc-400">
          Accounts lock for 15 minutes after 5 wrong passwords.
        </p>

        {events.length > 0 && (
          <div className="flex items-center gap-2">
            {counts.expired > 0 && (
              <button
                type="button"
                disabled={!isOnline || isClearing || deletingId !== null}
                onClick={() => {
                  triggerHaptic('light');
                  playSound('tap');
                  setConfirmClearMode('expired');
                }}
                className="admin-press min-h-[36px] px-3 rounded-xl bg-zinc-200/80 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 disabled:opacity-50 text-zinc-800 dark:text-zinc-200 text-xs font-semibold cursor-pointer"
              >
                Clear expired ({counts.expired})
              </button>
            )}
            <button
              type="button"
              disabled={!isOnline || isClearing || deletingId !== null}
              onClick={() => {
                triggerHaptic('light');
                playSound('tap');
                setConfirmClearMode('all');
              }}
              className="admin-press min-h-[36px] px-3 rounded-xl bg-red-600/10 hover:bg-red-600/20 border border-red-500/25 disabled:opacity-50 text-red-700 dark:text-red-400 text-xs font-semibold cursor-pointer"
            >
              Clear all
            </button>
          </div>
        )}
      </div>

      {events.length > 0 && (
        <Segmented<AlertFilter>
          value={filter}
          onChange={(v) => {
            playSound('tap');
            setFilter(v);
          }}
          ariaLabel="Filter security alerts"
          options={[
            { value: 'all', label: 'All', count: counts.all },
            { value: 'locked', label: 'Locked now', count: counts.locked },
            { value: 'expired', label: 'Expired', count: counts.expired },
          ]}
        />
      )}

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

      {!isLoading && !error && filteredEvents.length === 0 && (
        <EmptyState
          icon={<CheckCircle2 className="w-5 h-5 text-green-500" />}
          message={
            events.length === 0
              ? 'No locked accounts right now.'
              : 'No alerts match this filter.'
          }
        />
      )}

      {!error && filteredEvents.length > 0 && (
        <GroupedList>
          {filteredEvents.map((ev) => {
            const targetId = ev.org_id || '';
            const isLockedNow = isEventLockedNow(ev);
            const failsCount = typeof ev.detail?.fails === 'number' ? ev.detail.fails : 5;
            const isBusy = Boolean(targetId && unlockingOrgId === targetId);
            const isDeleting = deletingId === ev.id;

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
                  <div className="flex items-center gap-1.5">
                    {targetId && isLockedNow ? (
                      <button
                        type="button"
                        disabled={isBusy || isDeleting || !isOnline}
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
                    )}

                    <button
                      type="button"
                      disabled={isDeleting || isClearing || !isOnline}
                      onClick={() => {
                        triggerHaptic('light');
                        playSound('tap');
                        void handleDeleteEvent(ev);
                      }}
                      aria-label={`Delete alert for ${ev.org_name || targetId || 'account'}`}
                      title="Delete alert"
                      className="admin-press min-h-[44px] min-w-[44px] rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-red-500/40 hover:bg-red-500/10 text-zinc-600 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 flex items-center justify-center transition-colors cursor-pointer"
                    >
                      {isDeleting ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                }
              />
            );
          })}
        </GroupedList>
      )}

      <BottomSheet
        open={confirmClearMode !== null}
        onClose={() => setConfirmClearMode(null)}
        closeDisabled={isClearing}
        title={confirmClearMode === 'all' ? 'Clear all alerts?' : 'Clear expired alerts?'}
        subtitle={
          confirmClearMode === 'all'
            ? 'Removes all recorded lockout logs from this view.'
            : 'Removes expired lockout logs while keeping active locks.'
        }
      >
        <div className="space-y-4">
          <p className="admin-body text-zinc-700 dark:text-zinc-300">
            {confirmClearMode === 'all'
              ? 'This permanently deletes all security alert history entries. Active login throttles remain enforced until unlocked or expired.'
              : `This removes ${counts.expired} expired alert log entry(s).`}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              disabled={isClearing}
              onClick={() => setConfirmClearMode(null)}
              className="admin-press min-h-[44px] rounded-xl bg-zinc-200/80 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-[14px] font-semibold cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isClearing || !isOnline}
              onClick={() => void handleConfirmClear()}
              className="admin-press min-h-[44px] rounded-xl bg-red-600 hover:bg-red-500 text-white text-[14px] font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {isClearing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              <span>{isClearing ? 'Clearing...' : 'Delete'}</span>
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
