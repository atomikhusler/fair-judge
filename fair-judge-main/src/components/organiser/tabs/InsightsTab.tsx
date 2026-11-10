import React, { useState, useEffect } from 'react';
import { BarChart3, TrendingUp, Users, Scale, Award, PieChart, Sparkles } from 'lucide-react';
import { Organization, SupabaseEvent, SupabaseScore, SupabaseParticipant, SupabaseJudge } from '../../../lib/supabaseTypes';
import { dbService } from '../../../lib/supabase';

interface InsightsTabProps {
  organization: Organization;
}

export function InsightsTab({ organization }: InsightsTabProps) {
  const [events, setEvents] = useState<SupabaseEvent[]>([]);
  const [participants, setParticipants] = useState<SupabaseParticipant[]>([]);
  const [judges, setJudges] = useState<SupabaseJudge[]>([]);
  const [allScores, setAllScores] = useState<SupabaseScore[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      dbService.getEvents(organization.org_id),
      dbService.getParticipants(organization.org_id),
      dbService.getJudges(organization.org_id),
    ]).then(async ([evts, partList, judgeList]) => {
      setEvents(evts);
      setParticipants(partList);
      setJudges(judgeList);

      const scorePromises = evts.map((e) => dbService.getScores(e.id));
      const scoreArrays = await Promise.all(scorePromises);
      setAllScores(scoreArrays.flat());
      setIsLoading(false);
    });
  }, [organization.org_id]);

  const totalEvents = events.length;
  const activeEvents = events.filter((e) => e.status === 'active').length;
  const completedEvents = events.filter((e) => e.status === 'ended').length;
  const totalBallots = allScores.length;
  const totalParticipants = participants.length;
  const totalJudges = judges.length;

  const averageScore = totalBallots > 0
    ? (allScores.reduce((acc, s) => acc + (Number(s.total_score) || 0), 0) / totalBallots).toFixed(1)
    : '—';

  return (
    <div className="w-full space-y-6">
      {/* Header Bar */}
      <div className="flex items-center gap-3 p-5 rounded-3xl bg-zinc-900/80 border border-zinc-800 shadow-xl">
        <div className="w-12 h-12 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 flex items-center justify-center">
          <BarChart3 className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-base font-black text-white">Competition Telemetry & Analytics</h2>
          <p className="text-xs text-zinc-400">Score distributions, jury participation & ledger volume</p>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1 font-mono">
            <Award className="w-3.5 h-3.5 text-amber-400" />
            <span>TOTAL BALLOTS</span>
          </div>
          <span className="text-2xl font-black font-mono text-white">{totalBallots}</span>
          <span className="text-[10px] text-zinc-500 block mt-0.5">Sealed in ledger</span>
        </div>

        <div className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1 font-mono">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
            <span>AVG SCORE</span>
          </div>
          <span className="text-2xl font-black font-mono text-white">{averageScore}</span>
          <span className="text-[10px] text-zinc-500 block mt-0.5">Points per ballot</span>
        </div>

        <div className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1 font-mono">
            <Users className="w-3.5 h-3.5 text-blue-400" />
            <span>COMPETITORS</span>
          </div>
          <span className="text-2xl font-black font-mono text-white">{totalParticipants}</span>
          <span className="text-[10px] text-zinc-500 block mt-0.5">Across all events</span>
        </div>

        <div className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800">
          <div className="flex items-center gap-2 text-zinc-400 text-xs mb-1 font-mono">
            <Scale className="w-3.5 h-3.5 text-amber-400" />
            <span>JURY BENCH</span>
          </div>
          <span className="text-2xl font-black font-mono text-white">{totalJudges}</span>
          <span className="text-[10px] text-zinc-500 block mt-0.5">Active judges</span>
        </div>
      </div>

      {/* Events Breakdown Table */}
      <div className="p-5 rounded-3xl bg-zinc-900/70 border border-zinc-800 space-y-4">
        <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
          Division Performance Summary
        </h3>

        {events.length === 0 ? (
          <p className="text-xs text-zinc-500 text-center py-4">No events found for this organization.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500 uppercase text-[10px]">
                  <th className="pb-3">Event Name</th>
                  <th className="pb-3">Category</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3 text-right">Roster</th>
                  <th className="pb-3 text-right">Ballots</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {events.map((evt) => {
                  const eventBallots = allScores.filter((s) => s.event_id === evt.id).length;
                  return (
                    <tr key={evt.id} className="text-zinc-300">
                      <td className="py-3 font-bold text-white">{evt.name}</td>
                      <td className="py-3 text-zinc-400">{evt.category || 'General'}</td>
                      <td className="py-3">
                        <span className="px-2 py-0.5 rounded-full text-[10px] uppercase font-bold bg-zinc-800 text-zinc-300">
                          {evt.status}
                        </span>
                      </td>
                      <td className="py-3 text-right">{evt.assigned_participants?.length || 0}</td>
                      <td className="py-3 text-right font-bold text-emerald-400">{eventBallots}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
