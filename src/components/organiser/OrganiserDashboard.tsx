import React, { useState, useEffect, useCallback, useRef } from 'react';
import { 
  Menu, 
  CircleUser, 
  Scale, 
  Radio, 
  CalendarDays, 
  Users, 
  BarChart3,
  AlertTriangle,
  XCircle,
  CheckCircle2,
  Mail,
  Send,
  X
} from 'lucide-react';
import { Organization } from '../../lib/supabaseTypes';
import { dbService, subscribeToDatabase, getStoredSession, setStoredSession, invalidateCache } from '../../lib/supabase';
import { flushOfflineQueueToSupabase } from '../../lib/offlineQueue';
import { eventBus } from '../../lib/eventBus';
import { SettingsDrawer } from './SettingsDrawer';
import { AccountModal } from './AccountModal';
import { PullToRefresh } from '../common/PullToRefresh';
import { TabProgressFallback } from '../common/Skeletons';
import { triggerHaptic } from '../../lib/haptics';
import { lazyWithRetry } from '../../lib/lazyWithRetry';
import {
  PlatformAnnouncement,
  fetchActiveAnnouncements,
  dismissNotice,
} from '../../lib/announcements';
import { AnnouncementBanner } from '../common/AnnouncementBanner';
import { OrgBlockedScreen } from '../common/OrgBlockedScreen';
import { showToast } from '../common/ToastProvider';
import { getOrgEnforcementMessage } from '../../lib/orgEnforcement';

// Code Splitting: Asynchronously load organiser tabs with auto-retry resilience
const LiveTab = lazyWithRetry(() => import('./tabs/LiveTab').then((m) => ({ default: m.LiveTab })), 'live');
const EventsTab = lazyWithRetry(() => import('./tabs/EventsTab').then((m) => ({ default: m.EventsTab })), 'events');
const PeopleTab = lazyWithRetry(() => import('./tabs/PeopleTab').then((m) => ({ default: m.PeopleTab })), 'people');
const InsightsTab = lazyWithRetry(() => import('./tabs/InsightsTab').then((m) => ({ default: m.InsightsTab })), 'insights');

export type OrganiserNavTab = 'live' | 'events' | 'people' | 'insights';

interface OrganiserDashboardProps {
  organization: Organization;
  onLogout: () => void;
  onOpenPublicView: (eventId?: string) => void;
  onSwitchToJudgeView?: () => void;
  mustChangePassword?: boolean;
  onPasswordChanged?: () => void;
}

function areOrganizationsEqual(a: Organization, b: Organization): boolean {
  if (a === b) return true;
  return (
    a.id === b.id &&
    a.org_id === b.org_id &&
    a.name === b.name &&
    a.email === b.email &&
    a.verification_status === b.verification_status &&
    a.rejection_reason === b.rejection_reason &&
    a.suspended === b.suspended &&
    a.suspended_reason === b.suspended_reason &&
    a.deleted_at === b.deleted_at &&
    a.tie_breaker_enabled === b.tie_breaker_enabled &&
    a.tie_breaker_method === b.tie_breaker_method &&
    a.blind_judging_enabled === b.blind_judging_enabled &&
    a.auto_advance_enabled === b.auto_advance_enabled &&
    a.grace_period_enabled === b.grace_period_enabled &&
    a.isolated_jury_enabled === b.isolated_jury_enabled
  );
}

