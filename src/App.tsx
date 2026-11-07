/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback, Suspense, lazy } from 'react';
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
import { initOfflineSyncListener } from './lib/offlineQueue';
import { Scale } from 'lucide-react';
import { ResourceLoader } from './components/common/ResourceLoader';

// Code Splitting: Asynchronously load major route panels to minimize initial JS payload
const OrganiserDashboard = lazy(() =>
  import('./components/organiser/OrganiserDashboard').then((m) => ({ default: m.OrganiserDashboard }))
);
const ScoringPanel = lazy(() =>
  import('./components/judge/ScoringPanel').then((m) => ({ default: m.ScoringPanel }))
);
const JudgeLobby = lazy(() =>
  import('./components/judge/JudgeLobby').then((m) => ({ default: m.JudgeLobby }))
);
const PublicLeaderboard = lazy(() =>
  import('./components/public/PublicLeaderboard').then((m) => ({ default: m.PublicLeaderboard }))
);

export type UserSession = StoredUserSession;

export default function App() {
  const [isBooting, setIsBooting] = useState(true);
  const [isBootFading, setIsBootFading] = useState(false);
  const [session, setSession] = useState<UserSession | null>(getStoredSession);
  const [judgeEvents, setJudgeEvents] = useState<SupabaseEvent[]>([]);
  const [activeJudgeEvent, setActiveJudgeEvent] = useState<SupabaseEvent | null>(null);

  // Public projector screen state
  const [isPublicView, setIsPublicView] = useState(false);
  const [publicOrgId, setPublicOrgId] = useState('');
  const [publicEventId, setPublicEventId] = useState<string | null>(null);

  // Data-Driven Cold Boot Sequence & App Hydration (Directive 2)
  useEffect(() => {
    let isCancelled = false;
    let unsubSync: (() => void) | null = null;

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const runBootSequence = async () => {
      try {
        // Hydrate local cache and database state
        await initCacheStorage();
        if (isCancelled) return;

        const stored = getStoredSession();
        setSession(stored);
        unsubSync = initOfflineSyncListener();

        // 800ms initialization delay hold
        await delay(800);
        if (isCancelled) return;

        // Trigger 400ms CSS exit animation
        setIsBootFading(true);
        await delay(400);
        if (isCancelled) return;

        // Clean unmount from DOM
        setIsBooting(false);
      } catch (err) {
        console.warn('Boot sequence error:', err);
        setIsBooting(false);
      }
    };

    runBootSequence();

    const handleSessionEvent = () => {
      const stored = getStoredSession();
      setSession(stored);
    };

    window.addEventListener('fairjudge_session_change', handleSessionEvent);

    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'public') {
      const orgParam = params.get('orgId');
      const eventParam = params.get('eventId');
      if (orgParam) setPublicOrgId(orgParam.toUpperCase());
      if (eventParam) setPublicEventId(eventParam);
      setIsPublicView(true);
    }

    return () => {
      isCancelled = true;
      if (unsubSync) unsubSync();
      window.removeEventListener('fairjudge_session_change', handleSessionEvent);
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

      setJudgeEvents(assigned);

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
      return () => unsubDb();
    }
  }, [session?.role, session?.org?.org_id, session?.judge?.id, refreshJudgeData]);

  // Organiser Login Handler
  const handleOrganiserLogin = (org: Organization) => {
    const newSession: UserSession = {
      role: 'organiser',
      org,
    };
    setStoredSession(newSession);
    setSession(newSession);
  };

  // Judge Login Handler - Fetches real Organization record & routes to JudgeLobby
  const handleJudgeLogin = async (
    orgId: string,
    judge: SupabaseJudge,
    assignedEvents: SupabaseEvent[]
  ) => {
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
    };
    setStoredSession(newSession);
    setSession(newSession);
    setJudgeEvents(assignedEvents);
    setActiveJudgeEvent(null);
  };

  // Logout Handler
  const handleLogout = () => {
    setStoredSession(null);
    setSession(null);
    setActiveJudgeEvent(null);
    setIsPublicView(false);
  };

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
            {/* Glowing Fair Judge Scale Logo */}
            <div className="relative flex items-center justify-center mb-4">
              <div className="absolute -inset-2.5 rounded-3xl border border-emerald-500/30 animate-ping opacity-25 pointer-events-none" />
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 flex items-center justify-center relative z-10 shadow-xl shadow-emerald-500/25">
                <Scale className="w-8 h-8 stroke-[2.2]" />
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

      <NetworkStatusIndicator />
      <Suspense
        fallback={
          <div className="h-screen w-full bg-zinc-950 flex items-center justify-center">
            <div className="w-8 h-8 rounded-full border-2 border-emerald-500/20 border-t-emerald-500 animate-spin" />
          </div>
        }
      >
        <div className="w-full h-full animate-in fade-in slide-in-from-bottom-2 duration-[250ms] ease-out will-change-transform">
          {renderScreenContent()}
        </div>
      </Suspense>
    </ToastProvider>
  );
}
