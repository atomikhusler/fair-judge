import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { 
  Play, 
  Square, 
  Pause, 
  ChevronDown, 
  Clock, 
  Radio, 
  AlertTriangle, 
  Bell, 
  Search, 
  X, 
  Trophy, 
  Users, 
  CheckCircle2, 
  Activity, 
  ShieldCheck 
} from 'lucide-react';
import { 
  Organization, 
  SupabaseEvent, 
  SupabaseJudge, 
  SupabaseParticipant, 
  SupabaseScore, 
  EventStatus 
} from '../../../lib/supabaseTypes';
import { dbService, subscribeToDatabase } from '../../../lib/supabase';
import { getPendingCount, subscribeToQueueChanges } from '../../../lib/offlineQueue';

interface LiveTabProps {
  organization: Organization;
  onOpenPublicView?: (eventId?: string) => void;
}

export function LiveTab({ organization, onOpenPublicView }: LiveTabProps) {
  // 1. Core Data State
  const [events, setEvents] = useState<SupabaseEvent[]>([]);
  const [allParticipants, setAllParticipants] = useState<SupabaseParticipant[]>([]);
  const [judges, setJudges] = useState<SupabaseJudge[]>([]);
  const [allScores, setAllScores] = useState<SupabaseScore[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // 2. Command Bar & Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [isAlertsOpen, setIsAlertsOpen] = useState(false);
  const [unreadAlerts, setUnreadAlerts] = useState(false);
  const [pendingScoresCount, setPendingScoresCount] = useState(0);
  const prevWarningsCountRef = useRef(0);

  // 3. Accordion Expanded Card State (Single expandedCardId or null)
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);

  // 4. Live Tick for Dynamic Timers
  const [, setTick] = useState<number>(Date.now());

  // 5. Double-Confirmation Modal State for Ending Session
  const [confirmingEvent, setConfirmingEvent] = useState<SupabaseEvent | null>(null);

  // Load foundational data
  const loadData = useCallback(async () => {
    try {
      const [loadedEvents, loadedParticipants, loadedJudges, loadedScores, pendingCount] = await Promise.all([
        dbService.getEvents(organization.org_id),
        dbService.getParticipants(organization.org_id),
        dbService.getJudges(organization.org_id),
        dbService.getAllScores(),
        getPendingCount(),
      ]);

      setEvents(loadedEvents);
      setAllParticipants(loadedParticipants);
      setJudges(loadedJudges);
      setAllScores(loadedScores);
      setPendingScoresCount(pendingCount);
    } catch (err) {
      console.error('Failed to load LiveTab data:', err);
    } finally {
      setIsLoading(false);
    }
  }, [organization.org_id]);

  // Initial load and realtime subscription
  useEffect(() => {
    loadData();
    const unsubscribeDb = subscribeToDatabase((table) => {
      if (
        table === 'fairjudge_supabase_events' ||
        table === 'fairjudge_supabase_scores' ||
        table === 'fairjudge_supabase_participants' ||
        table === 'fairjudge_supabase_judges' ||
        table === 'all'
      ) {
        loadData();
      }
    });

    const unsubscribeQueue = subscribeToQueueChanges(() => {
      getPendingCount().then((count) => {
        setPendingScoresCount(count);
      });
    });

    return () => {
      unsubscribeDb();
      unsubscribeQueue();
    };
  }, [loadData]);

  // Dynamic ticking interval for any live event timer
  const hasLiveEvent = useMemo(() => {
    return events.some((e) => e.status === 'active');
  }, [events]);

  useEffect(() => {
    if (!hasLiveEvent) return;
    const interval = setInterval(() => {
      setTick(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [hasLiveEvent]);

  // Modal Scroll Lock: Ensure body does not scroll while confirm modal or alert popover is open
  useEffect(() => {
    if (confirmingEvent || isAlertsOpen) {
      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = originalOverflow;
      };
    }
  }, [confirmingEvent, isAlertsOpen]);

  // Helper to compute live elapsed seconds for an event
  const computeEventElapsedSeconds = useCallback((event: SupabaseEvent): number => {
    const baseSec = Number(event.elapsed_seconds) || 0;
    if (event.status === 'active' && event.started_at) {
      const startMs = new Date(event.started_at).getTime();
      if (!isNaN(startMs)) {
        const liveSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
        return baseSec + liveSec;
      }
    }
    return baseSec;
  }, []);

  // Format seconds to MM:SS or HH:MM:SS
  const formatTime = (totalSeconds: number): string => {
    if (totalSeconds < 0) return '00:00';
    const hrs = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;
    if (hrs > 0) {
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // -------------------------------------------------------------
  // INTELLIGENCE & BACKGROUND WARNING EVALUATION
  // -------------------------------------------------------------
  const specificWarnings = useMemo(() => {
    const list: Array<{ title: string; desc: string }> = [];

    // 1. Pending Scores Warning
    if (pendingScoresCount > 0) {
      list.push({
        title: 'Pending Scores Waiting',
        desc: `${pendingScoresCount} offline ballot${pendingScoresCount > 1 ? 's are' : ' is'} queued and waiting for network sync.`,
      });
    }

    // 2. Active Events with Empty Roster or Judges
    events.forEach((evt) => {
      if (evt.status === 'active') {
        const participantCount = (evt.assigned_participants || []).length;
        const judgeCount = (evt.assigned_judges || []).length;

        if (participantCount === 0 && judgeCount === 0) {
          list.push({
            title: `Active Event Missing Setup`,
            desc: `"${evt.name}" is LIVE but has no participants or judges assigned.`,
          });
        } else if (participantCount === 0) {
          list.push({
            title: `Active Event Missing Participants`,
            desc: `"${evt.name}" is LIVE but has no participants assigned to the lineup.`,
          });
        } else if (judgeCount === 0) {
          list.push({
            title: `Active Event Missing Judges`,
            desc: `"${evt.name}" is LIVE but has no judges assigned to evaluate.`,
          });
        }
      }
    });

    return list;
  }, [events, pendingScoresCount]);

  // Manage unreadAlerts state: trigger red dot if warnings exist
  useEffect(() => {
    if (specificWarnings.length > 0) {
      if (specificWarnings.length !== prevWarningsCountRef.current) {
        setUnreadAlerts(true);
      }
    } else {
      setUnreadAlerts(false);
    }
    prevWarningsCountRef.current = specificWarnings.length;
  }, [specificWarnings]);

  const handleOpenAlerts = () => {
    setUnreadAlerts(false);
    setIsAlertsOpen(true);
  };

  // Toggle Accordion Expansion
  const handleToggleCard = (eventId: string) => {
    setExpandedCardId((prev) => (prev === eventId ? null : eventId));
  };

  // -------------------------------------------------------------
  // EVENT LIFECYCLE ACTION HANDLERS
  // -------------------------------------------------------------
  const handleStartSession = async (event: SupabaseEvent, e: React.MouseEvent) => {
    e.stopPropagation();
    const nowIso = new Date().toISOString();
    try {
      await dbService.updateEventStatus(event.id, 'active');
      await dbService.updateEvent(event.id, {
        started_at: nowIso,
        elapsed_seconds: 0,
      });
      setEvents((prev) =>
        prev.map((item) =>
          item.id === event.id
            ? { ...item, status: 'active', started_at: nowIso, elapsed_seconds: 0 }
            : item
        )
      );
    } catch (err) {
      console.error('Failed to start session:', err);
    }
  };

  const handlePauseSession = async (event: SupabaseEvent, e: React.MouseEvent) => {
    e.stopPropagation();
    const totalSec = computeEventElapsedSeconds(event);
    try {
      await dbService.updateEventStatus(event.id, 'paused');
      await dbService.updateEvent(event.id, {
        elapsed_seconds: totalSec,
        started_at: null,
      });
      setEvents((prev) =>
        prev.map((item) =>
          item.id === event.id
            ? { ...item, status: 'paused', elapsed_seconds: totalSec, started_at: null }
            : item
        )
      );
    } catch (err) {
      console.error('Failed to pause session:', err);
    }
  };

  const handleResumeSession = async (event: SupabaseEvent, e: React.MouseEvent) => {
    e.stopPropagation();
    const nowIso = new Date().toISOString();
    const currentBase = Number(event.elapsed_seconds) || 0;
    try {
      await dbService.updateEventStatus(event.id, 'active');
      await dbService.updateEvent(event.id, {
        started_at: nowIso,
        elapsed_seconds: currentBase,
      });
      setEvents((prev) =>
        prev.map((item) =>
          item.id === event.id
            ? { ...item, status: 'active', started_at: nowIso, elapsed_seconds: currentBase }
            : item
        )
      );
    } catch (err) {
      console.error('Failed to resume session:', err);
    }
  };

  const handleConfirmEndSession = async () => {
    if (!confirmingEvent) return;
    const totalSec = computeEventElapsedSeconds(confirmingEvent);
    try {
      await dbService.updateEventStatus(confirmingEvent.id, 'ended');
      await dbService.updateEvent(confirmingEvent.id, {
        elapsed_seconds: totalSec,
        started_at: null,
      });
      setEvents((prev) =>
        prev.map((item) =>
          item.id === confirmingEvent.id
            ? { ...item, status: 'ended', elapsed_seconds: totalSec, started_at: null }
            : item
        )
      );
    } catch (err) {
      console.error('Failed to end session:', err);
    } finally {
      setConfirmingEvent(null);
    }
  };

  // -------------------------------------------------------------
  // DATA FILTERING & AUTO-SORT ALGORITHM
  // -------------------------------------------------------------
  // Mathematical priority: Active (1) > Paused (2) > Upcoming/Ready/Draft (3) > Ended (4) > Archived (5)
  const statusPriority: Record<EventStatus, number> = {
    active: 1,
    paused: 2,
    upcoming: 3,
    ready: 3,
    draft: 3,
    ended: 4,
    archived: 5,
  };

  const sortedEvents = useMemo(() => {
    return [...events].sort((a, b) => {
      const priorityA = statusPriority[a.status] || 99;
      const priorityB = statusPriority[b.status] || 99;
      if (priorityA !== priorityB) {
        return priorityA - priorityB;
      }
      return a.name.localeCompare(b.name);
    });
  }, [events]);

  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sortedEvents;
    return sortedEvents.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        (e.category && e.category.toLowerCase().includes(q))
    );
  }, [sortedEvents, searchQuery]);

  // -------------------------------------------------------------
  // PARTICIPANT & TELEMETRY CALCULATIONS
  // -------------------------------------------------------------
  // STRICT ROSTER RULE: If assigned_participants.length === 0, return [] (do NOT fallback to full org roster)
  const getEventParticipants = useCallback(
    (event: SupabaseEvent): SupabaseParticipant[] => {
      const assignedIds = event.assigned_participants || [];
      if (assignedIds.length === 0) {
        return [];
      }
      return assignedIds
        .map((id) => allParticipants.find((p) => p.id === id))
        .filter((p): p is SupabaseParticipant => Boolean(p));
    },
    [allParticipants]
  );

  const getParticipantDisplayName = (
    participant: SupabaseParticipant,
    event?: SupabaseEvent
  ): string => {
    const isBlind = Boolean(
      organization.blind_judging_enabled ||
      (event as unknown as { blind_judging_enabled?: boolean })?.blind_judging_enabled
    );
    if (isBlind) {
      return participant.identity_id ? `Participant ${participant.identity_id}` : `Participant #${participant.sl_no}`;
    }
    return participant.name;
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 pb-32 relative">
      {/* ======================================================== */}
      {/* PART 1: THE COMMAND BAR (Zero-Gap Sticky Header)          */}
      {/* ======================================================== */}
      <div className="sticky top-0 z-40 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md pb-3 pt-3 flex items-center gap-3">
        {/* Smart Notification Bell Button (Left) */}
        <button
          type="button"
          onClick={handleOpenAlerts}
          className="w-12 h-12 flex-shrink-0 rounded-2xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center relative shadow-sm hover:border-stone-300 dark:hover:border-zinc-700 transition-all active:scale-95 text-stone-700 dark:text-zinc-200 cursor-pointer"
          aria-label="Intelligence Alerts"
          title="System Warnings & Telemetry"
        >
          <Bell className="w-5 h-5 stroke-[2.2]" />
          {/* Pulsing Red Dot when unread alerts exist */}
          {unreadAlerts && (
            <span className="absolute top-2.5 right-2.5 flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-rose-500"></span>
            </span>
          )}
        </button>

        {/* Search Bar (Right / flex-1) */}
        <div className="flex-1 relative">
          <div className="w-full bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl px-3.5 py-3 flex items-center gap-2.5 shadow-sm focus-within:ring-2 focus-within:ring-stone-400 dark:focus-within:ring-zinc-600 transition-all">
            <Search className="w-4 h-4 text-stone-400 dark:text-zinc-500 flex-shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search events by name or category..."
              className="w-full bg-transparent text-sm font-medium text-stone-900 dark:text-white placeholder:text-stone-400 dark:placeholder:text-zinc-500 focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="p-1 rounded-full text-stone-400 hover:text-stone-600 dark:hover:text-zinc-200 transition-colors cursor-pointer"
                aria-label="Clear Search"
              >
                <X className="w-3.5 h-3.5 stroke-[2.5]" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ======================================================== */}
      {/* PART 3: THE EXPANDABLE EVENT CARDS (Accordion Logic)     */}
      {/* ======================================================== */}
      <div className="mt-4 space-y-3.5">
        {isLoading ? (
          <div className="py-20 flex flex-col items-center justify-center text-center gap-3">
            <div className="w-8 h-8 border-2 border-stone-300 dark:border-zinc-700 border-t-stone-800 dark:border-t-white rounded-full animate-spin" />
            <p className="text-xs font-semibold text-stone-500 dark:text-zinc-400 uppercase tracking-wider">
              Connecting Command Center...
            </p>
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-8 text-center shadow-sm">
            <div className="w-12 h-12 rounded-2xl bg-stone-100 dark:bg-zinc-800/80 flex items-center justify-center mx-auto text-stone-500 dark:text-zinc-400 mb-3">
              <Radio className="w-6 h-6 stroke-[2]" />
            </div>
            <h3 className="text-base font-bold text-stone-900 dark:text-white mb-1">
              {searchQuery ? 'No Matching Events Found' : 'No Events in Competition'}
            </h3>
            <p className="text-xs text-stone-500 dark:text-zinc-400 max-w-sm mx-auto">
              {searchQuery
                ? `No event matched "${searchQuery}". Try searching for another name or category.`
                : 'Create events in the Events Tab and assign judges to start real-time telemetry.'}
            </p>
          </div>
        ) : (
          filteredEvents.map((event) => {
            const isExpanded = expandedCardId === event.id;
            const currentElapsed = computeEventElapsedSeconds(event);
            const eventParticipants = getEventParticipants(event);
            const eventJudgesCount = event.assigned_judges?.length || 0;
            const eventScores = allScores.filter((s) => s.event_id === event.id);

            // Required judges count
            const requiredJudgesCount = eventJudgesCount > 0 ? eventJudgesCount : (judges.length > 0 ? judges.length : 1);

            // Sequence calculations
            const participantStatusList = eventParticipants.map((p) => {
              const pScores = eventScores.filter((s) => s.participant_id === p.id);
              const hasPerformed = pScores.length >= requiredJudgesCount;
              return {
                participant: p,
                scoreCount: pScores.length,
                hasPerformed,
              };
            });

            const performedCount = participantStatusList.filter((ps) => ps.hasPerformed).length;
            const performingIndex = participantStatusList.findIndex((ps) => !ps.hasPerformed);

            let performingParticipant: SupabaseParticipant | null = null;
            let justPerformedParticipant: SupabaseParticipant | null = null;
            let upNextParticipant: SupabaseParticipant | null = null;

            if (eventParticipants.length > 0) {
              if (performingIndex === -1) {
                // All finished
                justPerformedParticipant = eventParticipants[eventParticipants.length - 1];
              } else {
                performingParticipant = eventParticipants[performingIndex];
                if (performingIndex > 0) {
                  justPerformedParticipant = eventParticipants[performingIndex - 1];
                }
                if (performingIndex + 1 < eventParticipants.length) {
                  upNextParticipant = eventParticipants[performingIndex + 1];
                }
              }
            }

            const performingJudgesScored = performingParticipant
              ? eventScores.filter((s) => s.participant_id === performingParticipant.id).length
              : 0;

            const justPerformedJudgesScored = justPerformedParticipant
              ? eventScores.filter((s) => s.participant_id === justPerformedParticipant.id).length
              : 0;

            // Podium calculations for Ended status
            const rankedList = eventParticipants.map((p) => {
              const pScores = eventScores.filter((s) => s.participant_id === p.id);
              const totalScore = pScores.reduce((sum, s) => sum + (Number(s.total_score) || 0), 0);
              const avgScore = pScores.length > 0 ? Number((totalScore / pScores.length).toFixed(1)) : 0;
              return {
                participant: p,
                totalScore,
                avgScore,
                scoresReceived: pScores.length,
              };
            });
            rankedList.sort((a, b) => b.totalScore - a.totalScore);
            const top3Podium = rankedList.filter((r) => r.scoresReceived > 0).slice(0, 3);

            return (
              <div
                key={event.id}
                className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 shadow-sm transition-all duration-200 hover:border-stone-300 dark:hover:border-zinc-700"
              >
                {/* ---------------- TOP ROW: [CATEGORY] Pill (Left) | [STATUS] Badge (Right) ---------------- */}
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-md bg-stone-100 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300 border border-stone-200/50 dark:border-zinc-700/50 truncate max-w-[160px]">
                    {event.category || 'General'}
                  </span>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {event.status === 'active' && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-black bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        LIVE
                      </span>
                    )}
                    {event.status === 'paused' && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-black bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                        PAUSED
                      </span>
                    )}
                    {(event.status === 'upcoming' || event.status === 'draft' || event.status === 'ready') && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-black bg-stone-100 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300 border border-stone-200 dark:border-zinc-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-stone-400 dark:bg-zinc-500" />
                        UPCOMING
                      </span>
                    )}
                    {(event.status === 'ended' || event.status === 'archived') && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-black bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                        ENDED
                      </span>
                    )}
                  </div>
                </div>

                {/* ---------------- MIDDLE ROW: Bold Event Name (Left) | ChevronDown (Right) ---------------- */}
                <div
                  onClick={() => handleToggleCard(event.id)}
                  className="mt-2.5 flex items-center justify-between gap-3 cursor-pointer group select-none"
                >
                  <h2 className="text-base sm:text-lg font-black text-stone-900 dark:text-white truncate tracking-tight group-hover:text-stone-700 dark:group-hover:text-zinc-200 transition-colors">
                    {event.name}
                  </h2>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleToggleCard(event.id);
                    }}
                    className="p-1 rounded-lg text-stone-400 dark:text-zinc-500 group-hover:text-stone-800 dark:group-hover:text-white transition-colors cursor-pointer"
                    aria-label={isExpanded ? 'Collapse event' : 'Expand event'}
                  >
                    <ChevronDown
                      className={`w-4 h-4 stroke-[2.5] transition-transform duration-200 ${
                        isExpanded ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                </div>

                {/* ---------------- BOTTOM ROW (Action Bar): Timer Clock right next to Actions ---------------- */}
                <div className="mt-3 pt-3 border-t border-stone-100 dark:border-zinc-800/80 flex items-center justify-between gap-2">
                  {/* Compact Timer Clock */}
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5 text-stone-400 dark:text-zinc-500 stroke-[2.2]" />
                    <span className="text-sm font-black font-mono tracking-tight text-stone-800 dark:text-zinc-200">
                      {event.status === 'upcoming' || event.status === 'draft' || event.status === 'ready'
                        ? '00:00'
                        : formatTime(currentElapsed)}
                    </span>
                    {event.status === 'active' && (
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping ml-0.5" />
                    )}
                  </div>

                  {/* Action Buttons Right Next to Timer */}
                  <div className="flex items-center gap-1.5">
                    {/* Start Button */}
                    {(event.status === 'upcoming' || event.status === 'draft' || event.status === 'ready') && (
                      <button
                        type="button"
                        onClick={(e) => handleStartSession(event, e)}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-3.5 py-1.5 rounded-xl shadow-xs active:scale-95 flex items-center gap-1.5 transition-all cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>Start</span>
                      </button>
                    )}

                    {/* Active Controls: Pause & End */}
                    {event.status === 'active' && (
                      <>
                        <button
                          type="button"
                          onClick={(e) => handlePauseSession(event, e)}
                          className="bg-amber-500 hover:bg-amber-600 text-white font-bold text-xs px-3 py-1.5 rounded-xl shadow-xs active:scale-95 flex items-center gap-1.5 transition-all cursor-pointer"
                        >
                          <Pause className="w-3.5 h-3.5 fill-current" />
                          <span>Pause</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmingEvent(event);
                          }}
                          className="bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs px-3 py-1.5 rounded-xl shadow-xs active:scale-95 flex items-center gap-1.5 transition-all cursor-pointer"
                        >
                          <Square className="w-3.5 h-3.5 fill-current" />
                          <span>End</span>
                        </button>
                      </>
                    )}

                    {/* Paused Controls: Resume & End */}
                    {event.status === 'paused' && (
                      <>
                        <button
                          type="button"
                          onClick={(e) => handleResumeSession(event, e)}
                          className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs px-3 py-1.5 rounded-xl shadow-xs active:scale-95 flex items-center gap-1.5 transition-all cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>Resume</span>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmingEvent(event);
                          }}
                          className="bg-rose-600 hover:bg-rose-700 text-white font-bold text-xs px-3 py-1.5 rounded-xl shadow-xs active:scale-95 flex items-center gap-1.5 transition-all cursor-pointer"
                        >
                          <Square className="w-3.5 h-3.5 fill-current" />
                          <span>End</span>
                        </button>
                      </>
                    )}

                    {/* Ended / Sealed Indicator */}
                    {(event.status === 'ended' || event.status === 'archived') && (
                      <span className="text-[11px] font-bold text-stone-400 dark:text-zinc-500 flex items-center gap-1 bg-stone-100 dark:bg-zinc-800/60 px-2.5 py-1 rounded-lg border border-stone-200/50 dark:border-zinc-800">
                        <CheckCircle2 className="w-3 h-3 text-stone-400 dark:text-zinc-500" />
                        <span>Sealed</span>
                      </span>
                    )}

                    {/* Optional Public View Button */}
                    {onOpenPublicView && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenPublicView(event.id);
                        }}
                        className="p-1.5 rounded-lg text-stone-400 dark:text-zinc-500 hover:text-stone-900 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
                        title="Open Public Leaderboard"
                        aria-label="Public View"
                      >
                        <Radio className="w-3.5 h-3.5 stroke-[2]" />
                      </button>
                    )}
                  </div>
                </div>

                {/* ======================================================== */}
                {/* EXPANDED ACCORDION TELEMETRY (Revealed when Tapped)       */}
                {/* ======================================================== */}
                {isExpanded && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="mt-3 pt-3 border-t border-stone-200 dark:border-zinc-800 animate-fade-in"
                  >
                    {/* ---------------- 1. UPCOMING STATUS ---------------- */}
                    {(event.status === 'upcoming' || event.status === 'draft' || event.status === 'ready') && (
                      <div className="space-y-2.5">
                        {/* Telemetry Counts */}
                        <div className="flex items-center gap-2.5 text-xs font-bold text-stone-600 dark:text-zinc-300">
                          <span className="inline-flex items-center gap-1.5 bg-stone-100 dark:bg-zinc-800/80 px-2.5 py-1 rounded-lg">
                            <Users className="w-3.5 h-3.5 text-stone-400" />
                            Judges: {eventJudgesCount}
                          </span>
                          <span className="inline-flex items-center gap-1.5 bg-stone-100 dark:bg-zinc-800/80 px-2.5 py-1 rounded-lg">
                            <Activity className="w-3.5 h-3.5 text-stone-400" />
                            Participants: {eventParticipants.length}
                          </span>
                        </div>

                        {/* Muted Guidance Message */}
                        <div className="p-3 rounded-xl bg-stone-50 dark:bg-zinc-800/40 border border-stone-100 dark:border-zinc-800 text-center">
                          <p className="text-xs font-semibold text-stone-500 dark:text-zinc-400">
                            The Event has not been started yet.
                          </p>
                          <p className="text-[11px] text-stone-400 dark:text-zinc-500 mt-0.5">
                            Click &ldquo;Start&rdquo; above when judges and participants are ready on stage.
                          </p>
                        </div>
                      </div>
                    )}

                    {/* ---------------- 2. ACTIVE / PAUSED STATUS (Sequence Tracker) ---------------- */}
                    {(event.status === 'active' || event.status === 'paused') && (
                      <div className="space-y-3">
                        {/* Telemetry Counts */}
                        <div className="flex items-center gap-2.5 text-xs font-bold text-stone-600 dark:text-zinc-300">
                          <span className="inline-flex items-center gap-1.5 bg-stone-100 dark:bg-zinc-800/80 px-2.5 py-1 rounded-lg">
                            <Users className="w-3.5 h-3.5 text-stone-400" />
                            Judges: {eventJudgesCount}
                          </span>
                          <span className="inline-flex items-center gap-1.5 bg-stone-100 dark:bg-zinc-800/80 px-2.5 py-1 rounded-lg">
                            <Activity className="w-3.5 h-3.5 text-stone-400" />
                            Participants: {performedCount} / {eventParticipants.length}
                          </span>
                        </div>

                        {/* Sequence Tracker */}
                        {eventParticipants.length === 0 ? (
                          <div className="p-3 rounded-xl bg-stone-50 dark:bg-zinc-800/40 border border-stone-100 dark:border-zinc-800 text-center text-xs text-stone-500 dark:text-zinc-400">
                            No participants assigned to this event lineup.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {/* Currently Performing (Highlighted) */}
                            {performingParticipant ? (
                              <div className="flex flex-col space-y-1.5 p-3.5 rounded-xl bg-amber-500/10 dark:bg-amber-500/15 border border-amber-500/30 ring-1 ring-amber-500/20">
                                {/* Top Row */}
                                <div className="flex justify-between items-center">
                                  <span className="text-[10px] font-black uppercase tracking-wider text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping" />
                                    Performing
                                  </span>
                                  <span className="px-2 py-0.5 rounded-lg text-xs font-mono font-black bg-amber-500/20 text-amber-800 dark:text-amber-300 border border-amber-500/30">
                                    Judges: {performingJudgesScored}/{requiredJudgesCount}
                                  </span>
                                </div>
                                {/* Middle Row */}
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-black text-stone-900 dark:text-white truncate">
                                    {getParticipantDisplayName(performingParticipant, event)}
                                  </span>
                                  <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/25 shrink-0">
                                    [ID: {performingParticipant.identity_id || `P-${performingParticipant.sl_no}`}]
                                  </span>
                                </div>
                                {/* Bottom Row */}
                                <div className="flex justify-between items-center text-xs text-stone-500 dark:text-zinc-400">
                                  <span className="truncate">{performingParticipant.school || 'General / Independent'}</span>
                                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400 shrink-0">
                                    ORDER #{performingParticipant.sl_no}
                                  </span>
                                </div>
                              </div>
                            ) : (
                              <div className="p-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200/60 dark:border-zinc-800 flex items-center justify-between text-xs font-semibold text-stone-500 dark:text-zinc-400">
                                <span>All participants have concluded performance.</span>
                                <span className="text-emerald-500 font-bold">Ledger Complete</span>
                              </div>
                            )}

                            {/* Just Performed */}
                            {justPerformedParticipant && (
                              <div className="flex flex-col space-y-1.5 p-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200/60 dark:border-zinc-800">
                                {/* Top Row */}
                                <div className="flex justify-between items-center">
                                  <span className="text-[10px] font-black uppercase tracking-wider text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                    Just Performed
                                  </span>
                                  <span className="px-2 py-0.5 rounded-lg text-xs font-mono font-bold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
                                    Judges: {justPerformedJudgesScored}/{requiredJudgesCount}
                                  </span>
                                </div>
                                {/* Middle Row */}
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-black text-stone-900 dark:text-white truncate">
                                    {getParticipantDisplayName(justPerformedParticipant, event)}
                                  </span>
                                  <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-stone-200/70 dark:bg-zinc-800 text-stone-600 dark:text-zinc-400 border border-stone-300/60 dark:border-zinc-700/60 shrink-0">
                                    [ID: {justPerformedParticipant.identity_id || `P-${justPerformedParticipant.sl_no}`}]
                                  </span>
                                </div>
                                {/* Bottom Row */}
                                <div className="flex justify-between items-center text-xs text-stone-500 dark:text-zinc-400">
                                  <span className="truncate">{justPerformedParticipant.school || 'General / Independent'}</span>
                                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-stone-400 dark:text-zinc-500 shrink-0">
                                    ORDER #{justPerformedParticipant.sl_no}
                                  </span>
                                </div>
                              </div>
                            )}

                            {/* Up Next */}
                            {upNextParticipant && (
                              <div className="flex flex-col space-y-1.5 p-3.5 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200/60 dark:border-zinc-800">
                                {/* Top Row */}
                                <div className="flex justify-between items-center">
                                  <span className="text-[10px] font-black uppercase tracking-wider text-stone-500 dark:text-zinc-400 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-stone-400" />
                                    Up Next
                                  </span>
                                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-stone-400 dark:text-zinc-500">
                                    Next in Queue
                                  </span>
                                </div>
                                {/* Middle Row */}
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-black text-stone-900 dark:text-white truncate">
                                    {getParticipantDisplayName(upNextParticipant, event)}
                                  </span>
                                  <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-md bg-stone-200/70 dark:bg-zinc-800 text-stone-600 dark:text-zinc-400 border border-stone-300/60 dark:border-zinc-700/60 shrink-0">
                                    [ID: {upNextParticipant.identity_id || `P-${upNextParticipant.sl_no}`}]
                                  </span>
                                </div>
                                {/* Bottom Row */}
                                <div className="flex justify-between items-center text-xs text-stone-500 dark:text-zinc-400">
                                  <span className="truncate">{upNextParticipant.school || 'General / Independent'}</span>
                                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-stone-400 dark:text-zinc-500 shrink-0">
                                    ORDER #{upNextParticipant.sl_no}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* ---------------- 3. ENDED STATUS (Top 3 Podium) ---------------- */}
                    {(event.status === 'ended' || event.status === 'archived') && (
                      <div className="space-y-3">
                        {/* Telemetry Counts */}
                        <div className="flex items-center gap-2.5 text-xs font-bold text-stone-600 dark:text-zinc-300">
                          <span className="inline-flex items-center gap-1.5 bg-stone-100 dark:bg-zinc-800/80 px-2.5 py-1 rounded-lg">
                            <Users className="w-3.5 h-3.5 text-stone-400" />
                            Judges: {eventJudgesCount}
                          </span>
                          <span className="inline-flex items-center gap-1.5 bg-stone-100 dark:bg-zinc-800/80 px-2.5 py-1 rounded-lg">
                            <Activity className="w-3.5 h-3.5 text-stone-400" />
                            Participants: {eventParticipants.length}
                          </span>
                        </div>

                        {/* Podium Standings */}
                        {top3Podium.length === 0 ? (
                          <div className="p-3 rounded-xl bg-stone-50 dark:bg-zinc-800/40 border border-stone-100 dark:border-zinc-800 text-center text-xs text-stone-500 dark:text-zinc-400">
                            No scores were recorded for this session.
                          </div>
                        ) : (
                          <div className="space-y-2">
                            <div className="text-[11px] font-bold text-stone-500 dark:text-zinc-400 uppercase tracking-wider flex items-center gap-1">
                              <Trophy className="w-3.5 h-3.5 text-amber-500" />
                              Official Podium Results
                            </div>
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                              {/* 1st Place */}
                              {top3Podium[0] && (
                                <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-lg">🥇</span>
                                    <div className="min-w-0">
                                      <div className="text-xs font-black text-stone-900 dark:text-white truncate">
                                        <span className="font-mono text-amber-700 dark:text-amber-400 font-bold mr-1">
                                          [ID: {top3Podium[0].participant.identity_id || `P-${top3Podium[0].participant.sl_no}`}]
                                        </span>
                                        <span>{getParticipantDisplayName(top3Podium[0].participant, event)}</span>
                                      </div>
                                      <div className="text-[10px] text-amber-700 dark:text-amber-300 font-bold">
                                        1st Place
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-right flex-shrink-0">
                                    <div className="text-xs sm:text-sm font-black text-stone-900 dark:text-white">
                                      {top3Podium[0].totalScore}
                                    </div>
                                    <div className="text-[9px] text-stone-400 dark:text-zinc-500 font-bold uppercase">
                                      pts
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* 2nd Place */}
                              {top3Podium[1] && (
                                <div className="p-2.5 rounded-xl bg-stone-100/80 dark:bg-zinc-800/60 border border-stone-200 dark:border-zinc-700/80 flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-lg">🥈</span>
                                    <div className="min-w-0">
                                      <div className="text-xs font-black text-stone-900 dark:text-white truncate">
                                        <span className="font-mono text-stone-500 dark:text-zinc-400 font-bold mr-1">
                                          [ID: {top3Podium[1].participant.identity_id || `P-${top3Podium[1].participant.sl_no}`}]
                                        </span>
                                        <span>{getParticipantDisplayName(top3Podium[1].participant, event)}</span>
                                      </div>
                                      <div className="text-[10px] text-stone-500 dark:text-zinc-400 font-bold">
                                        2nd Place
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-right flex-shrink-0">
                                    <div className="text-xs sm:text-sm font-black text-stone-900 dark:text-white">
                                      {top3Podium[1].totalScore}
                                    </div>
                                    <div className="text-[9px] text-stone-400 dark:text-zinc-500 font-bold uppercase">
                                      pts
                                    </div>
                                  </div>
                                </div>
                              )}

                              {/* 3rd Place */}
                              {top3Podium[2] && (
                                <div className="p-2.5 rounded-xl bg-amber-900/10 dark:bg-amber-950/30 border border-amber-900/20 dark:border-amber-900/40 flex items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="text-lg">🥉</span>
                                    <div className="min-w-0">
                                      <div className="text-xs font-black text-stone-900 dark:text-white truncate">
                                        <span className="font-mono text-amber-800 dark:text-amber-400 font-bold mr-1">
                                          [ID: {top3Podium[2].participant.identity_id || `P-${top3Podium[2].participant.sl_no}`}]
                                        </span>
                                        <span>{getParticipantDisplayName(top3Podium[2].participant, event)}</span>
                                      </div>
                                      <div className="text-[10px] text-amber-800 dark:text-amber-400 font-bold">
                                        3rd Place
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-right flex-shrink-0">
                                    <div className="text-xs sm:text-sm font-black text-stone-900 dark:text-white">
                                      {top3Podium[2].totalScore}
                                    </div>
                                    <div className="text-[9px] text-stone-400 dark:text-zinc-500 font-bold uppercase">
                                      pts
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ======================================================== */}
      {/* DOUBLE-CONFIRMATION MODAL FOR ENDING EVENT SESSION       */}
      {/* Rendered outside the scroll container with body lock     */}
      {/* ======================================================== */}
      {confirmingEvent && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
          onClick={() => setConfirmingEvent(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-3xl p-6 shadow-2xl space-y-4"
          >
            <div className="w-12 h-12 rounded-2xl bg-rose-500/10 text-rose-600 dark:text-rose-400 flex items-center justify-center mx-auto border border-rose-500/20">
              <AlertTriangle className="w-6 h-6 stroke-[2.2]" />
            </div>

            <div className="text-center space-y-1">
              <h3 className="text-lg font-black text-stone-900 dark:text-white tracking-tight">
                End Live Session?
              </h3>
              <p className="text-xs text-stone-500 dark:text-zinc-400 leading-relaxed">
                Are you sure you want to end &ldquo;{confirmingEvent.name}&rdquo;? This will finalize all submitted judge scores and seal the scoring ledger permanently.
              </p>
            </div>

            <div className="p-3 rounded-2xl bg-stone-50 dark:bg-zinc-800/50 border border-stone-200 dark:border-zinc-800 text-[11px] text-stone-600 dark:text-zinc-400 space-y-1">
              <div className="flex items-center gap-1.5 font-bold text-stone-900 dark:text-white">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                Ledger Security Enforcement
              </div>
              <p className="leading-tight">
                Judges will no longer be able to submit new criteria evaluations once ended.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmingEvent(null)}
                className="w-full py-3 px-4 rounded-xl font-bold text-sm bg-stone-100 hover:bg-stone-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-stone-700 dark:text-zinc-200 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmEndSession}
                className="w-full py-3 px-4 rounded-xl font-bold text-sm bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-900/20 active:scale-95 transition-all cursor-pointer"
              >
                End Session
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* SMART NOTIFICATION BELL POPOVER / MODAL                  */}
      {/* Shows specific warnings or clean status                  */}
      {/* ======================================================== */}
      {isAlertsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
          onClick={() => setIsAlertsOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-3xl p-6 shadow-2xl space-y-4"
          >
            <div className="flex items-center justify-between pb-2 border-b border-stone-100 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400 flex items-center justify-center">
                  <Bell className="w-4 h-4 stroke-[2.2]" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-stone-900 dark:text-white">
                    Command Intelligence Warnings
                  </h3>
                  <p className="text-[10px] text-stone-400 dark:text-zinc-500 font-medium">
                    Real-time operational alerts
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsAlertsOpen(false)}
                className="p-1 rounded-full text-stone-400 hover:text-stone-600 dark:hover:text-zinc-200 cursor-pointer"
                aria-label="Close Alerts"
              >
                <X className="w-4 h-4 stroke-[2.5]" />
              </button>
            </div>

            {/* Warnings List */}
            <div className="space-y-2.5 max-h-[60vh] overflow-y-auto">
              {specificWarnings.length > 0 ? (
                specificWarnings.map((warning, idx) => (
                  <div
                    key={idx}
                    className="p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/25 flex items-start gap-3"
                  >
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-stone-900 dark:text-white">
                        {warning.title}
                      </div>
                      <div className="text-[11px] text-stone-600 dark:text-zinc-300 mt-0.5 leading-relaxed">
                        {warning.desc}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-4 rounded-2xl bg-stone-50 dark:bg-zinc-800/50 border border-stone-200 dark:border-zinc-800 flex items-center gap-3">
                  <ShieldCheck className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                  <div>
                    <div className="text-xs font-bold text-stone-900 dark:text-white">
                      All Systems Operational
                    </div>
                    <div className="text-[11px] text-stone-500 dark:text-zinc-400 mt-0.5">
                      No active warnings or missing rosters detected across your events.
                    </div>
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={() => setIsAlertsOpen(false)}
              className="w-full py-2.5 rounded-xl font-bold text-xs bg-stone-900 text-white dark:bg-white dark:text-black transition-colors cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
