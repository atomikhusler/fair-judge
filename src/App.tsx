/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AuthScreen } from './components/auth/AuthScreen';
import { OrganiserDashboard } from './components/organiser/OrganiserDashboard';
import { ScoringPanel } from './components/judge/ScoringPanel';
import { JudgeLobby } from './components/judge/JudgeLobby';
import { PublicLeaderboard } from './components/public/PublicLeaderboard';
import { NetworkStatusIndicator } from './components/NetworkStatusIndicator';
import { Organization, SupabaseJudge, SupabaseEvent } from './lib/supabaseTypes';
import {
  dbService,
  subscribeToDatabase,
  getStoredSession,
  setStoredSession,
  StoredUserSession,
} from './lib/supabase';
import { initOfflineSyncListener } from './lib/offlineQueue';
import { Scale } from 'lucide-react';

export type UserSession = StoredUserSession;

export default function App() {
  const [isBooting, setIsBooting] = useState(true);
  const [bootFadingOut, setBootFadingOut] = useState(false);
  const [session, setSession] = useState<UserSession | null>(getStoredSession);
  const [judgeEvents, setJudgeEvents] = useState<SupabaseEvent[]>([]);
  const [activeJudgeEvent, setActiveJudgeEvent] = useState<SupabaseEvent | null>(null);

  // Public projector screen state
  const [isPublicView, setIsPublicView] = useState(false);
  const [publicOrgId, setPublicOrgId] = useState('');
  const [publicEventId, setPublicEventId] = useState<string | null>(null);

  // Boot Animation Lifecycle (2 second premium cinematic entrance before resolving app shell)
  useEffect(() => {
    const fadeTimer = setTimeout(() => {
      setBootFadingOut(true);
    }, 1700);

    const finishTimer = setTimeout(() => {
      setIsBooting(false);
    }, 2000);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(finishTimer);
    };
  }, []);

  // Initialize offline sync and URL parameters
  useEffect(() => {
    const unsubSync = initOfflineSyncListener();

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
      unsubSync();
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

  // 0. BOOT ANIMATION: Industry gold-standard 2-second premium entrance
  if (isBooting) {
    return (
      <div
        className={`fixed inset-0 z-50 bg-black text-white flex flex-col items-center justify-center p-4 selection:bg-emerald-500 selection:text-black overflow-hidden transition-opacity duration-300 ease-out select-none ${
          bootFadingOut ? 'opacity-0' : 'opacity-100'
        }`}
      >
        {/* Subtle radial emerald luminescent bloom */}
        <div className="absolute w-[380px] h-[380px] bg-emerald-500/10 blur-[100px] rounded-full pointer-events-none" />

        <div className="relative flex flex-col items-center text-center px-4 animate-in fade-in zoom-in-95 duration-500">
          {/* Brand Logo Badge + Brand Name Row */}
          <div className="flex items-center justify-center gap-3">
            <div className="w-10 h-10 md:w-11 md:h-11 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500 shadow-lg shadow-emerald-500/25">
              <Scale className="w-5 h-5 md:w-6 md:h-6 stroke-[2.2]" />
            </div>
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white font-sans">
              Fair Judge
            </h1>
          </div>

          {/* Refined Tagline */}
          <p className="text-xs md:text-sm font-medium text-emerald-400/90 tracking-wide mt-2">
            Transparency in Judgement
          </p>

          {/* Micro progress laser bar */}
          <div className="w-40 sm:w-48 h-[2px] bg-zinc-900 rounded-full overflow-hidden mt-8 border border-zinc-800/80">
            <div className="h-full bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full animate-boot-progress" />
          </div>

          {/* Version string */}
          <p className="text-[10px] font-mono text-zinc-500 tracking-wider mt-4">
            Fair Judge v12.10.0
          </p>
        </div>
      </div>
    );
  }

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
    <>
      <NetworkStatusIndicator />
      {renderScreenContent()}
    </>
  );
}
