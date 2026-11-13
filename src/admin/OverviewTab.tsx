import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Database,
  ShieldCheck,
  AlertTriangle,
  Loader2,
  Building2,
  Inbox,
  ShieldAlert,
} from 'lucide-react';
import { AdminOverview, adminService, AdminOrgFilter } from './adminService';
import {
  BottomSheet,
  EmptyState,
  GroupedList,
  ListRow,
  Skel,
  showAdminToast,
} from './ui';
import { triggerHaptic } from '../lib/haptics';

export type AdminTabKey = 'overview' | 'orgs' | 'inbox' | 'notices' | 'alerts';

interface OverviewTabProps {
  overview: AdminOverview | null;
  isLoading: boolean;
  error: string | null;
  isOnline: boolean;
  onRefresh: () => Promise<void>;
  onNavigateTab: (tab: AdminTabKey, orgFilter?: AdminOrgFilter) => void;
}

const FREE_TIER_DB_BYTES = 500 * 1024 * 1024; // 500 MB cap

function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function useCountUpOnce(target: number | null, canAnimate: boolean): number {
  const [display, setDisplay] = useState<number>(target ?? 0);
  const hasAnimatedRef = useRef(false);

  useEffect(() => {
    if (target === null) return;

    if (hasAnimatedRef.current) {
      setDisplay(target);
      return;
    }

    const reducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const isHidden = typeof document !== 'undefined' && document.hidden;

    if (!canAnimate || reducedMotion || isHidden || target <= 0 || target > 99999) {
      hasAnimatedRef.current = true;
      setDisplay(target);
      return;
    }

    hasAnimatedRef.current = true;
    const duration = 400;
    const start = performance.now();
    let rafId = 0;

    const step = (now: number) => {
      if (typeof document !== 'undefined' && document.hidden) {
        setDisplay(target);
        return;
      }
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(target * eased));
      if (progress < 1) {
        rafId = window.requestAnimationFrame(step);
      } else {
        setDisplay(target);
      }
    };

    rafId = window.requestAnimationFrame(step);
    return () => {
      if (rafId) window.cancelAnimationFrame(rafId);
    };
  }, [target, canAnimate]);

  return display;
}

