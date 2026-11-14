import React, { useMemo } from 'react';
import { Lock, Scale } from 'lucide-react';
import {
  Organization,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
} from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';
import { BlindRankItem } from '../../lib/projectorService';

interface ProjectorScoreboardProps {
  organization: Organization | null;
  currentEvent: SupabaseEvent | undefined;
  judges: SupabaseJudge[];
  participants: SupabaseParticipant[];
  scores: SupabaseScore[];
  blindRanks?: BlindRankItem[];
  isStadiumWhite: boolean;
  isBlindMode: boolean;
}

export function ProjectorScoreboard({
  organization,
  currentEvent,
  judges,
  participants,
  scores,
  blindRanks = [],
  isStadiumWhite,
  isBlindMode,
}: ProjectorScoreboardProps) {
  const eventJudges = useMemo(() => {
    if (!currentEvent) return [];
    const assigned = new Set(currentEvent.assigned_judges || []);
    const matched = judges.filter(
      (j) => assigned.has(j.id) || (j.assigned_events || []).includes(currentEvent.id)
    );
    return matched.length > 0 ? matched : judges;
  }, [currentEvent, judges]);

  const assignedParticipants = useMemo(() => {
    if (!currentEvent) return [];
    const assignedIds = currentEvent.assigned_participants || [];
    if (assignedIds.length > 0) {
      return participants.filter((p) => assignedIds.includes(p.id));
    }
    return participants;
  }, [participants, currentEvent]);

  const eventScores = useMemo(() => {
    if (!currentEvent) return [];
    return scores.filter((s) => s.event_id === currentEvent.id);
  }, [scores, currentEvent]);

  const isServerBlind = useMemo(() => {
    if (!currentEvent) return false;
    const hasStrippedScore = eventScores.some(
      (s) => s.total_score === undefined || s.total_score === null
    );
    const hasEventBlindRanks = blindRanks.some((r) => r.event_id === currentEvent.id);
    return hasStrippedScore || (isBlindMode && hasEventBlindRanks);
  }, [currentEvent, eventScores, blindRanks, isBlindMode]);

  const rankedRows = useMemo(() => {
    if (!currentEvent) return [];
    if (isServerBlind) {
      const rankMap = new Map<string, BlindRankItem>();
      for (const r of blindRanks) {
        if (r.event_id === currentEvent.id) {
          rankMap.set(r.participant_id, r);
        }
      }
      const rows = assignedParticipants.map((p) => {
        const pScores = eventScores.filter((s) => s.participant_id === p.id);
        const br = rankMap.get(p.id);
        return {
          ...p,
          pScores,
          rank: br ? br.rank : 0,
          judgeCount: br ? br.judge_count : pScores.length,
          avgScore: 0,
        };
      });
      rows.sort((a, b) => {
        if (a.rank > 0 && b.rank > 0) return a.rank - b.rank;
        if (a.rank > 0) return -1;
        if (b.rank > 0) return 1;
        return a.name.localeCompare(b.name);
      });
      return rows;
    }

    return dbService.calculateRankings(
      assignedParticipants,
      eventScores,
      eventJudges.length || currentEvent.assigned_judges?.length || 0,
      organization?.tie_breaker_method || 'olympic'
    );
  }, [
    isServerBlind,
    blindRanks,
    assignedParticipants,
    eventScores,
    eventJudges.length,
    currentEvent,
    organization?.tie_breaker_method,
  ]);

  const scoreLookup = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const s of eventScores) {
      const rawVal = s.total_score;
      map.set(
        `${s.participant_id}::${s.judge_id}`,
        rawVal !== undefined && rawVal !== null ? Number(rawVal) : null
      );
    }
    return map;
  }, [eventScores]);

  if (!currentEvent) {
    return (
      <div
        className={`rounded-2xl border p-10 text-center font-mono text-[clamp(0.9rem,1.2vw,1.35rem)] ${
          isStadiumWhite
            ? 'bg-white border-stone-300 text-zinc-500'
            : 'bg-zinc-950 border-zinc-800 text-zinc-400'
        }`}
      >
        No events available for this screen.
      </div>
    );
  }

  return (
    <section aria-label="Per-Judge Scoreboard" className="w-full flex flex-col flex-1 min-h-0">
      <div className="text-center space-y-1 mb-5">
        <div className="inline-flex items-center gap-2 font-mono text-[clamp(0.75rem,1vw,1.05rem)] uppercase font-bold tracking-widest text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3.5 py-1 rounded-full border border-emerald-500/20">
          <span>{currentEvent.category || 'CHAMPIONSHIP'}</span>
          <span>—</span>
          <span>JUDGE SCOREBOARD</span>
        </div>
        <h1
          className={`text-[clamp(1.5rem,3vw,3.4rem)] font-black tracking-tight leading-tight uppercase ${
            isStadiumWhite ? 'text-zinc-950' : 'text-white'
          }`}
        >
          {currentEvent.name}
        </h1>
        <p
          className={`text-[clamp(0.75rem,0.95vw,1.05rem)] font-mono ${
            isStadiumWhite ? 'text-zinc-600' : 'text-zinc-400'
          }`}
        >
          Judges: <strong className={isStadiumWhite ? 'text-zinc-950' : 'text-white'}>{eventJudges.length}</strong>
          <span className="mx-2">•</span>
          Participants: <strong className={isStadiumWhite ? 'text-zinc-950' : 'text-white'}>{rankedRows.length}</strong>
          <span className="mx-2">•</span>
          Ballots: <strong className={isStadiumWhite ? 'text-emerald-700' : 'text-emerald-400'}>{eventScores.length}</strong>
        </p>
      </div>

      <div
        className={`rounded-2xl border overflow-hidden flex-1 flex flex-col min-h-0 ${
          isStadiumWhite
            ? 'bg-white border-stone-300 text-zinc-950 shadow-sm'
            : 'bg-zinc-950 border-zinc-800 text-white'
        }`}
      >
        <div className="overflow-x-auto overflow-y-auto max-h-[66vh] flex-1">
          <table className="w-full border-collapse text-left">
            <thead
              className={`sticky top-0 z-10 border-b ${
                isStadiumWhite
                  ? 'bg-stone-100 border-stone-300 text-zinc-700'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-300'
              }`}
            >
              <tr className="h-[52px] font-mono text-[clamp(0.7rem,0.9vw,1rem)] uppercase tracking-wider">
                <th className="px-4 font-black w-20">Rank</th>
                <th className="px-3 font-black w-20">SL</th>
                <th className="px-4 font-black min-w-[200px]">Contender</th>
                {eventJudges.map((j, idx) => (
                  <th
                    key={j.id}
                    className="px-3 font-black text-right whitespace-nowrap min-w-[84px]"
                    title={j.name}
                  >
                    <div className="truncate max-w-[110px] ml-auto">
                      {j.judge_id || `J${idx + 1}`}
                    </div>
                  </th>
                ))}
                <th className="px-4 font-black text-right whitespace-nowrap w-24">Total</th>
                <th className="px-4 font-black text-right whitespace-nowrap w-28">Avg</th>
              </tr>
            </thead>
            <tbody
              className={`divide-y ${
                isStadiumWhite ? 'divide-stone-200' : 'divide-zinc-800/80'
              }`}
            >
              {rankedRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={5 + eventJudges.length}
                    className="px-6 py-12 text-center font-mono text-sm text-zinc-500"
                  >
                    No participants assigned to this event.
                  </td>
                </tr>
              ) : (
                rankedRows.map((row) => {
                  const slDisplay =
                    currentEvent.participant_sl_numbers?.[row.id] || row.sl_no || '—';
                  const rowTotal = row.pScores.reduce(
                    (sum, s) => sum + Number(s.total_score || 0),
                    0
                  );
                  return (
                    <tr
                      key={row.id}
                      className={`h-[60px] ${
                        isStadiumWhite ? 'hover:bg-stone-50' : 'hover:bg-zinc-900/60'
                      }`}
                    >
                      <td className="px-4 font-mono font-black text-[clamp(0.9rem,1.15vw,1.35rem)] tabular-nums">
                        {row.rank > 0 ? `#${row.rank}` : '—'}
                      </td>
                      <td className="px-3 font-mono font-bold text-[clamp(0.8rem,1vw,1.15rem)] text-emerald-600 dark:text-emerald-400 tabular-nums">
                        {slDisplay}
                      </td>
                      <td className="px-4 max-w-[320px]">
                        <div className="font-bold text-[clamp(0.9rem,1.15vw,1.3rem)] truncate">
                          {row.name}
                        </div>
                        <div
                          className={`text-[clamp(0.7rem,0.85vw,0.95rem)] truncate ${
                            isStadiumWhite ? 'text-zinc-600' : 'text-zinc-400'
                          }`}
                        >
                          {row.school || 'Independent'}
                        </div>
                      </td>
                      {eventJudges.map((j) => {
                        const val = scoreLookup.get(`${row.id}::${j.id}`);
                        return (
                          <td
                            key={j.id}
                            className="px-3 text-right font-mono font-semibold text-[clamp(0.85rem,1.05vw,1.25rem)] tabular-nums whitespace-nowrap"
                          >
                            {val === undefined ? (
                              <span className="text-zinc-500">—</span>
                            ) : isBlindMode || val === null ? (
                              <Lock className="w-3.5 h-3.5 inline text-amber-500" />
                            ) : (
                              val
                            )}
                          </td>
                        );
                      })}
                      <td className="px-4 text-right font-mono font-bold text-[clamp(0.85rem,1.05vw,1.25rem)] tabular-nums whitespace-nowrap">
                        {row.judgeCount > 0 ? (
                          isBlindMode || isServerBlind ? (
                            <span className="text-amber-500 text-xs font-bold">AUDITED</span>
                          ) : (
                            Number(rowTotal.toFixed(2))
                          )
                        ) : (
                          <span className="text-zinc-500">—</span>
                        )}
                      </td>
                      <td className="px-4 text-right font-mono font-black text-[clamp(0.95rem,1.2vw,1.4rem)] text-emerald-600 dark:text-emerald-400 tabular-nums whitespace-nowrap">
                        {row.judgeCount > 0 ? (
                          isBlindMode || isServerBlind ? (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-500">
                              <Scale className="w-3.5 h-3.5" /> LOCK
                            </span>
                          ) : (
                            row.avgScore
                          )
                        ) : (
                          <span className="text-zinc-500 text-xs font-normal">PENDING</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
