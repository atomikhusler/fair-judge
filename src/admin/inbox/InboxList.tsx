import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Inbox, AlertTriangle } from 'lucide-react';
import { adminService, AdminReportSummary } from '../adminService';
import { EmptyState, GroupedList, ListRow, Segmented, Skel } from '../ui';
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
  const [reports, setReports] = useState<AdminReportSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    setFilter(next);
  };

  return (
    <div className="space-y-4">
      <div className="sticky top-[48px] md:top-0 z-10 bg-zinc-50 dark:bg-zinc-950 pt-1 pb-2">
        <Segmented
          options={FILTER_OPTIONS}
          value={filter}
          onChange={handleFilterChange}
          ariaLabel="Inbox report filter"
        />
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

      {!isLoading && !error && reports.length === 0 && (
        <EmptyState
          icon={<Inbox className="w-5 h-5" />}
          message={
            filter === 'all'
              ? 'No diagnostic reports yet.'
              : `No ${getStatusLabel(filter).toLowerCase()} reports.`
          }
        />
      )}

      {!error && reports.length > 0 && (
        <GroupedList>
          {reports.map((item, idx) => {
            const verdict = detectReportVerdict(item.summary);
            const isSelected = selectedReportId === item.id;
            const isNew = item.status === 'new';
            return (
              <ListRow
                key={item.id}
                animateIndex={allowEntranceAnim && idx < 8 ? idx : undefined}
                onClick={() => onSelectReport(item)}
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
    </div>
  );
}
