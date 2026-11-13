import React, { useState, useEffect, useCallback } from 'react';
import { X, RefreshCw, AlertTriangle, History } from 'lucide-react';
import { adminService, AdminAuditEntry } from './adminService';
import { Skel } from '../components/common/Skeletons';
import { triggerHaptic } from '../lib/haptics';

interface ActivityLogSheetProps {
  onClose: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  set_verification: 'Verification updated',
  suspend_org: 'Organisation suspended',
  unsuspend_org: 'Organisation unsuspended',
  reset_org_password: 'Password reset',
  soft_delete_org: 'Moved to bin',
  restore_org: 'Restored from bin',
  purge_deleted: 'Purged bin',
  unlock_org: 'Unlocked login throttle',
  set_enforcement: 'Enforcement updated',
  create_announcement: 'Announcement posted',
  update_announcement: 'Announcement updated',
  end_announcement: 'Announcement ended',
  set_report_status: 'Support report updated',
};

function formatDetail(entry: AdminAuditEntry): string {
  const d = entry.detail || {};
  if (entry.action === 'set_verification') {
    const base = `Status: ${d.status || 'updated'}`;
    return d.reason ? `${base} · ${d.reason}` : base;
  }
  if (entry.action === 'suspend_org' && d.reason) {
    return `Reason: ${d.reason}`;
  }
  if (entry.action === 'set_enforcement') {
    return d.enforce_verification ? 'Verification enforcement turned ON' : 'Verification enforcement turned OFF';
  }
  if (entry.action === 'purge_deleted') {
    return `Purged ${d.purged_count ?? 0} org(s) (> ${d.older_than_days ?? 30}d)`;
  }
  if (entry.action === 'create_announcement' || entry.action === 'update_announcement') {
    return d.title ? `"${d.title}" · ${d.audience || 'all'}` : 'Notice saved';
  }
  if (entry.action === 'set_report_status') {
    return `Report status: ${d.status || 'updated'}`;
  }
  if (entry.action === 'reset_org_password') {
    return 'Temporary password issued (must change on next sign-in)';
  }
  return '';
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ActivityLogSheet({ onClose }: ActivityLogSheetProps) {
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAudit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await adminService.listAudit(60);
      setEntries(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err?.message || 'Could not load activity log.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 bg-black/65 flex items-end sm:items-center justify-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-t-3xl sm:rounded-3xl p-5 max-h-[85dvh] flex flex-col gap-3 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0">
              <History className="w-4 h-4" />
            </div>
            <h3 className="text-base font-bold text-zinc-900 dark:text-white truncate">
              Activity Log
            </h3>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('tick');
                void loadAudit();
              }}
              aria-label="Refresh activity log"
              className="min-h-[44px] min-w-[44px] rounded-xl flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin text-violet-500' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close activity log"
              className="min-h-[44px] min-w-[44px] -mr-2 rounded-xl flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-2 pr-0.5">
          {error && (
            <div className="p-3.5 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-xs text-red-700 dark:text-red-300 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 min-w-0">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span className="truncate">{error}</span>
              </span>
              <button
                type="button"
                onClick={() => void loadAudit()}
                className="min-h-[36px] px-3 rounded-lg bg-white dark:bg-zinc-900 font-semibold shrink-0 cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {isLoading && entries.length === 0 && !error && (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, idx) => (
                <div key={idx} className="p-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 space-y-1.5">
                  <Skel w="52%" h={14} />
                  <Skel w="74%" h={12} />
                </div>
              ))}
            </div>
          )}

          {!isLoading && !error && entries.length === 0 && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400 py-8 text-center">
              No admin actions recorded yet.
            </p>
          )}

          {entries.map((entry) => {
            const label = ACTION_LABELS[entry.action] || entry.action;
            const detailText = formatDetail(entry);

            return (
              <div
                key={entry.id}
                className="p-3 rounded-xl bg-stone-100 dark:bg-zinc-800 space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-zinc-900 dark:text-white truncate">
                    {label}
                    {entry.target_org_id ? ` · ${entry.target_org_id}` : ''}
                  </span>
                  <span className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums shrink-0">
                    {formatDateTime(entry.created_at)}
                  </span>
                </div>
                {detailText && (
                  <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-snug">
                    {detailText}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
