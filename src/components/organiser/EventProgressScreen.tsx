import React, { useMemo } from 'react';
import { Users } from 'lucide-react';
import { TaskScreen } from '../common/TaskScreen';
import {
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
} from '../../lib/supabaseTypes';
import { computeEventProgress } from '../../lib/rules';

export interface EventProgressScreenProps {
  event: SupabaseEvent | null;
  orgJudges: SupabaseJudge[];
  orgParticipants: SupabaseParticipant[];
  eventScores: SupabaseScore[];
  blindJudgingEnabled: boolean;
  getParticipantDisplayName: (participant: SupabaseParticipant, event?: SupabaseEvent) => string;
  onClose: () => void;
}

function formatCleanScore(value: number): string {
  const rounded = Number(value.toFixed(2));
  return String(rounded);
}

function renderStatusBadge(status: SupabaseEvent['status']) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] lg:text-xs font-black bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        LIVE
      </span>
    );
  }
  if (status === 'paused') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] lg:text-xs font-black bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        PAUSED
      </span>
    );
  }
  if (status === 'ended' || status === 'archived') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] lg:text-xs font-black bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20 shrink-0">
        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
        ENDED
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] lg:text-xs font-black bg-stone-100 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300 border border-stone-200 dark:border-zinc-700 shrink-0">
      <span className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-zinc-500" />
      UPCOMING
    </span>
  );
}

