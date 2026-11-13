import React from 'react';
import {
  CheckCircle2,
  XCircle,
  RotateCcw,
  Ban,
  KeyRound,
  Trash2,
  ShieldCheck,
  Loader2,
} from 'lucide-react';
import { AdminOrg } from '../adminService';
import { GroupedList, ListRow } from '../ui';
import { triggerHaptic } from '../../lib/haptics';

interface OrgActionsProps {
  org: AdminOrg;
  isBusy: boolean;
  isOnline: boolean;
  onApprove: () => void;
  onSetPending: () => void;
  onOpenReject: () => void;
  onOpenSuspend: () => void;
  onReactivate: () => void;
  onOpenResetPassword: () => void;
  onMoveToBin: () => void;
  onRestore: () => void;
  onOpenPurge: () => void;
}

export function OrgActions({
  org,
  isBusy,
  isOnline,
  onApprove,
  onSetPending,
  onOpenReject,
  onOpenSuspend,
  onReactivate,
  onOpenResetPassword,
  onMoveToBin,
  onRestore,
  onOpenPurge,
}: OrgActionsProps) {
  const disabled = isBusy || !isOnline;
  const isPending = !org.deleted_at && org.verification_status === 'pending';

  if (org.deleted_at) {
    return (
      <div className="space-y-6">
        <GroupedList title="Danger zone">
          <ListRow
            leading={<RotateCcw className="w-5 h-5" />}
            title="Restore"
            subtitle="Return this organiser to active lists"
            disabled={disabled}
            onClick={onRestore}
          />
          <ListRow
            danger
            leading={<Trash2 className="w-5 h-5" />}
            title="Delete permanently"
            subtitle="Empty all organisers currently in the bin"
            disabled={disabled}
            onClick={onOpenPurge}
          />
        </GroupedList>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Approve / Reject pair for Pending (sticky bottom on <768px phone, inline on >=768px) */}
      {isPending && (
        <div className="fixed md:static bottom-[calc(3.5rem+env(safe-area-inset-bottom))] left-0 right-0 z-20 px-4 py-3 md:p-0 bg-zinc-50 dark:bg-zinc-950 md:bg-transparent border-t border-zinc-200 dark:border-zinc-800 md:border-t-0">
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                triggerHaptic('light');
                onApprove();
              }}
              className="admin-press min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-[15px] font-semibold inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              {isBusy ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <CheckCircle2 className="w-4 h-4" />
              )}
              <span>Approve</span>
            </button>

            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                triggerHaptic('light');
                onOpenReject();
              }}
              className="admin-press min-h-[44px] px-4 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-50 text-red-600 dark:text-red-400 text-[15px] font-semibold inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              <XCircle className="w-4 h-4" />
              <span>Reject</span>
            </button>
          </div>
        </div>
      )}

      {/* Account Controls */}
      <GroupedList title="Actions">
        {org.verification_status !== 'verified' && !isPending && (
          <ListRow
            leading={<CheckCircle2 className="w-5 h-5 text-green-500" />}
            title="Approve"
            subtitle="Mark organiser as verified"
            disabled={disabled}
            onClick={onApprove}
          />
        )}

        {org.verification_status !== 'pending' && (
          <ListRow
            leading={<RotateCcw className="w-5 h-5" />}
            title="Move to pending"
            subtitle="Return account to verification queue"
            disabled={disabled}
            onClick={onSetPending}
          />
        )}

        {org.verification_status !== 'rejected' && !isPending && (
          <ListRow
            leading={<XCircle className="w-5 h-5 text-red-500" />}
            title="Reject"
            subtitle="Decline verification request"
            disabled={disabled}
            onClick={onOpenReject}
          />
        )}

        {org.suspended ? (
          <ListRow
            leading={<ShieldCheck className="w-5 h-5 text-green-500" />}
            title="Reactivate"
            subtitle="Allow organiser and judge logins again"
            disabled={disabled}
            onClick={onReactivate}
          />
        ) : (
          <ListRow
            leading={<Ban className="w-5 h-5 text-orange-500" />}
            title="Suspend"
            subtitle="End active sessions and block sign-in"
            disabled={disabled}
            onClick={onOpenSuspend}
          />
        )}

        <ListRow
          leading={<KeyRound className="w-5 h-5" />}
          title="Reset password"
          subtitle="Create a one-time temporary password"
          disabled={disabled}
          onClick={onOpenResetPassword}
        />
      </GroupedList>

      {/* Danger Zone */}
      <GroupedList title="Danger zone">
        <ListRow
          danger
          leading={<Trash2 className="w-5 h-5" />}
          title="Move to bin"
          subtitle="Block access with 5-second Undo"
          disabled={disabled}
          onClick={onMoveToBin}
        />
      </GroupedList>
    </div>
  );
}
