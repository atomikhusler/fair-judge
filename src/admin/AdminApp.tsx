import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Lock,
  RefreshCw,
  ShieldCheck,
  LayoutGrid,
  Building2,
  Inbox,
  Megaphone,
  ShieldAlert,
  History,
} from 'lucide-react';
import { adminService, AdminOverview, AdminOrgFilter } from './adminService';
import { SignIn } from './SignIn';
import { OverviewTab, AdminTabKey } from './OverviewTab';
import { OrgsTab } from './OrgsTab';
import { InboxTab } from './InboxTab';
import { NoticesTab } from './NoticesTab';
import { AlertsTab } from './AlertsTab';
import { ActivityLogSheet } from './ActivityLogSheet';
import { ThemeToggleButton } from '../lib/theme';
import { PullToRefresh } from '../components/common/PullToRefresh';
import { triggerHaptic } from '../lib/haptics';

interface AdminAppProps {
  onExit: () => void;
}

const IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes inactivity
const HIDDEN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes hidden tab
const STALE_VISIBLE_REFRESH_MS = 60 * 1000; // > 60s background triggers auto-refresh

export function AdminApp({ onExit }: AdminAppProps) {
  const [admin, setAdmin] = useState<{ email: string; userId: string } | null>(null);
  const [isCheckingSession, setIsCheckingSession] = useState(true);
  const [isLocking, setIsLocking] = useState(false);

  const [activeTab, setActiveTab] = useState<AdminTabKey>('overview');
  const [orgFilterPreset, setOrgFilterPreset] = useState<AdminOrgFilter>('all');

  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [isLoadingOverview, setIsLoadingOverview] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [isAuditOpen, setIsAuditOpen] = useState(false);

  const idleTimerRef = useRef<number | null>(null);
  const hiddenSinceRef = useRef<number | null>(null);
  const hiddenTimerRef = useRef<number | null>(null);
  const lastRefreshAtRef = useRef<number>(0);

  const loadOverview = useCallback(async () => {
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
    setRefreshNonce((n) => n + 1);
    await loadOverview();
  }, [loadOverview]);

  const handleLock = useCallback(async () => {
    if (isLocking) return;
    setIsLocking(true);
    try {
      await adminService.signOut();
    } finally {
      setAdmin(null);
      setOverview(null);
      setOverviewError(null);
      setIsAuditOpen(false);
      setIsLocking(false);
    }
  }, [isLocking]);

  // Initial check (memory-only session)
  useEffect(() => {
    let active = true;
    adminService
      .checkSession()
      .then((res) => {
        if (active) setAdmin(res);
      })
      .finally(() => {
        if (active) setIsCheckingSession(false);
      });

    return () => {
      active = false;
    };
  }, []);

  // Load overview once on sign-in
  useEffect(() => {
    if (admin) {
      void loadOverview();
    }
  }, [admin, loadOverview]);

  // Auto-signout on 15m inactivity / 5m hidden tab + battery-friendly >60s tab-return refresh
  useEffect(() => {
    if (!admin) return;

    const resetIdleTimer = () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => {
        void handleLock();
      }, IDLE_TIMEOUT_MS);
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenSinceRef.current = Date.now();
        if (hiddenTimerRef.current !== null) {
          window.clearTimeout(hiddenTimerRef.current);
        }
        hiddenTimerRef.current = window.setTimeout(() => {
          void handleLock();
        }, HIDDEN_TIMEOUT_MS);
      } else {
        if (hiddenTimerRef.current !== null) {
          window.clearTimeout(hiddenTimerRef.current);
          hiddenTimerRef.current = null;
        }
        const hiddenElapsed = hiddenSinceRef.current ? Date.now() - hiddenSinceRef.current : 0;
        hiddenSinceRef.current = null;

        if (hiddenElapsed >= HIDDEN_TIMEOUT_MS) {
          void handleLock();
          return;
        }

        // Battery rule: refresh only when returning after > 60 seconds away
        if (Date.now() - lastRefreshAtRef.current > STALE_VISIBLE_REFRESH_MS) {
          void handleManualRefresh();
        }
        resetIdleTimer();
      }
    };

    const activityEvents: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'scroll'];
    activityEvents.forEach((evt) => window.addEventListener(evt, resetIdleTimer, { passive: true }));
    document.addEventListener('visibilitychange', handleVisibilityChange);
    resetIdleTimer();

    return () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
      if (hiddenTimerRef.current !== null) window.clearTimeout(hiddenTimerRef.current);
      activityEvents.forEach((evt) => window.removeEventListener(evt, resetIdleTimer));
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [admin, handleLock, handleManualRefresh]);

  const handleExit = async () => {
    if (admin) {
      await handleLock();
    }
    onExit();
  };

  const handleNavigateTab = (tab: AdminTabKey, filter?: AdminOrgFilter) => {
    if (filter) setOrgFilterPreset(filter);
    setActiveTab(tab);
  };

  if (isCheckingSession) {
    return (
      <div className="min-h-[100dvh] w-full flex items-center justify-center bg-stone-50 dark:bg-black text-zinc-500 dark:text-zinc-400">
        <RefreshCw className="w-5 h-5 text-violet-500 animate-spin" />
      </div>
    );
  }

  if (!admin) {
    return (
      <SignIn
        onSignedIn={(signedInAdmin) => setAdmin(signedInAdmin)}
        onExit={onExit}
      />
    );
  }

  const tabs: Array<{
    key: AdminTabKey;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    count?: number;
  }> = [
    { key: 'overview', label: 'Overview', icon: LayoutGrid },
    { key: 'orgs', label: 'Orgs', icon: Building2, count: overview?.pending_orgs || undefined },
    { key: 'inbox', label: 'Inbox', icon: Inbox, count: overview?.new_reports || undefined },
    { key: 'notices', label: 'Notices', icon: Megaphone },
    { key: 'alerts', label: 'Alerts', icon: ShieldAlert, count: overview?.lockouts_24h || undefined },
  ];

  return (
    <div className="min-h-[100dvh] w-full flex flex-col bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 bg-white dark:bg-zinc-900 border-b border-stone-200 dark:border-zinc-800 pt-[max(env(safe-area-inset-top),0px)]">
        <div className="max-w-4xl mx-auto px-3 sm:px-5 h-14 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-violet-500/15 border border-violet-500/30 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold tracking-tight truncate">Super Admin</h1>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">{admin.email}</p>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('tick');
                void handleManualRefresh();
              }}
              aria-label="Refresh admin data"
              className="min-h-[44px] min-w-[44px] rounded-xl hover:bg-stone-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${isLoadingOverview ? 'animate-spin text-violet-500' : ''}`} />
            </button>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('tick');
                setIsAuditOpen(true);
              }}
              aria-label="Open activity log"
              className="min-h-[44px] min-w-[44px] rounded-xl hover:bg-stone-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-300 flex items-center justify-center transition-colors cursor-pointer"
            >
              <History className="w-4 h-4" />
            </button>

            <ThemeToggleButton />

            <button
              type="button"
              onClick={() => {
                triggerHaptic('tick');
                void handleExit();
              }}
              aria-label="Lock and exit admin console"
              className="min-h-[44px] px-3 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-800 dark:text-zinc-200 inline-flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Lock className="w-3.5 h-3.5 text-violet-500" />
              <span className="whitespace-nowrap">Lock</span>
            </button>
          </div>
        </div>

        {/* Desktop / Tablet Tab Strip */}
        <nav
          aria-label="Admin sections"
          className="hidden sm:flex max-w-4xl mx-auto px-5 gap-1 border-t border-stone-200/80 dark:border-zinc-800/80"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  triggerHaptic('tick');
                  setActiveTab(tab.key);
                }}
                className={`min-h-[44px] px-3.5 inline-flex items-center gap-2 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  isActive
                    ? 'border-violet-500 text-violet-600 dark:text-violet-400'
                    : 'border-transparent text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
                {typeof tab.count === 'number' && tab.count > 0 && (
                  <span className="text-[11px] font-bold tabular-nums text-violet-600 dark:text-violet-400">
                    ({tab.count})
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Main Scrollable Viewport with Pull-to-Refresh */}
      <PullToRefresh
        onRefresh={handleManualRefresh}
        accentColor="violet"
        className="flex-1 overflow-y-auto"
      >
        <main className="max-w-4xl w-full mx-auto px-3 sm:px-5 pt-4 pb-24 sm:pb-10">
          {activeTab === 'overview' && (
            <OverviewTab
              overview={overview}
              isLoading={isLoadingOverview}
              error={overviewError}
              onRefresh={handleManualRefresh}
              onNavigateTab={handleNavigateTab}
            />
          )}

          {activeTab === 'orgs' && (
            <OrgsTab
              initialFilter={orgFilterPreset}
              refreshNonce={refreshNonce}
              onDataChanged={loadOverview}
            />
          )}

          {activeTab === 'inbox' && (
            <InboxTab
              refreshNonce={refreshNonce}
              onDataChanged={loadOverview}
            />
          )}

          {activeTab === 'notices' && (
            <NoticesTab
              refreshNonce={refreshNonce}
              onDataChanged={loadOverview}
            />
          )}

          {activeTab === 'alerts' && (
            <AlertsTab
              refreshNonce={refreshNonce}
              onDataChanged={loadOverview}
            />
          )}
        </main>
      </PullToRefresh>

      {/* Mobile Bottom Tab Bar */}
      <nav
        aria-label="Mobile admin navigation"
        className="sm:hidden fixed bottom-0 left-0 right-0 z-30 bg-white dark:bg-zinc-900 border-t border-stone-200 dark:border-zinc-800 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="grid grid-cols-5 h-15">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  triggerHaptic('tick');
                  setActiveTab(tab.key);
                }}
                className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer relative ${
                  isActive
                    ? 'text-violet-600 dark:text-violet-400'
                    : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {typeof tab.count === 'number' && tab.count > 0 && (
                    <span className="absolute -top-1 -right-2.5 text-[10px] font-bold tabular-nums text-violet-600 dark:text-violet-400">
                      {tab.count > 99 ? '99+' : tab.count}
                    </span>
                  )}
                </div>
                <span className="text-[10px] font-semibold tracking-tight whitespace-nowrap">
                  {tab.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Activity Log Sheet (B6) */}
      {isAuditOpen && (
        <ActivityLogSheet onClose={() => setIsAuditOpen(false)} />
      )}
    </div>
  );
}
