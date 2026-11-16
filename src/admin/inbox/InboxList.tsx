import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Inbox, AlertTriangle, Search, X, Trash2, Loader2 } from 'lucide-react';
import { adminService, AdminReportSummary } from '../adminService';
import {
  BottomSheet,
  EmptyState,
  GroupedList,
  ListRow,
  Segmented,
  Skel,
  showAdminToast,
} from '../ui';
import { triggerHaptic } from '../../lib/haptics';
import { playSound } from '../../lib/sound';
import {
  InboxFilter,
  detectReportVerdict,
  formatInboxRelativeTime,
  getStatusLabel,
} from './inboxUtils';

interface InboxListProps {
  selectedReportId: string | null;
  refreshNonce: number;
  isOnline: boolean;
  onSelectReport: (item: AdminReportSummary) => void;
}

const FILTER_OPTIONS: Array<{ value: InboxFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'new', label: 'New' },
  { value: 'acknowledged', label: 'Seen' },
  { value: 'resolved', label: 'Resolved' },
];

export function InboxList({
  selectedReportId,
  refreshNonce,
  isOnline,
  onSelectReport,
}: InboxListProps) {
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [search, setSearch] = useState('');
  const [reports, setReports] = useState<AdminReportSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmClearResolved, setConfirmClearResolved] = useState(false);
  const [isClearingResolved, setIsClearingResolved] = useState(false);

  const [allowEntranceAnim, setAllowEntranceAnim] = useState(true);
  const entranceUsedRef = useRef(false);

  const loadReports = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const list = await adminService.listReports(filter, 50);
      setReports(Array.isArray(list) ? list : []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load inbox.');
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void loadReports();
  }, [loadReports, refreshNonce]);

  useEffect(() => {
    if (!isLoading && reports.length > 0 && !entranceUsedRef.current) {
      entranceUsedRef.current = true;
      const t = window.setTimeout(() => setAllowEntranceAnim(false), 450);
      return () => window.clearTimeout(t);
    }
  }, [isLoading, reports.length]);

  const handleFilterChange = (next: InboxFilter) => {
    entranceUsedRef.current = true;
    setAllowEntranceAnim(false);
    playSound('tap');
    setFilter(next);
  };

  const resolvedCount = useMemo(
    () => reports.filter((r) => r.status === 'resolved').length,
    [reports]
  );

  const visibleReports = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return reports;
    return reports.filter(
      (r) =>
        (r.org_id || 'public').toLowerCase().includes(q) ||
        (r.role || '').toLowerCase().includes(q) ||
        (r.summary || '').toLowerCase().includes(q)
    );
  }, [reports, search]);

  const handleConfirmClearResolved = async () => {
    if (!isOnline || isClearingResolved) return;
    setIsClearingResolved(true);
    try {
      const res = await adminService.clearResolvedReports();
      if (!res?.ok) throw new Error('Could not clear resolved reports.');
      const count = res.deleted_count ?? 0;
      setConfirmClearResolved(false);
      triggerHaptic('success');
      playSound('success');
      showAdminToast(
        count > 0 ? `Cleared ${count} resolved report(s).` : 'No resolved reports to clear.',
        { tone: 'success' }
      );
      await loadReports();
    } catch (err: any) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast(err?.message || 'Failed to clear resolved reports.', { tone: 'error' });
    } finally {
      setIsClearingResolved(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="sticky top-[48px] md:top-0 z-10 bg-zinc-50 dark:bg-zinc-950 pt-1 pb-2 space-y-2.5">
        <Segmented
          options={FILTER_OPTIONS}
          value={filter}
          onChange={handleFilterChange}
          ariaLabel="Inbox report filter"
        />

        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search
              aria-hidden="true"
              className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by org, role, or summary..."
              aria-label="Filter inbox reports"
              className="w-full min-h-[40px] pl-9 pr-8 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 text-[13px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/60"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {resolvedCount > 0 && (
            <button
              type="button"
              disabled={!isOnline || isClearingResolved}
              onClick={() => {
                triggerHaptic('light');
                playSound('tap');
                setConfirmClearResolved(true);
              }}
              className="admin-press shrink-0 min-h-[40px] px-3 rounded-xl bg-zinc-200/80 hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 disabled:opacity-50 text-zinc-800 dark:text-zinc-200 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear resolved ({resolvedCount})</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <EmptyState
          icon={<AlertTriangle className="w-5 h-5 text-red-500" />}
          message={error}
          actionLabel="Retry"
          onAction={() => void loadReports()}
          actionDisabled={!isOnline}
        />
      )}

      {isLoading && reports.length === 0 && !error && (
        <GroupedList>
          {Array.from({ length: 4 }).map((_, i) => (
            <ListRow
              key={i}
              leading={<Skel w={10} h={10} rounded="rounded-full" />}
              title={<Skel w="75%" h={15} />}
              subtitle={<Skel w="55%" h={12} />}
              trailing={<Skel w={36} h={12} />}
            />
          ))}
        </GroupedList>
      )}

      {!isLoading && !error && visibleReports.length === 0 && (
        <EmptyState
          icon={<Inbox className="w-5 h-5" />}
          message={
            search.trim()
              ? 'No reports match your search.'
              : filter === 'all'
              ? 'No diagnostic reports yet.'
              : `No ${getStatusLabel(filter).toLowerCase()} reports.`
          }
        />
      )}

      {!error && visibleReports.length > 0 && (
        <GroupedList>
          {visibleReports.map((item, idx) => {
            const verdict = detectReportVerdict(item.summary);
            const isSelected = selectedReportId === item.id;
            const isNew = item.status === 'new';
            return (
              <ListRow
                key={item.id}
                animateIndex={allowEntranceAnim && idx < 8 ? idx : undefined}
                onClick={() => {
                  playSound('tap');
                  onSelectReport(item);
                }}
                className={
                  isSelected
                    ? 'md:bg-violet-600/8 dark:md:bg-violet-500/12'
                    : ''
                }
                leading={
                  <span className="flex items-center justify-center w-4 h-4">
                    <span
                      aria-hidden="true"
                      className={`w-2.5 h-2.5 rounded-full ${verdict.dotClass}`}
                    />
                    <span className="sr-only">Verdict {verdict.label}:</span>
                  </span>
                }
                title={item.summary}
                subtitle={
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono text-zinc-700 dark:text-zinc-300">
                      {item.org_id || 'PUBLIC'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="capitalize">{item.role}</span>
                    {item.app_version && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>v{item.app_version}</span>
                      </>
                    )}
                    <span aria-hidden="true">·</span>
                    <span>{formatInboxRelativeTime(item.created_at)}</span>
                  </span>
                }
                trailing={
                  isNew ? (
                    <span className="inline-flex items-center gap-1.5 admin-caption font-semibold text-orange-700 dark:text-orange-400">
                      <span aria-hidden="true" className="w-2 h-2 rounded-full bg-orange-500" />
                      <span>New</span>
                    </span>
                  ) : (
                    <span className="admin-caption text-zinc-500 dark:text-zinc-400">
                      {getStatusLabel(item.status)}
                    </span>
                  )
                }
                chevron
              />
            );
          })}
        </GroupedList>
      )}

      <BottomSheet
        open={confirmClearResolved}
        onClose={() => setConfirmClearResolved(false)}
        closeDisabled={isClearingResolved}
        title="Clear resolved reports?"
        subtitle={`${resolvedCount} resolved report(s) will be removed.`}
      >
        <div className="space-y-4">
          <p className="admin-body text-zinc-700 dark:text-zinc-300">
            This permanently deletes all reports marked Resolved from Inbox. Unread and Seen reports remain untouched.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              disabled={isClearingResolved}
              onClick={() => setConfirmClearResolved(false)}
              className="admin-press min-h-[44px] rounded-xl bg-zinc-200/80 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-[14px] font-semibold cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isClearingResolved || !isOnline}
              onClick={() => void handleConfirmClearResolved()}
              className="admin-press min-h-[44px] rounded-xl bg-red-600 hover:bg-red-500 text-white text-[14px] font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {isClearingResolved ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              <span>{isClearingResolved ? 'Clearing...' : 'Clear resolved'}</span>
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
