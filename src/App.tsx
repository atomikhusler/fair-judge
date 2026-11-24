/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, Suspense, lazy } from 'react';
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
  supabase,
  isSupabaseConfigured,
} from './lib/supabase';
import { initCacheStorage } from './lib/db/indexedDB';
import {
  initOfflineSyncListener,
  clearAllScoreDrafts,
  flushOfflineQueueToSupabase,
  getPendingCount,
  subscribeToQueueChanges,
} from './lib/offlineQueue';
import { clearSyncCursorForSession } from './lib/syncEngine';
import { areRecordsEqual, areOrganizationsEqual, eventBus } from './lib/eventBus';
import { DB_TABLES, matchesDbTable } from './lib/dbTables';
import { requestStoragePersistenceOnce } from './lib/storagePersistence';
import { scrubCachedPasswords } from './lib/authScrubber';
import { lazyWithRetry } from './lib/lazyWithRetry';
import { authService } from './lib/authService';
import { resetSignatureHardwareSession } from './components/shared/SignatureHardware';
import { resetLastTestResult, checkSwUpdateWaiting } from './lib/selfTest';
import {
  APP_VERSION,
  compareVersionsNumeric,
} from './config/version';
import { checkForAppUpdate, applyMinVersionUpdate } from './lib/swUpdateManager';
import { playSound, unlockSoundEngine } from './lib/sound';
import { RouteShellSkeleton } from './components/common/Skeletons';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { BrandBadge } from './components/shared/BrandBadge';
import {
  SessionReverifyModal,
  SessionReverifySuccessPayload,
} from './components/auth/SessionReverifyModal';
import {
  loadProjectorSession,
  clearProjectorSession,
} from './lib/projector/projectorTokenStore';
import { projectorAppService } from './lib/projector/projectorAppService';
import type { ProjectorExitOptions } from './components/projector/ProjectorApp';

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
const ProjectorApp = lazyWithRetry(() =>
  import('./components/projector/ProjectorApp').then((m) => ({ default: m.ProjectorApp })),
  'projector-app'
);
const AdminApp = lazyWithRetry(() =>
  import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })),
  'admin'
);

export type UserSession = StoredUserSession;

export function isProjectorAppHash(hash: string): boolean {
  const h = hash || '';
  return (
    h === '#/projector-app' ||
    h.startsWith('#/projector-app?') ||
    h.startsWith('#/projector-app/')
  );
}

export function cleanProjectorAppHash(): void {
  if (typeof window === 'undefined') return;
  if (isProjectorAppHash(window.location.hash || '')) {
    try {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search
      );
    } catch {}
  }
}

export function clearProjectorRouteState(): void {
  clearProjectorSession();
  cleanProjectorAppHash();
}

export function resolveProjectorAppRoute(options?: {
  allowWithoutSession?: boolean;
}): boolean {
  if (typeof window === 'undefined') return false;
  if (!isProjectorAppHash(window.location.hash || '')) return false;
  if (options?.allowWithoutSession) return true;
  if (loadProjectorSession()) return true;
  cleanProjectorAppHash();
  return false;
}

type BootSplashMode = 'skip' | 'short' | 'full';

function getBootSplashMode(initialProjectorAppRoute: boolean): BootSplashMode {
  if (typeof window === 'undefined') return 'skip';
  if (initialProjectorAppRoute) return 'skip';
  const s = getStoredSession();
  if (!s) return 'full';
  if (s.org?.org_id && dbService.hasCachedData(s.org.org_id)) {
    return 'skip';
  }
  return 'short';
}

function AnimatedEllipsis() {
  return (
    <span aria-hidden="true" className="inline-flex ml-0.5">
      <span className="fj-ellipsis-dot">.</span>
      <span className="fj-ellipsis-dot">.</span>
      <span className="fj-ellipsis-dot">.</span>
    </span>
  );
}