export function EventProgressScreen({
  event,
  orgJudges,
  orgParticipants,
  eventScores,
  blindJudgingEnabled,
  getParticipantDisplayName,
  onClose,
}: EventProgressScreenProps) {
  const progress = useMemo(() => {
    if (!event) return null;
    return computeEventProgress({
      event,
      orgJudges,
      orgParticipants,
      eventScores,
    });
  }, [event, orgJudges, orgParticipants, eventScores]);

  if (!event || !progress) {
    return null;
  }

  const isBlind = Boolean(
    blindJudgingEnabled ||
      (event as unknown as { blind_judging_enabled?: boolean })?.blind_judging_enabled
  );
  const isLiveOrPaused = event.status === 'active' || event.status === 'paused';

  return (
    <TaskScreen
      isOpen={Boolean(event)}
      title={event.name}
      subtitle={`${event.category || 'General'} · Read-only progress`}
      titleBadge={renderStatusBadge(event.status)}
      onBack={onClose}
      backLabel="Back"
    >
      {/* Summary Card */}
      <section className="rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 p-4 space-y-3 shadow-xs">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm font-bold text-stone-900 dark:text-white tabular-nums">
            Ballots: {progress.counts.completedBallots} of {progress.counts.totalBallots} done
          </div>
          <div className="text-xs font-semibold text-stone-500 dark:text-zinc-400 tabular-nums">
            {progress.counts.total}{' '}
            {progress.counts.total === 1 ? 'participant' : 'participants'}
          </div>
        </div>

        {/* Status Breakdown Counts */}
        <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 tabular-nums">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
            {progress.counts.scored} Scored
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20 tabular-nums">
            <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
            {progress.counts.partial} Partial
          </span>
          {progress.isEnded ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-rose-500/10 text-rose-700 dark:text-rose-400 border border-rose-500/20 tabular-nums">
              <span className="w-2 h-2 rounded-full bg-rose-500 shrink-0" />
              {progress.counts.absent} Absent
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-stone-100 dark:bg-zinc-900 text-stone-600 dark:text-zinc-300 border border-stone-200 dark:border-zinc-800 tabular-nums">
              <span className="w-2 h-2 rounded-full bg-stone-400 dark:bg-zinc-500 shrink-0" />
              {progress.counts.upcoming} Upcoming
            </span>
          )}
        </div>

        {/* Compact Judge Legend */}
        <div className="pt-2.5 border-t border-stone-100 dark:border-zinc-800/80">
          {progress.assignedJudges.length === 0 ? (
            <p className="text-xs text-stone-500 dark:text-zinc-400">
              No active judges assigned to this event yet.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] lg:text-xs text-stone-600 dark:text-zinc-400">
              <span className="font-bold text-stone-500 dark:text-zinc-500 uppercase tracking-wider text-[10px]">
                Judges:
              </span>
              {progress.assignedJudges.map((j) => (
                <span key={j.judgeId} className="inline-flex items-center gap-1">
                  <span className="font-mono font-bold text-stone-800 dark:text-zinc-200">
                    {j.code}
                  </span>
                  <span>=</span>
                  <span>{j.name}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {isLiveOrPaused && (
          <p className="text-[11px] lg:text-xs text-stone-500 dark:text-zinc-400 pt-0.5">
            Updates automatically as judge devices sync.
          </p>
        )}
      </section>

      {/* Participant Progress List */}
      <section className="space-y-2.5">
        {progress.rows.length === 0 ? (
          <div className="rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 p-8 text-center space-y-2">
            <div className="w-10 h-10 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-stone-400 dark:text-zinc-500 flex items-center justify-center mx-auto">
              <Users className="w-5 h-5" />
            </div>
            <p className="text-sm font-bold text-stone-800 dark:text-zinc-200">
              No participants enrolled
            </p>
            <p className="text-xs text-stone-500 dark:text-zinc-400">
              Enrol participants in the Events tab to track judging progress here.
            </p>
          </div>
        ) : (
          progress.rows.map((row) => {
            const dotClass =
              row.status === 'scored'
                ? 'bg-emerald-500'
                : row.status === 'partial'
                ? 'bg-amber-500'
                : row.status === 'absent'
                ? 'bg-rose-500'
                : 'bg-stone-400 dark:bg-zinc-500';

            const statusLabel =
              row.status === 'scored'
                ? 'Fully scored'
                : row.status === 'partial'
                ? 'Partially scored'
                : row.status === 'absent'
                ? 'Absent'
                : 'Upcoming';

            return (
              <div
                key={row.id}
                className="rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 p-3.5 space-y-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <span
                      className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${dotClass}`}
                      aria-label={statusLabel}
                      title={statusLabel}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[11px] font-mono font-bold text-stone-400 dark:text-zinc-500 shrink-0 tabular-nums">
                          #{row.orderNumber}
                        </span>
                        <span className="text-sm font-bold text-stone-900 dark:text-white truncate">
                          {getParticipantDisplayName(row.participant, event)}
                        </span>
                      </div>

                      {(!isBlind || row.status === 'absent') && (
                        <div className="text-[11px] lg:text-xs text-stone-500 dark:text-zinc-400 mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                          {!isBlind && (
                            <span className={row.participant.school ? 'truncate' : 'italic text-stone-400 dark:text-zinc-500'}>
                              {row.participant.school || 'No school'}
                            </span>
                          )}
                          {row.status === 'absent' && (
                            <>
                              {!isBlind && <span aria-hidden="true">·</span>}
                              <span className="font-semibold text-rose-600 dark:text-rose-400">
                                Excluded from ranking
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right-aligned Total / -- / Absent */}
                  <div className="text-right shrink-0">
                    {row.status === 'scored' && (
                      <span className="text-sm font-black font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCleanScore(row.totalScore)}
                      </span>
                    )}
                    {row.status === 'partial' && (
                      <span className="text-sm font-black font-mono tabular-nums text-amber-600 dark:text-amber-400">
                        {formatCleanScore(row.totalScore)}
                      </span>
                    )}
                    {row.status === 'upcoming' && (
                      <span className="text-sm font-bold font-mono text-stone-400 dark:text-zinc-500">
                        --
                      </span>
                    )}
                    {row.status === 'absent' && (
                      <span className="text-xs font-bold text-rose-600 dark:text-rose-400">
                        Absent
                      </span>
                    )}
                  </div>
                </div>

                {/* Per-Judge Chips */}
                {row.judgeStates.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5 pl-5">
                    {row.judgeStates.map((chip) => (
                      <span
                        key={chip.judgeId}
                        title={`${chip.name}: ${chip.scored ? 'Scored' : 'Not scored'}`}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono font-bold border ${
                          chip.scored
                            ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/25'
                            : 'bg-stone-100 dark:bg-zinc-900 text-stone-500 dark:text-zinc-400 border-stone-200 dark:border-zinc-800'
                        }`}
                      >
                        <span>{chip.code}</span>
                        <span aria-hidden="true">{chip.scored ? '✓' : '–'}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="pl-5 text-[11px] text-stone-400 dark:text-zinc-500">
                    No judges assigned
                  </div>
                )}
              </div>
            );
          })
        )}
      </section>
    </TaskScreen>
  );
}
