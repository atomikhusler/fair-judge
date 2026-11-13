import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Inbox,
  Loader2,
} from 'lucide-react';
import { AdminReportFull, AdminReportSummary, adminService } from '../adminService';
import {
  BackButton,
  EmptyState,
  GroupedList,
  ListRow,
  ScreenHeader,
  Segmented,
  Skel,
  StatusChip,
  showAdminToast,
} from '../ui';
import { triggerHaptic } from '../../lib/haptics';
import {
  detectReportVerdict,
  extractReadableFacts,
  formatInboxRelativeTime,
} from './inboxUtils';

interface InboxDetailProps {
  reportId: string;
  cachedSummary?: AdminReportSummary | null;
  isOnline: boolean;
  refreshNonce: number;
  onBack: () => void;
  onReportUpdated: () => Promise<void>;
}

const STATUS_OPTIONS: Array<{ value: 'acknowledged' | 'resolved'; label: string }> = [
  { value: 'acknowledged', label: 'Seen' },
  { value: 'resolved', label: 'Resolved' },
];

export default function InboxDetail({
  reportId,
  cachedSummary = null,
  isOnline,
  refreshNonce,
  onBack,
  onReportUpdated,
}: InboxDetailProps) {
  const [report, setReport] = useState<AdminReportFull | null>(null);
  const [summaryFallback, setSummaryFallback] = useState<AdminReportSummary | null>(
    cachedSummary
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [adminNote, setAdminNote] = useState(cachedSummary?.admin_note || '');
  const [isSaving, setIsSaving] = useState(false);
  const [showFullReport, setShowFullReport] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [copiedJson, setCopiedJson] = useState(false);

  const autoSeenDoneRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (cachedSummary && cachedSummary.id === reportId) {
      setSummaryFallback(cachedSummary);
      setAdminNote(cachedSummary.admin_note || '');
    }
  }, [cachedSummary, reportId]);

  const loadReport = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    setCopiedSummary(false);
    setCopiedJson(false);

    try {
      const res = await adminService.getReport(reportId);
      if (!res?.ok || !res.report) {
        throw new Error(res?.error || 'Report could not be loaded.');
      }

      const loaded = res.report;
      setReport(loaded);
      setSummaryFallback(loaded);
      setAdminNote(loaded.admin_note || '');

      // Opening a New report marks it Seen automatically
      if (loaded.status === 'new' && !autoSeenDoneRef.current.has(reportId)) {
        autoSeenDoneRef.current.add(reportId);
        try {
          const ack = await adminService.setReportStatus(
            reportId,
            'acknowledged',
            loaded.admin_note ?? null
          );
          if (ack?.ok) {
            setReport((prev) => (prev ? { ...prev, status: 'acknowledged' } : prev));
            setSummaryFallback((prev) =>
              prev ? { ...prev, status: 'acknowledged' } : prev
            );
            await onReportUpdated();
          }
        } catch {
          // Best-effort auto-mark
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to load report.');
    } finally {
      setIsLoading(false);
    }
  }, [reportId, onReportUpdated]);

  useEffect(() => {
    void loadReport();
  }, [loadReport, refreshNonce]);

  const activeItem = report || summaryFallback;

  const handleStatusChange = async (nextStatus: 'acknowledged' | 'resolved') => {
    if (!activeItem || isSaving || !isOnline) return;
    setIsSaving(true);
    try {
      const res = await adminService.setReportStatus(reportId, nextStatus, adminNote);
      if (!res?.ok) throw new Error(res?.error || 'Could not update status.');
      triggerHaptic('success');
      showAdminToast(
        nextStatus === 'resolved' ? 'Report marked Resolved.' : 'Report marked Seen.',
        { tone: 'success' }
      );
      setReport((prev) =>
        prev ? { ...prev, status: nextStatus, admin_note: adminNote } : prev
      );
      setSummaryFallback((prev) =>
        prev ? { ...prev, status: nextStatus, admin_note: adminNote } : prev
      );
      await onReportUpdated();
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Failed to update report.', { tone: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveNote = async () => {
    if (!activeItem || isSaving || !isOnline) return;
    const statusToKeep = activeItem.status === 'resolved' ? 'resolved' : 'acknowledged';
    setIsSaving(true);
    try {
      const res = await adminService.setReportStatus(reportId, statusToKeep, adminNote);
      if (!res?.ok) throw new Error(res?.error || 'Could not save note.');
      triggerHaptic('success');
      showAdminToast('Note saved.', { tone: 'success' });
      setReport((prev) =>
        prev ? { ...prev, status: statusToKeep, admin_note: adminNote } : prev
      );
      setSummaryFallback((prev) =>
        prev ? { ...prev, status: statusToKeep, admin_note: adminNote } : prev
      );
      await onReportUpdated();
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Failed to save note.', { tone: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCopySummary = async () => {
    if (!activeItem) return;
    try {
      await navigator.clipboard.writeText(activeItem.summary);
      setCopiedSummary(true);
      triggerHaptic('success');
      showAdminToast('Summary copied.', { tone: 'success' });
    } catch {
      triggerHaptic('warning');
      showAdminToast('Copy failed.', { tone: 'error' });
    }
  };

  const handleCopyJson = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report.report, null, 2));
      setCopiedJson(true);
      triggerHaptic('success');
      showAdminToast('Full report JSON copied.', { tone: 'success' });
    } catch {
      triggerHaptic('warning');
      showAdminToast('Copy failed.', { tone: 'error' });
    }
  };

  const verdict = activeItem
    ? detectReportVerdict(activeItem.summary, report?.report)
    : null;
  const readableFacts = extractReadableFacts(report?.report);

  return (
    <div className="min-h-full">
      <div className="md:hidden">
        <ScreenHeader
          compactOnly
          title={activeItem?.org_id || 'Report'}
          onBack={onBack}
          backLabel="Inbox"
        />
      </div>

      <div className="hidden md:flex items-center justify-between px-6 pt-5 pb-3 border-b border-zinc-200 dark:border-zinc-800">
        <div className="min-w-0">
          <h2 className="admin-title text-zinc-900 dark:text-zinc-100 truncate">
            Report · {activeItem?.org_id || 'PUBLIC'}
          </h2>
          {activeItem && (
            <p className="admin-caption text-zinc-500 dark:text-zinc-400">
              {activeItem.role}
              {activeItem.app_version ? ` · v${activeItem.app_version}` : ''} ·{' '}
              {formatInboxRelativeTime(activeItem.created_at)}
            </p>
          )}
        </div>
        <BackButton onClick={onBack} label="Close" />
      </div>

      <div className="p-4 md:p-6 max-w-2xl space-y-6 pb-10">
        {error && !activeItem && (
          <EmptyState
            icon={<AlertTriangle className="w-5 h-5 text-red-500" />}
            message={error}
            actionLabel="Retry"
            onAction={() => void loadReport()}
            actionDisabled={!isOnline}
          />
        )}

        {isLoading && !activeItem && !error && (
          <div className="space-y-4">
            <Skel w="60%" h={20} />
            <Skel w="100%" h={96} rounded="rounded-2xl" />
            <Skel w="100%" h={112} rounded="rounded-2xl" />
          </div>
        )}

        {!isLoading && !error && !activeItem && (
          <EmptyState
            icon={<Inbox className="w-5 h-5" />}
            message="Report not found."
            actionLabel="Back to Inbox"
            onAction={onBack}
          />
        )}

        {activeItem && (
          <>
            {/* Status header */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {verdict && (
                  <StatusChip
                    tone={
                      verdict.level === 'major'
                        ? 'problem'
                        : verdict.level === 'minor'
                          ? 'waiting'
                          : verdict.level === 'ok'
                            ? 'ok'
                            : 'neutral'
                    }
                    label={verdict.label}
                  />
                )}
                <span className="admin-caption text-zinc-500 dark:text-zinc-400 truncate">
                  {activeItem.role}
                  {activeItem.app_version ? ` · v${activeItem.app_version}` : ''} ·{' '}
                  {formatInboxRelativeTime(activeItem.created_at)}
                </span>
              </div>
            </div>

            {/* Summary card with Copy summary */}
            <section className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="admin-caption font-semibold text-zinc-500 dark:text-zinc-400">
                  Summary
                </h3>
                <button
                  type="button"
                  onClick={() => void handleCopySummary()}
                  className="admin-press min-h-[44px] px-3 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-[13px] font-semibold text-zinc-900 dark:text-zinc-100 inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
                >
                  {copiedSummary ? (
                    <Check className="w-4 h-4 text-green-500" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                  <span>{copiedSummary ? 'Copied' : 'Copy summary'}</span>
                </button>
              </div>
              <p className="admin-body text-zinc-900 dark:text-zinc-100 whitespace-pre-wrap break-words">
                {activeItem.summary}
              </p>
            </section>

            {/* Seen / Resolved Segmented + Note */}
            <section className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 space-y-4">
              <div className="space-y-1.5">
                <span className="block admin-caption font-semibold text-zinc-500 dark:text-zinc-400">
                  Status
                </span>
                <Segmented
                  options={STATUS_OPTIONS}
                  value={activeItem.status === 'resolved' ? 'resolved' : 'acknowledged'}
                  disabled={isSaving || !isOnline}
                  onChange={(val) => void handleStatusChange(val)}
                  ariaLabel="Report status"
                />
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="admin-inbox-note"
                  className="block admin-caption font-semibold text-zinc-500 dark:text-zinc-400"
                >
                  Admin note
                </label>
                <textarea
                  id="admin-inbox-note"
                  rows={3}
                  value={adminNote}
                  disabled={!isOnline || isSaving}
                  onChange={(e) => setAdminNote(e.target.value)}
                  placeholder="Add an internal note..."
                  className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/60 resize-none disabled:opacity-60"
                />
                <button
                  type="button"
                  disabled={isSaving || !isOnline}
                  onClick={() => void handleSaveNote()}
                  className="admin-press min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-[14px] font-semibold inline-flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
                >
                  {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                  <span>Save note</span>
                </button>
              </div>
            </section>

            {/* Collapsible Full report */}
            <section className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 overflow-hidden">
              <button
                type="button"
                aria-expanded={showFullReport}
                onClick={() => {
                  triggerHaptic('light');
                  setShowFullReport((prev) => !prev);
                }}
                className="admin-press w-full min-h-[56px] px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/60 cursor-pointer"
              >
                <span className="admin-body font-medium text-zinc-900 dark:text-zinc-100">
                  Full report
                </span>
                {showFullReport ? (
                  <ChevronUp className="w-4 h-4 text-zinc-500" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-zinc-500" />
                )}
              </button>

              {showFullReport && (
                <div className="border-t border-zinc-200 dark:border-zinc-800 p-4 space-y-4">
                  {isLoading && !report && (
                    <div className="space-y-2">
                      <Skel w="70%" h={14} />
                      <Skel w="90%" h={14} />
                      <Skel w="55%" h={14} />
                    </div>
                  )}

                  {error && !report && (
                    <p className="admin-caption text-red-600 dark:text-red-400">{error}</p>
                  )}

                  {report && (
                    <>
                      {readableFacts.length > 0 && (
                        <GroupedList>
                          {readableFacts.map((fact) => (
                            <ListRow
                              key={fact.label}
                              title={fact.label}
                              trailing={fact.value}
                            />
                          ))}
                        </GroupedList>
                      )}

                      <div className="flex items-center justify-between gap-2">
                        <span className="admin-caption font-semibold text-zinc-500 dark:text-zinc-400">
                          Raw JSON
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleCopyJson()}
                          className="admin-press min-h-[44px] px-3 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-[13px] font-semibold text-zinc-900 dark:text-zinc-100 inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
                        >
                          {copiedJson ? (
                            <Check className="w-4 h-4 text-green-500" />
                          ) : (
                            <Copy className="w-4 h-4" />
                          )}
                          <span>{copiedJson ? 'Copied' : 'Copy JSON'}</span>
                        </button>
                      </div>

                      <pre className="p-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[12px] font-mono text-zinc-800 dark:text-zinc-200 overflow-x-auto max-h-72 leading-relaxed">
                        {JSON.stringify(report.report, null, 2)}
                      </pre>
                    </>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
