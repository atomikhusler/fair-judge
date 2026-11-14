/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, useRef, Suspense, lazy } from 'react';
import { AuthScreen } from './components/auth/AuthScreen';
import { NetworkStatusIndicator } from './components/NetworkStatusIndicator';
import { ToastProvider, showToast } from './components/common/ToastProvider';
import { Organization, SupabaseJudge, SupabaseEvent } from './lib/supabaseTypes';
import {
  dbService,
  subscribeToDatabase,
  getStoredSession,
  setStoredSession,
  StoredUserSession,
} from './lib/supabase';
import { initCacheStorage } from './lib/db/indexedDB';
import {
  initOfflineSyncListener,
  clearAllScoreDrafts,
  flushOfflineQueueToSupabase,
} from './lib/offlineQueue';
import { areRecordsEqual, areOrganizationsEqual, eventBus } from './lib/eventBus';
import { DB_TABLES, matchesDbTable } from './lib/dbTables';
import { Scale } from 'lucide-react';
import { requestStoragePersistenceOnce } from './lib/storagePersistence';
import { scrubCachedPasswords } from './lib/authScrubber';
import { lazyWithRetry } from './lib/lazyWithRetry';
import { authService } from './lib/authService';
import { resetSignatureHardwareSession } from './components/shared/SignatureHardware';
import { resetLastTestResult } from './lib/selfTest';
import { RouteShellSkeleton } from './components/common/Skeletons';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import {
  SessionReverifyModal,
  SessionReverifySuccessPayload,
} from './components/auth/SessionReverifyModal';

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
const ProjectorView = lazyWithRetry(() =>
  import('./components/public/ProjectorView').then((m) => ({ default: m.ProjectorView })),
  'projector'
);
const AdminApp = lazyWithRetry(() =>
  import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })),
  'admin'
);

export type UserSession = StoredUserSession;

function detectProjectorRoute(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.hash.startsWith('#/projector')) return true;
  const params = new URLSearchParams(window.location.search);
  return params.get('view') === 'projector';
}

type BootSplashMode = 'skip' | 'short' | 'full';

function getBootSplashMode(): BootSplashMode {
  if (typeof window === 'undefined') return 'skip';
  if (detectProjectorRoute()) return 'skip';
  const s = getStoredSession();
  if (!s) return 'full';
  if (s.org?.org_id && dbService.hasCachedData(s.org.org_id)) {
    return 'skip';
  }
  return 'short';
}

