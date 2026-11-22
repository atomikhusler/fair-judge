import React, { useState, useEffect } from 'react';
import {
  Sun,
  Moon,
  Trophy,
  Table2,
  EyeOff,
  Eye,
  Maximize,
  Minimize,
  RefreshCw,
  LogOut,
  ArrowLeftRight,
  Clock,
  Wifi,
  WifiOff,
  Monitor,
  CheckCircle2,
} from 'lucide-react';
import {
  ProjectorLocalSettings,
  ProjectorOverscanPercent,
  StoredProjectorSession,
} from '../../lib/projector/projectorTokenStore';

interface ProjectorSetupSectionProps {
  session: StoredProjectorSession | null;
  settings: ProjectorLocalSettings;
  onUpdateSettings: (patch: Partial<ProjectorLocalSettings>) => void;
  lastSyncedAt: Date | null;
  cursorVersion: number;
  remainingLabel: string;
  isSyncing: boolean;
  isReconnecting: boolean;
  eventEnded: boolean;
  onSyncNow: () => void;
  onSwitchEvent: () => void;
  onEndSession: () => void;
  onOpenLiveView: () => void;
}

const OVERSCAN_OPTIONS: ProjectorOverscanPercent[] = [0, 2, 4, 6];

export function ProjectorSetupSection({
  session,
  settings,
  onUpdateSettings,
  lastSyncedAt,
  cursorVersion,
  remainingLabel,
  isSyncing,
  isReconnecting,
  eventEnded,
  onSyncNow,
  onSwitchEvent,
  onEndSession,
  onOpenLiveView,
}: ProjectorSetupSectionProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const syncFs = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    syncFs();
    document.addEventListener('fullscreenchange', syncFs);
    return () => document.removeEventListener('fullscreenchange', syncFs);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Ignore fullscreen denial in restricted iframes
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-white">
            Setup &amp; Settings
          </h1>
          <p className="text-sm text-zinc-400 mt-1">
            Configure this screen before switching to Live View. Preferences stay local to this browser tab.
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenLiveView}
          className="inline-flex items-center justify-center gap-2 min-h-[44px] px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold transition-colors cursor-pointer shrink-0"
        >
          <Monitor className="w-4 h-4" />
          <span>Open Live View</span>
        </button>
      </div>

      {/* Display Controls Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Display Theme */}
        <section className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-5 space-y-3">
          <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
            Stage Theme
          </h2>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => onUpdateSettings({ theme: 'dark' })}
              className={`min-h-[48px] px-3.5 rounded-xl border text-sm font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                settings.theme === 'dark'
                  ? 'bg-emerald-500/15 border-emerald-500 text-emerald-300'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Moon className="w-4 h-4" />
              <span>Dark Stage</span>
            </button>
            <button
              type="button"
              onClick={() => onUpdateSettings({ theme: 'light' })}
              className={`min-h-[48px] px-3.5 rounded-xl border text-sm font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                settings.theme === 'light'
                  ? 'bg-emerald-500/15 border-emerald-500 text-emerald-300'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Sun className="w-4 h-4" />
              <span>Stadium White</span>
            </button>
          </div>
        </section>

        {/* Live View Mode */}
        <section className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-5 space-y-3">
          <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
            Live View Layout
          </h2>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => onUpdateSettings({ liveMode: 'leaderboard' })}
              className={`min-h-[48px] px-3.5 rounded-xl border text-sm font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                settings.liveMode === 'leaderboard'
                  ? 'bg-emerald-500/15 border-emerald-500 text-emerald-300'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Trophy className="w-4 h-4" />
              <span>Leaderboard</span>
            </button>
            <button
              type="button"
              onClick={() => onUpdateSettings({ liveMode: 'scoreboard' })}
              className={`min-h-[48px] px-3.5 rounded-xl border text-sm font-bold flex items-center justify-center gap-2 transition-colors cursor-pointer ${
                settings.liveMode === 'scoreboard'
                  ? 'bg-emerald-500/15 border-emerald-500 text-emerald-300'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Table2 className="w-4 h-4" />
              <span>Scoreboard</span>
            </button>
          </div>
        </section>

        {/* Local Hide Scores Toggle */}
        <section className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
                Hide Numeric Scores
              </h2>
              <p className="text-xs text-zinc-400 mt-1">
                Local display toggle only. Rankings still compute live and contender names stay visible.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={settings.hideScores}
              onClick={() => onUpdateSettings({ hideScores: !settings.hideScores })}
              className={`min-h-[40px] px-3.5 rounded-xl border text-xs font-bold flex items-center gap-2 shrink-0 transition-colors cursor-pointer ${
                settings.hideScores
                  ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                  : 'bg-zinc-950 border-zinc-800 text-zinc-300 hover:border-zinc-600'
              }`}
            >
              {settings.hideScores ? (
                <>
                  <EyeOff className="w-4 h-4" />
                  <span>Hidden</span>
                </>
              ) : (
                <>
                  <Eye className="w-4 h-4" />
                  <span>Visible</span>
                </>
              )}
            </button>
          </div>
        </section>

        {/* Overscan & Fullscreen */}
        <section className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-5 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
              Screen Safe Margin &amp; Fullscreen
            </h2>
            <button
              type="button"
              onClick={() => void toggleFullscreen()}
              className="inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg bg-zinc-950 border border-zinc-700 hover:border-zinc-500 text-xs font-bold text-zinc-200 cursor-pointer"
            >
              {isFullscreen ? <Minimize className="w-3.5 h-3.5" /> : <Maximize className="w-3.5 h-3.5" />}
              <span>{isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}</span>
            </button>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {OVERSCAN_OPTIONS.map((pct) => (
              <button
                key={pct}
                type="button"
                onClick={() => onUpdateSettings({ overscan: pct })}
                className={`min-h-[42px] rounded-xl border text-xs font-mono font-bold transition-colors cursor-pointer ${
                  settings.overscan === pct
                    ? 'bg-emerald-500/15 border-emerald-500 text-emerald-300'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {pct}%
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Connection & Session Control Card */}
      <section className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
              Connection &amp; Session
            </h2>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-zinc-300">
              <span className="inline-flex items-center gap-1.5">
                {eventEnded ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-300 font-semibold">Event ended (final results locked)</span>
                  </>
                ) : isReconnecting ? (
                  <>
                    <WifiOff className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-amber-300 font-semibold">Reconnecting...</span>
                  </>
                ) : (
                  <>
                    <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Polling every 30 seconds (delta cursor v{cursorVersion})</span>
                  </>
                )}
              </span>

              {lastSyncedAt && (
                <span className="text-zinc-400 tabular-nums">
                  Last update: {lastSyncedAt.toLocaleTimeString()}
                </span>
              )}

              {!eventEnded && (
                <span className="inline-flex items-center gap-1 text-zinc-400 tabular-nums">
                  <Clock className="w-3.5 h-3.5" />
                  <span>{remainingLabel} remaining (8h max)</span>
                </span>
              )}
            </div>
          </div>

          {!eventEnded && (
            <button
              type="button"
              onClick={onSyncNow}
              disabled={isSyncing}
              className="inline-flex items-center justify-center gap-2 min-h-[42px] px-4 rounded-xl bg-zinc-950 border border-zinc-700 hover:border-zinc-500 text-xs font-bold text-zinc-100 cursor-pointer disabled:opacity-50 shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
              <span>{isSyncing ? 'Checking...' : 'Check for updates now'}</span>
            </button>
          )}
        </div>

        <div className="pt-4 border-t border-zinc-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="text-xs text-zinc-400">
            <span className="font-semibold text-zinc-200">{session?.orgName || 'Organisation'}</span>
            {session?.eventName ? ` · ${session.eventName}` : ''}
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={onSwitchEvent}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-bold transition-colors cursor-pointer"
            >
              <ArrowLeftRight className="w-4 h-4" />
              <span>Switch Event</span>
            </button>

            <button
              type="button"
              onClick={onEndSession}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-xl bg-rose-700 hover:bg-rose-600 text-white text-xs font-bold transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" />
              <span>End Projector Session</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
