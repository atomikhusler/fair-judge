import React, { useState } from 'react';
import {
  Building2,
  CalendarDays,
  Gavel,
  Users,
  Database,
  ShieldCheck,
  AlertTriangle,
  Inbox,
  ShieldAlert,
  ArrowRight,
  Loader2,
} from 'lucide-react';
import { AdminOverview, adminService, AdminOrgFilter } from './adminService';
import { Skel } from '../components/common/Skeletons';
import { showToast } from '../components/common/ToastProvider';
import { triggerHaptic } from '../lib/haptics';

export type AdminTabKey = 'overview' | 'orgs' | 'inbox' | 'notices' | 'alerts';

interface OverviewTabProps {
  overview: AdminOverview | null;
  isLoading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  onNavigateTab: (tab: AdminTabKey, orgFilter?: AdminOrgFilter) => void;
}

const FREE_TIER_DB_BYTES = 500 * 1024 * 1024; // 500 MB reference cap

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function OverviewTab({
  overview,
  isLoading,
  error,
  onRefresh,
  onNavigateTab,
}: OverviewTabProps) {
  const [confirmEnforceTarget, setConfirmEnforceTarget] = useState<boolean | null>(null);
  const [isUpdatingEnforcement, setIsUpdatingEnforcement] = useState(false);

  const dbBytes = overview?.db_bytes ?? 0;
  const dbRatio = Math.min(1, Math.max(0, dbBytes / FREE_TIER_DB_BYTES));
  const dbPercent = Math.round(dbRatio * 100);
  const dbBarColor =
    dbPercent >= 85
      ? 'bg-red-500'
      : dbPercent >= 65
        ? 'bg-amber-500'
        : 'bg-violet-500';

  const handleConfirmEnforcement = async () => {
    if (confirmEnforceTarget === null || isUpdatingEnforcement) return;
    setIsUpdatingEnforcement(true);
    try {
      const res = await adminService.setEnforcement(confirmEnforceTarget);
      if (res?.ok) {
        triggerHaptic('success');
        showToast(
          confirmEnforceTarget
            ? 'Verification enforcement is now ON.'
            : 'Verification enforcement is now OFF.',
          'success'
        );
        setConfirmEnforceTarget(null);
        await onRefresh();
      } else {
        throw new Error('Could not update setting.');
      }
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Failed to update enforcement setting.', 'error');
    } finally {
      setIsUpdatingEnforcement(false);
    }
  };

  if (error && !overview) {
    return (
      <div className="bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-900/60 rounded-2xl p-5 space-y-3">
        <div className="flex items-start gap-2.5 text-red-700 dark:text-red-300">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-semibold">Unable to load overview</p>
            <p className="text-xs opacity-80 mt-0.5">{error}</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void onRefresh()}
          className="min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-900 dark:text-white transition-colors cursor-pointer"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 1. Primary Platform Metrics */}
      <section className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-zinc-900 dark:text-white">
            Platform Overview
          </h2>
          <span className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
            {isLoading && !overview ? (
              <Skel w={72} h={14} />
            ) : (
              `${overview?.total_orgs ?? 0} active orgs`
            )}
          </span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {/* Pending Orgs */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tick');
              onNavigateTab('orgs', 'pending');
            }}
            className="min-h-[76px] text-left p-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200/80 dark:hover:bg-zinc-700/80 transition-colors cursor-pointer flex flex-col justify-between"
          >
            <div className="flex items-center justify-between gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              <span>Pending orgs</span>
              <ArrowRight className="w-3.5 h-3.5 shrink-0 text-violet-500" />
            </div>
            <div className="text-xl font-bold text-zinc-900 dark:text-white tabular-nums mt-1">
              {isLoading && !overview ? <Skel w={36} h={24} /> : overview?.pending_orgs ?? 0}
            </div>
          </button>

          {/* Verified Orgs */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('tick');
              onNavigateTab('orgs', 'verified');
            }}
            className="min-h-[76px] text-left p-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200/80 dark:hover:bg-zinc-700/80 transition-colors cursor-pointer flex flex-col justify-between"
          >
            <div className="flex items-center justify-between gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              <span>Verified orgs</span>
              <Building2 className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
            </div>
            <div className="text-xl font-bold text-zinc-900 dark:text-white tabular-nums mt-1">
              {isLoading && !overview ? <Skel w={36} h={24} /> : overview?.verified_orgs ?? 0}
            </div>
          </button>

          {/* Active Events */}
          <div className="min-h-[76px] p-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 flex flex-col justify-between">
            <div className="flex items-center justify-between gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              <span>Live events</span>
              <CalendarDays className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
            </div>
            <div className="text-xl font-bold text-zinc-900 dark:text-white tabular-nums mt-1">
              {isLoading && !overview ? (
                <Skel w={48} h={24} />
              ) : (
                <>
                  {overview?.active_events ?? 0}
                  <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                    {' '}
                    / {overview?.total_events ?? 0}
                  </span>
                </>
              )}
            </div>
          </div>

          {/* Scores 7d */}
          <div className="min-h-[76px] p-3.5 rounded-xl bg-stone-100 dark:bg-zinc-800 flex flex-col justify-between">
            <div className="flex items-center justify-between gap-1 text-xs text-zinc-600 dark:text-zinc-400">
              <span>Scores (7d)</span>
              <Gavel className="w-3.5 h-3.5 shrink-0 text-zinc-400" />
            </div>
            <div className="text-xl font-bold text-zinc-900 dark:text-white tabular-nums mt-1">
              {isLoading && !overview ? (
                <Skel w={48} h={24} />
              ) : (
                <>
                  {overview?.scores_7d ?? 0}
                  <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
                    {' '}
                    / {overview?.total_scores ?? 0}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Quiet inline secondary stats row (zero pill clutter) */}
        <div className="pt-1 border-t border-stone-200 dark:border-zinc-800 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-600 dark:text-zinc-400 tabular-nums">
          <span className="inline-flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-zinc-400" />
            {isLoading && !overview ? (
              <Skel w={80} h={14} />
            ) : (
              `${overview?.total_judges ?? 0} judges · ${overview?.total_participants ?? 0} participants`
            )}
          </span>
          {overview && (overview.suspended_orgs > 0 || overview.deleted_orgs > 0) && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => onNavigateTab('orgs', overview.suspended_orgs > 0 ? 'suspended' : 'deleted')}
                className="text-violet-600 dark:text-violet-400 hover:underline font-medium cursor-pointer"
              >
                {overview.suspended_orgs} suspended · {overview.deleted_orgs} in bin
              </button>
            </>
          )}
        </div>
      </section>

      {/* 2. Action Queue Shortcuts: Support Inbox & Lockout Alerts */}
      <section className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <button
          type="button"
          onClick={() => {
            triggerHaptic('tick');
            onNavigateTab('inbox');
          }}
          className="min-h-[68px] p-4 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 hover:border-violet-500/50 rounded-2xl flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-stone-100 dark:bg-zinc-800 flex items-center justify-center text-violet-500 shrink-0">
              <Inbox className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-900 dark:text-white truncate">
                Support Inbox
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums mt-0.5">
                {isLoading && !overview ? (
                  <Skel w={96} h={14} />
                ) : (
                  `${overview?.new_reports ?? 0} new · ${overview?.open_reports ?? 0} open`
                )}
              </p>
            </div>
          </div>
          <ArrowRight className="w-4 h-4 text-zinc-400 shrink-0" />
        </button>

        <button
          type="button"
          onClick={() => {
            triggerHaptic('tick');
            onNavigateTab('alerts');
          }}
          className="min-h-[68px] p-4 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 hover:border-violet-500/50 rounded-2xl flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-stone-100 dark:bg-zinc-800 flex items-center justify-center text-amber-500 shrink-0">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-zinc-900 dark:text-white truncate">
                Security Alerts
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums mt-0.5">
                {isLoading && !overview ? (
                  <Skel w={96} h={14} />
                ) : (
                  `${overview?.lockouts_24h ?? 0} lockouts in last 24h`
                )}
              </p>
            </div>
          </div>
          <ArrowRight className="w-4 h-4 text-zinc-400 shrink-0" />
        </button>
      </section>

      {/* 3. Database Storage Meter */}
      <section className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Database className="w-4 h-4 text-violet-500 shrink-0" />
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-white truncate">
              Database Storage
            </h3>
          </div>
          <span className="text-xs font-mono font-medium text-zinc-700 dark:text-zinc-300 tabular-nums shrink-0">
            {isLoading && !overview ? (
              <Skel w={110} h={14} />
            ) : (
              `${formatMb(dbBytes)} / 500 MB (${dbPercent}%)`
            )}
          </span>
        </div>

        <div className="h-2.5 w-full rounded-full bg-stone-100 dark:bg-zinc-800 overflow-hidden">
          <div
            className={`h-full w-full origin-left rounded-full transition-transform duration-300 ${dbBarColor}`}
            style={{ transform: `scaleX(${Math.max(0.02, dbRatio)})` }}
          />
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Free tier ceiling is 500 MB. Purge soft-deleted organisations older than 30 days from Orgs → Bin to reclaim space.
        </p>
      </section>

      {/* 4. Verification Enforcement Switch */}
      <section className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 sm:p-5 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-violet-500 shrink-0" />
              <h3 className="text-sm font-semibold text-zinc-900 dark:text-white">
                Verification Enforcement
              </h3>
              <span className="text-xs font-semibold tabular-nums text-violet-600 dark:text-violet-400">
                {isLoading && !overview ? (
                  <Skel w={28} h={14} />
                ) : overview?.enforce_verification ? (
                  'ON'
                ) : (
                  'OFF'
                )}
              </span>
            </div>
            <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              When ON, unverified organisers can still build rosters and draft events, but cannot start live events or record scores.
            </p>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={Boolean(overview?.enforce_verification)}
            disabled={isLoading && !overview}
            onClick={() => {
              if (!overview) return;
              triggerHaptic('tap');
              setConfirmEnforceTarget(!overview.enforce_verification);
            }}
            className={`shrink-0 min-h-[44px] min-w-[60px] px-2 flex items-center rounded-xl border transition-colors cursor-pointer ${
              overview?.enforce_verification
                ? 'bg-violet-600 border-violet-500 justify-end'
                : 'bg-stone-100 dark:bg-zinc-800 border-stone-200 dark:border-zinc-700 justify-start'
            }`}
          >
            <span
              className={`w-6 h-6 rounded-lg shadow-xs ${
                overview?.enforce_verification ? 'bg-white' : 'bg-zinc-400 dark:bg-zinc-500'
              }`}
            />
          </button>
        </div>

        {overview && !overview.enforce_verification && overview.pending_orgs > 0 && (
          <div className="p-3 rounded-xl bg-stone-100 dark:bg-zinc-800 flex items-start gap-2.5 text-xs text-zinc-700 dark:text-zinc-300">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <span>
              <strong className="tabular-nums">{overview.pending_orgs}</strong> pending{' '}
              {overview.pending_orgs === 1 ? 'organisation' : 'organisations'} will be blocked from running live events if you switch enforcement ON. Verify trusted accounts first.
            </span>
          </div>
        )}
      </section>

      {/* Confirmation Dialog for Enforcement Toggle */}
      {confirmEnforceTarget !== null && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/65 flex items-end sm:items-center justify-center p-4"
          onClick={() => {
            if (!isUpdatingEnforcement) setConfirmEnforceTarget(null);
          }}
        >
          <div
            className="w-full max-w-sm bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-3xl p-5 space-y-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-1.5">
              <h4 className="text-base font-bold text-zinc-900 dark:text-white">
                {confirmEnforceTarget
                  ? 'Turn ON verification enforcement?'
                  : 'Turn OFF verification enforcement?'}
              </h4>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                {confirmEnforceTarget
                  ? `Unverified organisers (${overview?.pending_orgs ?? 0} pending) will no longer be able to launch live events or submit new scores until verified.`
                  : 'All active non-suspended organisations will be able to run live events regardless of verification status.'}
              </p>
            </div>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={isUpdatingEnforcement}
                onClick={() => setConfirmEnforceTarget(null)}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-800 dark:text-zinc-200 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isUpdatingEnforcement}
                onClick={() => void handleConfirmEnforcement()}
                className="flex-1 min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                {isUpdatingEnforcement && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{confirmEnforceTarget ? 'Turn ON' : 'Turn OFF'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