export function OrganiserDashboard({
  organization: initialOrg,
  onLogout,
  onOpenPublicView,
  mustChangePassword = false,
  onPasswordChanged,
}: OrganiserDashboardProps) {
  const [organization, setOrganization] = useState<Organization>(initialOrg);
  const [activeTab, setActiveTab] = useState<OrganiserNavTab>('live');

  // Modals, Drawers & UI State
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(mustChangePassword);
  const [isBannerDismissed, setIsBannerDismissed] = useState(false);
  const [announcements, setAnnouncements] = useState<PlatformAnnouncement[]>([]);
  const [blockedMode, setBlockedMode] = useState<'suspended' | 'deleted' | null>(null);

  const verificationStatus = organization.verification_status || 'pending';

  // Stable refs for mutable values to prevent dependency cycling & infinite loops
  const orgIdRef = useRef(organization.org_id);
  const statusRef = useRef(organization.verification_status);
  const onLogoutRef = useRef(onLogout);

  useEffect(() => {
    orgIdRef.current = organization.org_id;
    statusRef.current = organization.verification_status;
  }, [organization.org_id, organization.verification_status]);

  useEffect(() => {
    onLogoutRef.current = onLogout;
  }, [onLogout]);

  // Stage A4: Prefetch all lazy tab chunks once after first paint
  useEffect(() => {
    const prefetchTabs = () => {
      import('./tabs/LiveTab');
      import('./tabs/EventsTab');
      import('./tabs/PeopleTab');
      import('./tabs/InsightsTab');
    };

    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      const handle = (window as any).requestIdleCallback(prefetchTabs);
      return () => {
        if ('cancelIdleCallback' in window) {
          (window as any).cancelIdleCallback(handle);
        }
      };
    } else {
      const timer = setTimeout(prefetchTabs, 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  // Sync organization status with deduplication and stable callback reference
  const syncOrganizationStatus = useCallback(async () => {
    const currentOrgId = orgIdRef.current;
    if (!currentOrgId) return;

    try {
      const freshOrg = await dbService.getOrganizationByOrgId(currentOrgId);
      if (!freshOrg) {
        // Organization was deleted by Admin/Security Team
        onLogoutRef.current();
        return;
      }

      setOrganization((prev) => {
        if (areOrganizationsEqual(prev, freshOrg)) {
          return prev;
        }
        setStoredSession({
          role: 'organiser',
          org: freshOrg,
          sessionToken: getStoredSession()?.sessionToken,
        });
        return freshOrg;
      });

      // Only transition banner dismiss state when verification_status actually changed
      if (freshOrg.verification_status !== statusRef.current) {
        statusRef.current = freshOrg.verification_status;
        setIsBannerDismissed(false);
      }
    } catch (err) {
      console.warn('Could not sync organization status:', err);
    }
  }, []);

  const loadAnnouncements = useCallback(async () => {
    const items = await fetchActiveAnnouncements('organiser', orgIdRef.current);
    setAnnouncements(items);
  }, []);

  useEffect(() => {
    void loadAnnouncements();
  }, [loadAnnouncements, organization.org_id]);

  // Open AccountModal automatically when forced temporary password change is required
  useEffect(() => {
    if (mustChangePassword) {
      setIsAccountModalOpen(true);
    }
  }, [mustChangePassword]);

  // Listen for runtime org enforcement events (SUSPENDED / DELETED / NOT_VERIFIED)
  useEffect(() => {
    const unsub = eventBus.on('org_enforcement', ({ code }) => {
      if (code === 'DELETED') {
        setBlockedMode('deleted');
      } else if (code === 'SUSPENDED') {
        setBlockedMode('suspended');
      } else if (code === 'NOT_VERIFIED') {
        showToast(getOrgEnforcementMessage('NOT_VERIFIED'), 'warning', 4500);
      }
    });
    return unsub;
  }, []);

  // Singleton Supabase Realtime subscription lifecycle - mounts once and cleans up on unmount
  useEffect(() => {
    syncOrganizationStatus();
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const unsub = subscribeToDatabase((table) => {
      // Debounce and only trigger organization status check if organization changed
      if (table === 'organizations') {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          syncOrganizationStatus();
        }, 300);
      }
    });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      unsub();
    };
  }, [syncOrganizationStatus]);

  const handleUpdateOrganization = (updated: Organization) => {
    setOrganization(updated);
    setStoredSession({
      role: 'organiser',
      org: updated,
      sessionToken: getStoredSession()?.sessionToken,
    });
  };

  // Full cloud refresh triggered by PullToRefresh (bypasses 5-minute cache throttle)
  const handleManualPullRefresh = async () => {
    invalidateCache();
    await flushOfflineQueueToSupabase();
    await Promise.all([
      syncOrganizationStatus(),
      loadAnnouncements(),
      dbService.getEvents(organization.org_id, true),
      dbService.getParticipants(organization.org_id, true),
      dbService.getJudges(organization.org_id, true),
      dbService.getAllScores(true),
    ]);
    eventBus.emit('cache_updated', { table: 'all' });
  };

  // Tab definitions
  const navTabs: Array<{ id: OrganiserNavTab; label: string; icon: React.ElementType }> = [
    { id: 'live', label: 'Live', icon: Radio },
    { id: 'events', label: 'Events', icon: CalendarDays },
    { id: 'people', label: 'People', icon: Users },
    { id: 'insights', label: 'Insights', icon: BarChart3 },
  ];

  const isOrgDeleted = Boolean(organization.deleted_at) || blockedMode === 'deleted';
  const isOrgSuspended = Boolean(organization.suspended) || blockedMode === 'suspended';

  if (isOrgDeleted || isOrgSuspended) {
    return (
      <OrgBlockedScreen
        mode={isOrgDeleted ? 'deleted' : 'suspended'}
        orgName={organization.name}
        orgId={organization.org_id}
        reason={organization.suspended_reason}
        onLogout={onLogout}
      />
    );
  }

  return (
    <div className="h-[100dvh] w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col justify-between overflow-hidden transition-colors duration-200 relative select-none">
      
      {/* ======================================================== */}
      {/* 1. THE TOP HEADER (Framer-Grade Premium Navigation)     */}
      {/* ======================================================== */}
      <header className="h-[10dvh] min-h-[72px] max-h-[90px] shrink-0 bg-white dark:bg-zinc-950 border-b border-stone-200 dark:border-zinc-800/80 flex items-center justify-between px-3 sm:px-4 transition-colors z-30">
        
        {/* Left: Hamburger Menu Icon */}
        <button
          type="button"
          onClick={() => setIsDrawerOpen(true)}
          className="w-12 h-12 rounded-2xl text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-900 transition-all duration-200 active:scale-[0.96] flex items-center justify-center cursor-pointer"
          aria-label="Open Navigation Drawer"
        >
          <Menu className="w-5 h-5 stroke-[2.2]" />
        </button>

        {/* Center: Branding & Organisation Name */}
        <div className="flex-1 min-w-0 flex flex-col items-center justify-center text-center px-2">
          {/* Top Line: App Logo + Fair Judge */}
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 sm:w-7 sm:h-7 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500 shadow-sm shadow-emerald-500/20">
              <Scale className="w-3.5 h-3.5 sm:w-4 sm:h-4 stroke-[2.5]" />
            </div>
            <span className="text-base sm:text-lg font-black tracking-tight text-zinc-900 dark:text-white">
              Fair Judge
            </span>
          </div>

          {/* Bottom Line: Actual Organisation Name + Verified Tick */}
          <div className="flex items-center space-x-1 mt-0.5 max-w-full justify-center">
            <span className="text-[11px] sm:text-xs font-bold text-zinc-700 dark:text-zinc-300 tracking-wide uppercase truncate max-w-[180px] sm:max-w-xs md:max-w-sm">
              {organization.name}
            </span>
            {verificationStatus === 'verified' && (
              <span title="Verified Organization" className="inline-flex shrink-0">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
              </span>
            )}
          </div>
        </div>

        {/* Right: Account Modal Icon */}
        <button
          type="button"
          onClick={() => setIsAccountModalOpen(true)}
          className="relative w-12 h-12 rounded-2xl text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-900 transition-all duration-200 active:scale-[0.96] flex items-center justify-center cursor-pointer"
          aria-label="Open Account Settings"
        >
          <CircleUser className="w-5 h-5 stroke-[2.2]" />
          {verificationStatus !== 'verified' && (
            <span
              className={`absolute top-2.5 right-2.5 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-zinc-950 ${
                verificationStatus === 'rejected' ? 'bg-red-500 animate-ping' : 'bg-amber-500'
              }`}
            />
          )}
        </button>
      </header>

      <AnnouncementBanner
        notices={announcements}
        onDismiss={(id) => {
          dismissNotice(id);
          setAnnouncements((prev) => prev.filter((n) => n.id !== id));
        }}
      />

      {/* ======================================================== */}
      {/* 1.5 VERIFICATION STATUS BANNER (PENDING OR REJECTED)     */}
      {/* ======================================================== */}
      {verificationStatus === 'pending' && !isBannerDismissed && (
        <div
          onClick={() => setIsAccountModalOpen(true)}
          className="shrink-0 bg-amber-500/10 dark:bg-amber-500/15 border-b border-amber-500/30 px-4 py-2 flex items-center justify-between gap-3 cursor-pointer hover:bg-amber-500/15 transition-colors z-20 animate-in slide-in-from-top-2 duration-300"
        >
          <div className="flex items-center space-x-2.5 min-w-0">
            <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
            <p className="text-[11px] font-semibold text-amber-800 dark:text-amber-200 leading-snug">
              <span className="font-bold uppercase tracking-wider mr-1">Account Under Verification:</span>
              Your account &amp; email ({organization.email || 'no email set'}) are being reviewed. Unverified accounts may be deleted if rejected by the Security Team.
            </p>
          </div>
          <div className="flex items-center space-x-1.5 shrink-0">
            <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-700 dark:text-amber-300">
              Details
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation(); // Prevent opening the modal
                setIsBannerDismissed(true);
              }}
              className="p-1 rounded-full text-amber-600/60 hover:text-amber-600 hover:bg-amber-500/20 dark:text-amber-400/60 dark:hover:text-amber-400 transition-colors cursor-pointer"
              aria-label="Dismiss banner"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {verificationStatus === 'rejected' && !isBannerDismissed && (
        <div className="shrink-0 bg-red-500/15 dark:bg-red-950/60 border-b border-red-500/40 px-4 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 z-20 animate-in slide-in-from-top-2 duration-300">
          <div className="flex items-start sm:items-center space-x-2.5 min-w-0 pr-6 relative">
            <XCircle className="w-4 h-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5 sm:mt-0" />
            <p className="text-[11px] font-bold text-red-700 dark:text-red-300 leading-snug pr-2">
              {organization.rejection_reason
                ? `Verification rejected: ${organization.rejection_reason}`
                : 'Email verification failed! Your organization is scheduled for deletion. Contact Developer immediately:'}
            </p>
            {/* Mobile-only dismiss button (positioned absolutely top right if wrapping occurs) */}
            <button
              type="button"
              onClick={() => setIsBannerDismissed(true)}
              className="absolute top-0 right-0 sm:hidden p-1 -mr-2 -mt-1 rounded-full text-red-600/60 hover:text-red-600 hover:bg-red-500/20 transition-colors cursor-pointer"
              aria-label="Dismiss banner"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          
          <div className="flex items-center space-x-2 shrink-0 self-start sm:self-center">
            <a
              href="mailto:spesium.code@proton.me"
              className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-white dark:bg-zinc-900 border border-red-500/40 text-[10px] font-mono font-bold text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <Mail className="w-3 h-3" />
              <span>spesium.code@proton.me</span>
            </a>
            <a
              href="https://t.me/+ljTOKLi5dQs1MTM9"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center space-x-1 px-2.5 py-1 rounded-lg bg-blue-600 text-white text-[10px] font-bold hover:bg-blue-500 transition-colors"
            >
              <Send className="w-3 h-3" />
              <span>Telegram Group</span>
            </a>
            
            {/* Desktop-only dismiss button */}
            <button
              type="button"
              onClick={() => setIsBannerDismissed(true)}
              className="hidden sm:flex p-1 ml-1 rounded-full text-red-600/60 hover:text-red-600 hover:bg-red-500/20 dark:text-red-400/60 dark:hover:text-red-400 transition-colors cursor-pointer"
              aria-label="Dismiss banner"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* 2. THE HAMBURGER MENU (Strictly Unmounted When Closed)  */}
      {/* ======================================================== */}
      {isDrawerOpen ? (
        <SettingsDrawer
          isOpen={isDrawerOpen}
          onClose={() => setIsDrawerOpen(false)}
          organization={organization}
          onUpdateOrganization={handleUpdateOrganization}
          onOpenPublicView={onOpenPublicView}
        />
      ) : null}

      {/* ======================================================== */}
      {/* 3. THE ACCOUNT MODAL (Identity & Security)              */}
      {/* ======================================================== */}
      {isAccountModalOpen ? (
        <AccountModal
          isOpen={isAccountModalOpen}
          onClose={() => setIsAccountModalOpen(false)}
          organization={organization}
          onUpdateOrganization={handleUpdateOrganization}
          onLogout={onLogout}
          mustChangePassword={mustChangePassword}
          onPasswordChanged={onPasswordChanged}
        />
      ) : null}

      {/* ======================================================== */}
      {/* MAIN VIEW CONTENT AREA (With Pull-To-Refresh Sync)       */}
      {/* ======================================================== */}
      <PullToRefresh
        onRefresh={handleManualPullRefresh}
        className="flex-1 flex flex-col overflow-hidden max-w-4xl w-full mx-auto relative animate-fade-in"
      >
        <div
          key={activeTab}
          className="w-full h-full flex-1 flex flex-col overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-[250ms] ease-out will-change-transform"
        >
          <React.Suspense fallback={<TabProgressFallback />}>
            {/* Tab 1: Live Control Room */}
            {activeTab === 'live' && (
              <LiveTab
                organization={organization}
                onOpenPublicView={onOpenPublicView}
              />
            )}

            {/* Tab 2: Events Engine & Management View */}
            {activeTab === 'events' && (
              <EventsTab
                organization={organization}
                onOpenPublicView={onOpenPublicView}
                onNavigateToLiveControl={() => setActiveTab('live')}
              />
            )}

            {/* Tab 3: People View */}
            {activeTab === 'people' && (
              <PeopleTab organization={organization} />
            )}

            {/* Tab 4: Insights View */}
            {activeTab === 'insights' && (
              <InsightsTab organization={organization} />
            )}
          </React.Suspense>
        </div>
      </PullToRefresh>

      {/* ======================================================== */}
      {/* 4. THE 4-TAB BOTTOM NAVIGATION SHELL (Framer-Grade)     */}
      {/* ======================================================== */}
      <nav className="fixed bottom-0 left-0 w-full h-[8dvh] min-h-[64px] pb-safe bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl border-t border-stone-200 dark:border-zinc-800/80 flex items-center justify-around px-2 sm:px-6 select-none z-40">
        {navTabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                triggerHaptic('tap');
                setActiveTab(tab.id);
              }}
              className={`flex-1 min-h-[44px] flex flex-col items-center justify-center py-1 px-2 rounded-xl transition-all duration-300 ease-out hover:-translate-y-0.5 active:scale-[0.97] active:translate-y-0 cursor-pointer ${
                isActive
                  ? 'text-emerald-600 dark:text-emerald-400 font-bold'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <div
                className={`p-1 rounded-xl transition-all duration-200 ${
                  isActive ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : ''
                }`}
              >
                <Icon className="w-5 h-5 stroke-[2.2]" />
              </div>
              <span className="text-[10px] tracking-tight mt-0.5 font-medium">
                {tab.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