export function OverviewTab({
  overview,
  isLoading,
  error,
  isOnline,
  onRefresh,
  onNavigateTab,
}: OverviewTabProps) {
  const [confirmEnforceTarget, setConfirmEnforceTarget] = useState<boolean | null>(null);
  const [isUpdatingEnforcement, setIsUpdatingEnforcement] = useState(false);

  const canCountUp = Boolean(overview);
  const orgsVal = useCountUpOnce(overview ? overview.total_orgs : null, canCountUp);
  const eventsVal = useCountUpOnce(overview ? overview.total_events : null, canCountUp);
  const judgesVal = useCountUpOnce(overview ? overview.total_judges : null, canCountUp);
  const scoresVal = useCountUpOnce(overview ? overview.scores_7d : null, canCountUp);

  const dbBytes = overview?.db_bytes ?? 0;
  const dbRatio = Math.min(1, Math.max(0, dbBytes / FREE_TIER_DB_BYTES));
  const dbPercent = Math.round(dbRatio * 100);
  const dbBarColor =
    dbPercent >= 90
      ? 'bg-red-500'
      : dbPercent >= 70
        ? 'bg-orange-500'
        : 'bg-green-500';

  const unverifiedCount =
    (overview?.pending_orgs ?? 0) + (overview?.rejected_orgs ?? 0);

  const pendingCount = overview?.pending_orgs ?? 0;
  const reportsCount = overview?.new_reports ?? 0;
  const lockoutsCount = overview?.lockouts_24h ?? 0;
  const allClear =
    Boolean(overview) && pendingCount === 0 && reportsCount === 0 && lockoutsCount === 0;

  const handleConfirmEnforcement = async () => {
    if (confirmEnforceTarget === null || isUpdatingEnforcement || !isOnline) return;
    setIsUpdatingEnforcement(true);
    try {
      const res = await adminService.setEnforcement(confirmEnforceTarget);
      if (!res?.ok) {
        throw new Error('Could not update rule.');
      }
      triggerHaptic('success');
      showAdminToast(
        confirmEnforceTarget
          ? 'Unverified organisers are now blocked from running events.'
          : 'Unverified organisers can now run events.',
        { tone: 'success' }
      );
      setConfirmEnforceTarget(null);
      await onRefresh();
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Failed to update rule.', { tone: 'error' });
    } finally {
      setIsUpdatingEnforcement(false);
    }
  };

  if (error && !overview) {
    return (
      <EmptyState
        icon={<AlertTriangle className="w-5 h-5 text-red-500" />}
        message={error}
        actionLabel="Retry"
        onAction={() => void onRefresh()}
        actionDisabled={!isOnline}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
      {/* Column 1: Needs attention */}
      <div className="lg:col-span-1 space-y-6">
        <GroupedList title="Needs attention">
          {isLoading && !overview ? (
            <>
              <ListRow title={<Skel w="60%" h={15} />} trailing={<Skel w={24} h={15} />} />
              <ListRow title={<Skel w="55%" h={15} />} trailing={<Skel w={24} h={15} />} />
              <ListRow title={<Skel w="58%" h={15} />} trailing={<Skel w={24} h={15} />} />
            </>
          ) : allClear ? (
            <ListRow
              animateIndex={0}
              leading={<CheckCircle2 className="w-5 h-5 text-green-500" />}
              title="All clear"
              subtitle="Nothing needs attention right now"
            />
          ) : (
            <>
              <ListRow
                animateIndex={0}
                leading={<Building2 className="w-5 h-5" />}
                title="Pending requests"
                trailing={
                  <span className="inline-flex items-center gap-2 font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    {pendingCount > 0 && (
                      <span
                        aria-hidden="true"
                        className="w-2 h-2 rounded-full bg-orange-500 admin-attention-pulse"
                      />
                    )}
                    <span>{pendingCount}</span>
                  </span>
                }
                chevron
                onClick={() => onNavigateTab('orgs', 'pending')}
              />
              <ListRow
                animateIndex={1}
                leading={<Inbox className="w-5 h-5" />}
                title="New reports"
                trailing={
                  <span className="inline-flex items-center gap-2 font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    {reportsCount > 0 && (
                      <span
                        aria-hidden="true"
                        className="w-2 h-2 rounded-full bg-orange-500 admin-attention-pulse"
                      />
                    )}
                    <span>{reportsCount}</span>
                  </span>
                }
                chevron
                onClick={() => onNavigateTab('inbox')}
              />
              <ListRow
                animateIndex={2}
                leading={<ShieldAlert className="w-5 h-5" />}
                title="Locked accounts"
                trailing={
                  <span className="inline-flex items-center gap-2 font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
                    {lockoutsCount > 0 && (
                      <span
                        aria-hidden="true"
                        className="w-2 h-2 rounded-full bg-red-500 admin-attention-pulse"
                      />
                    )}
                    <span>{lockoutsCount}</span>
                  </span>
                }
                chevron
                onClick={() => onNavigateTab('alerts')}
              />
            </>
          )}
        </GroupedList>
      </div>

      {/* Columns 2-3: Platform 2x2 tiles, Database, Rules */}
      <div className="lg:col-span-2 space-y-6">
        {/* Platform 2x2 stat tiles */}
        <section className="space-y-2">
          <h2 className="admin-caption font-semibold text-zinc-500 dark:text-zinc-400 px-1">
            Platform
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 flex flex-col justify-between min-h-[104px]">
              <span className="admin-caption font-medium text-zinc-500 dark:text-zinc-400">
                Organisers
              </span>
              <div className="admin-large-title text-zinc-900 dark:text-zinc-100 tabular-nums mt-2">
                {isLoading && !overview ? <Skel w={48} h={30} /> : orgsVal.toLocaleString()}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 flex flex-col justify-between min-h-[104px]">
              <span className="admin-caption font-medium text-zinc-500 dark:text-zinc-400">
                Events
              </span>
              <div className="admin-large-title text-zinc-900 dark:text-zinc-100 tabular-nums mt-2">
                {isLoading && !overview ? <Skel w={48} h={30} /> : eventsVal.toLocaleString()}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 flex flex-col justify-between min-h-[104px]">
              <span className="admin-caption font-medium text-zinc-500 dark:text-zinc-400">
                Judges
              </span>
              <div className="admin-large-title text-zinc-900 dark:text-zinc-100 tabular-nums mt-2">
                {isLoading && !overview ? <Skel w={48} h={30} /> : judgesVal.toLocaleString()}
              </div>
            </div>

            <div className="rounded-2xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-4 flex flex-col justify-between min-h-[104px]">
              <span className="admin-caption font-medium text-zinc-500 dark:text-zinc-400">
                Scores (7d)
              </span>
              <div className="admin-large-title text-zinc-900 dark:text-zinc-100 tabular-nums mt-2">
                {isLoading && !overview ? <Skel w={56} h={30} /> : scoresVal.toLocaleString()}
              </div>
            </div>
          </div>
        </section>

        {/* Database row */}
        <GroupedList title="Database">
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <Database className="w-5 h-5 text-zinc-500 dark:text-zinc-400 shrink-0" />
                <span className="admin-body font-medium text-zinc-900 dark:text-zinc-100 truncate">
                  Storage used
                </span>
              </div>
              <span className="admin-caption font-medium text-zinc-600 dark:text-zinc-400 tabular-nums shrink-0">
                {isLoading && !overview ? (
                  <Skel w={96} h={14} />
                ) : (
                  `${formatMb(dbBytes)} / 500 MB (${dbPercent}%)`
                )}
              </span>
            </div>

            <div className="h-1.5 w-full rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
              <div
                className={`h-full w-full origin-left rounded-full admin-slide-transform ${dbBarColor}`}
                style={{ transform: `scaleX(${Math.max(0.015, dbRatio)})` }}
              />
            </div>
          </div>
        </GroupedList>

        {/* Rules row */}
        <GroupedList title="Rules">
          <div className="min-h-[56px] px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <ShieldCheck className="w-5 h-5 text-zinc-500 dark:text-zinc-400 shrink-0" />
              <div className="min-w-0">
                <p className="admin-body font-medium text-zinc-900 dark:text-zinc-100">
                  Block unverified organisers from running events
                </p>
                <p className="admin-caption text-zinc-500 dark:text-zinc-400 mt-0.5">
                  {overview?.enforce_verification
                    ? 'On — unverified accounts can draft only'
                    : 'Off — all active accounts can start live events'}
                </p>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={Boolean(overview?.enforce_verification)}
              aria-label="Block unverified organisers from running events"
              disabled={!isOnline || (isLoading && !overview)}
              onClick={() => {
                if (!overview || !isOnline) return;
                triggerHaptic('light');
                setConfirmEnforceTarget(!overview.enforce_verification);
              }}
              className={`admin-press shrink-0 min-h-[44px] min-w-[56px] px-1.5 flex items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                overview?.enforce_verification ? 'justify-end' : 'justify-start'
              }`}
            >
              <span
                className={`w-12 h-7 rounded-full p-0.5 flex items-center border ${
                  overview?.enforce_verification
                    ? 'bg-violet-600 border-violet-600 justify-end'
                    : 'bg-zinc-200 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 justify-start'
                }`}
              >
                <span className="w-5 h-5 rounded-full bg-white shadow-xs" />
              </span>
            </button>
          </div>
        </GroupedList>
      </div>

      {/* Confirm rule toggle dialog */}
      <BottomSheet
        open={confirmEnforceTarget !== null}
        onClose={() => {
          if (!isUpdatingEnforcement) setConfirmEnforceTarget(null);
        }}
        closeDisabled={isUpdatingEnforcement}
        title={
          confirmEnforceTarget
            ? 'Block unverified organisers?'
            : 'Allow unverified organisers?'
        }
      >
        <div className="space-y-4">
          <p className="admin-body text-zinc-600 dark:text-zinc-400">
            {confirmEnforceTarget
              ? `${unverifiedCount} unverified ${
                  unverifiedCount === 1 ? 'organiser' : 'organisers'
                } would be blocked from starting live events or recording scores until verified.`
              : 'All active, non-suspended organisers will be allowed to run live events even before verification.'}
          </p>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              disabled={isUpdatingEnforcement}
              onClick={() => setConfirmEnforceTarget(null)}
              className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-[15px] font-semibold text-zinc-900 dark:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isUpdatingEnforcement || !isOnline}
              onClick={() => void handleConfirmEnforcement()}
              className="admin-press flex-1 min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-[15px] font-semibold text-white inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              {isUpdatingEnforcement && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{confirmEnforceTarget ? 'Turn on' : 'Turn off'}</span>
            </button>
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}
