import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  SlidersHorizontal,
  LayoutDashboard,
  MonitorPlay,
  Clock,
  ChevronUp,
  ChevronDown,
  WifiOff,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import {
  loadProjectorSession,
  saveProjectorSession,
  updateProjectorCursor,
  clearProjectorSession,
  loadProjectorSettings,
  saveProjectorSettings,
  StoredProjectorSession,
  ProjectorLocalSettings,
} from '../../lib/projector/projectorTokenStore';
import {
  projectorAppService,
  mergeProjectorDelta,
  ProjectorChangesResult,
} from '../../lib/projector/projectorAppService';
import { ProjectorEventState } from '../../lib/projector/projectorRanking';
import { saveProjectorDisplayPrefs, ProjectorOverscan } from '../../lib/projectorService';
import { ProjectorLoginScreen } from './ProjectorLoginScreen';
import { ProjectorSetupSection } from './ProjectorSetupSection';
import { ProjectorOverviewSection } from './ProjectorOverviewSection';
import { ProjectorLiveSection } from './ProjectorLiveSection';

type ProjectorSection = 'setup' | 'overview' | 'live';

const POLL_INTERVAL_MS = 30_000;

const EMPTY_STATE: ProjectorEventState = {
  org: null,
  event: null,
  participants: [],
  judges: [],
  scores: [],
};

function formatCountdown(expiresAt?: string): string {
  if (!expiresAt) return '8h 00m';
  const diffMs = Date.parse(expiresAt) - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return '0m';
  const totalMinutes = Math.ceil(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours <= 0) return `${mins}m`;
  return `${hours}h ${String(mins).padStart(2, '0')}m`;
}

export interface ProjectorRpcErrorState {
  code?: string;
  message: string;
}

export function computeProjectorPollConnectionState(result: ProjectorChangesResult): {
  isReconnecting: boolean;
  rpcError: ProjectorRpcErrorState | null;
} {
  if (result.ok) {
    return { isReconnecting: false, rpcError: null };
  }
  if (result.error === 'network_error') {
    return { isReconnecting: true, rpcError: null };
  }
  if (result.error === 'rpc_error') {
    return {
      isReconnecting: false,
      rpcError: {
        code: result.errorCode,
        message: result.message || 'Server error while loading scoreboard updates.',
      },
    };
  }
  return { isReconnecting: false, rpcError: null };
}

export interface ProjectorExitOptions {
  animate?: boolean;
  endToken?: string | null;
}

interface ProjectorAppProps {
  onExit: (options?: ProjectorExitOptions) => void | Promise<void>;
}

