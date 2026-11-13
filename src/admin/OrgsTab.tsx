import React, { useState, useEffect, useCallback } from 'react';
import {
  Search,
  CheckCircle2,
  XCircle,
  Clock,
  Ban,
  Trash2,
  AlertTriangle,
  ChevronRight,
  X,
  Loader2,
  RotateCcw,
  KeyRound,
  Copy,
  Check,
  ShieldCheck,
} from 'lucide-react';
import { adminService, AdminOrg, AdminOrgFilter } from './adminService';
import { Skel } from '../components/common/Skeletons';
import { showToast } from '../components/common/ToastProvider';
import { triggerHaptic } from '../lib/haptics';

interface OrgsTabProps {
  initialFilter: AdminOrgFilter;
  refreshNonce: number;
  onDataChanged: () => Promise<void>;
}

const FILTER_TABS: Array<{ key: AdminOrgFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending' },
  { key: 'verified', label: 'Verified' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'suspended', label: 'Suspended' },
  { key: 'deleted', label: 'Bin' },
];

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function getStatusMeta(org: AdminOrg): {
  label: string;
  textClass: string;
  Icon: React.ComponentType<{ className?: string }>;
} {
  if (org.deleted_at) {
    return { label: 'In bin', textClass: 'text-zinc-500 dark:text-zinc-400', Icon: Trash2 };
  }
  if (org.suspended) {
    return { label: 'Suspended', textClass: 'text-red-600 dark:text-red-400', Icon: Ban };
  }
  if (org.verification_status === 'verified') {
    return { label: 'Verified', textClass: 'text-emerald-600 dark:text-emerald-400', Icon: CheckCircle2 };
  }
  if (org.verification_status === 'rejected') {
    return { label: 'Rejected', textClass: 'text-red-600 dark:text-red-400', Icon: XCircle };
  }
  return { label: 'Pending', textClass: 'text-amber-600 dark:text-amber-400', Icon: Clock };
}

