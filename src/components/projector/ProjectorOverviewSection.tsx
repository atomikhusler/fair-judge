import React, { useMemo } from 'react';
import {
  Monitor,
  Users,
  Scale,
  Clock,
  CheckCircle2,
  ClipboardCheck,
  AlertTriangle,
  EyeOff,
} from 'lucide-react';
import {
  ProjectorEventState,
  computeProjectorOverview,
  computeProjectorRankings,
} from '../../lib/projector/projectorRanking';

interface ProjectorOverviewSectionProps {
  state: ProjectorEventState;
  hideScores: boolean;
  remainingLabel: string;
  lastSyncedAt: Date | null;
  eventEnded: boolean;
  onOpenLiveView: () => void;
  onSignInAnotherEvent: () => void;
}

export function ProjectorOverviewSection({
  state,
  hideScores,
  remainingLabel,
  lastSyncedAt,
  eventEnded,
  onOpenLiveView,
  onSignInAnotherEvent,
}: ProjectorOverviewSectionProps) {
  const metrics = useMemo(() => computeProjectorOverview(state), [state]);
  const topStandings = useMemo(() => computeProjectorRankings(state).slice(0, 5), [state]);

  const showFinal = eventEnded || metrics.isEnded;
  const tieBreakerLabel = state.org?.tie_breaker_enabled
    ? `Active (${state.org.tie_breaker_method || 'olympic'})`
    : 'Off (shared rank on ties)';

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8 space-y-6">
      {/* Header Banner */}
      <div className="rounded-2xl bg-zinc-900/90 border border-zinc-800 p-5 sm:p-6 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="space-y-1.5 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
              {state.org?.name || 'Organisation'}
            </span>
            {showFinal ? (
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-[11px] font-bold uppercase tracking-wider text-emerald-300">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Final results
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-[11px] font-bold uppercase tracking-wider text-amber-300">
                <AlertTriangle className="w-3.5 h-3.5" />
                Provisional
              </span>
            )}
          </div>

          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-white truncate">
            {state.event?.name || 'Loading event...'}
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
            {state.event?.category && <span>{state.event.category}</span>}
            {!showFinal && (
              <span className="inline-flex items-center gap-1 tabular-nums">
                <Clock className="w-3.5 h-3.5" />
                <span>Session: {remainingLabel} left</span>
              </span>
            )}
            {lastSyncedAt && (
              <span className="tabular-nums">Updated {lastSyncedAt.toLocaleTimeString()}</span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {showFinal && (
            <button
              type="button"
              onClick={onSignInAnotherEvent}
              className="min-h-[44px] px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs font-bold transition-colors cursor-pointer"
            >
              Sign in for another event
            </button>
          )}
          <button
            type="button"
            onClick={onOpenLiveView}
            className="inline-flex items-center gap-2 min-h-[44px] px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-bold transition-colors cursor-pointer"
          >
            <Monitor className="w-4 h-4" />
            <span>Open Live View</span>
          </button>
        </div>
      </div>

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-zinc-400">
            <Users className="w-3.5 h-3.5 text-emerald-400" />
            <span>Contenders</span>
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-white">
            {metrics.scoredContenders}
            <span className="text-base font-semibold text-zinc-500"> / {metrics.totalContenders}</span>
          </div>
          <p className="text-xs text-zinc-400">
            {metrics.waitingContenders === 0
              ? 'All contenders scored'
              : `${metrics.waitingContenders} waiting for first score`}
          </p>
        </div>

        <div className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-zinc-400">
            <ClipboardCheck className="w-3.5 h-3.5 text-sky-400" />
            <span>Ballots</span>
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-white">
            {metrics.totalBallots}
            <span className="text-base font-semibold text-zinc-500"> / {metrics.expectedBallots}</span>
          </div>
          <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden mt-1">
            <div
              className="h-full bg-emerald-500 transition-all duration-300"
              style={{ width: `${metrics.completionPercent}%` }}
            />
          </div>
        </div>

        <div className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-zinc-400">
            <CheckCircle2 className="w-3.5 h-3.5 text-amber-400" />
            <span>Judges</span>
          </div>
          <div className="text-2xl font-extrabold tabular-nums text-white">
            {metrics.totalJudges}
          </div>
          <p className="text-xs text-zinc-400">Assigned to this event</p>
        </div>

        <div className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-4 space-y-1">
          <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-zinc-400">
            <Scale className="w-3.5 h-3.5 text-violet-400" />
            <span>Tie-Breaker</span>
          </div>
          <div className="text-sm font-bold text-white pt-1">{tieBreakerLabel}</div>
          <p className="text-xs text-zinc-400">Computed locally on projector</p>
        </div>
      </div>

      {/* Two-column detail: Judge Ballot Progress + Top 5 Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-5 space-y-3">
          <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
            Judge Ballot Progress
          </h2>
          {metrics.judgeProgress.length === 0 ? (
            <p className="text-xs text-zinc-500 py-4">No active judges assigned yet.</p>
          ) : (
            <div className="space-y-3">
              {metrics.judgeProgress.map(({ judge, ballotsCast, expected }) => {
                const pct = expected > 0 ? Math.min(100, Math.round((ballotsCast / expected) * 100)) : 0;
                return (
                  <div key={judge.id} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-zinc-200 truncate">{judge.name}</span>
                      <span className="font-mono text-zinc-400 tabular-nums">
                        {ballotsCast} / {expected} ({pct}%)
                      </span>
                    </div>
                    <div className="w-full h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          pct >= 100 ? 'bg-emerald-500' : 'bg-sky-500'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-2xl bg-zinc-900/80 border border-zinc-800 p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
              Current Top 5 Preview
            </h2>
            {hideScores && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-300">
                <EyeOff className="w-3.5 h-3.5" />
                Scores hidden
              </span>
            )}
          </div>
          {topStandings.length === 0 ? (
            <p className="text-xs text-zinc-500 py-4">
              Waiting for the first judge scores to arrive.
            </p>
          ) : (
            <div className="divide-y divide-zinc-800">
              {topStandings.map((item) => (
                <div
                  key={item.id}
                  className="py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="w-7 h-7 rounded-lg bg-zinc-800 text-zinc-200 font-mono text-xs font-bold flex items-center justify-center shrink-0">
                      #{item.rank}
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-white truncate">
                        {item.name}
                      </div>
                      <div className="text-xs text-zinc-400 truncate">
                        {item.school || item.identity_id || 'Contender'}
                      </div>
                    </div>
                  </div>
                  <div className="text-right font-mono text-sm font-bold text-emerald-400 tabular-nums shrink-0">
                    {hideScores ? '—' : item.avgScore.toFixed(2)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
