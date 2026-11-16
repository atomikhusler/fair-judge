import React, { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Megaphone, Plus, PowerOff, Trash2 } from 'lucide-react';
import { AdminAnnouncement, adminService } from '../adminService';
import {
  BottomSheet,
  EmptyState,
  GroupedList,
  ListRow,
  Segmented,
  Skel,
  StatusChip,
  showAdminToast,
} from '../ui';
import { triggerHaptic } from '../../lib/haptics';
import { playSound } from '../../lib/sound';

const NoticeEditor = lazy(() => import('./NoticeEditor'));

interface NoticesListProps {
  refreshNonce: number;
  isOnline: boolean;
  onDataChanged: () => Promise<void>;
}

type NoticesTabFilter = 'active' | 'ended';
type SeverityFilter = 'all' | 'info' | 'warning' | 'urgent';

function isNoticeLive(item: AdminAnnouncement): boolean {
  if (!item.active) return false;
  if (!item.ends_at) return true;
  return new Date(item.ends_at).getTime() > Date.now();
}

function formatAudience(item: AdminAnnouncement): string {
  if (item.audience === 'org') return item.target_org_id || 'One organiser';
  if (item.audience === 'organisers') return 'Organisers';
  if (item.audience === 'judges') return 'Judges';
  return 'Everyone';
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

export function NoticesList({ refreshNonce, isOnline, onDataChanged }: NoticesListProps) {
  const [filter, setFilter] = useState<NoticesTabFilter>('active');
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>('all');
  const [notices, setNotices] = useState<AdminAnnouncement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingNotice, setEditingNotice] = useState<AdminAnnouncement | null>(null);

  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmDeleteNotice, setConfirmDeleteNotice] = useState<AdminAnnouncement | null>(null);
  const [confirmClearEnded, setConfirmClearEnded] = useState(false);
  const [isMutating, setIsMutating] = useState(false);

  const loadNotices = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const list = await adminService.listAnnouncements();
      setNotices(Array.isArray(list) ? list : []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load notices.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNotices();
  }, [loadNotices, refreshNonce]);

  const activeNotices = useMemo(() => notices.filter(isNoticeLive), [notices]);
  const endedNotices = useMemo(() => notices.filter((n) => !isNoticeLive(n)), [notices]);

  const visibleNotices = useMemo(() => {
    const base = filter === 'active' ? activeNotices : endedNotices;
    if (severityFilter === 'all') return base;
    return base.filter((n) => n.severity === severityFilter);
  }, [filter, activeNotices, endedNotices, severityFilter]);

  const openNewNotice = () => {
    if (!isOnline) return;
    triggerHaptic('light');
    playSound('tap');
    setEditingNotice(null);
    setEditorOpen(true);
  };

  const openEditNotice = (item: AdminAnnouncement) => {
    triggerHaptic('light');
    playSound('tap');
    setEditingNotice(item);
    setEditorOpen(true);
  };

  const handleQuickRevoke = async (item: AdminAnnouncement) => {
    if (!isOnline || revokingId || isMutating) return;
    setRevokingId(item.id);
    try {
      const res = await adminService.endAnnouncement(item.id);
      if (!res?.ok) throw new Error('Could not revoke notice.');
      triggerHaptic('success');
      playSound('success');
      showAdminToast(`Revoked "${item.title}".`, { tone: 'success' });
      await Promise.all([loadNotices(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast(err?.message || 'Revoke failed.', { tone: 'error' });
    } finally {
      setRevokingId(null);
    }
  };

  const handleConfirmDeleteSingle = async () => {
    if (!confirmDeleteNotice || !isOnline || isMutating) return;
    setIsMutating(true);
    try {
      const res = await adminService.deleteAnnouncement(confirmDeleteNotice.id);
      if (!res?.ok) throw new Error('Could not delete notice.');
      setConfirmDeleteNotice(null);
      triggerHaptic('success');
      playSound('success');
      showAdminToast('Notice deleted permanently.', { tone: 'success' });
      await Promise.all([loadNotices(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast(err?.message || 'Delete failed.', { tone: 'error' });
    } finally {
      setIsMutating(false);
    }
  };

  const handleConfirmClearEnded = async () => {
    if (!isOnline || isMutating) return;
    setIsMutating(true);
    try {
      const res = await adminService.clearEndedAnnouncements();
      if (!res?.ok) throw new Error('Could not clear ended notices.');
      const count = res.deleted_count ?? 0;
      setConfirmClearEnded(false);
      triggerHaptic('success');
      playSound('success');
      showAdminToast(
        count > 0 ? `Cleared ${count} ended notice(s).` : 'No ended notices to clear.',
        { tone: 'success' }
      );
      await Promise.all([loadNotices(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast(err?.message || 'Failed to clear ended notices.', { tone: 'error' });
    } finally {
      setIsMutating(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <Segmented
          options={[
            { value: 'active', label: 'Active', count: activeNotices.length },
            { value: 'ended', label: 'Ended', count: endedNotices.length },
          ]}
          value={filter}
          onChange={(val) => {
            playSound('tap');
            setFilter(val);
          }}
          ariaLabel="Notice status filter"
          className="flex-1"
        />

        <button
          type="button"
          disabled={!isOnline}
          onClick={openNewNotice}
          className="admin-press min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-[14px] font-semibold inline-flex items-center justify-center gap-2 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>New notice</span>
        </button>
      </div>

      {/* Severity Filter + Clear Ended */}
      {notices.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div
            role="group"
            aria-label="Filter notices by severity"
            className="inline-flex rounded-xl bg-zinc-200/80 dark:bg-zinc-800 p-0.5 border border-zinc-200 dark:border-zinc-700"
          >
            {(['all', 'info', 'warning', 'urgent'] as const).map((sev) => (
              <button
                key={sev}
                type="button"
                aria-pressed={severityFilter === sev}
                onClick={() => {
                  triggerHaptic('light');
                  playSound('tap');
                  setSeverityFilter(sev);
                }}
                className={`min-h-[34px] px-2.5 py-1 text-[11px] font-bold rounded-lg capitalize transition-colors cursor-pointer ${
                  severityFilter === sev
                    ? 'bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 shadow-xs'
                    : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                {sev}
              </button>
            ))}
          </div>

          {endedNotices.length > 0 && (
            <button
              type="button"
              disabled={!isOnline || isMutating || revokingId !== null}
              onClick={() => {
                triggerHaptic('light');
                playSound('tap');
                setConfirmClearEnded(true);
              }}
              className="admin-press min-h-[34px] px-3 rounded-xl bg-zinc-200/80 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 disabled:opacity-50 text-zinc-800 dark:text-zinc-200 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear ended ({endedNotices.length})</span>
            </button>
          )}
        </div>
      )}

      {error && (
        <EmptyState
          icon={<AlertTriangle className="w-5 h-5 text-red-500" />}
          message={error}
          actionLabel="Retry"
          onAction={() => void loadNotices()}
          actionDisabled={!isOnline}
        />
      )}

      {isLoading && notices.length === 0 && !error && (
        <GroupedList>
          {Array.from({ length: 3 }).map((_, i) => (
            <ListRow
              key={i}
              title={<Skel w="60%" h={15} />}
              subtitle={<Skel w="80%" h={12} />}
              trailing={<Skel w={58} h={22} rounded="rounded-full" />}
            />
          ))}
        </GroupedList>
      )}

      {!isLoading && !error && visibleNotices.length === 0 && (
        <EmptyState
          icon={<Megaphone className="w-5 h-5" />}
          message={
            severityFilter !== 'all'
              ? `No ${severityFilter} notices in this view.`
              : filter === 'active'
              ? 'No active notices right now.'
              : 'No ended notices yet.'
          }
          actionLabel={filter === 'active' && severityFilter === 'all' ? 'New notice' : undefined}
          onAction={filter === 'active' && severityFilter === 'all' ? openNewNotice : undefined}
          actionDisabled={!isOnline}
        />
      )}

      {!error && visibleNotices.length > 0 && (
        <GroupedList>
          {visibleNotices.map((item) => {
            const tone =
              item.severity === 'urgent'
                ? 'problem'
                : item.severity === 'warning'
                  ? 'waiting'
                  : 'neutral';
            const sevLabel =
              item.severity === 'urgent'
                ? 'Urgent'
                : item.severity === 'warning'
                  ? 'Warning'
                  : 'Info';

            const timeDetail = item.ends_at
              ? filter === 'active'
                ? `Ends ${formatDateTime(item.ends_at)}`
                : `Ended ${formatDateTime(item.ends_at)}`
              : `Posted ${formatDateTime(item.starts_at)}`;

            const isLive = isNoticeLive(item);
            const isRevoking = revokingId === item.id;

            return (
              <ListRow
                key={item.id}
                title={
                  <button
                    type="button"
                    onClick={() => openEditNotice(item)}
                    className="w-full text-left font-medium text-zinc-900 dark:text-zinc-100 hover:text-violet-600 dark:hover:text-violet-400 truncate cursor-pointer focus:outline-none"
                  >
                    {item.title}
                  </button>
                }
                subtitle={
                  <button
                    type="button"
                    onClick={() => openEditNotice(item)}
                    className="w-full text-left truncate cursor-pointer focus:outline-none"
                  >
                    {formatAudience(item)} · {timeDetail}
                  </button>
                }
                trailing={
                  <div className="flex items-center gap-1.5">
                    <StatusChip tone={tone} label={sevLabel} />
                    {isLive && (
                      <button
                        type="button"
                        disabled={!isOnline || isRevoking || isMutating}
                        onClick={() => {
                          triggerHaptic('light');
                          playSound('tap');
                          void handleQuickRevoke(item);
                        }}
                        aria-label={`Revoke notice ${item.title}`}
                        title="Revoke notice"
                        className="admin-press min-h-[38px] px-2.5 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 disabled:opacity-50 text-amber-700 dark:text-amber-300 text-xs font-semibold inline-flex items-center gap-1 cursor-pointer"
                      >
                        {isRevoking ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <PowerOff className="w-3.5 h-3.5" />
                        )}
                        <span className="hidden sm:inline">Revoke</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!isOnline || isRevoking || isMutating}
                      onClick={() => {
                        triggerHaptic('light');
                        playSound('tap');
                        setConfirmDeleteNotice(item);
                      }}
                      aria-label={`Delete notice ${item.title}`}
                      title="Delete notice"
                      className="admin-press min-h-[38px] min-w-[38px] rounded-xl border border-zinc-200 dark:border-zinc-800 hover:border-red-500/40 hover:bg-red-500/10 text-zinc-600 dark:text-zinc-400 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-50 flex items-center justify-center transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                }
              />
            );
          })}
        </GroupedList>
      )}

      <Suspense fallback={null}>
        <NoticeEditor
          open={editorOpen}
          notice={editingNotice}
          isOnline={isOnline}
          onClose={() => setEditorOpen(false)}
          onSaved={async () => {
            await Promise.all([loadNotices(), onDataChanged()]);
          }}
        />
      </Suspense>

      <BottomSheet
        open={confirmDeleteNotice !== null}
        onClose={() => setConfirmDeleteNotice(null)}
        closeDisabled={isMutating}
        title="Delete notice permanently?"
        subtitle={confirmDeleteNotice?.title || 'Notice'}
      >
        <div className="space-y-4">
          <p className="admin-body text-zinc-700 dark:text-zinc-300">
            This permanently deletes this notice from Admin Console and removes it from client banners and notification inboxes.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              disabled={isMutating}
              onClick={() => setConfirmDeleteNotice(null)}
              className="admin-press min-h-[44px] rounded-xl bg-zinc-200/80 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-[14px] font-semibold cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isMutating || !isOnline}
              onClick={() => void handleConfirmDeleteSingle()}
              className="admin-press min-h-[44px] rounded-xl bg-red-600 hover:bg-red-500 text-white text-[14px] font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {isMutating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              <span>{isMutating ? 'Deleting...' : 'Delete'}</span>
            </button>
          </div>
        </div>
      </BottomSheet>

      <BottomSheet
        open={confirmClearEnded}
        onClose={() => setConfirmClearEnded(false)}
        closeDisabled={isMutating}
        title="Clear ended notices?"
        subtitle={`${endedNotices.length} ended notice(s) will be removed.`}
      >
        <div className="space-y-4">
          <p className="admin-body text-zinc-700 dark:text-zinc-300">
            This permanently deletes all inactive and expired notices. Currently active notices remain untouched.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              disabled={isMutating}
              onClick={() => setConfirmClearEnded(false)}
              className="admin-press min-h-[44px] rounded-xl bg-zinc-200/80 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-[14px] font-semibold cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isMutating || !isOnline}
              onClick={() => void handleConfirmClearEnded()}
              className="admin-press min-h-[44px] rounded-xl bg-red-600 hover:bg-red-500 text-white text-[14px] font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {isMutating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              <span>{isMutating ? 'Clearing...' : 'Clear ended'}</span>
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
