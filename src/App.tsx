/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, Suspense, lazy } from 'react';
import { AuthScreen } from './components/auth/AuthScreen';
import { NetworkStatusIndicator } from './components/NetworkStatusIndicator';
import { ToastProvider } from './components/common/ToastProvider';
import { Organization, SupabaseJudge, SupabaseEvent } from './lib/supabaseTypes';
import {
  dbService,
  subscribeToDatabase,
  getStoredSession,
  setStoredSession,
  StoredUserSession,
  isSupabaseConfigured,
} from './lib/supabase';
import { SuperAdminSetupModal } from './components/auth/SuperAdminSetupModal';
import { initCacheStorage } from './lib/db/indexedDB';
import { initOfflineSyncListener, clearAllScoreDrafts } from './lib/offlineQueue';
import { areRecordsEqual, eventBus } from './lib/eventBus';
import { Scale } from 'lucide-react';
import { requestStoragePersistenceOnce } from './lib/storagePersistence';
import { scrubCachedPasswords } from './lib/authScrubber';
import { lazyWithRetry } from './lib/lazyWithRetry';
import { authService } from './lib/authService';
import { resetSignatureHardwareSession } from './components/shared/SignatureHardware';
import { resetLastTestResult } from './lib/selfTest';

// Code Splitting: Asynchronously load major route panels with auto-retry resilience
const OrganiserDashboard = lazyWithRetry(() =>
  import('./components/organiser/OrganiserDashboard').then((m) => ({ default: m.OrganiserDashboard })),
  'organiser'
);
const ScoringPanel = lazyWithRetry(() =>
  import('./components/judge/ScoringPanel').then((m) => ({ default: m.ScoringPanel })),
  'scoring'
);
const JudgeLobby = lazyWithRetry(() =>
  import('./components/judge/JudgeLobby').then((m) => ({ default: m.JudgeLobby })),
  'lobby'
);
const PublicLeaderboard = lazyWithRetry(() =>
  import('./components/public/PublicLeaderboard').then((m) => ({ default: m.PublicLeaderboard })),
  'public'
);
const AdminApp = lazyWithRetry(() =>
  import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })),
  'admin'
);

export type UserSession = StoredUserSession;