export default function App() {
  // Standalone Projector App route (#/projector-app): keep open on reload ONLY if a valid session exists
  const [isProjectorAppRoute, setIsProjectorAppRoute] = useState<boolean>(() =>
    resolveProjectorAppRoute()
  );
  const intentionalProjectorEntryRef = useRef(false);

  const [bootMode] = useState<BootSplashMode>(() => getBootSplashMode(isProjectorAppRoute));
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

  // Transient Auth Splash State (EPIC 15.3 Target 1)
  const [authSplash, setAuthSplash] = useState<{
    name: string;
    isFading: boolean;
  } | null>(null);
  const authSplashTimerRef = useRef<{ hold?: number; fade?: number }>({});

  // Forced temporary password reset flag (set via org_login must_change)
  const [mustChangePassword, setMustChangePassword] = useState(false);

  // Epic 16.6.0: Minimum-version safety net state (null = not blocked)
  const [minRequiredVersion, setMinRequiredVersion] = useState<string | null>(null);
  const [minVersionPendingCount, setMinVersionPendingCount] = useState<number>(0);

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
  const splashCoreRef = useRef<HTMLDivElement>(null);
  const splashBadgeRef = useRef<HTMLDivElement>(null);

  // Lock document scroll while full-screen splashes/overlays are active to prevent handoff scrollbar flicker
  useLayoutEffect(() => {
    const hasOverlay = Boolean(isBooting || authSplash || signOutOverlay);
    document.documentElement.classList.toggle('fj-splash-lock', hasOverlay);
    return () => {
      document.documentElement.classList.remove('fj-splash-lock');
    };
  }, [isBooting, authSplash, signOutOverlay]);

  // Measure Gateway BrandBadge coordinates so the splash docks pixel-for-pixel into Gateway
  useLayoutEffect(() => {
    if (!isBooting || bootMode !== 'full') return;

    const alignSplashToGateway = () => {
      const coreEl = splashCoreRef.current;
      const badgeRestEl = splashBadgeRef.current;
      const gatewayAnchorEl = document.querySelector<HTMLElement>('[data-fj-brand-anchor="gateway"]');
      if (!coreEl || !badgeRestEl || !gatewayAnchorEl) return;

      coreEl.style.transform = 'none';
      const restRect = badgeRestEl.getBoundingClientRect();
      const anchorRect = gatewayAnchorEl.getBoundingClientRect();

      const restCx = restRect.left + restRect.width / 2;
      const restCy = restRect.top + restRect.height / 2;
      const anchorCx = anchorRect.left + anchorRect.width / 2;
      const anchorCy = anchorRect.top + anchorRect.height / 2;

      const coreShiftX = anchorCx - restCx;
      const coreShiftY = anchorCy - restCy;

      coreEl.style.transform = `translate3d(${coreShiftX}px, ${coreShiftY}px, 0)`;
      coreEl.style.setProperty('--fj-hero-dx', `${window.innerWidth / 2 - anchorCx}px`);
      coreEl.style.setProperty('--fj-hero-dy', `${window.innerHeight / 2 - anchorCy}px`);
      coreEl.style.setProperty('--fj-hero-scale', '1.35');
    };

    alignSplashToGateway();
    window.addEventListener('resize', alignSplashToGateway);
    return () => {
      window.removeEventListener('resize', alignSplashToGateway);
    };
  }, [isBooting, bootMode]);

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
      const allowEntry =
        intentionalProjectorEntryRef.current &&
        isProjectorAppHash(window.location.hash || '');
      if (allowEntry) {
        setIsProjectorAppRoute(true);
        return;
      }
      intentionalProjectorEntryRef.current = false;
      setIsProjectorAppRoute(resolveProjectorAppRoute());
    };
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    window.addEventListener('popstate', handleHashChange);

    const prefersReducedMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let bootHoldMs = 0;
    let bootFadeMs = 0;
    if (bootMode === 'full') {
      bootHoldMs = prefersReducedMotion ? 300 : 3550;
      bootFadeMs = prefersReducedMotion ? 100 : 450;
    } else if (bootMode === 'short') {
      bootHoldMs = prefersReducedMotion ? 100 : 250;
      bootFadeMs = prefersReducedMotion ? 100 : 150;
    }

    let bootFadeTimer: number | undefined;
    let bootUnmountTimer: number | undefined;

    if (!isProjectorAppHash(window.location.hash || '')) {
      unlockSoundEngine();
      if (bootMode !== 'skip') {
        playSound('boot', { launch: true });
      }
    }
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
      window.removeEventListener('popstate', handleHashChange);
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

      if (eventsRes.unauthorized || orgRes.unauthorized) {
        showToast('Session expired or organisation unavailable. Please sign in again.', 'error');
        void handleLogoutRef.current?.();
        return;
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
      if (isSigningOutRef.current || isAdminRoute || isProjectorAppRoute) return;
      setReverifyPrompt((prev) => prev || { role, reason });
    });
    return unsub;
  }, [session, isAdminRoute, isProjectorAppRoute]);

  // Epic 16.6.0: Silent update check (/version.json + reg.waiting) and minimum client version safety net
  useEffect(() => {
    let cancelled = false;

    const runChecks = async () => {
      void checkForAppUpdate();
      void checkSwUpdateWaiting();

      if (isProjectorAppRoute || !isSupabaseConfigured()) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

      try {
        const { data, error } = await supabase.rpc('fj_min_client_version');
        if (cancelled || error || typeof data !== 'string') return;
        const minVer = data.trim();
        if (!minVer) return;

        if (compareVersionsNumeric(APP_VERSION, minVer) < 0) {
          const pending = await getPendingCount().catch(() => 0);
          if (cancelled) return;
          setMinVersionPendingCount(pending);
          setMinRequiredVersion(minVer);
        } else {
          setMinRequiredVersion(null);
        }
      } catch {
        // Offline or RPC unavailable: do nothing
      }
    };

    void runChecks();

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        void runChecks();
      }
    };

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      cancelled = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [isProjectorAppRoute]);

  // Epic 16.6.0: While minimum version blocks the app, flush and monitor pending IndexedDB work until empty
  useEffect(() => {
    if (!minRequiredVersion || isProjectorAppRoute) return;

    let cancelled = false;
    let retryTimer: number | null = null;
    let flushing = false;

    const clearRetry = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const refreshAndSync = async () => {
      if (cancelled || flushing) return;
      flushing = true;
      clearRetry();
      try {
        const before = await getPendingCount().catch(() => 0);
        if (cancelled) return;
        setMinVersionPendingCount(before);

        if (before > 0 && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
          const result = await flushOfflineQueueToSupabase().catch(() => ({
            syncedCount: 0,
            failedCount: 0,
            authRequired: false,
          }));
          if (cancelled) return;
          const after = await getPendingCount().catch(() => 0);
          if (cancelled) return;
          setMinVersionPendingCount(after);

          if (after > 0 && !result.authRequired && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
            retryTimer = window.setTimeout(() => {
              void refreshAndSync();
            }, 3000);
          }
        }
      } finally {
        flushing = false;
      }
    };

    void refreshAndSync();
    const unsubQueue = subscribeToQueueChanges(() => {
      void getPendingCount()
        .then((count) => {
          if (!cancelled) setMinVersionPendingCount(count);
        })
        .catch(() => {});
    });

    const handleOnlineOrVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refreshAndSync();
    };
    window.addEventListener('online', handleOnlineOrVisible);
    document.addEventListener('visibilitychange', handleOnlineOrVisible);

    return () => {
      cancelled = true;
      clearRetry();
      unsubQueue();
      window.removeEventListener('online', handleOnlineOrVisible);
      document.removeEventListener('visibilitychange', handleOnlineOrVisible);
    };
  }, [minRequiredVersion, isProjectorAppRoute]);

  // Helper to trigger hardware-accelerated ~2.4s sign-in splash
  const triggerAuthSplash = useCallback((displayName: string) => {
    if (authSplashTimerRef.current.hold) clearTimeout(authSplashTimerRef.current.hold);
    if (authSplashTimerRef.current.fade) clearTimeout(authSplashTimerRef.current.fade);

    const prefersReducedMotion =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const holdMs = prefersReducedMotion ? 350 : 1950;
    const fadeMs = prefersReducedMotion ? 150 : 450;

    playSound('signin');
    setAuthSplash({ name: displayName, isFading: false });

    authSplashTimerRef.current.hold = window.setTimeout(() => {
      setAuthSplash((prev) => (prev ? { ...prev, isFading: true } : null));

      authSplashTimerRef.current.fade = window.setTimeout(() => {
        setAuthSplash(null);
      }, fadeMs);
    }, holdMs);
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
    const minDwellMs = prefersReducedMotion ? 350 : 1950;
    const fadeMs = prefersReducedMotion ? 150 : 450;

    if (signOutTimersRef.current.wait) clearTimeout(signOutTimersRef.current.wait);
    if (signOutTimersRef.current.fade) clearTimeout(signOutTimersRef.current.fade);

    playSound('shutdown');
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
      void clearSyncCursorForSession(currentSession);
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

  const handleLogoutRef = useRef(handleLogout);
  handleLogoutRef.current = handleLogout;

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

  const openProjectorAppRoute = useCallback(() => {
    intentionalProjectorEntryRef.current = true;
    if (!isProjectorAppHash(window.location.hash || '')) {
      window.location.hash = '#/projector-app';
    }
    setIsProjectorAppRoute(true);
  }, []);

  const exitProjectorAppRoute = useCallback(async (options?: ProjectorExitOptions) => {
    const shouldAnimate = Boolean(options?.animate);
    intentionalProjectorEntryRef.current = false;
    clearProjectorRouteState();

    if (!shouldAnimate) {
      setIsProjectorAppRoute(false);
      return;
    }

    if (isSigningOutRef.current) return;
    isSigningOutRef.current = true;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const minDwellMs = prefersReducedMotion ? 350 : 1950;
    const fadeMs = prefersReducedMotion ? 150 : 450;

    if (signOutTimersRef.current.wait) clearTimeout(signOutTimersRef.current.wait);
    if (signOutTimersRef.current.fade) clearTimeout(signOutTimersRef.current.fade);

    playSound('shutdown');
    setSignOutOverlay({
      name: 'Projector',
      role: 'organiser',
      waitingOnServer: false,
      isFading: false,
    });

    const tokenToEnd = options?.endToken?.trim() || null;
    if (tokenToEnd) {
      signOutTimersRef.current.wait = window.setTimeout(() => {
        setSignOutOverlay((prev) => (prev ? { ...prev, waitingOnServer: true } : null));
      }, 1500);
    }

    const serverEndPromise = tokenToEnd
      ? Promise.race([
          projectorAppService
            .endSession(tokenToEnd)
            .then(() => undefined)
            .catch(() => undefined),
          new Promise<void>((resolve) => window.setTimeout(resolve, 8000)),
        ])
      : Promise.resolve();

    const dwellPromise = new Promise<void>((resolve) =>
      window.setTimeout(resolve, minDwellMs)
    );

    try {
      await Promise.all([serverEndPromise, dwellPromise]);
    } finally {
      if (signOutTimersRef.current.wait) {
        clearTimeout(signOutTimersRef.current.wait);
        signOutTimersRef.current.wait = undefined;
      }

      setIsProjectorAppRoute(false);

      setSignOutOverlay((prev) => (prev ? { ...prev, isFading: true } : null));
      signOutTimersRef.current.fade = window.setTimeout(() => {
        setSignOutOverlay(null);
        isSigningOutRef.current = false;
      }, fadeMs);
    }
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

    // 1A. STANDALONE PROJECTOR APP (#/projector-app)
    if (isProjectorAppRoute) {
      return (
        <ErrorBoundary
          variant="fullscreen"
          title="Projector app interrupted"
          resetKeys={['projector-app', screenRetryNonce]}
          onRetry={() => setScreenRetryNonce((n) => n + 1)}
        >
          <ProjectorApp onExit={exitProjectorAppRoute} />
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
            onOpenProjector={openProjectorAppRoute}
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
          onOpenProjector={openProjectorAppRoute}
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
      {/* GPU-ACCELERATED COLD BOOT SPLASH -> SEAMLESS HANDOFF     */}
      {/* ======================================================== */}
      {isBooting && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed inset-0 z-[10000] flex flex-col items-center justify-center bg-stone-50 dark:bg-black select-none overflow-hidden pb-safe transition-opacity ${
            bootMode === 'full'
              ? 'duration-[450ms] ease-[cubic-bezier(0.32,0.72,0,1)]'
              : 'duration-[150ms] ease-out'
          } motion-reduce:duration-100 ${isBootFading ? 'will-change-opacity opacity-0 pointer-events-none' : 'opacity-100 pointer-events-auto'}`}
        >
          {/* Subtle Ambient Radial Glow (pure gradient, zero filter/backdrop blur) */}
          <div
            aria-hidden="true"
            className="absolute w-[380px] h-[380px] rounded-full pointer-events-none opacity-80 dark:opacity-100"
            style={{
              background: 'radial-gradient(circle, rgba(16, 185, 129, 0.12) 0%, transparent 70%)',
            }}
          />

          {/* Shared-Element Brand Core aligned to Gateway anchor */}
          <div
            ref={splashCoreRef}
            className="relative flex flex-col items-center justify-center text-center px-6 max-w-xl w-full"
          >
            {/* Resting badge wrapper measured for exact 1:1 Gateway coordinate lock */}
            <div ref={splashBadgeRef} className="mb-4 relative z-10">
              <BrandBadge
                size="lg"
                role="organiser"
                motion={bootMode === 'full' ? 'damped' : 'rock'}
                className={bootMode === 'full' ? 'fj-badge-dock' : ''}
                onAnimationEnd={
                  bootMode === 'full'
                    ? (e) => e.currentTarget.classList.add('fj-motion-settled')
                    : undefined
                }
              />
            </div>

            {/* Revealed beneath docked badge with identical Gateway typography */}
            <h1
              className={`text-3xl md:text-4xl font-extrabold tracking-tight text-zinc-900 dark:text-white font-sans ${
                bootMode === 'full' ? 'fj-boot-title-reveal' : ''
              }`}
              onAnimationEnd={
                bootMode === 'full'
                  ? (e) => e.currentTarget.classList.add('fj-motion-settled')
                  : undefined
              }
            >
              Fair Judge
            </h1>
            <p
              className={`text-[11px] sm:text-xs font-mono font-bold uppercase tracking-[0.18em] sm:tracking-[0.22em] text-zinc-600 dark:text-zinc-400 whitespace-nowrap mt-2.5 ${
                bootMode === 'full' ? 'fj-boot-tagline-reveal' : ''
              }`}
              onAnimationEnd={
                bootMode === 'full'
                  ? (e) => e.currentTarget.classList.add('fj-motion-settled')
                  : undefined
              }
            >
              MANAGE &amp; EVALUATE FAIRLY
            </p>
          </div>
        </div>
      )}

      {/* Transient Auth Splash (Theme-aware Light & AMOLED Dark, Unified BrandBadge) */}
      {authSplash && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed inset-0 z-[999] bg-stone-50 dark:bg-black flex flex-col items-center justify-center text-zinc-900 dark:text-white px-6 overflow-hidden transition-opacity duration-[450ms] motion-reduce:transition-none ${
            authSplash.isFading ? 'will-change-opacity opacity-0 pointer-events-none' : 'opacity-100'
          }`}
        >
          <div className="flex flex-col items-center text-center max-w-sm w-full">
            <BrandBadge
              size="lg"
              role={session?.role === 'judge' ? 'judge' : 'organiser'}
              motion="rock"
              className="mb-5"
            />
            <p className="text-base sm:text-lg font-semibold text-zinc-800 dark:text-zinc-100 tracking-tight font-sans">
              Signing in
              <AnimatedEllipsis />
            </p>
          </div>
        </div>
      )}

      {/* Smooth Server-Aware Sign-Out Overlay (Unified BrandBadge) */}
      {signOutOverlay && (
        <div
          role="status"
          aria-live="polite"
          className={`fixed inset-0 z-[999] bg-stone-50 dark:bg-black flex flex-col items-center justify-center text-zinc-900 dark:text-white px-6 overflow-hidden transition-opacity duration-[450ms] motion-reduce:transition-none ${
            signOutOverlay.isFading ? 'will-change-opacity opacity-0 pointer-events-none' : 'opacity-100'
          }`}
        >
          <div className="flex flex-col items-center text-center max-w-sm w-full">
            <BrandBadge
              size="lg"
              role={signOutOverlay.role}
              motion="rock"
              className="mb-5"
            />
            <p className="text-base sm:text-lg font-semibold text-zinc-800 dark:text-zinc-100 tracking-tight font-sans">
              Signing out
              <AnimatedEllipsis />
            </p>
          </div>
        </div>
      )}

      <NetworkStatusIndicator />
      <Suspense fallback={<RouteShellSkeleton />}>
        <div className="w-full h-full animate-in fade-in duration-[250ms] ease-out motion-reduce:animate-none">
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

      {minRequiredVersion && !isProjectorAppRoute && (
        <div
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="fj-min-version-title"
          className="fixed inset-0 z-[940] flex items-center justify-center p-4 bg-black/85 select-none"
        >
          <div className="w-full max-w-sm rounded-3xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 p-6 shadow-2xl space-y-4 text-center">
            {minVersionPendingCount > 0 ? (
              <>
                <h2
                  id="fj-min-version-title"
                  className="text-lg font-bold tracking-tight text-zinc-900 dark:text-white"
                >
                  Syncing your work, then update
                </h2>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  {minVersionPendingCount} queued{' '}
                  {minVersionPendingCount === 1 ? 'change is' : 'changes are'} being saved to the server before updating to v{minRequiredVersion}. Nothing has been discarded.
                </p>
              </>
            ) : (
              <>
                <h2
                  id="fj-min-version-title"
                  className="text-lg font-bold tracking-tight text-zinc-900 dark:text-white"
                >
                  Update required
                </h2>
                <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                  Fair Judge v{APP_VERSION} must be updated to at least v{minRequiredVersion} to continue.
                </p>
                <button
                  type="button"
                  onClick={() => void applyMinVersionUpdate()}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold uppercase tracking-wider cursor-pointer active:scale-[0.98] transition-transform motion-reduce:transition-none"
                >
                  Update now
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </ToastProvider>
  );
}