export function ProjectorApp({ onExit }: ProjectorAppProps) {
  const [session, setSession] = useState<StoredProjectorSession | null>(() => loadProjectorSession());
  const [settings, setSettings] = useState<ProjectorLocalSettings>(() => loadProjectorSettings());
  const [section, setSection] = useState<ProjectorSection>(() =>
    loadProjectorSession() ? 'live' : 'overview'
  );
  const [chromeHidden, setChromeHidden] = useState(false);

  const [eventState, setEventState] = useState<ProjectorEventState>(EMPTY_STATE);
  const [cursorVersion, setCursorVersion] = useState<number>(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [rpcError, setRpcError] = useState<ProjectorRpcErrorState | null>(null);
  const [eventEnded, setEventEnded] = useState(false);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [remainingLabel, setRemainingLabel] = useState<string>(() =>
    formatCountdown(loadProjectorSession()?.expiresAt)
  );

  // Refs prevent stale closures inside the 30s interval & visibility listener
  const cursorRef = useRef<number>(0);
  const hasHydratedRef = useRef<boolean>(false);
  const inFlightRef = useRef<boolean>(false);
  const isExitingRef = useRef<boolean>(false);

  const triggerAnimatedExit = useCallback(
    (callServerEnd: boolean) => {
      if (isExitingRef.current) return;
      isExitingRef.current = true;
      const activeToken = callServerEnd && !eventEnded ? session?.token || null : null;
      clearProjectorSession();
      cursorRef.current = 0;
      hasHydratedRef.current = false;
      void onExit({ animate: true, endToken: activeToken });
    },
    [session, eventEnded, onExit]
  );

  // Sync display theme/overscan to PublicLeaderboard display prefs on change
  useEffect(() => {
    const mappedOverscan: ProjectorOverscan =
      settings.overscan === 2 ? 2 : settings.overscan >= 4 ? 4 : 0;
    saveProjectorDisplayPrefs({
      overscan: mappedOverscan,
      segment: settings.liveMode === 'scoreboard' ? 'scoreboard' : 'leaderboard',
    });
  }, [settings.overscan, settings.liveMode]);

  // Keep screen awake on PCs/TVs while projector app is mounted
  useEffect(() => {
    let wakeLock: { release?: () => Promise<void> } | null = null;
    const requestWakeLock = async () => {
      try {
        const nav = navigator as Navigator & {
          wakeLock?: { request: (type: 'screen') => Promise<{ release?: () => Promise<void> }> };
        };
        if (nav.wakeLock?.request) {
          wakeLock = await nav.wakeLock.request('screen');
        }
      } catch {
        // Wake Lock is best-effort
      }
    };
    void requestWakeLock();
    return () => {
      try {
        void wakeLock?.release?.();
      } catch {
        // Ignore
      }
    };
  }, []);

  // Update 8-hour countdown label once per minute and auto-expire if elapsed
  useEffect(() => {
    if (!session || eventEnded) return;
    const updateTimer = () => {
      if (isExitingRef.current) return;
      const expMs = Date.parse(session.expiresAt);
      if (Number.isFinite(expMs) && expMs <= Date.now()) {
        triggerAnimatedExit(true);
        return;
      }
      setRemainingLabel(formatCountdown(session.expiresAt));
    };
    updateTimer();
    const id = window.setInterval(updateTimer, 30_000);
    return () => window.clearInterval(id);
  }, [session, eventEnded, triggerAnimatedExit]);

  const pollChanges = useCallback(async () => {
    if (!session || eventEnded || inFlightRef.current || isExitingRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

    inFlightRef.current = true;
    setIsSyncing(true);

    try {
      // First fetch after mount/reload uses cursor 0 to hydrate full single-event state
      const since = hasHydratedRef.current ? cursorRef.current : 0;
      const result = await projectorAppService.fetchChanges(session.token, since);
      if (isExitingRef.current) return;
      const nextConn = computeProjectorPollConnectionState(result);
      setIsReconnecting(nextConn.isReconnecting);
      setRpcError(nextConn.rpcError);

      if (!result.ok) {
        if (result.error === 'network_error' || result.error === 'rpc_error') {
          return;
        }
        if (result.error === 'replaced' || result.error === 'expired' || result.error === 'revoked') {
          triggerAnimatedExit(false);
          return;
        }
        if (result.error === 'event_ended') {
          clearProjectorSession();
          setEventEnded(true);
          setSection('live');
          return;
        }
        return;
      }

      const payload = result.payload!;
      setLastSyncedAt(new Date());

      if (payload.changed || payload.eventEnded || !hasHydratedRef.current) {
        setEventState((prev) => mergeProjectorDelta(prev, payload));
        hasHydratedRef.current = true;
      }

      cursorRef.current = payload.cursor;
      setCursorVersion(payload.cursor);

      if (payload.eventEnded) {
        // Server already revoked projector_token and freed the org_sessions slot after returning final delta
        clearProjectorSession();
        setEventEnded(true);
        setSection('live');
      } else {
        updateProjectorCursor(payload.cursor, payload.expiresAt);
        if (payload.expiresAt && payload.expiresAt !== session.expiresAt) {
          setSession((prev) => (prev ? { ...prev, expiresAt: payload.expiresAt! } : prev));
        }
      }
    } finally {
      inFlightRef.current = false;
      setIsSyncing(false);
    }
  }, [session, eventEnded, triggerAnimatedExit]);

  // 30-second cursor polling + immediate sync on tab focus / network reconnect
  useEffect(() => {
    if (!session || eventEnded) return;

    void pollChanges();
    const intervalId = window.setInterval(() => {
      void pollChanges();
    }, POLL_INTERVAL_MS);

    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        void pollChanges();
      }
    };

    window.addEventListener('online', handleResume);
    document.addEventListener('visibilitychange', handleResume);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('online', handleResume);
      document.removeEventListener('visibilitychange', handleResume);
    };
  }, [session, eventEnded, pollChanges]);

  const handleAuthenticated = useCallback((newSession: StoredProjectorSession) => {
    isExitingRef.current = false;
    const stored = saveProjectorSession(newSession);
    cursorRef.current = 0;
    hasHydratedRef.current = false;
    setCursorVersion(0);
    setEventState(EMPTY_STATE);
    setEventEnded(false);
    setIsReconnecting(false);
    setRpcError(null);
    setLastSyncedAt(null);
    setLoginNotice(null);
    setRemainingLabel(formatCountdown(stored.expiresAt));
    setSession(stored);
    setSection('overview');
  }, []);

  const handleUpdateSettings = useCallback((patch: Partial<ProjectorLocalSettings>) => {
    setSettings(saveProjectorSettings(patch));
  }, []);

  const handleEndAndExit = useCallback(() => {
    triggerAnimatedExit(true);
  }, [triggerAnimatedExit]);

  // When not signed in (and not holding ended final results on screen), render Login Screen
  if (!session && !eventEnded) {
    return (
      <ProjectorLoginScreen
        notice={loginNotice}
        onDismissNotice={() => setLoginNotice(null)}
        onAuthenticated={handleAuthenticated}
        onExit={() => void onExit({ animate: false })}
      />
    );
  }

  return (
    <div className="min-h-[100dvh] w-full flex flex-col bg-zinc-950 text-zinc-100">
      {/* Compact 3-Section Top Navigation Bar (collapsible in Live View for unobstructed projection) */}
      {!(section === 'live' && chromeHidden) ? (
        <header className="sticky top-0 z-40 bg-zinc-950/95 border-b border-zinc-800 px-3 sm:px-5 py-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setSection('setup')}
              className={`inline-flex items-center gap-1.5 min-h-[38px] px-3 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                section === 'setup'
                  ? 'bg-emerald-600 text-white'
                  : 'text-zinc-300 hover:bg-zinc-900'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              <span>Setup &amp; Settings</span>
            </button>

            <button
              type="button"
              onClick={() => setSection('overview')}
              className={`inline-flex items-center gap-1.5 min-h-[38px] px-3 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                section === 'overview'
                  ? 'bg-emerald-600 text-white'
                  : 'text-zinc-300 hover:bg-zinc-900'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              <span>Overview</span>
            </button>

            <button
              type="button"
              onClick={() => setSection('live')}
              className={`inline-flex items-center gap-1.5 min-h-[38px] px-3 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                section === 'live'
                  ? 'bg-emerald-600 text-white'
                  : 'text-zinc-300 hover:bg-zinc-900'
              }`}
            >
              <MonitorPlay className="w-3.5 h-3.5" />
              <span>Live View</span>
            </button>
          </div>

          <div className="flex items-center gap-2.5 text-xs">
            {eventEnded ? (
              <span className="inline-flex items-center gap-1 text-emerald-400 font-semibold">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Final results</span>
              </span>
            ) : isReconnecting ? (
              <span className="inline-flex items-center gap-1 text-amber-400 font-semibold">
                <WifiOff className="w-3.5 h-3.5" />
                <span>Reconnecting</span>
              </span>
            ) : (
              <span className="hidden sm:inline-flex items-center gap-1 text-zinc-400 tabular-nums">
                <Clock className="w-3.5 h-3.5" />
                <span>{remainingLabel}</span>
              </span>
            )}

            {section === 'live' && (
              <button
                type="button"
                onClick={() => setChromeHidden(true)}
                title="Hide top bar for clean projection"
                className="inline-flex items-center gap-1 min-h-[34px] px-2.5 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-600 text-[11px] font-bold text-zinc-300 cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Hide bar</span>
              </button>
            )}
          </div>
        </header>
      ) : (
        <button
          type="button"
          onClick={() => setChromeHidden(false)}
          aria-label="Show projector controls"
          className="fixed top-2 right-2 z-50 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-950/75 hover:bg-zinc-900 border border-zinc-700/70 text-[11px] font-bold text-zinc-200 cursor-pointer opacity-60 hover:opacity-100 transition-opacity"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          <span>Controls</span>
        </button>
      )}

      {/* Server / RPC Error Notice (distinct from network Reconnecting; keeps current standings on screen) */}
      {!eventEnded && rpcError && (
        <div
          role="alert"
          data-testid="projector-rpc-error-banner"
          className="w-full bg-rose-950/95 border-b border-rose-500/40 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-rose-100 z-30"
        >
          <div className="flex items-center gap-2 text-xs sm:text-sm font-semibold min-w-0">
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
            <span className="truncate">
              Update failed{rpcError.code ? ` (${rpcError.code})` : ''}: {rpcError.message}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void pollChanges()}
            disabled={isSyncing}
            className="inline-flex items-center gap-1.5 min-h-[34px] px-3.5 rounded-lg bg-rose-700 hover:bg-rose-600 text-white text-xs font-bold transition-colors cursor-pointer disabled:opacity-50 shrink-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
            <span>{isSyncing ? 'Retrying...' : 'Retry'}</span>
          </button>
        </div>
      )}

      {/* Active Section */}
      <main className="flex-1 flex flex-col min-h-0">
        {section === 'setup' && (
          <ProjectorSetupSection
            session={session}
            settings={settings}
            onUpdateSettings={handleUpdateSettings}
            lastSyncedAt={lastSyncedAt}
            cursorVersion={cursorVersion}
            remainingLabel={remainingLabel}
            isSyncing={isSyncing}
            isReconnecting={isReconnecting}
            eventEnded={eventEnded}
            onSyncNow={() => void pollChanges()}
            onSwitchEvent={handleEndAndExit}
            onEndSession={handleEndAndExit}
            onOpenLiveView={() => setSection('live')}
          />
        )}

        {section === 'overview' && (
          <ProjectorOverviewSection
            state={eventState}
            hideScores={settings.hideScores}
            remainingLabel={remainingLabel}
            lastSyncedAt={lastSyncedAt}
            eventEnded={eventEnded}
            onOpenLiveView={() => setSection('live')}
            onSignInAnotherEvent={handleEndAndExit}
          />
        )}

        {section === 'live' && (
          <ProjectorLiveSection
            state={eventState}
            settings={settings}
            isReconnecting={isReconnecting}
            eventEnded={eventEnded}
            onBackToOverview={() => {
              setChromeHidden(false);
              setSection('overview');
            }}
            onSignInAnotherEvent={handleEndAndExit}
          />
        )}
      </main>
    </div>
  );
}
