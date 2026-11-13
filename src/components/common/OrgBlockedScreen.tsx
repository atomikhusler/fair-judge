import React from 'react';
import { ExternalLink, LogOut, ShieldAlert, Trash2 } from 'lucide-react';
import { TELEGRAM_SUPPORT_URL } from '../../config/support';
import { triggerHaptic } from '../../lib/haptics';

interface OrgBlockedScreenProps {
  mode: 'suspended' | 'deleted';
  orgName?: string;
  orgId?: string;
  reason?: string | null;
  onLogout: () => void;
}

export const OrgBlockedScreen: React.FC<OrgBlockedScreenProps> = ({
  mode,
  orgName,
  orgId,
  reason,
  onLogout,
}) => {
  const isDeleted = mode === 'deleted';

  return (
    <div className="min-h-[100dvh] w-full flex items-center justify-center bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 p-4">
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-6 space-y-5 shadow-xl">
        <div className="flex items-start gap-3.5">
          <div className="w-11 h-11 rounded-2xl bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 flex items-center justify-center shrink-0">
            {isDeleted ? <Trash2 className="w-5 h-5" /> : <ShieldAlert className="w-5 h-5" />}
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-zinc-900 dark:text-white">
              {isDeleted ? 'Organization Removed' : 'Organization Suspended'}
            </h1>
            {(orgName || orgId) && (
              <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                {orgName ? `${orgName}${orgId ? ` (${orgId})` : ''}` : orgId}
              </p>
            )}
          </div>
        </div>

        <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
          {isDeleted
            ? 'This organization has been removed by a platform administrator and can no longer run live events or sync ballots.'
            : 'Access for this organization has been temporarily suspended by a platform administrator.'}
        </p>

        {reason && (
          <div className="rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 p-3 space-y-1">
            <span className="block text-[10px] font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
              Reason
            </span>
            <p className="text-xs text-zinc-800 dark:text-zinc-200 leading-relaxed">{reason}</p>
          </div>
        )}

        <div className="flex flex-col gap-2.5 pt-1">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tick');
              onLogout();
            }}
            className="w-full min-h-[44px] rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>

          <a
            href={TELEGRAM_SUPPORT_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => triggerHaptic('light')}
            className="w-full min-h-[44px] rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-200 font-medium text-xs flex items-center justify-center gap-2 no-underline"
          >
            <span>Contact Support on Telegram</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
};
