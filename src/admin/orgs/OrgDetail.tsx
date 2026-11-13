import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Building2 } from 'lucide-react';
import { AdminOrg, adminService } from '../adminService';
import {
  BackButton,
  EmptyState,
  GroupedList,
  ListRow,
  ScreenHeader,
  Skel,
  StatusChip,
  showAdminToast,
} from '../ui';
import { triggerHaptic } from '../../lib/haptics';
import { OrgActions } from './OrgActions';
import { formatFullDate, getOrgInitials, getOrgStatus } from './orgUtils';
import type { ActiveOrgDialog, TempPasswordReveal } from './dialogs';

const OrgDialogs = lazy(() => import('./dialogs'));

interface OrgDetailProps {
  orgId: string;
  cachedOrg?: AdminOrg | null;
  isOnline: boolean;
  refreshNonce: number;
  onBack: () => void;
  onOrgMutated: (orgId: string, options?: { navigateAway?: boolean }) => Promise<void>;
}

export default function OrgDetail({
  orgId,
  cachedOrg = null,
  isOnline,
  refreshNonce,
  onBack,
  onOrgMutated,
}: OrgDetailProps) {
  const [org, setOrg] = useState<AdminOrg | null>(cachedOrg);
  const [isLoading, setIsLoading] = useState(!cachedOrg);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const [activeDialog, setActiveDialog] = useState<ActiveOrgDialog>(null);
  const [tempPasswordInfo, setTempPasswordInfo] = useState<TempPasswordReveal | null>(null);

  useEffect(() => {
    if (cachedOrg && cachedOrg.org_id === orgId) {
      setOrg(cachedOrg);
    }
  }, [cachedOrg, orgId]);

  const loadOrgDetail = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsLoading(false);
      return;
    }
    setIsLoading((prev) => (org?.org_id === orgId ? prev : true));
    setError(null);
    try {
      const activeList = await adminService.listOrgs('all', orgId);
      let found = activeList.find((item) => item.org_id === orgId) || null;
      if (!found) {
        const deletedList = await adminService.listOrgs('deleted', orgId);
        found = deletedList.find((item) => item.org_id === orgId) || null;
      }
      setOrg(found);
    } catch (err: any) {
      setError(err?.message || 'Could not load organiser details.');
    } finally {
      setIsLoading(false);
    }
  }, [orgId, org?.org_id]);

  useEffect(() => {
    void loadOrgDetail();
  }, [loadOrgDetail, refreshNonce]);

  // Ephemeral temporary password 60s auto-clear & unmount cleanup
  useEffect(() => {
    if (!tempPasswordInfo) return;
    const timer = window.setInterval(() => {
      setTempPasswordInfo((prev) => {
        if (!prev) return null;
        if (prev.secondsLeft <= 1) return null;
        return { ...prev, secondsLeft: prev.secondsLeft - 1 };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [Boolean(tempPasswordInfo)]);

  useEffect(() => {
    return () => {
      setTempPasswordInfo(null);
    };
  }, [orgId]);

  const handleSetVerification = async (
    status: 'verified' | 'rejected' | 'pending',
    reason?: string
  ) => {
    if (!org || isBusy || !isOnline) return;
    setIsBusy(true);
    try {
      const res = await adminService.setVerification(org.org_id, status, reason);
      if (!res?.ok) throw new Error(res?.error || 'Could not update verification.');
      triggerHaptic('success');
      showAdminToast(
        status === 'verified'
          ? `${org.name} verified.`
          : status === 'rejected'
            ? `${org.name} rejected.`
            : `${org.name} moved to pending.`,
        { tone: 'success' }
      );
      setActiveDialog(null);
      await loadOrgDetail();
      await onOrgMutated(org.org_id);
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Verification update failed.', { tone: 'error' });
    } finally {
      setIsBusy(false);
    }
  };

  const handleSetSuspended = async (suspended: boolean, reason?: string) => {
    if (!org || isBusy || !isOnline) return;
    setIsBusy(true);
    try {
      const res = await adminService.setSuspended(org.org_id, suspended, reason);
      if (!res?.ok) throw new Error(res?.error || 'Could not update account state.');
      triggerHaptic('success');
      showAdminToast(
        suspended ? `${org.name} suspended.` : `${org.name} reactivated.`,
        { tone: 'success' }
      );
      setActiveDialog(null);
      await loadOrgDetail();
      await onOrgMutated(org.org_id);
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Account update failed.', { tone: 'error' });
    } finally {
      setIsBusy(false);
    }
  };

  const handleResetPassword = async () => {
    if (!org || isBusy || !isOnline) return;
    setIsBusy(true);
    try {
      const res = await adminService.resetOrgPassword(org.org_id);
      if (!res?.ok || !res.temp_password) {
        throw new Error(res?.error || 'Could not reset password.');
      }
      triggerHaptic('success');
      setActiveDialog(null);
      setTempPasswordInfo({
        orgId: org.org_id,
        orgName: org.name,
        tempPassword: res.temp_password,
        secondsLeft: 60,
      });
      await loadOrgDetail();
      await onOrgMutated(org.org_id);
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Password reset failed.', { tone: 'error' });
    } finally {
      setIsBusy(false);
    }
  };

  const handleMoveToBin = async () => {
    if (!org || isBusy || !isOnline) return;
    const targetId = org.org_id;
    const targetName = org.name;
    setIsBusy(true);
    try {
      const res = await adminService.softDeleteOrg(targetId);
      if (!res?.ok) throw new Error(res?.error || 'Could not move organiser to bin.');
      triggerHaptic('success');
      showAdminToast(`${targetName} moved to bin.`, {
        tone: 'info',
        undoLabel: 'Undo',
        onUndo: async () => {
          const restoreRes = await adminService.restoreOrg(targetId);
          if (!restoreRes?.ok) {
            showAdminToast(restoreRes?.error || 'Could not restore organiser.', { tone: 'error' });
            return;
          }
          triggerHaptic('success');
          showAdminToast(`${targetName} restored.`, { tone: 'success' });
          await onOrgMutated(targetId);
        },
      });
      await onOrgMutated(targetId, { navigateAway: true });
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Move to bin failed.', { tone: 'error' });
    } finally {
      setIsBusy(false);
    }
  };

  const handleRestore = async () => {
    if (!org || isBusy || !isOnline) return;
    setIsBusy(true);
    try {
      const res = await adminService.restoreOrg(org.org_id);
      if (!res?.ok) throw new Error(res?.error || 'Could not restore organiser.');
      triggerHaptic('success');
      showAdminToast(`${org.name} restored.`, { tone: 'success' });
      await loadOrgDetail();
      await onOrgMutated(org.org_id);
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Restore failed.', { tone: 'error' });
    } finally {
      setIsBusy(false);
    }
  };

  const handlePurgeBin = async () => {
    if (!org || isBusy || !isOnline) return;
    const targetId = org.org_id;
    setIsBusy(true);
    try {
      const res = await adminService.purgeDeleted(0);
      if (!res?.ok) throw new Error('Could not permanently delete bin.');
      triggerHaptic('success');
      setActiveDialog(null);
      const count = res.purged_count ?? 0;
      showAdminToast(
        `Permanently deleted ${count} ${count === 1 ? 'organiser' : 'organisers'}.`,
        { tone: 'success' }
      );
      await onOrgMutated(targetId, { navigateAway: true });
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Permanent delete failed.', { tone: 'error' });
    } finally {
      setIsBusy(false);
    }
  };

  const headerTitle = org?.name || orgId;

  return (
    <div className="min-h-full">
      {/* Mobile compact drill-down header */}
      <div className="md:hidden">
        <ScreenHeader
          compactOnly
          title={headerTitle}
          onBack={onBack}
          backLabel="Organisers"
        />
      </div>

      {/* Tablet/desktop pane header */}
      <div className="hidden md:flex items-center justify-between px-6 pt-5 pb-3 border-b border-zinc-200 dark:border-zinc-800">
        <div className="min-w-0">
          <h2 className="admin-title text-zinc-900 dark:text-zinc-100 truncate">
            {headerTitle}
          </h2>
          <p className="admin-caption font-mono text-zinc-500 dark:text-zinc-400">
            {orgId}
          </p>
        </div>
        <BackButton onClick={onBack} label="Close" />
      </div>

      <div
        className={`p-4 md:p-6 max-w-2xl space-y-6 ${
          org && !org.deleted_at && org.verification_status === 'pending'
            ? 'pb-24 md:pb-6'
            : 'pb-8'
        }`}
      >
        {error && !org && (
          <EmptyState
            icon={<AlertTriangle className="w-5 h-5 text-red-500" />}
            message={error}
            actionLabel="Retry"
            onAction={() => void loadOrgDetail()}
            actionDisabled={!isOnline}
          />
        )}

        {isLoading && !org && !error && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Skel w={48} h={48} rounded="rounded-full" />
              <div className="space-y-2 flex-1">
                <Skel w="55%" h={18} />
                <Skel w="35%" h={13} />
              </div>
            </div>
            <GroupedList>
              <ListRow title={<Skel w="40%" h={15} />} trailing={<Skel w={80} h={14} />} />
              <ListRow title={<Skel w="45%" h={15} />} trailing={<Skel w={64} h={14} />} />
              <ListRow title={<Skel w="38%" h={15} />} trailing={<Skel w={40} h={14} />} />
            </GroupedList>
          </div>
        )}

        {!isLoading && !error && !org && (
          <EmptyState
            icon={<Building2 className="w-5 h-5" />}
            message={`Organiser ${orgId} was not found.`}
            actionLabel="Back to list"
            onAction={onBack}
          />
        )}

        {org && (() => {
          const status = getOrgStatus(org);
          return (
            <>
              {/* Summary Hero */}
              <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    aria-hidden="true"
                    className="w-12 h-12 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 text-base font-semibold flex items-center justify-center shrink-0"
                  >
                    {getOrgInitials(org.name)}
                  </div>
                  <div className="min-w-0">
                    <h3 className="admin-title text-zinc-900 dark:text-zinc-100 truncate">
                      {org.name}
                    </h3>
                    <p className="admin-caption font-mono text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
                      {org.org_id}
                    </p>
                  </div>
                </div>
                <StatusChip tone={status.tone} label={status.label} />
              </div>

              {status.reason && (
                <div className="rounded-2xl bg-red-500/10 border border-red-500/25 px-4 py-3 text-[14px] text-red-700 dark:text-red-300">
                  {org.suspended ? 'Suspension reason: ' : 'Rejection reason: '}
                  {status.reason}
                </div>
              )}

              {/* Facts */}
              <GroupedList title="Details">
                <ListRow title="Email" trailing={org.email || '—'} />
                <ListRow title="Created" trailing={formatFullDate(org.created_at)} />
                {org.verified_at && (
                  <ListRow title="Verified" trailing={formatFullDate(org.verified_at)} />
                )}
                {org.deleted_at && (
                  <ListRow title="Moved to bin" trailing={formatFullDate(org.deleted_at)} />
                )}
                {org.must_change && (
                  <ListRow
                    title="Password state"
                    trailing={
                      <span className="text-orange-700 dark:text-orange-400 font-medium">
                        Temp password active
                      </span>
                    }
                  />
                )}
                {org.locked_until && new Date(org.locked_until).getTime() > Date.now() && (
                  <ListRow
                    title="Login lock"
                    trailing={
                      <span className="text-red-600 dark:text-red-400 font-medium">
                        Until{' '}
                        {new Date(org.locked_until).toLocaleTimeString(undefined, {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    }
                  />
                )}
                <ListRow
                  title="Events"
                  trailing={`${org.events_count} (${org.active_events_count} live)`}
                />
                <ListRow title="Judges" trailing={org.judges_count} />
                <ListRow title="Participants" trailing={org.participants_count} />
                <ListRow title="Scores" trailing={org.scores_count} />
              </GroupedList>

              {/* Actions */}
              <OrgActions
                org={org}
                isBusy={isBusy}
                isOnline={isOnline}
                onApprove={() => void handleSetVerification('verified')}
                onSetPending={() => void handleSetVerification('pending')}
                onOpenReject={() => setActiveDialog('reject')}
                onOpenSuspend={() => setActiveDialog('suspend')}
                onReactivate={() => void handleSetSuspended(false)}
                onOpenResetPassword={() => setActiveDialog('reset')}
                onMoveToBin={() => void handleMoveToBin()}
                onRestore={() => void handleRestore()}
                onOpenPurge={() => setActiveDialog('purge')}
              />

              <Suspense fallback={null}>
                <OrgDialogs
                  org={org}
                  dialog={activeDialog}
                  tempPasswordInfo={tempPasswordInfo}
                  isBusy={isBusy}
                  isOnline={isOnline}
                  onCloseDialog={() => {
                    if (!isBusy) setActiveDialog(null);
                  }}
                  onDismissTempPassword={() => setTempPasswordInfo(null)}
                  onConfirmReject={(reason) => handleSetVerification('rejected', reason)}
                  onConfirmSuspend={(reason) => handleSetSuspended(true, reason)}
                  onConfirmResetPassword={handleResetPassword}
                  onConfirmPurgeBin={handlePurgeBin}
                />
              </Suspense>
            </>
          );
        })()}
      </div>
    </div>
  );
}
