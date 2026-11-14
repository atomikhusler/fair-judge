import React, { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import {
  Lock,
  RefreshCw,
  ShieldCheck,
  LayoutGrid,
  Building2,
  Inbox,
  MoreHorizontal,
  ArrowLeft,
  Sun,
  Moon,
  WifiOff,
} from 'lucide-react';
import './ui/tokens.css';
import {
  adminService,
  AdminOverview,
  AdminOrgFilter,
  AdminOrg,
  AdminReportSummary,
} from './adminService';
import { getAdminClient } from './adminClient';
import {
  ADMIN_IDLE_TIMEOUT_MS,
  clearAdminStorage,
  getLastActive,
  isIdleExpired,
  touchLastActive,
} from './adminSession';
import { useAdminRoute, AdminRootTab } from './useAdminRoute';
import {
  AdminToastHost,
  EmptyState,
  ScreenHeader,
  Skel,
} from './ui';
import { isSupabaseConfigured } from '../lib/supabase';
import { SignIn } from './SignIn';
import { OverviewTab, AdminTabKey } from './OverviewTab';
import { OrgList } from './orgs/OrgList';
import { OrgUiFilter, mapRpcFilterToUi } from './orgs/orgUtils';
import { InboxList } from './inbox/InboxList';
import { MoreView } from './MoreView';
import { useTheme } from '../lib/theme';
import { PullToRefresh } from '../components/common/PullToRefresh';
import { triggerHaptic } from '../lib/haptics';
import { lazyWithRetry } from '../lib/lazyWithRetry';
import { ErrorBoundary } from '../components/common/ErrorBoundary';

const OrgDetail = lazyWithRetry(() => import('./orgs/OrgDetail'), 'admin_org_detail');
const InboxDetail = lazyWithRetry(() => import('./inbox/InboxDetail'), 'admin_inbox_detail');

interface AdminAppProps {
  onExit: () => void;
}

const ACTIVITY_THROTTLE_MS = 15 * 1000;
const STALE_VISIBLE_REFRESH_MS = 60 * 1000;

export function AdminApp({ onExit }: AdminAppProps) {
  const [admin, setAdmin] = useState<{ email: string; userId: string } | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isLocking, setIsLocking] = useState(false);
  const [signInNotice, setSignInNotice] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  const [isDocHidden, setIsDocHidden] = useState(() =>
    typeof document === 'undefined' ? false : document.hidden
  );

  const { route, direction, isDrillDown, switchTab, pushRoute, goUp } = useAdminRoute();
  const [orgFilterPreset, setOrgFilterPreset] = useState<OrgUiFilter>('active');
  const [orgFilterSyncNonce, setOrgFilterSyncNonce] = useState(0);
  const [selectedOrgCache, setSelectedOrgCache] = useState<AdminOrg | null>(null);
  const [selectedReportCache, setSelectedReportCache] = useState<AdminReportSummary | null>(null);
  const [highlightedOrgId, setHighlightedOrgId] = useState<string | null>(null);
  const [listRefreshNonce, setListRefreshNonce] = useState(0);

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [isLoadingOverview, setIsLoadingOverview] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  const idleTimerRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  const lastActivityWriteRef = useRef<number>(0);
  const lastRefreshAtRef = useRef<number>(0);
  const overviewErrorRef = useRef<string | null>(null);

  useEffect(() => {
    overviewErrorRef.current = overviewError;
  }, [overviewError]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  // Track online/offline state
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Pause CSS animations when document.hidden
  useEffect(() => {
    const handleVisibility = () => setIsDocHidden(document.hidden);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // Escape key goes up one level on drill-down pages
  useEffect(() => {
    if (!admin || !isDrillDown) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        goUp();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [admin, isDrillDown, goUp]);

  const loadOverview = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return;
    }
    setIsLoadingOverview(true);
    setOverviewError(null);
    try {
      const data = await adminService.getOverview();
      setOverview(data);
      lastRefreshAtRef.current = Date.now();
    } catch (err: any) {
      setOverviewError(err?.message || 'Failed to load overview.');
    } finally {
      setIsLoadingOverview(false);
    }
  }, []);

  const handleManualRefresh = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return;
    }
    setRefreshNonce((n) => n + 1);
    await loadOverview();
  }, [loadOverview]);

  const stripAdminHashFromUrl = useCallback(() => {
    if (typeof window !== 'undefined' && window.location.hash.startsWith('#/admin')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  const handleLock = useCallback(
    async (reasonNotice?: string) => {
      if (isLocking) return;
      setIsLocking(true);
      try {
        await adminService.signOut();
      } finally {
        clearAdminStorage();
        setAdmin(null);
        setOverview(null);
        setOverviewError(null);
        setIsLocking(false);

        if (reasonNotice) {
          // Automatic idle/expired lock: show reason on SignIn in-tab, but clear #/admin so refresh exits cleanly
          stripAdminHashFromUrl();
          setSignInNotice(reasonNotice);
        } else {
          // Manual Lock / Sign-out: exit admin console back to the main app and clear #/admin
          setSignInNotice(null);
          onExit();
        }
      }
    },
    [isLocking, onExit, stripAdminHashFromUrl]
  );

  // Initial session check on admin start (persistent across reloads within 30 min idle)
  useEffect(() => {
    let active = true;

    async function verifyInitialSession() {
      if (!isSupabaseConfigured()) {
        clearAdminStorage();
        if (active) setIsCheckingSession(false);
        return;
      }

      try {
        const client = getAdminClient();
        const { data } = await client.auth.getSession();
        const sessionUser = data.session?.user;

        if (!sessionUser) {
          clearAdminStorage();
          if (active) {
            setAdmin(null);
            setIsCheckingSession(false);
          }
          return;
        }

        if (isIdleExpired()) {
          await adminService.signOut().catch(() => {});
          clearAdminStorage();
          stripAdminHashFromUrl();
          if (active) {
            setAdmin(null);
            setSignInNotice('Signed out after 30 minutes of inactivity.');
            setIsCheckingSession(false);
          }
          return;
        }

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          touchLastActive();
          if (active) {
            setAdmin({
              email: sessionUser.email || 'Admin',
              userId: sessionUser.id,
            });
            setIsCheckingSession(false);
          }
          return;
        }

        const { data: isAdmin, error: checkError } = await client.rpc('is_platform_admin');
        if (checkError || !isAdmin) {
          await adminService.signOut().catch(() => {});
          clearAdminStorage();
          stripAdminHashFromUrl();
          if (active) {
            setAdmin(null);
            setIsCheckingSession(false);
          }
          return;
        }

        touchLastActive();
        if (active) {
          setAdmin({
            email: sessionUser.email || 'Admin',
            userId: sessionUser.id,
          });
          setIsCheckingSession(false);
        }
      } catch {
        await adminService.signOut().catch(() => {});
        clearAdminStorage();
        stripAdminHashFromUrl();
        if (active) {
          setAdmin(null);
          setIsCheckingSession(false);
        }
      }
    }

    void verifyInitialSession();

    return () => {
      active = false;
    };
  }, [stripAdminHashFromUrl]);

  // Load overview once on sign-in / when returning online
  useEffect(() => {
    if (admin && isOnline) {
      void loadOverview();
    }
  }, [admin, isOnline, loadOverview]);

  // Verify admin role when connectivity returns
  useEffect(() => {
    if (!admin || !isOnline) return;
    let active = true;
    adminService.checkSession().then((verified) => {
      if (!active) return;
      if (!verified) {
        void handleLock('Admin session expired. Please sign in again.');
      }
    });
    return () => {
      active = false;
    };
  }, [admin, isOnline, handleLock]);

  // Single 30-minute idle timeout + throttled activity clock + >60s tab-return refresh
  useEffect(() => {
    if (!admin) return;

    const scheduleIdleTimer = (delayMs: number) => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => {
        void handleLock('Signed out after 30 minutes of inactivity.');
      }, Math.max(0, delayMs));
    };

    const recordActivity = (force: boolean = false) => {
      const now = Date.now();
      if (!force && now - lastActivityWriteRef.current < ACTIVITY_THROTTLE_MS) {
        return;
      }
      lastActivityWriteRef.current = now;
      touchLastActive(now);
      scheduleIdleTimer(ADMIN_IDLE_TIMEOUT_MS);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) return;

      if (isIdleExpired()) {
        void handleLock('Signed out after 30 minutes of inactivity.');
        return;
      }

      recordActivity(true);

      if (
        (typeof navigator === 'undefined' || navigator.onLine) &&
        (Boolean(overviewErrorRef.current) ||
          Date.now() - lastRefreshAtRef.current > STALE_VISIBLE_REFRESH_MS)
      ) {
        void handleManualRefresh();
      }
    };

    const handlePointerOrKey = () => recordActivity(false);
    const handleScroll = () => recordActivity(false);

    window.addEventListener('pointerdown', handlePointerOrKey, { passive: true });
    window.addEventListener('keydown', handlePointerOrKey, { passive: true });
    window.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const existingLast = getLastActive();
    const initialRemaining = existingLast
      ? Math.max(0, ADMIN_IDLE_TIMEOUT_MS - (Date.now() - existingLast))
      : ADMIN_IDLE_TIMEOUT_MS;
    if (!existingLast) {
      touchLastActive();
    }
    scheduleIdleTimer(initialRemaining);

    return () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
      window.removeEventListener('pointerdown', handlePointerOrKey);
      window.removeEventListener('keydown', handlePointerOrKey);
      window.removeEventListener('scroll', handleScroll, { capture: true });
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [admin, handleLock, handleManualRefresh]);

  const handleBackToApp = () => {
    onExit();
  };

  const handleNavigateTab = (tab: AdminTabKey, filter?: AdminOrgFilter) => {
    if (filter) {
      setOrgFilterPreset(mapRpcFilterToUi(filter));
      setOrgFilterSyncNonce((n) => n + 1);
    }
    if (tab === 'overview') {
      switchTab('overview');
    } else if (tab === 'orgs') {
      switchTab('orgs');
    } else if (tab === 'inbox') {
      switchTab('inbox');
    } else if (tab === 'notices') {
      pushRoute('#/admin/more/notices');
    } else if (tab === 'alerts') {
      pushRoute('#/admin/more/alerts');
    }
  };

  const triggerHighlightOrg = useCallback((orgId: string) => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    setHighlightedOrgId(orgId);
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightedOrgId((current) => (current === orgId ? null : current));
      highlightTimerRef.current = null;
    }, 950);
  }, []);

  const handleOrgMutated = useCallback(
    async (orgId: string, options?: { navigateAway?: boolean }) => {
      setListRefreshNonce((n) => n + 1);
      triggerHighlightOrg(orgId);
      if (options?.navigateAway) {
        goUp();
      }
      await loadOverview();
    },
    [goUp, loadOverview, triggerHighlightOrg]
  );

  const handleReportUpdated = useCallback(async () => {
    setListRefreshNonce((n) => n + 1);
    await loadOverview();
  }, [loadOverview]);

  if (isCheckingSession) {
    return (
      <div
        role="status"
        aria-label="Checking admin session"
        className="min-h-[100dvh] w-full flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 text-zinc-500 dark:text-zinc-400"
      >
        <RefreshCw className="w-5 h-5 text-violet-500 animate-spin" />
      </div>
    );
  }

  if (!admin) {
    return (
      <SignIn
        notice={signInNotice}
        onSignedIn={(signedInAdmin) => {
          setSignInNotice(null);
          touchLastActive();
          switchTab('overview');
          setAdmin(signedInAdmin);
        }}
        onExit={onExit}
      />
    );
  }

  const navItems: Array<{
    key: AdminRootTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
  }> = [
    { key: 'overview', label: 'Overview', icon: LayoutGrid },
    { key: 'orgs', label: 'Organisers', icon: Building2, badge: overview?.pending_orgs || undefined },
    { key: 'inbox', label: 'Inbox', icon: Inbox, badge: overview?.new_reports || undefined },
    { key: 'more', label: 'More', icon: MoreHorizontal, badge: overview?.lockouts_24h || undefined },
  ];

  const activeNavIndex = Math.max(
    0,
    navItems.findIndex((t) => t.key === route.tab)
  );

  const transitionClass =
    direction === 'forward'
      ? 'admin-push-forward'
      : direction === 'back'
      ? 'admin-push-back'
      : 'admin-tab-fade';

  const detailSuspenseFallback = (
    <div className="p-4 md:p-6 space-y-4">
      <Skel w="50%" h={20} />
      <Skel w="100%" h={112} rounded="rounded-2xl" />
      <Skel w="100%" h={140} rounded="rounded-2xl" />
    </div>
  );

  const renderMainContent = () => {
    if (route.tab === 'overview') {
      return (
        <div key="overview" className={`w-full max-w-[760px] lg:max-w-[1200px] mx-auto md:px-6 md:py-4 pb-6 ${transitionClass}`}>
          <div className="md:hidden">
            <ScreenHeader title="Overview" subtitle={admin.email} />
          </div>
          <div className="hidden md:block mb-4">
            <h1 className="admin-large-title text-zinc-900 dark:text-zinc-100">Overview</h1>
            <p className="admin-caption text-zinc-500 dark:text-zinc-400 mt-0.5">{admin.email}</p>
          </div>
          <div className="px-4 md:px-0">
            <OverviewTab
              overview={overview}
              isLoading={isLoadingOverview}
              error={overviewError}
              isOnline={isOnline}
              onRefresh={handleManualRefresh}
              onNavigateTab={handleNavigateTab}
            />
          </div>
        </div>
      );
    }

    if (route.tab === 'orgs') {
      const hasDetail = Boolean(route.orgId);
      const cachedOrg =
        route.orgId && selectedOrgCache?.org_id === route.orgId ? selectedOrgCache : null;

      return (
        <div key="orgs" className={`w-full h-full flex flex-col md:flex-row ${transitionClass}`}>
          {/* List pane: hidden on mobile when detail is pushed; fixed width on tablet/desktop */}
          <div
            className={`${
              hasDetail ? 'hidden md:flex' : 'flex'
            } flex-col w-full md:w-[340px] lg:w-[400px] md:shrink-0 md:border-r md:border-zinc-200 dark:md:border-zinc-800 md:h-full md:overflow-y-auto`}
          >
            <div className="md:hidden">
              <ScreenHeader title="Organisers" />
            </div>
            <div className="hidden md:block px-4 pt-5 pb-3">
              <h1 className="admin-large-title text-zinc-900 dark:text-zinc-100">Organisers</h1>
            </div>
            <div className="px-4 pb-6 flex-1">
              <OrgList
                initialFilter={orgFilterPreset}
                filterSyncNonce={orgFilterSyncNonce}
                selectedOrgId={route.orgId}
                highlightedOrgId={highlightedOrgId}
                refreshNonce={refreshNonce + listRefreshNonce}
                isOnline={isOnline}
                onSelectOrg={(org) => {
                  setSelectedOrgCache(org);
                  pushRoute(`#/admin/orgs/${encodeURIComponent(org.org_id)}`);
                }}
              />
            </div>
          </div>

          {/* Detail pane: pushed page on mobile; persistent right pane on tablet/desktop */}
          <div
            className={`${
              hasDetail ? 'flex' : 'hidden md:flex'
            } flex-1 min-w-0 flex-col md:h-full md:overflow-y-auto`}
          >
            {route.orgId ? (
              <div key={route.orgId} className="min-h-full admin-push-forward">
                <ErrorBoundary
                  variant="inline"
                  title="Could not load organiser details"
                  subtitle="A network or rendering issue interrupted this panel"
                  resetKeys={[route.orgId, refreshNonce]}
                  onRetry={() => setRefreshNonce((n) => n + 1)}
                >
                  <Suspense fallback={detailSuspenseFallback}>
                    <OrgDetail
                      orgId={route.orgId}
                      cachedOrg={cachedOrg}
                      isOnline={isOnline}
                      refreshNonce={refreshNonce}
                      onBack={goUp}
                      onOrgMutated={handleOrgMutated}
                    />
                  </Suspense>
                </ErrorBoundary>
              </div>
            ) : (
              <div className="hidden md:flex flex-1 items-center justify-center p-6">
                <EmptyState
                  icon={<Building2 className="w-5 h-5" />}
                  message="Select an organiser"
                  className="max-w-sm w-full"
                />
              </div>
            )}
          </div>
        </div>
      );
    }

    if (route.tab === 'inbox') {
      const hasDetail = Boolean(route.reportId);
      const cachedReport =
        route.reportId && selectedReportCache?.id === route.reportId
          ? selectedReportCache
          : null;

      return (
        <div key="inbox" className={`w-full h-full flex flex-col md:flex-row ${transitionClass}`}>
          {/* List pane */}
          <div
            className={`${
              hasDetail ? 'hidden md:flex' : 'flex'
            } flex-col w-full md:w-[340px] lg:w-[400px] md:shrink-0 md:border-r md:border-zinc-200 dark:md:border-zinc-800 md:h-full md:overflow-y-auto`}
          >
            <div className="md:hidden">
              <ScreenHeader title="Inbox" />
            </div>
            <div className="hidden md:block px-4 pt-5 pb-3">
              <h1 className="admin-large-title text-zinc-900 dark:text-zinc-100">Inbox</h1>
            </div>
            <div className="px-4 pb-6 flex-1">
              <InboxList
                selectedReportId={route.reportId}
                refreshNonce={refreshNonce + listRefreshNonce}
                isOnline={isOnline}
                onSelectReport={(report) => {
                  setSelectedReportCache(report);
                  pushRoute(`#/admin/inbox/${encodeURIComponent(report.id)}`);
                }}
              />
            </div>
          </div>

          {/* Detail pane */}
          <div
            className={`${
              hasDetail ? 'flex' : 'hidden md:flex'
            } flex-1 min-w-0 flex-col md:h-full md:overflow-y-auto`}
          >
            {route.reportId ? (
              <div key={route.reportId} className="min-h-full admin-push-forward">
                <ErrorBoundary
                  variant="inline"
                  title="Could not load inbox report"
                  subtitle="A network or rendering issue interrupted this panel"
                  resetKeys={[route.reportId, refreshNonce]}
                  onRetry={() => setRefreshNonce((n) => n + 1)}
                >
                  <Suspense fallback={detailSuspenseFallback}>
                    <InboxDetail
                      reportId={route.reportId}
                      cachedSummary={cachedReport}
                      isOnline={isOnline}
                      refreshNonce={refreshNonce}
                      onBack={goUp}
                      onReportUpdated={handleReportUpdated}
                    />
                  </Suspense>
                </ErrorBoundary>
              </div>
            ) : (
              <div className="hidden md:flex flex-1 items-center justify-center p-6">
                <EmptyState
                  icon={<Inbox className="w-5 h-5" />}
                  message="Select a report"
                  className="max-w-sm w-full"
                />
              </div>
            )}
          </div>
        </div>
      );
    }

    // More tab & sub-pages
    return (
      <div
        key={`more-${route.moreSection || 'root'}`}
        className={`w-full max-w-[760px] lg:max-w-[900px] mx-auto md:px-6 md:py-4 pb-6 ${transitionClass}`}
      >
        <MoreView
          section={route.moreSection}
          adminEmail={admin.email}
          lockoutsCount={overview?.lockouts_24h ?? 0}
          isOnline={isOnline}
          isRefreshing={isLoadingOverview}
          refreshNonce={refreshNonce}
          onNavigateSection={(sec) => pushRoute(`#/admin/more/${sec}`)}
          onBack={goUp}
          onRefresh={handleManualRefresh}
          onDataChanged={loadOverview}
          onBackToApp={handleBackToApp}
          onLock={() => void handleLock()}
        />
      </div>
    );
  };

  return (
    <div
      data-admin-hidden={isDocHidden ? 'true' : 'false'}
      className="min-h-[100dvh] h-[100dvh] w-full flex flex-col bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 overflow-hidden"
    >
      {/* Slim Offline Strip */}
      {!isOnline && (
        <div
          role="status"
          className="w-full shrink-0 bg-orange-500/15 border-b border-orange-500/30 text-orange-800 dark:text-orange-300 admin-caption font-medium px-4 py-2 flex items-center justify-center gap-2"
        >
          <WifiOff className="w-3.5 h-3.5 shrink-0" />
          <span>Offline: admin actions are paused.</span>
        </div>
      )}

      {/* Responsive Workspace Shell */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        {/* Tablet (72px) & Desktop (220px) Left Navigation Rail */}
        <aside
          aria-label="Admin navigation rail"
          className="hidden md:flex md:w-[72px] lg:w-[220px] shrink-0 flex-col justify-between bg-white dark:bg-zinc-900 border-r border-zinc-200 dark:border-zinc-800 py-4 px-2 lg:px-3"
        >
          <div className="space-y-4">
            {/* Brand mark */}
            <div className="flex items-center justify-center lg:justify-start gap-2.5 px-1 lg:px-2 min-h-[44px]">
              <div className="w-9 h-9 rounded-xl bg-violet-600/15 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div className="hidden lg:block min-w-0">
                <p className="admin-body font-semibold text-zinc-900 dark:text-zinc-100 truncate leading-tight">
                  Admin
                </p>
                <p className="admin-caption text-zinc-500 dark:text-zinc-400 truncate">
                  {admin.email}
                </p>
              </div>
            </div>

            {/* Rail items with ONE sliding indicator pill */}
            <nav aria-label="Admin sections" className="relative flex flex-col">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute left-0 right-0 h-[56px] lg:h-[44px] rounded-xl bg-violet-600/12 dark:bg-violet-500/15 admin-slide-transform"
                style={{
                  transform: `translateY(${activeNavIndex * 100}%)`,
                }}
              />

              {navItems.map((item) => {
                const Icon = item.icon;
                const isActive = route.tab === item.key;
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => {
                      triggerHaptic('light');
                      switchTab(item.key);
                    }}
                    className={`admin-press relative z-10 h-[56px] lg:h-[44px] px-1 lg:px-3 rounded-xl flex flex-col lg:flex-row items-center justify-center lg:justify-between gap-1 lg:gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer ${
                      isActive
                        ? 'text-violet-600 dark:text-violet-400 font-semibold'
                        : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 font-medium'
                    }`}
                  >
                    <div className="flex flex-col lg:flex-row items-center gap-0.5 lg:gap-2.5 min-w-0">
                      <div className="relative shrink-0">
                        <Icon className="w-6 h-6 lg:w-[18px] lg:h-[18px]" />
                        {typeof item.badge === 'number' && item.badge > 0 && (
                          <span className="lg:hidden absolute -top-1 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-violet-600 text-white text-[9px] font-semibold tabular-nums flex items-center justify-center">
                            {item.badge > 99 ? '99+' : item.badge}
                          </span>
                        )}
                      </div>
                      <span className="text-[10px] lg:text-[14px] leading-tight truncate">
                        {item.label}
                      </span>
                    </div>

                    {typeof item.badge === 'number' && item.badge > 0 && (
                      <span className="hidden lg:inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-violet-600/15 text-violet-600 dark:text-violet-400 text-[11px] font-semibold tabular-nums shrink-0">
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Rail Footer (>=768px): Theme, Back to app, Lock */}
          <div className="space-y-1 pt-3 border-t border-zinc-200 dark:border-zinc-800">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setTheme(isDark ? 'light' : 'dark');
              }}
              aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
              className="admin-press w-full min-h-[44px] px-2 lg:px-3 rounded-xl flex items-center justify-center lg:justify-start gap-2.5 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              {isDark ? <Sun className="w-[18px] h-[18px] shrink-0" /> : <Moon className="w-[18px] h-[18px] shrink-0" />}
              <span className="hidden lg:inline text-[14px] font-medium truncate">
                {isDark ? 'Light mode' : 'Dark mode'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                handleBackToApp();
              }}
              aria-label="Back to app"
              className="admin-press w-full min-h-[44px] px-2 lg:px-3 rounded-xl flex items-center justify-center lg:justify-start gap-2.5 text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              <ArrowLeft className="w-[18px] h-[18px] shrink-0" />
              <span className="hidden lg:inline text-[14px] font-medium truncate">
                Back to app
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                void handleLock();
              }}
              aria-label="Lock admin console"
              className="admin-press w-full min-h-[44px] px-2 lg:px-3 rounded-xl flex items-center justify-center lg:justify-start gap-2.5 text-red-600 dark:text-red-400 hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              <Lock className="w-[18px] h-[18px] shrink-0" />
              <span className="hidden lg:inline text-[14px] font-medium truncate">
                Lock
              </span>
            </button>
          </div>
        </aside>

        {/* Main Viewport */}
        <PullToRefresh
          onRefresh={handleManualRefresh}
          disabled={!isOnline}
          accentColor="violet"
          className="flex-1 min-h-0 overflow-y-auto"
        >
          <main className="min-h-full md:h-full pb-20 md:pb-0">
            {renderMainContent()}
          </main>
        </PullToRefresh>
      </div>

      {/* Mobile Bottom Navigation Bar (<768px) */}
      <nav
        aria-label="Mobile admin navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="relative grid grid-cols-4 min-h-[56px] px-1">
          {/* ONE sliding indicator pill */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 bottom-1.5 left-1 w-[calc((100%-8px)/4)] px-1 admin-slide-transform"
            style={{
              transform: `translateX(${activeNavIndex * 100}%)`,
            }}
          >
            <div className="w-full h-full rounded-xl bg-violet-600/12 dark:bg-violet-500/15" />
          </div>

          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = route.tab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                aria-current={isActive ? 'page' : undefined}
                onClick={() => {
                  triggerHaptic('light');
                  switchTab(item.key);
                }}
                className={`admin-press relative z-10 min-h-[56px] flex flex-col items-center justify-center gap-0.5 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer ${
                  isActive
                    ? 'text-violet-600 dark:text-violet-400'
                    : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                <div className="relative">
                  <Icon className="w-6 h-6" />
                  {typeof item.badge === 'number' && item.badge > 0 && (
                    <span className="absolute -top-1 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-violet-600 text-white text-[10px] font-semibold tabular-nums flex items-center justify-center">
                      {item.badge > 99 ? '99+' : item.badge}
                    </span>
                  )}
                </div>
                <span className="text-[11px] leading-[14px] font-medium whitespace-nowrap">
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      <AdminToastHost />
    </div>
  );
}
