import React, { useState, useEffect } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { AdminOrg } from '../adminService';
import { BottomSheet, showAdminToast } from '../ui';
import { triggerHaptic } from '../../lib/haptics';

export type ActiveOrgDialog = 'reject' | 'suspend' | 'reset' | 'purge' | null;

export interface TempPasswordReveal {
  orgId: string;
  orgName: string;
  tempPassword: string;
  secondsLeft: number;
}

interface OrgDialogsProps {
  org: AdminOrg;
  dialog: ActiveOrgDialog;
  tempPasswordInfo: TempPasswordReveal | null;
  isBusy: boolean;
  isOnline: boolean;
  onCloseDialog: () => void;
  onDismissTempPassword: () => void;
  onConfirmReject: (reason: string) => Promise<void>;
  onConfirmSuspend: (reason: string) => Promise<void>;
  onConfirmResetPassword: () => Promise<void>;
  onConfirmPurgeBin: () => Promise<void>;
}

export default function OrgDialogs({
  org,
  dialog,
  tempPasswordInfo,
  isBusy,
  isOnline,
  onCloseDialog,
  onDismissTempPassword,
  onConfirmReject,
  onConfirmSuspend,
  onConfirmResetPassword,
  onConfirmPurgeBin,
}: OrgDialogsProps) {
  const [rejectReason, setRejectReason] = useState('');
  const [suspendReason, setSuspendReason] = useState('');
  const [purgeConfirmText, setPurgeConfirmText] = useState('');
  const [copiedTemp, setCopiedTemp] = useState(false);

  useEffect(() => {
    if (dialog === 'reject') {
      setRejectReason(org.rejection_reason || '');
    } else if (dialog === 'suspend') {
      setSuspendReason('');
    } else if (dialog === 'purge') {
      setPurgeConfirmText('');
    }
  }, [dialog, org]);

  useEffect(() => {
    setCopiedTemp(false);
  }, [tempPasswordInfo?.tempPassword]);

  const handleCopyTempPassword = async () => {
    if (!tempPasswordInfo) return;
    try {
      await navigator.clipboard.writeText(tempPasswordInfo.tempPassword);
      setCopiedTemp(true);
      triggerHaptic('success');
    } catch {
      triggerHaptic('warning');
      showAdminToast('Copy failed. Note the temporary password manually.', { tone: 'error' });
    }
  };

  const canPurge = purgeConfirmText.trim().toUpperCase() === 'PURGE';

  return (
    <>
      {/* Reject dialog */}
      <BottomSheet
        open={dialog === 'reject'}
        onClose={onCloseDialog}
        closeDisabled={isBusy}
        title={`Reject ${org.name}?`}
        subtitle={org.org_id}
      >
        <div className="space-y-4">
          <p className="admin-body text-zinc-600 dark:text-zinc-400">
            Optional reason shown to the organiser in their portal.
          </p>

          <div>
            <label htmlFor="admin-reject-reason" className="sr-only">
              Rejection reason
            </label>
            <textarea
              id="admin-reject-reason"
              rows={3}
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection (optional)"
              className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/60 resize-none"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={isBusy}
              onClick={onCloseDialog}
              className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-[15px] font-semibold text-zinc-900 dark:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isBusy || !isOnline}
              onClick={() => void onConfirmReject(rejectReason)}
              className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-[15px] font-semibold text-white inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              {isBusy && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Reject</span>
            </button>
          </div>
        </div>
      </BottomSheet>

      {/* Suspend dialog */}
      <BottomSheet
        open={dialog === 'suspend'}
        onClose={onCloseDialog}
        closeDisabled={isBusy}
        title={`Suspend ${org.name}?`}
        subtitle={org.org_id}
      >
        <div className="space-y-4">
          <p className="admin-body text-zinc-600 dark:text-zinc-400">
            Active organiser and judge sessions end immediately and logins are blocked until reactivated.
          </p>

          <div>
            <label htmlFor="admin-suspend-reason" className="sr-only">
              Suspension reason
            </label>
            <textarea
              id="admin-suspend-reason"
              rows={3}
              value={suspendReason}
              onChange={(e) => setSuspendReason(e.target.value)}
              placeholder="Optional reason shown to organiser"
              className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/60 resize-none"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={isBusy}
              onClick={onCloseDialog}
              className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-[15px] font-semibold text-zinc-900 dark:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isBusy || !isOnline}
              onClick={() => void onConfirmSuspend(suspendReason)}
              className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-[15px] font-semibold text-white inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              {isBusy && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Suspend</span>
            </button>
          </div>
        </div>
      </BottomSheet>

      {/* Confirm Reset Password dialog */}
      <BottomSheet
        open={dialog === 'reset'}
        onClose={onCloseDialog}
        closeDisabled={isBusy}
        title={`Reset password for ${org.name}?`}
        subtitle={org.org_id}
      >
        <div className="space-y-4">
          <p className="admin-body text-zinc-600 dark:text-zinc-400">
            Generates a one-time 12-character temporary password, clears lockouts, signs out active sessions, and requires a password change on next sign-in.
          </p>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={isBusy}
              onClick={onCloseDialog}
              className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-[15px] font-semibold text-zinc-900 dark:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isBusy || !isOnline}
              onClick={() => void onConfirmResetPassword()}
              className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-[15px] font-semibold text-white inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              {isBusy && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Generate</span>
            </button>
          </div>
        </div>
      </BottomSheet>

      {/* One-time temporary password reveal (60s auto-hide, never persisted) */}
      <BottomSheet
        open={Boolean(tempPasswordInfo)}
        onClose={onDismissTempPassword}
        title="Temporary password"
        subtitle={
          tempPasswordInfo
            ? `${tempPasswordInfo.orgName} · ${tempPasswordInfo.orgId}`
            : undefined
        }
      >
        {tempPasswordInfo && (
          <div className="space-y-4">
            <div className="p-4 rounded-2xl bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-center">
              <p className="font-mono text-lg font-bold tracking-wider text-zinc-900 dark:text-zinc-100 select-all">
                {tempPasswordInfo.tempPassword}
              </p>
            </div>

            <p className="admin-caption text-zinc-500 dark:text-zinc-400 tabular-nums">
              Shown once only and never saved. Hides automatically in {tempPasswordInfo.secondsLeft}s.
            </p>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleCopyTempPassword()}
                className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 text-[15px] font-semibold text-white inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
              >
                {copiedTemp ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copiedTemp ? 'Copied' : 'Copy'}</span>
              </button>
              <button
                type="button"
                onClick={onDismissTempPassword}
                className="admin-press min-h-[44px] px-4 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-[15px] font-semibold text-zinc-900 dark:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </BottomSheet>

      {/* Permanent Bin Purge dialog requiring typed PURGE */}
      <BottomSheet
        open={dialog === 'purge'}
        onClose={onCloseDialog}
        closeDisabled={isBusy}
        title="Delete permanently?"
        subtitle="Empties all accounts currently in Bin"
      >
        <div className="space-y-4">
          <p className="admin-body text-zinc-600 dark:text-zinc-400">
            Permanently deletes all organisers in the Bin along with their events, judges, participants, and scores. This cannot be undone.
          </p>

          <div className="space-y-1.5">
            <label
              htmlFor="admin-purge-confirm"
              className="block admin-caption font-semibold text-zinc-700 dark:text-zinc-300"
            >
              Type PURGE to confirm
            </label>
            <input
              id="admin-purge-confirm"
              type="text"
              value={purgeConfirmText}
              onChange={(e) => setPurgeConfirmText(e.target.value)}
              placeholder="PURGE"
              autoComplete="off"
              className="w-full min-h-[44px] px-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 font-mono text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/60"
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={isBusy}
              onClick={onCloseDialog}
              className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-[15px] font-semibold text-zinc-900 dark:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isBusy || !isOnline || !canPurge}
              onClick={() => void onConfirmPurgeBin()}
              className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-40 text-[15px] font-semibold text-white inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              {isBusy && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>Delete permanently</span>
            </button>
          </div>
        </div>
      </BottomSheet>
    </>
  );
}
