import React, { useState, useEffect, useCallback } from 'react';
import {
  Inbox,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  X,
  Copy,
  Check,
  Loader2,
  ChevronRight,
} from 'lucide-react';
import {
  adminService,
  AdminReportSummary,
  AdminReportFull,
} from './adminService';
import { Skel } from '../components/common/Skeletons';
import { showToast } from '../components/common/ToastProvider';
import { triggerHaptic } from '../lib/haptics';

interface InboxTabProps {
  refreshNonce: number;
  onDataChanged: () => Promise<void>;
}

type ReportFilter = 'all' | 'new' | 'acknowledged' | 'resolved';

const STATUS_FILTERS: Array<{ key: ReportFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'acknowledged', label: 'Acknowledged' },
  { key: 'resolved', label: 'Resolved' },
];

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

function getReportStatusMeta(status: AdminReportSummary['status']) {
  if (status === 'resolved') {
    return {
      label: 'Resolved',
      textClass: 'text-emerald-600 dark:text-emerald-400',
      Icon: CheckCircle2,
    };
  }
  if (status === 'acknowledged') {
    return {
      label: 'Acknowledged',
      textClass: 'text-amber-600 dark:text-amber-400',
      Icon: Eye,
    };
  }
  return {
    label: 'New',
    textClass: 'text-violet-600 dark:text-violet-400',
    Icon: Clock,
  };
}

