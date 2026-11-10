import React, { useState, useEffect } from 'react';
import { Radio, Users, CheckCircle, Scale, Eye, RefreshCw, AlertCircle, ChevronRight } from 'lucide-react';
import { Organization, SupabaseEvent, SupabaseScore, SupabaseParticipant, SupabaseJudge } from '../../../lib/supabaseTypes';
import { dbService, subscribeToDatabase } from '../../../lib/supabase';
import { calculateRankings } from '../../../lib/tieBreakerEngine';
import { useToast } from '../../common/ToastProvider';

interface LiveTabProps {
  organization: Organization;
  onOpenPublicView: (eventId?: string) => void;
}

export function LiveTab({ organization, onOpenPublicView }: LiveTabProps) {
  const { showToast } = useToast();
  const [events, setEvents] = useState<SupabaseEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [participants, setParticipants] = useState<SupabaseParticipant[]>([]);
  const [scores, setScores] = useState<SupabaseScore[]>([]);
  const [judges, setJudges] = useState<SupabaseJudge[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadData = async () => {
    try {
      const [evts, partList, judgeList] = await Promise.all([
        dbService.getEvents(organization.org_id),
        dbService.getParticipants(organization.org_id),
        dbService.getJudges(organization.org_id),
      ]);
      setEvents(evts);
      setParticipants(partList);
      setJudges(judgeList);

      const activeEvent = evts.find((e) => e.status === 'active') || evts[0];
      if (activeEvent && !selectedEventId) {
        setSelectedEventId(activeEvent.id);
      }
    } catch (err) {
      console.warn('Error loading live data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const unsub = subscribeToDatabase((table) => {
      if (table === 'events' || table === 'scores' || table === 'participants' || table === 'all') {
        loadData();
      }
    });
    return () => unsub();
  }, [organization.org_id]);

  useEffect(() => {
    if (!selectedEventId) return;
    dbService.getScores(selectedEventId).then((sc) => {
      setScores(sc);
    });
  }, [selectedEventId]);

  const activeEvents = events.filter((e) => e.status === 'active');
  const currentEvent = events.find((e) => e.id === selectedEventId) || activeEvents[0] || events[0];

  const assignedParticipants = currentEvent
    ? participants.filter((p) => (currentEvent.assigned_participants || []).includes(p.id))
    : [];

  const rankings = currentEvent
    ? calculateRankings(assignedParticipants, scores, (currentEvent.assigned_judges || []).length, organization.tie_breaker_method)
    : [];

  return (
    <div className="w-full space-y-6">
      {/* Live Status Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-3xl bg-zinc-900/80 border border-zinc-800 shadow-xl">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center relative">
            <Radio className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-black text-white">Live Competition Monitor</span>
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-[10px] font-mono font-bold">
                {activeEvents.length} Active
              </span>
            </div>
            <p className="text-xs text-zinc-400 mt-0.5">Real-time judge telemetry & scoring ledger audit</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {events.length > 0 && (
            <select
              value={selectedEventId}
              onChange={(e) => setSelectedEventId(e.target.value)}
              className="h-10 px-3 rounded-xl bg-zinc-950 border border-zinc-800 text-xs font-bold text-white focus:outline-hidden"
            >
              {events.map((evt) => (
                <option key={evt.id} value={evt.id}>
                  {evt.name} ({evt.status.toUpperCase()})
                </option>
              ))}
            </select>
          )}

          <button
            type="button"
            onClick={() => onOpenPublicView(currentEvent?.id)}
            className="h-10 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-extrabold text-xs flex items-center gap-1.5 active:scale-95 cursor-pointer shadow-md"
          >
            <Eye className="w-4 h-4" />
            <span className="hidden sm:inline">Projector</span>
          </button>
        </div>
      </div>

      {/* Leaderboard & Standings */}
      {currentEvent ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main Standings Column */}
          <div className="lg:col-span-2 space-y-4">
            <div className="flex items-center justify-between px-1">
              <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
                Official Standings ({rankings.length})
              </h3>
              <span className="text-[10px] font-mono text-zinc-500">
                Method: {organization.tie_breaker_method.toUpperCase()}
              </span>
            </div>

            {rankings.length === 0 ? (
              <div className="p-8 rounded-3xl bg-zinc-900/40 border border-zinc-800 text-center">
                <Users className="w-8 h-8 text-zinc-500 mx-auto mb-2" />
                <p className="text-xs font-bold text-zinc-400">No competitors scored yet for this event</p>
              </div>
            ) : (
              <div className="space-y-2">
                {rankings.map((r, index) => (
                  <div
                    key={r.participant.id}
                    className="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between gap-3 shadow-xs"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`w-9 h-9 rounded-xl flex items-center justify-center font-mono font-black text-sm shrink-0 ${
                          r.rank === 1
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : r.rank === 2
                            ? 'bg-zinc-300/20 text-zinc-300 border border-zinc-300/30'
                            : r.rank === 3
                            ? 'bg-amber-700/20 text-amber-600 border border-amber-700/30'
                            : 'bg-zinc-950 text-zinc-400 border border-zinc-800'
                        }`}
                      >
                        #{r.rank}
                      </div>
                      <div className="min-w-0">
                        <span className="text-xs font-extrabold text-white block truncate">
                          {r.participant.name}
                        </span>
                        <span className="text-[11px] text-zinc-400 truncate block">
                          {r.participant.school} • SL #{r.participant.sl_no}
                        </span>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <span className="text-base font-black font-mono text-emerald-400 block">
                        {r.totalScore} pts
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">
                        {r.scoresCount} ballot{r.scoresCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quick Jury Telemetry Card */}
          <div className="space-y-4">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
              Jury Activity Feed
            </h3>
            <div className="p-4 rounded-3xl bg-zinc-900/60 border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <span className="text-xs text-zinc-400">Total Recorded Ballots</span>
                <span className="text-sm font-mono font-bold text-white">{scores.length}</span>
              </div>
              <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
                <span className="text-xs text-zinc-400">Assigned Judges</span>
                <span className="text-sm font-mono font-bold text-white">
                  {(currentEvent.assigned_judges || []).length}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-400">Event Status</span>
                <span className="text-xs font-mono font-bold uppercase text-emerald-400">
                  {currentEvent.status}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-8 rounded-3xl bg-zinc-900/40 border border-zinc-800 text-center">
          <p className="text-sm font-bold text-zinc-400">No competition events found</p>
          <p className="text-xs text-zinc-500 mt-1">Navigate to the Events tab to create your first event.</p>
        </div>
      )}
    </div>
  );
}
