import React, { useMemo } from 'react';
import { CheckCircle2, WifiOff, ArrowLeft, LogIn } from 'lucide-react';
import {
  ProjectorEventState,
  buildLiveViewSnapshot,
  isEventProvisional,
} from '../../lib/projector/projectorRanking';
import { ProjectorLocalSettings } from '../../lib/projector/projectorTokenStore';
import { PublicLeaderboard } from '../public/PublicLeaderboard';
import { ProjectorScoreboard } from '../public/ProjectorScoreboard';

interface ProjectorLiveSectionProps {
  state: ProjectorEventState;
  settings: ProjectorLocalSettings;
  isReconnecting: boolean;
  eventEnded: boolean;
  onBackToOverview: () => void;
  onSignInAnotherEvent: () => void;
}

export function ProjectorLiveSection({
  state,
  settings,
  isReconnecting,
  eventEnded,
  onBackToOverview,
  onSignInAnotherEvent,
}: ProjectorLiveSectionProps) {
  const snapshot = useMemo(
    () => buildLiveViewSnapshot(state, settings.hideScores),
    [state, settings.hideScores]
  );

  const isStadiumWhite = settings.theme === 'light';
  const showFinalNotice = eventEnded || (state.event ? !isEventProvisional(state.event) : false);

  if (!snapshot) {
    return (
      <div className="flex-1 flex items-center justify-center p-8 text-center">
        <div className="space-y-2">
          <p className="text-base font-bold text-white">Loading live scoreboard...</p>
          <p className="text-xs text-zinc-400">Syncing event rows from Fair Judge.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      {showFinalNotice && (
        <div
          role="status"
          data-testid="projector-final-results-banner"
          className="w-full bg-emerald-950/95 border-b border-emerald-500/40 px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-emerald-100 z-30"
        >
          <div className="flex items-center gap-2 text-xs sm:text-sm font-bold">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              Final results — this event has ended. Projector session closed and session slot freed.
            </span>
          </div>
          <button
            type="button"
            onClick={onSignInAnotherEvent}
            className="inline-flex items-center gap-1.5 min-h-[34px] px-3.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-colors cursor-pointer shrink-0"
          >
            <LogIn className="w-3.5 h-3.5" />
            <span>Sign in for another event</span>
          </button>
        </div>
      )}

      {!showFinalNotice && isReconnecting && (
        <div
          role="status"
          className="w-full bg-amber-950/95 border-b border-amber-500/40 px-4 py-2 flex items-center justify-center gap-2 text-xs font-semibold text-amber-200 z-30"
        >
          <WifiOff className="w-3.5 h-3.5 text-amber-400" />
          <span>Connection interrupted — keeping last synced standings on screen and retrying...</span>
        </div>
      )}

      {settings.liveMode === 'scoreboard' ? (
        <div
          className={`flex-1 flex flex-col min-h-[calc(100dvh-56px)] ${
            isStadiumWhite ? 'bg-white text-slate-950' : 'bg-[#09090B] text-white'
          }`}
          style={
            settings.overscan > 0
              ? { padding: `${settings.overscan}vh ${settings.overscan}vw` }
              : undefined
          }
        >
          <div className="px-5 py-3.5 flex items-center justify-between gap-3 border-b border-zinc-800/40">
            <div className="min-w-0">
              <div className="text-xs font-mono uppercase tracking-wider opacity-70 truncate">
                {snapshot.org.name}
              </div>
              <div className="text-lg font-extrabold truncate">{snapshot.events[0]?.name}</div>
            </div>
            <button
              type="button"
              onClick={onBackToOverview}
              className={`inline-flex items-center gap-1.5 min-h-[36px] px-3 rounded-lg text-xs font-bold cursor-pointer border ${
                isStadiumWhite
                  ? 'border-slate-300 text-slate-800 hover:bg-slate-100'
                  : 'border-zinc-700 text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Overview</span>
            </button>
          </div>

          <div className="flex-1 p-4 sm:p-6 overflow-auto">
            <ProjectorScoreboard
              organization={snapshot.org}
              currentEvent={snapshot.events[0]}
              judges={snapshot.judges}
              participants={snapshot.participants}
              scores={snapshot.scores}
              blindRanks={[]}
              isStadiumWhite={isStadiumWhite}
              isBlindMode={settings.hideScores}
            />
          </div>
        </div>
      ) : (
        <div
          className="flex-1 flex flex-col min-h-0"
          style={
            settings.overscan > 0
              ? { padding: `${settings.overscan}vh ${settings.overscan}vw` }
              : undefined
          }
        >
          <PublicLeaderboard
            snapshot={snapshot}
            isReconnecting={isReconnecting}
            onExit={onBackToOverview}
          />
        </div>
      )}
    </div>
  );
}