export function OrgsTab({ initialFilter, refreshNonce, onDataChanged }: OrgsTabProps) {
  const [filter, setFilter] = useState<AdminOrgFilter>(initialFilter);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedOrg, setSelectedOrg] = useState<AdminOrg | null>(null);
  const [rejectTarget, setRejectTarget] = useState<AdminOrg | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [suspendTarget, setSuspendTarget] = useState<AdminOrg | null>(null);
  const [suspendReason, setSuspendReason] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AdminOrg | null>(null);
  const [resetConfirmTarget, setResetConfirmTarget] = useState<AdminOrg | null>(null);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = useState(false);

  // Ephemeral in-memory only temporary password (auto-clears in 60s, never persisted)
  const [tempPasswordInfo, setTempPasswordInfo] = useState<{
    orgId: string;
    orgName: string;
    tempPassword: string;
    secondsLeft: number;
  } | null>(null);
  const [copiedTemp, setCopiedTemp] = useState(false);

  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  const [isPurging, setIsPurging] = useState(false);

  useEffect(() => {
    setFilter(initialFilter);
  }, [initialFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 260);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadOrgs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const list = await adminService.listOrgs(filter, debouncedSearch);
      setOrgs(Array.isArray(list) ? list : []);
      setSelectedOrg((prev) =>
        prev ? list.find((item) => item.org_id === prev.org_id) || null : null
      );
    } catch (err: any) {
      setError(err?.message || 'Failed to load organisations.');
    } finally {
      setIsLoading(false);
    }
  }, [filter, debouncedSearch]);

  useEffect(() => {
    void loadOrgs();
  }, [loadOrgs, refreshNonce]);

  // Auto-clear one-time temporary password from memory after 60 seconds or on unmount
  useEffect(() => {
    if (!tempPasswordInfo) return;
    const timer = window.setInterval(() => {
      setTempPasswordInfo((prev) => {
        if (!prev) return null;
        if (prev.secondsLeft <= 1) {
          return null;
        }
        return { ...prev, secondsLeft: prev.secondsLeft - 1 };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [Boolean(tempPasswordInfo)]);

  // Ensure ephemeral temp password clears if tab unmounts
  useEffect(() => {
    return () => {
      setTempPasswordInfo(null);
    };
  }, []);

  const handleSetVerification = async (
    org: AdminOrg,
    status: 'verified' | 'rejected' | 'pending',
    reason?: string
  ) => {
    if (busyOrgId) return;
    setBusyOrgId(org.org_id);
    try {
      const res = await adminService.setVerification(org.org_id, status, reason);
      if (!res?.ok) {
        throw new Error(res?.error || 'Could not update verification status.');
      }
      triggerHaptic('success');
      showToast(
        status === 'verified'
          ? `${org.name} verified.`
          : status === 'rejected'
            ? `${org.name} rejected.`
            : `${org.name} moved to pending.`,
        'success'
      );
      setRejectTarget(null);
      setRejectReason('');
      await Promise.all([loadOrgs(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Verification update failed.', 'error');
    } finally {
      setBusyOrgId(null);
    }
  };

  const handleSetSuspended = async (org: AdminOrg, suspended: boolean, reason?: string) => {
    if (busyOrgId) return;
    setBusyOrgId(org.org_id);
    try {
      const res = await adminService.setSuspended(org.org_id, suspended, reason);
      if (!res?.ok) {
        throw new Error(res?.error || 'Could not update suspension state.');
      }
      triggerHaptic('success');
      showToast(suspended ? `${org.name} suspended.` : `${org.name} unsuspended.`, 'success');
      setSuspendTarget(null);
      setSuspendReason('');
      await Promise.all([loadOrgs(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Failed to update suspension.', 'error');
    } finally {
      setBusyOrgId(null);
    }
  };

  const handleResetPassword = async (org: AdminOrg) => {
    if (busyOrgId) return;
    setBusyOrgId(org.org_id);
    try {
      const res = await adminService.resetOrgPassword(org.org_id);
      if (!res?.ok || !res.temp_password) {
        throw new Error(res?.error || 'Could not reset organisation password.');
      }
      triggerHaptic('success');
      setResetConfirmTarget(null);
      setCopiedTemp(false);
      setTempPasswordInfo({
        orgId: org.org_id,
        orgName: org.name,
        tempPassword: res.temp_password,
        secondsLeft: 60,
      });
      await Promise.all([loadOrgs(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Password reset failed.', 'error');
    } finally {
      setBusyOrgId(null);
    }
  };

  const handleSoftDelete = async (org: AdminOrg) => {
    if (busyOrgId) return;
    setBusyOrgId(org.org_id);
    try {
      const res = await adminService.softDeleteOrg(org.org_id);
      if (!res?.ok) {
        throw new Error(res?.error || 'Could not move organisation to bin.');
      }
      triggerHaptic('success');
      showToast(`${org.name} moved to bin.`, 'success');
      setDeleteTarget(null);
      setSelectedOrg(null);
      await Promise.all([loadOrgs(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Failed to delete organisation.', 'error');
    } finally {
      setBusyOrgId(null);
    }
  };

  const handleRestore = async (org: AdminOrg) => {
    if (busyOrgId) return;
    setBusyOrgId(org.org_id);
    try {
      const res = await adminService.restoreOrg(org.org_id);
      if (!res?.ok) {
        throw new Error(res?.error || 'Could not restore organisation.');
      }
      triggerHaptic('success');
      showToast(`${org.name} restored.`, 'success');
      setSelectedOrg(null);
      await Promise.all([loadOrgs(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Restore failed.', 'error');
    } finally {
      setBusyOrgId(null);
    }
  };

  const handlePurgeBin = async () => {
    if (isPurging) return;
    setIsPurging(true);
    try {
      const res = await adminService.purgeDeleted(30);
      if (!res?.ok) {
        throw new Error('Could not purge bin.');
      }
      triggerHaptic('success');
      const count = res.purged_count ?? 0;
      showToast(
        count > 0
          ? `Permanently purged ${count} ${count === 1 ? 'organisation' : 'organisations'}.`
          : 'No deleted organisations were older than 30 days.',
        'info'
      );
      setPurgeConfirmOpen(false);
      await Promise.all([loadOrgs(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Purge failed.', 'error');
    } finally {
      setIsPurging(false);
    }
  };

  const handleCopyTempPassword = async () => {
    if (!tempPasswordInfo) return;
    try {
      await navigator.clipboard.writeText(tempPasswordInfo.tempPassword);
      setCopiedTemp(true);
      triggerHaptic('success');
    } catch {
      triggerHaptic('warning');
      showToast('Copy failed. Please note the password manually.', 'warning');
    }
  };

  return (
    <div className="space-y-3.5">
      {/* Search + Filter Controls */}
      <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-3 sm:p-4 space-y-3">
        <div className="relative">
          <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by org name, ID, or email..."
            aria-label="Search organisations"
            className="w-full min-h-[44px] pl-10 pr-10 py-2 rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:border-violet-500"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              aria-label="Clear search"
              className="absolute right-0 top-0 bottom-0 min-w-[44px] flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
          {FILTER_TABS.map((tab) => {
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

      {/* Bin Purge Bar when viewing deleted orgs */}
      {filter === 'deleted' && (
        <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-3.5 sm:px-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-zinc-900 dark:text-white">
              Recycle Bin
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Purge permanently removes orgs deleted over 30 days ago.
            </p>
          </div>
          <button
            type="button"
            disabled={isPurging || orgs.length === 0}
            onClick={() => {
              triggerHaptic('tick');
              setPurgeConfirmOpen(true);
            }}
            className="min-h-[44px] px-3.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs font-semibold whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Purge &gt;30d</span>
          </button>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-900/60 rounded-2xl p-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 text-xs text-red-700 dark:text-red-300 min-w-0">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span className="truncate">{error}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadOrgs()}
            className="min-h-[44px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 text-xs font-semibold shrink-0 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading Skeleton */}
      {isLoading && orgs.length === 0 && !error && (
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 space-y-2.5"
            >
              <div className="flex items-center justify-between gap-3">
                <Skel w="55%" h={18} />
                <Skel w={64} h={16} />
              </div>
              <Skel w="78%" h={14} />
              <Skel w="42%" h={12} />
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && orgs.length === 0 && (
        <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-6 text-center space-y-2">
          <p className="text-sm font-semibold text-zinc-900 dark:text-white">
            No organisations found
          </p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {debouncedSearch
              ? `No results match "${debouncedSearch}" in ${filter}.`
              : `There are currently no organisations under "${filter}".`}
          </p>
        </div>
      )}

      {/* Organisations List */}
      {orgs.length > 0 && (
        <div className="space-y-2.5">
          {orgs.map((org) => {
            const status = getStatusMeta(org);
            const StatusIcon = status.Icon;
            const isBusy = busyOrgId === org.org_id;

            return (
              <div
                key={org.org_id}
                className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 space-y-3"
              >
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tick');
                    setSelectedOrg(org);
                  }}
                  className="w-full text-left flex items-start justify-between gap-3 cursor-pointer"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                        {org.name}
                      </h3>
                    </div>

                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      <span className="font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                        {org.org_id}
                      </span>
                      {org.email ? ` · ${org.email}` : ''}
                    </p>

                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                      <span>{org.events_count} events</span>
                      <span aria-hidden="true">·</span>
                      <span>{org.judges_count} judges</span>
                      <span aria-hidden="true">·</span>
                      <span>{org.participants_count} participants</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatDate(org.created_at)}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 pt-0.5">
                    <span
                      className={`inline-flex items-center gap-1 text-xs font-semibold whitespace-nowrap ${status.textClass}`}
                    >
                      <StatusIcon className="w-3.5 h-3.5" />
                      <span>{status.label}</span>
                    </span>
                    <ChevronRight className="w-4 h-4 text-zinc-400" />
                  </div>
                </button>

                {org.rejection_reason && org.verification_status === 'rejected' && !org.deleted_at && (
                  <p className="text-xs text-red-600 dark:text-red-400 bg-stone-100 dark:bg-zinc-800 rounded-xl px-3 py-2">
                    Reason: {org.rejection_reason}
                  </p>
                )}

                {org.suspended && org.suspended_reason && !org.deleted_at && (
                  <p className="text-xs text-red-600 dark:text-red-400 bg-stone-100 dark:bg-zinc-800 rounded-xl px-3 py-2">
                    Suspended: {org.suspended_reason}
                  </p>
                )}

                {/* Quick Approve / Reject actions for active non-suspended non-deleted orgs */}
                {!org.deleted_at && !org.suspended && org.verification_status !== 'verified' && (
                  <div className="flex items-center gap-2 pt-1 border-t border-stone-200 dark:border-zinc-800">
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleSetVerification(org, 'verified')}
                      className="flex-1 min-h-[44px] px-3 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      )}
                      <span>Approve</span>
                    </button>

                    {org.verification_status !== 'rejected' && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => {
                          triggerHaptic('tick');
                          setRejectReason('');
                          setRejectTarget(org);
                        }}
                        className="flex-1 min-h-[44px] px-3 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 disabled:opacity-60 text-zinc-800 dark:text-zinc-200 text-xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <XCircle className="w-3.5 h-3.5 text-red-500" />
                        <span>Reject</span>
                      </button>
                    )}
                  </div>
                )}

                {/* Quick Restore for deleted orgs */}
                {org.deleted_at && (
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-stone-200 dark:border-zinc-800">
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      Deleted {formatDate(org.deleted_at)}
                    </span>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => void handleRestore(org)}
                      className="min-h-[44px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-900 dark:text-white inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      {isBusy ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3.5 h-3.5 text-violet-500" />
                      )}
                      <span>Restore</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Organisation Detail Sheet */}
      {selectedOrg && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/65 flex items-end sm:items-center justify-center sm:p-4"
          onClick={() => setSelectedOrg(null)}
        >
          <div
            className="w-full sm:max-w-md bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-t-3xl sm:rounded-3xl p-5 max-h-[88dvh] flex flex-col gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-zinc-900 dark:text-white truncate">
                  {selectedOrg.name}
                </h3>
                <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {selectedOrg.org_id}
                  {selectedOrg.email ? ` · ${selectedOrg.email}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedOrg(null)}
                aria-label="Close organisation details"
                className="min-h-[44px] min-w-[44px] -mr-2 -mt-2 rounded-xl flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto space-y-3 pr-0.5">
              <div className="grid grid-cols-2 gap-2.5 text-xs tabular-nums">
                <div className="p-3 rounded-xl bg-stone-100 dark:bg-zinc-800">
                  <div className="text-zinc-500 dark:text-zinc-400">Events</div>
                  <div className="text-base font-bold text-zinc-900 dark:text-white mt-0.5">
                    {selectedOrg.events_count} ({selectedOrg.active_events_count} live)
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-stone-100 dark:bg-zinc-800">
                  <div className="text-zinc-500 dark:text-zinc-400">Scores</div>
                  <div className="text-base font-bold text-zinc-900 dark:text-white mt-0.5">
                    {selectedOrg.scores_count}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-stone-100 dark:bg-zinc-800">
                  <div className="text-zinc-500 dark:text-zinc-400">Judges</div>
                  <div className="text-base font-bold text-zinc-900 dark:text-white mt-0.5">
                    {selectedOrg.judges_count}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-stone-100 dark:bg-zinc-800">
                  <div className="text-zinc-500 dark:text-zinc-400">Participants</div>
                  <div className="text-base font-bold text-zinc-900 dark:text-white mt-0.5">
                    {selectedOrg.participants_count}
                  </div>
                </div>
              </div>

              <div className="text-xs text-zinc-600 dark:text-zinc-400 space-y-1.5 p-3 rounded-xl bg-stone-100 dark:bg-zinc-800">
                <div>Created: {formatDate(selectedOrg.created_at)}</div>
                {selectedOrg.verified_at && <div>Verified: {formatDate(selectedOrg.verified_at)}</div>}
                {selectedOrg.must_change && (
                  <div className="text-amber-600 dark:text-amber-400 font-medium">
                    Temporary password active (must change on next sign-in)
                  </div>
                )}
                {selectedOrg.locked_until && (
                  <div className="text-red-600 dark:text-red-400 font-medium">
                    Login throttled until {new Date(selectedOrg.locked_until).toLocaleTimeString()}
                  </div>
                )}
              </div>

              {!selectedOrg.deleted_at && (
                <div className="space-y-2 pt-1">
                  <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300">
                    Verification Status
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {selectedOrg.verification_status !== 'verified' && (
                      <button
                        type="button"
                        disabled={busyOrgId === selectedOrg.org_id}
                        onClick={() => void handleSetVerification(selectedOrg, 'verified')}
                        className="min-h-[44px] px-3 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>Approve</span>
                      </button>
                    )}

                    {selectedOrg.verification_status !== 'rejected' && (
                      <button
                        type="button"
                        disabled={busyOrgId === selectedOrg.org_id}
                        onClick={() => {
                          setRejectReason(selectedOrg.rejection_reason || '');
                          setRejectTarget(selectedOrg);
                        }}
                        className="min-h-[44px] px-3 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-zinc-900 dark:text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <XCircle className="w-3.5 h-3.5 text-red-500" />
                        <span>Reject</span>
                      </button>
                    )}

                    {selectedOrg.verification_status !== 'pending' && (
                      <button
                        type="button"
                        disabled={busyOrgId === selectedOrg.org_id}
                        onClick={() => void handleSetVerification(selectedOrg, 'pending')}
                        className="min-h-[44px] px-3 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-zinc-900 dark:text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5 text-amber-500" />
                        <span>Set Pending</span>
                      </button>
                    )}
                  </div>

                  <p className="text-xs font-semibold text-zinc-700 dark:text-zinc-300 pt-2">
                    Account Controls
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      disabled={busyOrgId === selectedOrg.org_id}
                      onClick={() => {
                        triggerHaptic('tick');
                        setResetConfirmTarget(selectedOrg);
                      }}
                      className="min-h-[44px] px-3 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-zinc-900 dark:text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <KeyRound className="w-3.5 h-3.5 text-violet-500" />
                      <span>Reset password</span>
                    </button>

                    {selectedOrg.suspended ? (
                      <button
                        type="button"
                        disabled={busyOrgId === selectedOrg.org_id}
                        onClick={() => void handleSetSuspended(selectedOrg, false)}
                        className="min-h-[44px] px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Unsuspend</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busyOrgId === selectedOrg.org_id}
                        onClick={() => {
                          triggerHaptic('tick');
                          setSuspendReason('');
                          setSuspendTarget(selectedOrg);
                        }}
                        className="min-h-[44px] px-3 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-red-600 dark:text-red-400 text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        <span>Suspend</span>
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={busyOrgId === selectedOrg.org_id}
                      onClick={() => {
                        triggerHaptic('tick');
                        setDeleteTarget(selectedOrg);
                      }}
                      className="sm:col-span-2 min-h-[44px] px-3 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 hover:bg-red-100 dark:hover:bg-red-950/60 text-red-700 dark:text-red-300 text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Move to bin</span>
                    </button>
                  </div>
                </div>
              )}

              {selectedOrg.deleted_at && (
                <div className="pt-2">
                  <button
                    type="button"
                    disabled={busyOrgId === selectedOrg.org_id}
                    onClick={() => void handleRestore(selectedOrg)}
                    className="w-full min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Restore organisation</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reject Reason Modal */}
      {rejectTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[60] bg-black/70 flex items-end sm:items-center justify-center p-4"
          onClick={() => {
            if (!busyOrgId) setRejectTarget(null);
          }}
        >
          <div
            className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-3xl p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1">
              <h4 className="text-base font-bold text-zinc-900 dark:text-white">
                Reject {rejectTarget.name}?
              </h4>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Optional reason shown to the organiser in their portal.
              </p>
            </div>

            <textarea
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. Incomplete organisation details or test account"
              className="w-full px-3.5 py-2.5 rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:border-violet-500 resize-none"
            />

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={Boolean(busyOrgId)}
                onClick={() => setRejectTarget(null)}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={Boolean(busyOrgId)}
                onClick={() => void handleSetVerification(rejectTarget, 'rejected', rejectReason)}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {busyOrgId === rejectTarget.org_id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Reject org</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Suspend Reason Modal */}
      {suspendTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[60] bg-black/70 flex items-end sm:items-center justify-center p-4"
          onClick={() => {
            if (!busyOrgId) setSuspendTarget(null);
          }}
        >
          <div
            className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-3xl p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1">
              <h4 className="text-base font-bold text-zinc-900 dark:text-white">
                Suspend {suspendTarget.name}?
              </h4>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Active organiser and judge sessions will end immediately and logins will be blocked.
              </p>
            </div>

            <textarea
              rows={3}
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder="Optional reason shown to organiser..."
              className="w-full px-3.5 py-2.5 rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:border-violet-500 resize-none"
            />

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={Boolean(busyOrgId)}
                onClick={() => setSuspendTarget(null)}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={Boolean(busyOrgId)}
                onClick={() => void handleSetSuspended(suspendTarget, true, suspendReason)}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {busyOrgId === suspendTarget.org_id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Suspend org</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Soft Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[60] bg-black/70 flex items-end sm:items-center justify-center p-4"
          onClick={() => {
            if (!busyOrgId) setDeleteTarget(null);
          }}
        >
          <div
            className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-3xl p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1">
              <h4 className="text-base font-bold text-zinc-900 dark:text-white">
                Move {deleteTarget.name} to bin?
              </h4>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                All logins and writes are blocked. You can restore it from Bin before purging.
              </p>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={Boolean(busyOrgId)}
                onClick={() => setDeleteTarget(null)}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={Boolean(busyOrgId)}
                onClick={() => void handleSoftDelete(deleteTarget)}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {busyOrgId === deleteTarget.org_id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Move to bin</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Password Reset Modal */}
      {resetConfirmTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[60] bg-black/70 flex items-end sm:items-center justify-center p-4"
          onClick={() => {
            if (!busyOrgId) setResetConfirmTarget(null);
          }}
        >
          <div
            className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-3xl p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1">
              <h4 className="text-base font-bold text-zinc-900 dark:text-white">
                Reset password for {resetConfirmTarget.name}?
              </h4>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Creates a one-time 12-character password, clears login lockouts, signs out active sessions, and prompts the organiser to set a new password on next sign-in.
              </p>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={Boolean(busyOrgId)}
                onClick={() => setResetConfirmTarget(null)}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={Boolean(busyOrgId)}
                onClick={() => void handleResetPassword(resetConfirmTarget)}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {busyOrgId === resetConfirmTarget.org_id && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Generate password</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* One-Time Temporary Password Modal (Auto-clears in 60s) */}
      {tempPasswordInfo && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[70] bg-black/75 flex items-end sm:items-center justify-center p-4"
        >
          <div className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-3xl p-5 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h4 className="text-base font-bold text-zinc-900 dark:text-white">
                  Temporary Password
                </h4>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                  {tempPasswordInfo.orgName} ({tempPasswordInfo.orgId})
                </p>
              </div>
              <span className="text-xs font-mono font-bold tabular-nums text-violet-600 dark:text-violet-400 shrink-0">
                {tempPasswordInfo.secondsLeft}s
              </span>
            </div>

            <div className="p-4 rounded-2xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-center">
              <p className="font-mono text-lg font-bold tracking-wider text-zinc-900 dark:text-white select-all">
                {tempPasswordInfo.tempPassword}
              </p>
            </div>

            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Shown once only. Share this securely with the organiser. This screen clears automatically in {tempPasswordInfo.secondsLeft} seconds.
            </p>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => void handleCopyTempPassword()}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {copiedTemp ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copiedTemp ? 'Copied' : 'Copy password'}</span>
              </button>
              <button
                type="button"
                onClick={() => setTempPasswordInfo(null)}
                className="min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-200 cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Purge >30 days Bin Confirmation Modal */}
      {purgeConfirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[60] bg-black/70 flex items-end sm:items-center justify-center p-4"
          onClick={() => {
            if (!isPurging) setPurgeConfirmOpen(false);
          }}
        >
          <div
            className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-3xl p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1">
              <h4 className="text-base font-bold text-zinc-900 dark:text-white">
                Purge bin older than 30 days?
              </h4>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Permanently removes organisations deleted more than 30 days ago along with their events, judges, participants, and scores. This cannot be undone.
              </p>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={isPurging}
                onClick={() => setPurgeConfirmOpen(false)}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 text-xs font-semibold text-zinc-800 dark:text-zinc-200 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isPurging}
                onClick={() => void handlePurgeBin()}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                {isPurging && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>Purge permanently</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