export default function App() {
  const [isBooting, setIsBooting] = useState(() => {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).get('view') !== 'public';
  });
  const [isBootFading, setIsBootFading] = useState(false);
  const [session, setSession] = useState<UserSession | null>(getStoredSession);
  const [judgeEvents, setJudgeEvents] = useState<SupabaseEvent[]>(() => {
    const s = getStoredSession();
    if (s?.role === 'judge' && s.org?.org_id) {
      const allEvents = dbService.getCachedEvents(s.org.org_id);
      let assigned = allEvents.filter(
        (e) =>
          (s.judge?.id && e.assigned_judges.includes(s.judge.id)) ||
          (s.judge?.assigned_events || []).includes(e.id)
      );
      if (assigned.length === 0) {
        assigned = allEvents.filter((e) => e.status === 'active');
      }
      return assigned;
    }
    return [];
  });
  const [activeJudgeEvent, setActiveJudgeEvent] = useState<SupabaseEvent | null>(null);

  const [isAdminRoute, setIsAdminRoute] = useState(false);

  // Public projector screen state
  const [isPublicView, setIsPublicView] = useState(false);
  const [publicOrgId, setPublicOrgId] = useState('');
  const [publicEventId, setPublicEventId] = useState<string | null>(null);

  // Transient Auth Splash State (EPIC 15.3 Target 1)
  const [authSplash, setAuthSplash] = useState<{
    name: string;
    isFading: boolean;
  } | null>(null);
  const authSplashTimerRef = useRef<{ hold?: number; fade?: number }>({});

  // Forced temporary password reset flag (set via org_login must_change)
  const [mustChangePassword, setMustChangePassword] = useState(false);

  // Smooth server-aware Sign-Out transition state
  const [signOutOverlay, setSignOutOverlay] = useState<{
    name: string;
    role: 'organiser' | 'judge';
    waitingOnServer: boolean;
    isFading: boolean;
  } | null>(null);
  const isSigningOutRef = useRef(false);
  const signOutTimersRef = useRef<{ wait?: number; fade?: number }>({});

  // Instant App Hydration
  useEffect(() => {
    let unsubSync: (() => void) | null = null;

    try {
      // Storage Eviction Defense: Protect queued scores & IndexedDB cache from browser eviction
      if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then((granted) => {
          try {
            localStorage.setItem('fj_storage_persisted', granted ? 'true' : 'false');
          } catch {}
        }).catch(() => {});
      }

      // Hydrate local cache and database state non-blockingly
      initCacheStorage().catch(() => {});
      scrubCachedPasswords().catch(() => {});
      unsubSync = initOfflineSyncListener();
    } catch (err) {
      console.warn('Boot sequence error:', err);
    }

    const handleSessionEvent = () => {
      const stored = getStoredSession();
      setSession(stored);
    };

    window.addEventListener('fairjudge_session_change', handleSessionEvent);

    if (window.location.hash.startsWith('#/admin')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    const handleHashChange = () => {
      if (window.location.hash.startsWith('#/admin')) {
        history.replaceState(null, '', window.location.pathname + window.location.search);
        setIsAdminRoute(true);
      }
    };
    window.addEventListener('hashchange', handleHashChange);

    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'public') {
      const orgParam = params.get('orgId');
      const eventParam = params.get('eventId');
      if (orgParam) setPublicOrgId(orgParam.toUpperCase());
      if (eventParam) setPublicEventId(eventParam);
      setIsPublicView(true);
    }

    const prefersReducedMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const bootHoldMs = prefersReducedMotion ? 250 : 1100;
    const bootFadeMs = prefersReducedMotion ? 150 : 420;
    let bootFadeTimer: number | undefined;
    let bootUnmountTimer: number | undefined;

    if (params.get('view') !== 'public') {
      bootFadeTimer = window.setTimeout(() => {
        setIsBootFading(true);
        bootUnmountTimer = window.setTimeout(() => {
          setIsBooting(false);
        }, bootFadeMs);
      }, bootHoldMs);
    }

    return () => {
      if (bootFadeTimer) clearTimeout(bootFadeTimer);
      if (bootUnmountTimer) clearTimeout(bootUnmountTimer);
      if (signOutTimersRef.current.wait) clearTimeout(signOutTimersRef.current.wait);
      if (signOutTimersRef.current.fade) clearTimeout(signOutTimersRef.current.fade);
      if (unsubSync) unsubSync();
      window.removeEventListener('fairjudge_session_change', handleSessionEvent);
      window.removeEventListener('hashchange', handleHashChange);
    };
  }, []);

  // Sync Judge events & Organization settings in real-time when a Judge session is active
  const refreshJudgeData = useCallback(async () => {
    if (session?.role !== 'judge' || !session.org?.org_id || !session.judge) return;

    try {
      const [allEvents, freshOrg] = await Promise.all([
        dbService.getEvents(session.org.org_id),
        dbService.getOrganizationByOrgId(session.org.org_id),
      ]);

      // Filter events assigned to this judge (or fallback to active events)
      let assigned = allEvents.filter(
        (e) =>
          e.assigned_judges.includes(session.judge!.id) ||
          (session.judge!.assigned_events || []).includes(e.id)
      );
      if (assigned.length === 0) {
        assigned = allEvents.filter((e) => e.status === 'active');
      }

      setJudgeEvents((prev) => (areRecordsEqual(prev, assigned) ? prev : assigned));

      // Keep activeJudgeEvent synchronized if the Organiser pauses/ends/updates it
      setActiveJudgeEvent((prev) => {
        if (!prev) return null;
        return allEvents.find((e) => e.id === prev.id) || prev;
      });

      // Keep Organization name & Jury rules synced if updated
      if (freshOrg && freshOrg.name !== session.org.name) {
        const updatedSession: UserSession = { ...session, org: freshOrg };
        setStoredSession(updatedSession);
      }
    } catch (err) {
      console.warn('Error refreshing judge session data:', err);
    }
  }, [session]);

  useEffect(() => {
    if (session?.role === 'judge') {
      refreshJudgeData();
      const unsubDb = subscribeToDatabase((table) => {
        if (table === 'events' || table === 'organizations' || table === 'all') {
          refreshJudgeData();
        }
      });
      const unsubEnforce = eventBus.on('org_enforcement', ({ code }) => {
        if (code === 'SUSPENDED' || code === 'DELETED') {
          setActiveJudgeEvent(null);
          refreshJudgeData();
        }
      });
      return () => {
        unsubDb();
        unsubEnforce();
      };
    }
  }, [session?.role, session?.org?.org_id, session?.judge?.id, refreshJudgeData]);

  // Helper to trigger hardware-accelerated 1.2s splash with 500ms opacity fade
  const triggerAuthSplash = useCallback((displayName: string) => {
    if (authSplashTimerRef.current.hold) clearTimeout(authSplashTimerRef.current.hold);
    if (authSplashTimerRef.current.fade) clearTimeout(authSplashTimerRef.current.fade);

    setAuthSplash({ name: displayName, isFading: false });

    // Hold for exactly 1.2 seconds, then transition out using opacity-0 duration-500
    authSplashTimerRef.current.hold = window.setTimeout(() => {
      setAuthSplash((prev) => (prev ? { ...prev, isFading: true } : null));

      // After 500ms fade completes, unmount splash
      authSplashTimerRef.current.fade = window.setTimeout(() => {
        setAuthSplash(null);
      }, 500);
    }, 1200);
  }, []);

  // Organiser Login Handler
  const handleOrganiserLogin = (org: Organization, sessionToken?: string, mustChange?: boolean) => {
    resetSignatureHardwareSession();
    resetLastTestResult();
    clearAllScoreDrafts();
    requestStoragePersistenceOnce();
    const newSession: UserSession = {
      role: 'organiser',
      org,
      sessionToken,
    };
    setMustChangePassword(Boolean(mustChange));
    setStoredSession(newSession);
    setSession(newSession);
    triggerAuthSplash(org.name || 'Organiser');
  };

  // Judge Login Handler - Fetches real Organization record & routes to JudgeLobby
  const handleJudgeLogin = async (
    orgId: string,
    judge: SupabaseJudge,
    assignedEvents: SupabaseEvent[],
    sessionToken?: string
  ) => {
    resetSignatureHardwareSession();
    resetLastTestResult();
    clearAllScoreDrafts();
    requestStoragePersistenceOnce();
    const cleanOrgId = orgId.trim().toUpperCase();
    let orgRecord: Organization | null = null;
    try {
      orgRecord = await dbService.getOrganizationByOrgId(cleanOrgId);
    } catch {}

    const newSession: UserSession = {
      role: 'judge',
      org: orgRecord || {
        id: judge.org_id,
        org_id: cleanOrgId,
        name: 'Official Stage',
        created_at: new Date().toISOString(),
      },
      judge,
      sessionToken,
    };
    setMustChangePassword(false);
    setStoredSession(newSession);
    setSession(newSession);
    setJudgeEvents(assignedEvents);
    setActiveJudgeEvent(null);
    triggerAuthSplash(judge.name ? `Judge ${judge.name}` : 'Judge');
  };

  // Smooth Server-Aware Sign-Out Handler
  const handleLogout = useCallback(async () => {
    if (isSigningOutRef.current) return;
    isSigningOutRef.current = true;

    const currentSession = session;
    const role: 'organiser' | 'judge' = currentSession?.role === 'judge' ? 'judge' : 'organiser';
    const displayName =
      role === 'judge'
        ? currentSession?.judge?.name || 'Judge'
        : currentSession?.org?.name || 'Organiser';
    const token = currentSession?.sessionToken;

    const prefersReducedMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const minDwellMs = prefersReducedMotion ? 350 : 1200;
    const fadeMs = prefersReducedMotion ? 150 : 350;

    if (signOutTimersRef.current.wait) clearTimeout(signOutTimersRef.current.wait);
    if (signOutTimersRef.current.fade) clearTimeout(signOutTimersRef.current.fade);

    setSignOutOverlay({
      name: displayName,
      role,
      waitingOnServer: false,
      isFading: false,
    });

    if (token) {
      signOutTimersRef.current.wait = window.setTimeout(() => {
        setSignOutOverlay((prev) => (prev ? { ...prev, waitingOnServer: true } : null));
      }, 1500);
    }

    const serverLogoutPromise = token
      ? Promise.race([
          authService.logoutSession(role, token),
          new Promise<void>((resolve) => window.setTimeout(resolve, 8000)),
        ])
      : Promise.resolve();

    const dwellPromise = new Promise<void>((resolve) => window.setTimeout(resolve, minDwellMs));

    try {
      await Promise.all([serverLogoutPromise, dwellPromise]);
    } finally {
      if (signOutTimersRef.current.wait) {
        clearTimeout(signOutTimersRef.current.wait);
        signOutTimersRef.current.wait = undefined;
      }

      resetSignatureHardwareSession();
      resetLastTestResult();
      clearAllScoreDrafts();
      setMustChangePassword(false);
      setStoredSession(null);
      setSession(null);
      setActiveJudgeEvent(null);
      setIsPublicView(false);

      setSignOutOverlay((prev) => (prev ? { ...prev, isFading: true } : null));
      signOutTimersRef.current.fade = window.setTimeout(() => {
        setSignOutOverlay(null);
        isSigningOutRef.current = false;
      }, fadeMs);
    }
  }, [session]);

  // Public View Launcher
  const handleOpenPublicView = (eventId?: string) => {
    if (session?.org) {
      setPublicOrgId(session.org.org_id);
      if (eventId) setPublicEventId(eventId);
    }
    setIsPublicView(true);
  };

  // Active Screen Content based on session and route
  const renderScreenContent = () => {
    // 0. SUPER ADMIN CONSOLE (#/admin)
    if (isAdminRoute) {
      return (
        <AdminApp
          onExit={() => {
            if (window.location.hash) {
              history.replaceState(null, '', window.location.pathname + window.location.search);
            }
            setIsAdminRoute(false);
          }}
        />
      );
    }

    // 1. PUBLIC PROJECTOR SCREEN
    if (isPublicView) {
      return (
        <PublicLeaderboard
          orgId={publicOrgId}
          initialEventId={publicEventId}
          onExit={() => setIsPublicView(false)}
        />
      );
    }

    // 2. STRICT AUTH CHECK: IF !SESSION -> RENDER ONLY AUTH SCREEN
    if (!session) {
      return (
        <AuthScreen
          onOrganiserLogin={handleOrganiserLogin}
          onJudgeLogin={handleJudgeLogin}
          onOpenAdmin={() => setIsAdminRoute(true)}
        />
      );
    }

    // 3. IF ROLE === 'ORGANISER' -> RENDER ONLY ORGANISER DASHBOARD
    if (session.role === 'organiser') {
      return (
        <OrganiserDashboard
          organization={session.org}
          onLogout={handleLogout}
          onOpenPublicView={handleOpenPublicView}
          mustChangePassword={mustChangePassword}
          onPasswordChanged={() => setMustChangePassword(false)}
        />
      );
    }

    // 4. IF ROLE === 'JUDGE' -> RENDER ONLY SCORING PANEL (JudgeStage)
    if (session.role === 'judge' && session.judge) {
      if (activeJudgeEvent) {
        return (
          <ScoringPanel
            orgId={session.org.org_id}
            judge={session.judge}
            event={activeJudgeEvent}
            onBackToLobby={() => setActiveJudgeEvent(null)}
          />
        );
      }

      return (
        <JudgeLobby
          orgId={session.org.org_id}
          judge={session.judge}
          events={judgeEvents}
          onSelectEvent={(ev) => setActiveJudgeEvent(ev)}
          onLogout={handleLogout}
        />
      );
    }

    // Fallback to AuthScreen
    return (
      <AuthScreen
        onOrganiserLogin={handleOrganiserLogin}
        onJudgeLogin={handleJudgeLogin}
        onOpenAdmin={() => setIsAdminRoute(true)}
      />
    );
  };

  return (
    <ToastProvider>
      {/* ======================================================== */}
      {/* DIRECTIVE 2: GPU-ACCELERATED COLD BOOT SPLASH SCREEN     */}
      {/* ======================================================== */}
      {isBooting && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed inset-0 z-[200] flex flex-col items-center justify-center bg-zinc-950 select-none overflow-hidden pb-safe transition-opacity duration-[400ms] ease-out will-change-opacity pointer-events-none ${
            isBootFading ? 'opacity-0' : 'opacity-100 pointer-events-auto'
          }`}
        >
          {/* Subtle Ambient Radial Glow */}
          <div className="absolute w-[380px] h-[380px] rounded-full bg-emerald-500/10 blur-[120px] pointer-events-none" />

          {/* Dead Center Brand Core: scales down (scale-75) & translates up (-translate-y-8) as it fades */}
          <div
            className={`relative flex flex-col items-center text-center px-6 max-w-sm w-full transition-all duration-[400ms] ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform will-change-opacity ${
              isBootFading
                ? 'scale-75 -translate-y-8 opacity-0'
                : 'scale-100 translate-y-0 opacity-100'
            }`}
          >
            {/* Glowing Fair Judge Scale Logo with Premium Boot Kinematics */}
            <div className="relative flex items-center justify-center mb-4 animate-in fade-in zoom-in-95 duration-700 ease-out">
              <div className="absolute -inset-2.5 rounded-3xl border border-emerald-500/30 animate-ping opacity-25 pointer-events-none" />
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 flex items-center justify-center relative z-10 shadow-xl shadow-emerald-500/25 overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-emerald-400/10 to-transparent animate-progress-shimmer pointer-events-none" />
                <Scale className="w-8 h-8 stroke-[2.2] relative z-10" />
              </div>
            </div>

            {/* Fair Judge Title & Monospace Subtitle */}
            <h1 className="text-3xl font-extrabold tracking-tight text-white font-sans">
              Fair Judge
            </h1>
            <p className="text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-widest mt-1.5">
              Competition Systems
            </p>
          </div>
        </div>
      )}

      {/* Target 1: Transient Auth Splash (Solid dark overlay, zero stutter, 60fps GPU fade) */}
      {authSplash && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed inset-0 z-[999] bg-zinc-950 flex flex-col items-center justify-center text-white px-6 transition-opacity duration-500 ${
            authSplash.isFading ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}
        >
          <div className="flex flex-col items-center text-center max-w-sm w-full">
            <div
              className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-5 shadow-xl ${
                session?.role === 'judge'
                  ? 'bg-amber-500/15 border border-amber-500/40 text-amber-400 shadow-amber-500/20'
                  : 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 shadow-emerald-500/20'
              }`}
            >
              <Scale className="w-8 h-8 stroke-[2.2]" />
            </div>
            <p className="text-base sm:text-lg font-semibold text-zinc-100 tracking-tight">
              Welcome back, <span className="font-extrabold text-white">{authSplash.name}</span>
            </p>
            <p className="text-xs font-mono text-zinc-400 mt-2 flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                  session?.role === 'judge' ? 'bg-amber-400' : 'bg-emerald-400'
                }`}
              />
              <span>Syncing offline ledger...</span>
            </p>
          </div>
        </div>
      )}

      {/* Smooth Server-Aware Sign-Out Overlay */}
      {signOutOverlay && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed inset-0 z-[999] bg-zinc-950 flex flex-col items-center justify-center text-white px-6 transition-opacity duration-300 motion-reduce:transition-none ${
            signOutOverlay.isFading ? 'opacity-0 pointer-events-none' : 'opacity-100'
          }`}
        >
          <div className="flex flex-col items-center text-center max-w-sm w-full">
            <div
              className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-5 shadow-xl ${
                signOutOverlay.role === 'judge'
                  ? 'bg-amber-500/15 border border-amber-500/40 text-amber-400 shadow-amber-500/20'
                  : 'bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 shadow-emerald-500/20'
              }`}
            >
              <Scale className="w-8 h-8 stroke-[2.2]" />
            </div>
            <p className="text-base sm:text-lg font-semibold text-zinc-100 tracking-tight">
              Signing out <span className="font-extrabold text-white">{signOutOverlay.name}</span>
            </p>
            <p className="text-xs font-mono text-zinc-400 mt-2 flex items-center gap-2">
              <span
                className={`w-1.5 h-1.5 rounded-full animate-pulse ${
                  signOutOverlay.role === 'judge' ? 'bg-amber-400' : 'bg-emerald-400'
                }`}
              />
              <span>
                {signOutOverlay.waitingOnServer
                  ? 'Waiting on server to finish signing out...'
                  : 'Securing local ledger & revoking session...'}
              </span>
            </p>
          </div>
        </div>
      )}

      <NetworkStatusIndicator />
      <Suspense fallback={<div className="w-full h-full min-h-[100dvh] bg-stone-50 dark:bg-black" />}>
        <div className="w-full h-full animate-in fade-in slide-in-from-bottom-2 duration-[250ms] ease-out will-change-transform">
          {renderScreenContent()}
        </div>
      </Suspense>
    </ToastProvider>
  );
}