export default function App() {
  const [bootMode] = useState<BootSplashMode>(() => getBootSplashMode());
  const [isBooting, setIsBooting] = useState(() => bootMode !== 'skip');
  const [isBootFading, setIsBootFading] = useState(false);
  const [session, setSession] = useState<UserSession | null>(getStoredSession);
  const [judgeLoadError, setJudgeLoadError] = useState<string | null>(null);
  const [isRetryingJudgeLoad, setIsRetryingJudgeLoad] = useState(false);
  const [screenRetryNonce, setScreenRetryNonce] = useState(0);
  const judgeLoadErrorRef = useRef<string | null>(null);

  useEffect(() => {
    judgeLoadErrorRef.current = judgeLoadError;
  }, [judgeLoadError]);
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

  const [isAdminRoute, setIsAdminRoute] = useState(() =>
    typeof window !== 'undefined' && window.location.hash.startsWith('#/admin')
  );

  // Paired Projector route (#/projector or ?view=projector; old ?view=public links intentionally disabled)
  const [isProjectorRoute, setIsProjectorRoute] = useState<boolean>(detectProjectorRoute);

  // Transient Auth Splash State (EPIC 15.3 Target 1)
  const [authSplash, setAuthSplash] = useState<{
    name: string;
    isFading: boolean;
  } | null>(null);
  const authSplashTimerRef = useRef<{ hold?: number; fade?: number }>({});

  // Forced temporary password reset flag (set via org_login must_change)
  const [mustChangePassword, setMustChangePassword] = useState(false);

  // In-app Session Re-verification prompt (Stage 1 security lock)
  const [reverifyPrompt, setReverifyPrompt] = useState<{
    role: 'organiser' | 'judge';
    reason: 'missing' | 'expired';
  } | null>(null);

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

    const handleHashChange = () => {
      setIsAdminRoute(window.location.hash.startsWith('#/admin'));
      setIsProjectorRoute(detectProjectorRoute());
    };
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);

    const prefersReducedMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let bootHoldMs = 0;
    let bootFadeMs = 0;
    if (bootMode === 'full') {
      bootHoldMs = prefersReducedMotion ? 300 : 800;
      bootFadeMs = prefersReducedMotion ? 100 : 400;
    } else if (bootMode === 'short') {
      bootHoldMs = prefersReducedMotion ? 100 : 250;
      bootFadeMs = prefersReducedMotion ? 100 : 150;
    }

    let bootFadeTimer: number | undefined;
    let bootUnmountTimer: number | undefined;

    if (bootMode !== 'skip') {
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
  }, [bootMode]);

  // Sync Judge events & Organization settings in real-time when a Judge session is active
  const refreshJudgeData = useCallback(async (force: boolean = false) => {
    if (session?.role !== 'judge' || !session.org?.org_id || !session.judge) return;

    if (force) setIsRetryingJudgeLoad(true);
    try {
      const [eventsRes, orgRes] = await Promise.all([
        dbService.getEventsResult(session.org.org_id, force),
        dbService.getOrganizationByOrgIdResult(session.org.org_id, force),
      ]);

      const allEvents = eventsRes.data || [];
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

      const freshOrg = orgRes.data;
      if (freshOrg && !areOrganizationsEqual(freshOrg, session.org)) {
        const updatedSession: UserSession = { ...session, org: freshOrg };
        setSession(updatedSession);
        setStoredSession(updatedSession);
      }

      if (!eventsRes.ok || !orgRes.ok) {
        setJudgeLoadError(
          eventsRes.error || orgRes.error || 'Showing cached schedule. Unable to reach server.'
        );
      } else {
        setJudgeLoadError(null);
      }
    } catch (err: any) {
      setJudgeLoadError(err?.message || 'Showing cached schedule. Unable to reach server.');
    } finally {
      if (force) setIsRetryingJudgeLoad(false);
    }
  }, [session]);

  useEffect(() => {
    if (session?.role === 'judge') {
      void refreshJudgeData(false);
      const unsubDb = subscribeToDatabase((table) => {
        if (matchesDbTable(table, DB_TABLES.EVENTS, DB_TABLES.ORGANIZATIONS)) {
          void refreshJudgeData(false);
        }
      });
      const unsubEnforce = eventBus.on('org_enforcement', ({ code }) => {
        if (code === 'SUSPENDED' || code === 'DELETED') {
          setActiveJudgeEvent(null);
          void refreshJudgeData(true);
        }
      });
      const handleVisibilityOrOnline = () => {
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (typeof navigator !== 'undefined' && !navigator.onLine) return;
        if (judgeLoadErrorRef.current) {
          void refreshJudgeData(true);
        }
      };
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', handleVisibilityOrOnline);
      }
      if (typeof window !== 'undefined') {
        window.addEventListener('online', handleVisibilityOrOnline);
      }
      return () => {
        unsubDb();
        unsubEnforce();
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', handleVisibilityOrOnline);
        }
        if (typeof window !== 'undefined') {
          window.removeEventListener('online', handleVisibilityOrOnline);
        }
      };
    } else {
      setJudgeLoadError(null);
    }
  }, [session?.role, session?.org?.org_id, session?.judge?.id, refreshJudgeData]);

  // Listen for session_expired events so expired/missing tokens prompt re-verification without losing drafts
  useEffect(() => {
    if (!session) {
      setReverifyPrompt(null);
      return;
    }
    const unsub = eventBus.on('session_expired', ({ role, reason }) => {
      if (isSigningOutRef.current || isAdminRoute || isProjectorRoute) return;
      setReverifyPrompt((prev) => prev || { role, reason });
    });
    return unsub;
  }, [session, isAdminRoute, isProjectorRoute]);

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

  // Judge Login Handler - Uses verified Organization record or explicit ReadResult lookup
  const handleJudgeLogin = async (
    orgId: string,
    judge: SupabaseJudge,
    assignedEvents: SupabaseEvent[],
    sessionToken?: string,
    verifiedOrg?: Organization
  ) => {
    resetSignatureHardwareSession();
    resetLastTestResult();
    clearAllScoreDrafts();
    requestStoragePersistenceOnce();
    const cleanOrgId = orgId.trim().toUpperCase();
    let orgRecord: Organization | null = verifiedOrg || null;
    let orgHydrationWarning: string | null = null;

    if (!orgRecord) {
      const orgRes = await dbService.getOrganizationByOrgIdResult(cleanOrgId, false, sessionToken);
      if (orgRes.ok && orgRes.notFound && !orgRes.fromCache) {
        showToast('Organisation not found or unavailable. Please re-authenticate.', 'error');
        return;
      }
      orgRecord = orgRes.data;
      if (!orgRes.ok) {
        orgHydrationWarning =
          orgRes.error || 'Connected without full organisation settings — retrying sync automatically.';
      }
    }

    if (!orgRecord) {
      showToast(
        orgHydrationWarning ||
          'Connected without full organisation settings — retrying sync automatically.',
        'warning'
      );
      setJudgeLoadError(
        orgHydrationWarning || 'Could not load full organisation settings. Showing cached data.'
      );
    } else {
      setJudgeLoadError(null);
    }

    const newSession: UserSession = {
      role: 'judge',
      org: orgRecord || {
        id: judge.org_id,
        org_id: cleanOrgId,
        name: cleanOrgId,
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
      setReverifyPrompt(null);
      setStoredSession(null);
      setSession(null);
      setActiveJudgeEvent(null);

      setSignOutOverlay((prev) => (prev ? { ...prev, isFading: true } : null));
      signOutTimersRef.current.fade = window.setTimeout(() => {
        setSignOutOverlay(null);
        isSigningOutRef.current = false;
      }, fadeMs);
    }
  }, [session]);

  const handleReverifySuccess = useCallback(
    (payload: SessionReverifySuccessPayload) => {
      if (!session) return;
      const updatedSession: UserSession = {
        ...session,
        org: payload.org || session.org,
        judge: payload.judge || session.judge,
        sessionToken: payload.sessionToken,
      };
      if (payload.mustChange) {
        setMustChangePassword(true);
      }
      setStoredSession(updatedSession);
      setSession(updatedSession);
      setReverifyPrompt(null);
      showToast('Session verified. Syncing pending changes...', 'success');
      void flushOfflineQueueToSupabase();
    },
    [session]
  );

  const exitProjectorRoute = useCallback(() => {
    if (window.location.hash.startsWith('#/projector')) {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'projector') {
      params.delete('view');
      const nextSearch = params.toString();
      history.replaceState(
        null,
        '',
        window.location.pathname + (nextSearch ? `?${nextSearch}` : '') + window.location.hash
      );
    }
    setIsProjectorRoute(false);
  }, []);

  // Active Screen Content based on session and route
  const renderScreenContent = () => {
    // 0. SUPER ADMIN CONSOLE (#/admin)
    if (isAdminRoute) {
      return (
        <ErrorBoundary
          variant="fullscreen"
          title="Admin console interrupted"
          resetKeys={['admin', screenRetryNonce]}
          onRetry={() => setScreenRetryNonce((n) => n + 1)}
        >
          <AdminApp
            onExit={() => {
              if (window.location.hash) {
                history.replaceState(null, '', window.location.pathname + window.location.search);
              }
              setIsAdminRoute(false);
            }}
          />
        </ErrorBoundary>
      );
    }

    // 1. PAIRED PROJECTOR SCREEN (#/projector or ?view=projector)
    if (isProjectorRoute) {
      return (
        <ErrorBoundary
          variant="fullscreen"
          title="Projector screen interrupted"
          resetKeys={['projector', screenRetryNonce]}
          onRetry={() => setScreenRetryNonce((n) => n + 1)}
        >
          <ProjectorView onExit={exitProjectorRoute} />
        </ErrorBoundary>
      );
    }

    // 2. STRICT AUTH CHECK: IF !SESSION -> RENDER ONLY AUTH SCREEN
    if (!session) {
      return (
        <ErrorBoundary
          variant="fullscreen"
          title="Sign-in screen interrupted"
          resetKeys={['auth', screenRetryNonce]}
          onRetry={() => setScreenRetryNonce((n) => n + 1)}
        >
          <AuthScreen
            onOrganiserLogin={handleOrganiserLogin}
            onJudgeLogin={handleJudgeLogin}
            onOpenAdmin={() => {
              if (!window.location.hash.startsWith('#/admin')) {
                window.location.hash = '#/admin';
              }
              setIsAdminRoute(true);
            }}
          />
        </ErrorBoundary>
      );
    }

    // 3. IF ROLE === 'ORGANISER' -> RENDER ONLY ORGANISER DASHBOARD
    if (session.role === 'organiser') {
      return (
        <ErrorBoundary
          variant="fullscreen"
          title="Organiser workspace interrupted"
          resetKeys={['organiser', session.org.org_id, screenRetryNonce]}
          onRetry={() => setScreenRetryNonce((n) => n + 1)}
        >
          <OrganiserDashboard
            organization={session.org}
            onLogout={handleLogout}
            mustChangePassword={mustChangePassword}
            onPasswordChanged={() => setMustChangePassword(false)}
          />
        </ErrorBoundary>
      );
    }

    // 4. IF ROLE === 'JUDGE' -> RENDER ONLY SCORING PANEL (JudgeStage)
    if (session.role === 'judge' && session.judge) {
      if (activeJudgeEvent) {
        return (
          <ErrorBoundary
            variant="fullscreen"
            title="Scoring panel interrupted"
            resetKeys={['judge-scoring', session.org.org_id, activeJudgeEvent.id, screenRetryNonce]}
            onRetry={() => setScreenRetryNonce((n) => n + 1)}
          >
            <ScoringPanel
              orgId={session.org.org_id}
              judge={session.judge}
              event={activeJudgeEvent}
              onBackToLobby={() => setActiveJudgeEvent(null)}
            />
          </ErrorBoundary>
        );
      }

      return (
        <ErrorBoundary
          variant="fullscreen"
          title="Judge lobby interrupted"
          resetKeys={['judge-lobby', session.org.org_id, session.judge.id, screenRetryNonce]}
          onRetry={() => setScreenRetryNonce((n) => n + 1)}
        >
          <JudgeLobby
            orgId={session.org.org_id}
            judge={session.judge}
            events={judgeEvents}
            loadError={judgeLoadError}
            isRetryingLoad={isRetryingJudgeLoad}
            onRetryLoad={() => void refreshJudgeData(true)}
            onSelectEvent={(ev) => setActiveJudgeEvent(ev)}
            onLogout={handleLogout}
          />
        </ErrorBoundary>
      );
    }

    // Fallback to AuthScreen
    return (
      <ErrorBoundary
        variant="fullscreen"
        title="Sign-in screen interrupted"
        resetKeys={['auth-fallback', screenRetryNonce]}
        onRetry={() => setScreenRetryNonce((n) => n + 1)}
      >
        <AuthScreen
          onOrganiserLogin={handleOrganiserLogin}
          onJudgeLogin={handleJudgeLogin}
          onOpenAdmin={() => {
            if (!window.location.hash.startsWith('#/admin')) {
              window.location.hash = '#/admin';
            }
            setIsAdminRoute(true);
          }}
        />
      </ErrorBoundary>
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
          className={`fixed inset-0 z-[10000] flex flex-col items-center justify-center bg-stone-50 dark:bg-zinc-950 select-none overflow-hidden pb-safe transition-opacity ${
            bootMode === 'full'
              ? 'duration-[400ms] ease-[cubic-bezier(0.32,0.72,0,1)]'
              : 'duration-[150ms] ease-out'
          } motion-reduce:duration-100 will-change-opacity ${
            isBootFading ? 'opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'
          }`}
        >
          {/* Subtle Ambient Radial Glow (pure gradient, zero filter/backdrop blur) */}
          <div
            aria-hidden="true"
            className="absolute w-[380px] h-[380px] rounded-full pointer-events-none opacity-80 dark:opacity-100"
            style={{
              background: 'radial-gradient(circle, rgba(16, 185, 129, 0.12) 0%, transparent 70%)',
            }}
          />

          {/* Dead Center Brand Core: scales down (scale-75) & translates up (-translate-y-8) as it fades */}
          <div
            className={`relative flex flex-col items-center text-center px-6 max-w-sm w-full transition-[transform,opacity] ${
              bootMode === 'full' ? 'duration-[400ms]' : 'duration-[150ms]'
            } ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none motion-reduce:transform-none will-change-transform will-change-opacity ${
              isBootFading
                ? 'scale-75 -translate-y-8 opacity-0 motion-reduce:scale-100 motion-reduce:translate-y-0 motion-reduce:opacity-100'
                : 'scale-100 translate-y-0 opacity-100'
            }`}
          >
            {/* Glowing Fair Judge Scale Logo with Boot Kinematics */}
            <div className="relative flex items-center justify-center mb-4 animate-in fade-in zoom-in-95 duration-200 motion-reduce:animate-none">
              <div className="absolute -inset-2.5 rounded-3xl border border-emerald-500/30 animate-ping motion-reduce:animate-none opacity-25 pointer-events-none" />
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 dark:bg-emerald-500/15 border border-emerald-500/30 dark:border-emerald-500/40 text-emerald-600 dark:text-emerald-400 flex items-center justify-center relative z-10 shadow-xl shadow-emerald-500/15 dark:shadow-emerald-500/25 overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-emerald-400/10 to-transparent animate-progress-shimmer motion-reduce:hidden pointer-events-none" />
                <Scale className="w-8 h-8 stroke-[2.2] relative z-10" />
              </div>
            </div>

            {/* Fair Judge Title & Monospace Subtitle */}
            <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900 dark:text-white font-sans">
              Fair Judge
            </h1>
            <p className="text-[10px] font-mono font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest mt-1.5">
              Competition Systems
            </p>

            {/* Emerald Boot Status Dot */}
            <div className="mt-4 flex items-center justify-center" aria-hidden="true">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse motion-reduce:animate-none" />
            </div>
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
      <Suspense fallback={<RouteShellSkeleton />}>
        <div className="w-full h-full animate-in fade-in slide-in-from-bottom-2 duration-[250ms] ease-out motion-reduce:animate-none will-change-transform">
          {renderScreenContent()}
        </div>
      </Suspense>

      {session && reverifyPrompt && !isAdminRoute && (
        <SessionReverifyModal
          session={session}
          reason={reverifyPrompt.reason}
          onSuccess={handleReverifySuccess}
          onDismiss={() => setReverifyPrompt(null)}
          onSignOut={() => {
            setReverifyPrompt(null);
            void handleLogout();
          }}
        />
      )}
    </ToastProvider>
  );
}