export function InboxTab({ refreshNonce, onDataChanged }: InboxTabProps) {
  const [filter, setFilter] = useState<ReportFilter>('all');
  const [reports, setReports] = useState<AdminReportSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedSummary, setSelectedSummary] = useState<AdminReportSummary | null>(null);
  const [fullReport, setFullReport] = useState<AdminReportFull | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [adminNote, setAdminNote] = useState('');
  const [isSavingStatus, setIsSavingStatus] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  const loadReports = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const list = await adminService.listReports(filter, 50);
      setReports(Array.isArray(list) ? list : []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load support inbox.');
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void loadReports();
  }, [loadReports, refreshNonce]);

  const openReport = async (item: AdminReportSummary) => {
    triggerHaptic('tick');
    setSelectedSummary(item);
    setFullReport(null);
    setDetailError(null);
    setAdminNote(item.admin_note || '');
    setCopiedJson(false);
    setIsLoadingDetail(true);

    try {
      const res = await adminService.getReport(item.id);
      if (!res?.ok || !res.report) {
        throw new Error(res?.error || 'Report could not be loaded.');
      }
      setFullReport(res.report);
      setAdminNote(res.report.admin_note || '');
    } catch (err: any) {
      setDetailError(err?.message || 'Failed to load full report.');
    } finally {
      setIsLoadingDetail(false);
    }
  };

  const handleUpdateStatus = async (status: 'new' | 'acknowledged' | 'resolved') => {
    if (!selectedSummary || isSavingStatus) return;
    setIsSavingStatus(true);
    try {
      const res = await adminService.setReportStatus(selectedSummary.id, status, adminNote);
      if (!res?.ok) {
        throw new Error(res?.error || 'Could not update report status.');
      }
      triggerHaptic('success');
      showToast(`Report marked as ${status}.`, 'success');
      setSelectedSummary((prev) => (prev ? { ...prev, status, admin_note: adminNote } : null));
      setFullReport((prev) => (prev ? { ...prev, status, admin_note: adminNote } : null));
      await Promise.all([loadReports(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Status update failed.', 'error');
    } finally {
      setIsSavingStatus(false);
    }
  };

  const handleCopyJson = async () => {
    if (!fullReport) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(fullReport.report, null, 2));
      setCopiedJson(true);
      triggerHaptic('success');
      showToast('Diagnostic JSON copied.', 'success');
    } catch {
      triggerHaptic('warning');
      showToast('Could not copy to clipboard.', 'warning');
    }
  };

  return (
    <div className="space-y-3.5">
      {/* Header + Filter Controls */}
      <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-3 sm:p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 px-0.5">
          <h2 className="text-sm font-bold text-zinc-900 dark:text-white">
            Support Inbox
          </h2>
          <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400 tabular-nums">
            {isLoading && reports.length === 0 ? <Skel w={40} h={14} /> : `${reports.length} shown`}
          </span>
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {STATUS_FILTERS.map((tab) => {
            const active = filter === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  triggerHaptic('tick');
                  setFilter(tab.key);
                }}
                className={`min-h-[44px] px-3.5 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  active
                    ? 'bg-violet-600 text-white'
                    : 'bg-stone-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-900/60 rounded-2xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs text-red-700 dark:text-red-300 min-w-0">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadReports()}
            className="min-h-[44px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 text-xs font-semibold shrink-0 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading Skeleton */}
      {isLoading && reports.length === 0 && !error && (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, idx) => (
            <div
              key={idx}
              className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <Skel w="45%" h={15} />
                <Skel w={64} h={14} />
              </div>
              <Skel w="85%" h={14} />
              <Skel w="35%" h={12} />
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && reports.length === 0 && (
        <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-6 text-center space-y-1.5">
          <div className="w-10 h-10 rounded-xl bg-stone-100 dark:bg-zinc-800 text-violet-500 flex items-center justify-center mx-auto mb-2">
            <Inbox className="w-5 h-5" />
          </div>
          <p className="text-sm font-semibold text-zinc-900 dark:text-white">
            No support reports
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {filter === 'all'
              ? 'Diagnostic reports sent from user devices will appear here.'
              : `No reports with status "${filter}".`}
          </p>
        </div>
      )}

      {/* Report List */}
      {reports.length > 0 && (
        <div className="space-y-2.5">
          {reports.map((item) => {
            const meta = getReportStatusMeta(item.status);
            const StatusIcon = meta.Icon;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => void openReport(item)}
                className="w-full text-left bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 hover:border-violet-500/50 rounded-2xl p-4 space-y-2 transition-colors cursor-pointer"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                      <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">
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
                      <span>{formatDateTime(item.created_at)}</span>
                    </div>

                    <p className="text-sm font-medium text-zinc-900 dark:text-white line-clamp-2">
                      {item.summary}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 shrink-0 pt-0.5">
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap ${meta.textClass}`}
                    >
                      <StatusIcon className="w-3.5 h-3.5" />
                      <span>{meta.label}</span>
                    </span>
                    <ChevronRight className="w-4 h-4 text-zinc-400" />
                  </div>
                </div>

                {item.admin_note && (
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    Note: {item.admin_note}
                  </p>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Report Detail Sheet */}
      {selectedSummary && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/65 flex items-end sm:items-center justify-center sm:p-4"
          onClick={() => setSelectedSummary(null)}
        >
          <div
            className="w-full sm:max-w-xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-t-3xl sm:rounded-3xl p-5 max-h-[90dvh] flex flex-col gap-3.5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-zinc-900 dark:text-white">
                  Report · {selectedSummary.org_id || 'PUBLIC'}
                </h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums mt-0.5">
                  {selectedSummary.role} · {formatDateTime(selectedSummary.created_at)}
                  {selectedSummary.app_version ? ` · v${selectedSummary.app_version}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSummary(null)}
                aria-label="Close report"
                className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 rounded-xl flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-3 pr-0.5">
              {/* Summary */}
              <div className="p-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 space-y-1">
                <div className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                  User Summary
                </div>
                <p className="text-sm text-zinc-900 dark:text-white whitespace-pre-wrap break-words">
                  {selectedSummary.summary}
                </p>
              </div>

              {/* Status + Note Controls */}
              <div className="space-y-2.5">
                <div className="grid grid-cols-3 gap-2">
                  {(['new', 'acknowledged', 'resolved'] as const).map((st) => {
                    const active = (fullReport?.status || selectedSummary.status) === st;
                    return (
                      <button
                        key={st}
                        type="button"
                        disabled={isSavingStatus}
                        onClick={() => void handleUpdateStatus(st)}
                        className={`min-h-[44px] px-2.5 rounded-xl text-xs font-semibold capitalize transition-colors cursor-pointer ${
                          active
                            ? 'bg-violet-600 text-white'
                            : 'bg-stone-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-200 dark:hover:bg-zinc-700'
                        }`}
                      >
                        {st}
                      </button>
                    );
                  })}
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="admin-report-note"
                    className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300"
                  >
                    Admin Note
                  </label>
                  <textarea
                    id="admin-report-note"
                    rows={2}
                    value={adminNote}
                    onChange={(e) => setAdminNote(e.target.value)}
                    placeholder="Internal triage notes..."
                    className="w-full px-3.5 py-2.5 rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-xs text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:border-violet-500 resize-none"
                  />
                  <button
                    type="button"
                    disabled={isSavingStatus}
                    onClick={() => void handleUpdateStatus(fullReport?.status || selectedSummary.status)}
                    className="min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-900 dark:text-white inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    {isSavingStatus && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>Save note</span>
                  </button>
                </div>
              </div>

              {/* Diagnostic JSON Payload */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                    Diagnostic Payload
                  </span>
                  {fullReport && (
                    <button
                      type="button"
                      onClick={() => void handleCopyJson()}
                      className="min-h-[36px] px-3 rounded-lg bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-800 dark:text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      {copiedJson ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copiedJson ? 'Copied' : 'Copy JSON'}</span>
                    </button>
                  )}
                </div>

                {isLoadingDetail && (
                  <div className="p-4 rounded-xl bg-stone-100 dark:bg-zinc-800 space-y-2">
                    <Skel w="70%" h={14} />
                    <Skel w="90%" h={14} />
                    <Skel w="55%" h={14} />
                  </div>
                )}

                {detailError && (
                  <p className="text-xs text-red-600 dark:text-red-400 p-3 rounded-xl bg-red-50 dark:bg-red-950/40">
                    {detailError}
                  </p>
                )}

                {fullReport && (
                  <pre className="p-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-[11px] font-mono text-zinc-800 dark:text-zinc-200 overflow-x-auto max-h-72 leading-relaxed">
                    {JSON.stringify(fullReport.report, null, 2)}
                  </pre>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
