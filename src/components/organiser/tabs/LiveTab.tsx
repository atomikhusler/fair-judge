import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Play, 
  Square, 
  Pause, 
  ChevronDown, 
  Clock, 
  Radio,
  AlertTriangle,
  CheckCircle2,
  X
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
import { PullToRefresh } from '../../common/PullToRefresh';

interface LiveTabProps {
  organization: Organization;
  onOpenPublicView?: (eventId?: string) => void;
}

type FilterTab = 'all' | 'performing' | 'completed' | 'up_next';

interface ConfirmDialogState {
  isOpen: boolean;
  type: 'end';
  title: string;
  description: string;
  confirmLabel: string;
  isDestructive: boolean;
}

export function LiveTab({ organization, onOpenPublicView }: LiveTabProps) {
  // 1. Events State & Event Selection
  const [events, setEvents] = useState<SupabaseEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');
  const [isEventSelectorOpen, setIsEventSelectorOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // 2. Participants, Judges & Scores Data for Selected Event
  const [allParticipants, setAllParticipants] = useState<SupabaseParticipant[]>([]);
  const [judges, setJudges] = useState<SupabaseJudge[]>([]);
  const [eventScores, setEventScores] = useState<SupabaseScore[]>([]);

  // 3. Command Strip Timer & Local State
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 4. Performance Tracking Filter Tab State (Compact Tabs)
  const [activeFilterTab, setActiveFilterTab] = useState<FilterTab>('all');

  // 5. Workflow Confirmation Modal State
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState | null>(null);

  // 6. Tap-to-reveal expanded participant card
  const [expandedParticipantId, setExpandedParticipantId] = useState<string | null>(null);

  // Load all foundational data from Supabase/dbService
  const loadData = async () => {
    try {
      let loadedEvents = await dbService.getEvents(organization.org_id);
      
      // Auto-seed initial events if none exist
      if (loadedEvents.length === 0) {
        const seed1 = await dbService.createEvent({
          org_id: organization.org_id,
          name: 'Solo Dance Championship',
          category: 'Performing Arts',
          date: new Date().toISOString().split('T')[0],
          status: 'upcoming',
          rubric_schema: [
            { id: 'c1', name: 'Rhythm & Choreography', max_marks: 10, weight: 1 },
            { id: 'c2', name: 'Stage Expression', max_marks: 10, weight: 1 },
            { id: 'c3', name: 'Costume & Presentation', max_marks: 10, weight: 1 },
          ],
          assigned_judges: [],
          assigned_participants: [],
        });
        loadedEvents = [seed1];
      }

      setEvents(loadedEvents);

      // Select active event first, or preserve current selection, or fall back to first
      let targetId = selectedEventId;
      if (!targetId || !loadedEvents.some((e) => e.id === targetId)) {
        const activeOne = loadedEvents.find((e) => e.status === 'active' || e.status === 'paused');
        targetId = activeOne ? activeOne.id : loadedEvents[0].id;
        setSelectedEventId(targetId);
      }

      // Load participants and judges
      const [loadedParticipants, loadedJudges] = await Promise.all([
        dbService.getParticipants(organization.org_id),
        dbService.getJudges(organization.org_id),
      ]);
      setAllParticipants(loadedParticipants);
      setJudges(loadedJudges);

      // Load scores for target event
      if (targetId) {
        const scores = await dbService.getScores(targetId);
        setEventScores(scores);
      }
    } catch (err) {
      console.error('Failed to load Live Tab data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Subscribe to realtime database changes
  useEffect(() => {
    loadData();
    const unsubscribe = subscribeToDatabase((table) => {
      if (
        table === 'fairjudge_supabase_events' ||
        table === 'fairjudge_supabase_scores' ||
        table === 'fairjudge_supabase_participants' ||
        table === 'all'
      ) {
        dbService.getEvents(organization.org_id).then((freshEvents) => {
          if (freshEvents.length > 0) setEvents(freshEvents);
        });
        if (selectedEventId) {
          dbService.getScores(selectedEventId).then((freshScores) => {
            setEventScores(freshScores);
          });
        }
      }
    });
    return () => unsubscribe();
  }, [organization.org_id, selectedEventId]);

  // Selected Event Object
  const currentEvent = useMemo(() => {
    return events.find((e) => e.id === selectedEventId) || events[0];
  }, [events, selectedEventId]);

  // Refresh scores when selected event switches
  useEffect(() => {
    if (selectedEventId) {
      dbService.getScores(selectedEventId).then((scores) => {
        setEventScores(scores);
      });
    }
  }, [selectedEventId]);

  // Helper to compute true elapsed seconds for an event
  const computeEventElapsedSeconds = useCallback((event: SupabaseEvent | undefined): number => {
    if (!event) return 0;
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

  // Sync Timer with Current Event Status and elapsed seconds
  useEffect(() => {
    if (!currentEvent) {
      setElapsedSeconds(0);
      return;
    }
    setElapsedSeconds(computeEventElapsedSeconds(currentEvent));
  }, [currentEvent?.id, currentEvent?.status, currentEvent?.started_at, currentEvent?.elapsed_seconds, computeEventElapsedSeconds]);

  // True Background Timer: Stopwatch ticking logic based on wall-clock timestamp
  useEffect(() => {
    if (currentEvent?.status === 'active' && currentEvent.started_at) {
      const tick = () => {
        setElapsedSeconds(computeEventElapsedSeconds(currentEvent));
      };

      tick();
      timerRef.current = setInterval(tick, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [currentEvent?.status, currentEvent?.started_at, currentEvent?.elapsed_seconds, currentEvent?.id, computeEventElapsedSeconds]);

  // Format stopwatch as HH:MM:SS
  const formatTime = (totalSeconds: number): string => {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  };

  // State derivation helpers
  const eventStatus: EventStatus = (currentEvent?.status || 'draft') as EventStatus;
  const isEventLive = eventStatus === 'active';
  const isEventPaused = eventStatus === 'paused';
  const isEventEnded = eventStatus === 'ended' || eventStatus === 'archived';

  // -------------------------------------------------------------
  // DUAL-BUTTON COMMAND STRIP ACTIONS & CONFIRMATION WORKFLOW
  // -------------------------------------------------------------
  
  // Action A: Start Session (from upcoming/draft) - ONLY starts on explicit click
  const handleStartSession = async () => {
    if (!currentEvent || isEventEnded) return;

    const nowIso = new Date().toISOString();
    try {
      await dbService.updateEventStatus(currentEvent.id, 'active');
      await dbService.updateEvent(currentEvent.id, {
        started_at: nowIso,
        elapsed_seconds: 0,
      });

      setElapsedSeconds(0);
      setEvents((prev) =>
        prev.map((e) =>
          e.id === currentEvent.id
            ? { ...e, status: 'active', started_at: nowIso, elapsed_seconds: 0 }
            : e
        )
      );
    } catch (err) {
      console.error('Failed to start session:', err);
    }
  };

  // Action B: Resume Session (from paused)
  const handleResumeSession = async () => {
    if (!currentEvent || isEventEnded) return;

    const nowIso = new Date().toISOString();
    const currentBase = currentEvent.elapsed_seconds || 0;
    try {
      await dbService.updateEventStatus(currentEvent.id, 'active');
      await dbService.updateEvent(currentEvent.id, {
        started_at: nowIso,
        elapsed_seconds: currentBase,
      });

      setElapsedSeconds(currentBase);
      setEvents((prev) =>
        prev.map((e) =>
          e.id === currentEvent.id
            ? { ...e, status: 'active', started_at: nowIso, elapsed_seconds: currentBase }
            : e
        )
      );
    } catch (err) {
      console.error('Failed to resume session:', err);
    }
  };

  // Action C: Pause Session (from active)
  const handlePauseSession = async () => {
    if (!currentEvent || !isEventLive) return;

    const totalSec = computeEventElapsedSeconds(currentEvent);

    try {
      await dbService.updateEventStatus(currentEvent.id, 'paused');
      await dbService.updateEvent(currentEvent.id, {
        elapsed_seconds: totalSec,
        started_at: null,
      });

      setElapsedSeconds(totalSec);
      setEvents((prev) =>
        prev.map((e) =>
          e.id === currentEvent.id
            ? { ...e, status: 'paused', elapsed_seconds: totalSec, started_at: null }
            : e
        )
      );
    } catch (err) {
      console.error('Failed to pause session:', err);
    }
  };

  // Action D: Trigger End Session with Double-Confirmation Workflow
  const promptEndSession = () => {
    if (!currentEvent || isEventEnded) return;

    setConfirmDialog({
      isOpen: true,
      type: 'end',
      title: 'End Live Session?',
      description: `Are you sure you want to end "${currentEvent.name}"? This will finalize all submitted judge scores and seal the scoring ledger.`,
      confirmLabel: 'End Session',
      isDestructive: true,
    });
  };

  // Confirm dialog execution (End Session)
  const handleConfirmAction = async () => {
    if (!confirmDialog || !currentEvent) return;

    try {
      if (confirmDialog.type === 'end') {
        const totalSec = computeEventElapsedSeconds(currentEvent);

        await dbService.updateEventStatus(currentEvent.id, 'ended');
        await dbService.updateEvent(currentEvent.id, {
          elapsed_seconds: totalSec,
          started_at: null,
        });

        setElapsedSeconds(totalSec);
        setEvents((prev) =>
          prev.map((e) =>
            e.id === currentEvent.id
              ? { ...e, status: 'ended', elapsed_seconds: totalSec, started_at: null }
              : e
          )
        );
      }
    } catch (err) {
      console.error('Failed to end session:', err);
    } finally {
      setConfirmDialog(null);
    }
  };

  // -------------------------------------------------------------
  // PARTICIPANTS & PERFORMANCE TRACKER CALCULATIONS
  // -------------------------------------------------------------
  const eventParticipants = useMemo(() => {
    if (!currentEvent) return [];
    const assignedIds = currentEvent.assigned_participants || [];
    if (assignedIds.length > 0) {
      return allParticipants.filter((p) => assignedIds.includes(p.id));
    }
    return allParticipants;
  }, [allParticipants, currentEvent]);

  const maxRubricPoints = useMemo(() => {
    if (!currentEvent) return 30;
    const rubricList = currentEvent.rubric_schema || currentEvent.rubric || [];
    const total = rubricList.reduce((sum, c) => sum + (Number(c.max_marks) || 0), 0);
    return total > 0 ? total : 30;
  }, [currentEvent]);

  const expectedJudgesCount = useMemo(() => {
    if (!currentEvent) return 1;
    const assignedCount = currentEvent.assigned_judges?.length || 0;
    if (assignedCount > 0) return assignedCount;
    return judges.length > 0 ? judges.length : 1;
  }, [currentEvent, judges]);

  // Compute status helpers and tab counts
  const participantStatuses = useMemo(() => {
    const map = new Map<string, 'up_next' | 'performing' | 'completed'>();
    
    eventParticipants.forEach((p) => {
      const pScores = eventScores.filter((s) => s.participant_id === p.id);
      const scoresCount = pScores.length;
      if (scoresCount >= expectedJudgesCount && scoresCount > 0) {
        map.set(p.id, 'completed');
      } else if (scoresCount > 0 && scoresCount < expectedJudgesCount) {
        map.set(p.id, 'performing');
      } else {
        map.set(p.id, 'up_next');
      }
    });

    return map;
  }, [eventParticipants, eventScores, expectedJudgesCount]);

  const tabCounts = useMemo(() => {
    let performing = 0;
    let completed = 0;
    let upNext = 0;

    participantStatuses.forEach((status) => {
      if (status === 'performing') performing++;
      else if (status === 'completed') completed++;
      else if (status === 'up_next') upNext++;
    });

    return {
      all: eventParticipants.length,
      performing,
      completed,
      upNext,
    };
  }, [participantStatuses, eventParticipants.length]);

  // Filter participants based on active filter tab
  const filteredParticipants = useMemo(() => {
    if (activeFilterTab === 'all') return eventParticipants;
    return eventParticipants.filter((p) => participantStatuses.get(p.id) === activeFilterTab);
  }, [eventParticipants, activeFilterTab, participantStatuses]);

  return (
    <PullToRefresh onRefresh={loadData} className="flex-1 px-4 pt-4 pb-28 space-y-4">
      {/* ======================================================== */}
      {/* 1. THE EVENT SELECTOR DROPDOWN                           */}
      {/* ======================================================== */}
      <div className="relative w-full">
        <label className="block text-xs font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400 font-bold mb-1.5 ml-1">
          Select Event to Manage
        </label>

        <button
          type="button"
          onClick={() => setIsEventSelectorOpen(!isEventSelectorOpen)}
          className="w-full min-h-[56px] text-lg font-bold rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 p-4 flex justify-between items-center shadow-sm transition-all duration-300 ease-out hover:-translate-y-0.5 active:scale-[0.97] active:translate-y-0 cursor-pointer"
        >
          <div className="flex items-center gap-3 truncate text-left">
            {/* Status Beacon based on selected event */}
            {eventStatus === 'active' ? (
              <span className="relative flex h-3 w-3 shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
            ) : eventStatus === 'paused' ? (
              <span className="relative flex h-3 w-3 shrink-0">
                <span className="inline-flex rounded-full h-3 w-3 bg-amber-500"></span>
              </span>
            ) : isEventEnded ? (
              <span className="relative flex h-3 w-3 shrink-0">
                <span className="inline-flex rounded-full h-3 w-3 bg-red-500"></span>
              </span>
            ) : (
              <span className="relative flex h-3 w-3 shrink-0">
                <span className="inline-flex rounded-full h-3 w-3 bg-zinc-400"></span>
              </span>
            )}

            <span className="text-base md:text-lg font-bold text-zinc-900 dark:text-white tracking-tight truncate">
              {currentEvent ? currentEvent.name : 'Loading Event...'}
            </span>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border ${
                eventStatus === 'active'
                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                  : eventStatus === 'paused'
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
                  : isEventEnded
                  ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30'
                  : 'bg-stone-200 dark:bg-zinc-800 text-zinc-500 border-stone-300 dark:border-zinc-700'
              }`}
            >
              {eventStatus === 'active'
                ? 'LIVE'
                : eventStatus === 'paused'
                ? 'PAUSED'
                : isEventEnded
                ? 'ENDED'
                : eventStatus.toUpperCase()}
            </span>
            <ChevronDown 
              className={`w-5 h-5 text-zinc-400 transition-transform duration-300 ${
                isEventSelectorOpen ? 'rotate-180' : ''
              }`} 
            />
          </div>
        </button>

        {/* Dropdown Menu for Event Selection */}
        {isEventSelectorOpen && (
          <div className="absolute top-full left-0 right-0 mt-2 z-30 bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-white border border-stone-200 dark:border-zinc-800/80 rounded-2xl p-2 shadow-2xl space-y-1 animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-zinc-400 font-bold">
              Available Sessions
            </div>
            {events.map((ev) => {
              const isSelected = ev.id === selectedEventId;
              const evSt = (ev.status || 'draft').toLowerCase();
              return (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => {
                    setSelectedEventId(ev.id);
                    setIsEventSelectorOpen(false);
                  }}
                  className={`w-full min-h-[48px] px-3.5 py-2.5 rounded-xl text-left flex items-center justify-between transition-all duration-200 active:scale-[0.98] cursor-pointer ${
                    isSelected
                      ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 font-bold'
                      : 'hover:bg-stone-100 dark:hover:bg-zinc-900 text-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  <div className="flex flex-col truncate pr-2">
                    <span className="text-xs font-semibold truncate">{ev.name}</span>
                    <span className="text-[10px] font-mono text-zinc-400">{ev.category || 'Standard'}</span>
                  </div>
                  <span
                    className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded-md uppercase shrink-0 ${
                      evSt === 'active'
                        ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                        : evSt === 'paused'
                        ? 'bg-amber-500/20 text-amber-600 dark:text-amber-400'
                        : evSt === 'ended' || evSt === 'archived'
                        ? 'bg-red-500/20 text-red-600 dark:text-red-400'
                        : 'bg-stone-200 dark:bg-zinc-800 text-zinc-500'
                    }`}
                  >
                    {evSt}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* 2. THE COMPACT COMMAND STRIP (EXACTLY 2 BUTTONS)         */}
      {/* ======================================================== */}
      <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-3.5 flex items-center justify-between shadow-xs mt-3 gap-2">
        {/* Left Side: Highly legible, compact digital clock */}
        <div className="flex items-center gap-2 shrink-0">
          <Clock className="w-4 h-4 text-emerald-500 shrink-0" />
          <span className="font-mono text-xl sm:text-2xl font-bold tracking-tight text-zinc-900 dark:text-white tabular-nums">
            {formatTime(elapsedSeconds)}
          </span>
        </div>

        {/* Right Side: Exactly 2 Compact Action Buttons (fits all mobile screens without overflow) */}
        <div className="flex items-center gap-2 shrink-0">
          {/* 
            BUTTON 1: Primary State Action
            - If upcoming/draft: Start (Emerald)
            - If active: Pause (Amber)
            - If paused: Resume (Emerald)
            - If ended: Ended (Disabled)
          */}
          {isEventLive ? (
            <button
              type="button"
              onClick={handlePauseSession}
              className="min-h-[36px] h-9 px-3 text-xs rounded-xl font-bold uppercase tracking-wider bg-amber-500 hover:bg-amber-600 active:scale-[0.97] text-white transition-all duration-200 cursor-pointer flex items-center gap-1.5 shadow-xs"
              title="Pause session"
            >
              <Pause className="w-3.5 h-3.5 fill-current" />
              <span>Pause</span>
            </button>
          ) : isEventPaused ? (
            <button
              type="button"
              onClick={handleResumeSession}
              className="min-h-[36px] h-9 px-3 text-xs rounded-xl font-bold uppercase tracking-wider bg-emerald-600 hover:bg-emerald-500 active:scale-[0.97] text-white transition-all duration-200 cursor-pointer flex items-center gap-1.5 shadow-xs"
              title="Resume session"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Resume</span>
            </button>
          ) : isEventEnded ? (
            <button
              type="button"
              disabled
              className="min-h-[36px] h-9 px-3 text-xs rounded-xl font-bold uppercase tracking-wider bg-stone-100 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-600 border border-stone-200 dark:border-zinc-800 transition-all duration-200 cursor-not-allowed flex items-center gap-1.5 opacity-80"
              title="Session finalized"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Ended</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStartSession}
              className="min-h-[36px] h-9 px-3.5 text-xs rounded-xl font-bold uppercase tracking-wider bg-emerald-600 hover:bg-emerald-500 active:scale-[0.97] text-white transition-all duration-200 cursor-pointer flex items-center gap-1.5 shadow-xs"
              title="Start live session"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span>Start</span>
            </button>
          )}

          {/* 
            BUTTON 2: Secondary / Termination Action
            - If active or paused: End (Red -> opens double confirmation modal)
            - If ended or upcoming/draft: Disabled secondary placeholder (once ended, cannot be reopened)
          */}
          {isEventLive || isEventPaused ? (
            <button
              type="button"
              onClick={promptEndSession}
              className="min-h-[36px] h-9 px-3 text-xs rounded-xl font-bold uppercase tracking-wider bg-red-600 hover:bg-red-500 active:scale-[0.97] text-white transition-all duration-200 cursor-pointer flex items-center gap-1.5 shadow-xs"
              title="End live session"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>End</span>
            </button>
          ) : (
            <button
              type="button"
              disabled
              className="min-h-[36px] h-9 px-3 text-xs rounded-xl font-bold uppercase tracking-wider bg-stone-100 dark:bg-zinc-900 text-zinc-400 dark:text-zinc-600 border border-stone-200/80 dark:border-zinc-850 cursor-not-allowed opacity-40 flex items-center gap-1.5"
              title={isEventEnded ? "Event finalized - cannot be reopened" : "Session not started"}
            >
              <Square className="w-3.5 h-3.5" />
              <span>End</span>
            </button>
          )}
        </div>
      </div>

      {/* ======================================================== */}
      {/* 3. LIVE PERFORMANCE TRACKING (COMPACT TABS & LIST)       */}
      {/* ======================================================== */}
      <div className="pt-2">
        {/* Header with Title & Total count */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Radio className="w-3.5 h-3.5 text-emerald-500 animate-pulse" />
            <h3 className="text-xs sm:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
              Live Performance Tracking
            </h3>
          </div>
          <span className="text-[11px] font-mono text-zinc-400 dark:text-zinc-500">
            {eventParticipants.length} Total
          </span>
        </div>

        {/* Compact, smaller filter tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-stone-100 dark:bg-zinc-900/90 rounded-xl border border-stone-200/60 dark:border-zinc-800/60 mb-3 overflow-x-auto no-scrollbar">
          {[
            { id: 'all' as FilterTab, label: 'All', count: tabCounts.all },
            { id: 'performing' as FilterTab, label: 'Performing', count: tabCounts.performing },
            { id: 'completed' as FilterTab, label: 'Completed', count: tabCounts.completed },
            { id: 'up_next' as FilterTab, label: 'Up Next', count: tabCounts.upNext },
          ].map((tab) => {
            const isActive = activeFilterTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveFilterTab(tab.id)}
                className={`h-7 px-2.5 py-0.5 rounded-lg text-[11px] font-semibold whitespace-nowrap transition-all duration-200 flex items-center gap-1.5 cursor-pointer ${
                  isActive
                    ? 'bg-white dark:bg-zinc-800 text-zinc-900 dark:text-white shadow-xs font-bold border border-stone-200/60 dark:border-zinc-700/60'
                    : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white hover:bg-stone-200/40 dark:hover:bg-zinc-850'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.2 rounded-full font-bold ${
                    isActive
                      ? 'bg-zinc-100 dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100'
                      : 'bg-stone-200/70 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* The Tracker List (pb-32 for mobile scroll padding) */}
        <div className="flex flex-col gap-2 pb-32">
          {filteredParticipants.length === 0 ? (
            <div className="p-6 text-center bg-white dark:bg-zinc-950 border border-dashed border-stone-200 dark:border-zinc-800 rounded-xl">
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {activeFilterTab === 'all'
                  ? 'No participants currently enrolled for this event.'
                  : `No participants currently in "${activeFilterTab.replace('_', ' ')}".`}
              </p>
              {activeFilterTab !== 'all' ? (
                <button
                  type="button"
                  onClick={() => setActiveFilterTab('all')}
                  className="mt-2 text-xs font-bold text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer"
                >
                  View All Participants ({tabCounts.all})
                </button>
              ) : (
                <p className="text-[11px] text-zinc-400 dark:text-zinc-600 mt-1">
                  Assign participants in the Events tab to enable live tracking.
                </p>
              )}
            </div>
          ) : (
            filteredParticipants.map((p) => {
              const pScores = eventScores.filter((s) => s.participant_id === p.id);
              const scoresCount = pScores.length;
              const status = participantStatuses.get(p.id) || 'up_next';

              const isCompleted = status === 'completed';
              const isPerforming = status === 'performing';
              const isUpNext = status === 'up_next';

              const totalSum = pScores.reduce((acc, s) => acc + (s.total_score || 0), 0);
              const avgScore = scoresCount > 0 ? totalSum / scoresCount : 0;
              const formattedScore = avgScore % 1 === 0 ? avgScore.toString() : avgScore.toFixed(1);

              const isExpanded = expandedParticipantId === p.id;
              const orderSerial = currentEvent?.participant_sl_numbers?.[p.id] || p.sl_no;

              return (
                <div
                  key={p.id}
                  onClick={() => setExpandedParticipantId(isExpanded ? null : p.id)}
                  className={`bg-white dark:bg-zinc-950 border rounded-xl overflow-hidden transition-all duration-200 cursor-pointer ${
                    isExpanded
                      ? 'border-emerald-500/50 shadow-md ring-1 ring-emerald-500/20'
                      : 'border-stone-200/80 dark:border-zinc-800/80 hover:border-stone-300 dark:hover:border-zinc-700 shadow-xs'
                  }`}
                >
                  {/* Normal / Collapsed View: ONLY Name + Status/Score */}
                  <div className="p-3.5 flex justify-between items-center gap-3">
                    {/* Left: ONLY Competitor Name */}
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="text-sm font-bold text-zinc-900 dark:text-white break-words leading-tight">
                        {p.name}
                      </span>
                    </div>

                    {/* Right: Status (Performing / Up Next / Performed) + Score (if performed & scored) */}
                    <div className="shrink-0 flex items-center gap-2">
                      {isUpNext && (
                        <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500">
                          Up Next
                        </span>
                      )}

                      {isPerforming && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 whitespace-nowrap">
                          🟡 Performing
                        </span>
                      )}

                      {isCompleted && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-bold text-zinc-500 dark:text-zinc-400">
                            Performed
                          </span>
                          {scoresCount > 0 && (
                            <span className="text-xs sm:text-sm font-black text-emerald-600 dark:text-emerald-400 whitespace-nowrap bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">
                              🟢 {formattedScore} / {maxRubricPoints}
                            </span>
                          )}
                        </div>
                      )}

                      <ChevronDown
                        className={`w-4 h-4 text-zinc-400 transition-transform duration-200 shrink-0 ${
                          isExpanded ? 'rotate-180 text-emerald-500' : ''
                        }`}
                      />
                    </div>
                  </div>

                  {/* Tap to Reveal: Expanded Detail Panel */}
                  {isExpanded && (
                    <div className="px-3.5 pb-3.5 pt-1 border-t border-stone-100 dark:border-zinc-800/80 bg-stone-50/50 dark:bg-zinc-900/40 text-xs space-y-3 animate-in fade-in duration-150">
                      {/* Metadata Grid */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px]">
                        <div className="bg-white dark:bg-zinc-950 p-2 rounded-lg border border-stone-200/60 dark:border-zinc-800">
                          <span className="text-zinc-400 uppercase font-mono text-[9px] block">Order / Serial</span>
                          <span className="font-bold text-zinc-800 dark:text-zinc-200 font-mono">
                            {orderSerial ? `#${orderSerial}` : '—'}
                          </span>
                        </div>

                        <div className="bg-white dark:bg-zinc-950 p-2 rounded-lg border border-stone-200/60 dark:border-zinc-800">
                          <span className="text-zinc-400 uppercase font-mono text-[9px] block">Affiliation</span>
                          <span className="font-semibold text-zinc-800 dark:text-zinc-200 truncate block">
                            {p.school || 'General Institution'}
                          </span>
                        </div>

                        <div className="bg-white dark:bg-zinc-950 p-2 rounded-lg border border-stone-200/60 dark:border-zinc-800">
                          <span className="text-zinc-400 uppercase font-mono text-[9px] block">Class / Age</span>
                          <span className="font-semibold text-zinc-800 dark:text-zinc-200 block">
                            {p.class_or_age || '—'}
                          </span>
                        </div>

                        <div className="bg-white dark:bg-zinc-950 p-2 rounded-lg border border-stone-200/60 dark:border-zinc-800">
                          <span className="text-zinc-400 uppercase font-mono text-[9px] block">Event Session</span>
                          <span className="font-semibold text-zinc-800 dark:text-zinc-200 truncate block">
                            {currentEvent?.name || '—'}
                          </span>
                        </div>
                      </div>

                      {/* Jury Scoring Ballots Breakdown */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="font-bold uppercase tracking-wider text-zinc-500">
                            Jury Ballots ({scoresCount} / {expectedJudgesCount})
                          </span>
                          {scoresCount > 0 && (
                            <span className="font-mono text-emerald-600 dark:text-emerald-400 font-bold">
                              Average: {formattedScore} pts
                            </span>
                          )}
                        </div>

                        {scoresCount === 0 ? (
                          <div className="p-2.5 rounded-lg bg-white dark:bg-zinc-950 border border-stone-200/60 dark:border-zinc-800 text-zinc-400 text-center text-[11px]">
                            Awaiting jury evaluation. Scores appear live once submitted.
                          </div>
                        ) : (
                          <div className="space-y-1.5">
                            {pScores.map((score, sIdx) => {
                              const judge = judges.find((j) => j.id === score.judge_id);
                              const judgeName = judge?.name || score.judge_id.slice(0, 8);
                              const criteriaMap = score.score_payload?.criteria || score.score_data || {};
                              const criteriaEntries = Object.entries(criteriaMap);

                              return (
                                <div
                                  key={score.id || sIdx}
                                  className="p-2 rounded-lg bg-white dark:bg-zinc-950 border border-stone-200/60 dark:border-zinc-800 space-y-1.5"
                                >
                                  <div className="flex items-center justify-between font-semibold">
                                    <span className="text-zinc-800 dark:text-zinc-200">
                                      ⚖️ {judgeName}
                                    </span>
                                    <span className="font-mono font-black text-emerald-600 dark:text-emerald-400">
                                      {score.total_score} pts
                                    </span>
                                  </div>

                                  {criteriaEntries.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 pt-1 border-t border-stone-100 dark:border-zinc-800/60">
                                      {criteriaEntries.map(([critKey, val]) => {
                                        const critObj = (currentEvent?.rubric_schema || []).find(
                                          (c) => c.id === critKey || c.name === critKey
                                        );
                                        const critLabel = critObj?.name || critKey;
                                        return (
                                          <span
                                            key={critKey}
                                            className="px-1.5 py-0.5 rounded bg-stone-100 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 text-[10px] font-mono"
                                          >
                                            {critLabel}: <strong className="text-zinc-900 dark:text-white">{val}</strong>
                                          </span>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ======================================================== */}
      {/* 4. WORKFLOW CONFIRMATION MODAL                           */}
      {/* ======================================================== */}
      {confirmDialog && confirmDialog.isOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-5 max-w-sm w-full shadow-2xl space-y-4 animate-in zoom-in-95 duration-200">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center bg-red-500/10 text-red-600 dark:text-red-400">
                  <AlertTriangle className="w-5 h-5" />
                </div>
                <h4 className="text-base font-bold text-zinc-900 dark:text-white">
                  {confirmDialog.title}
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 p-1 rounded-lg"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              {confirmDialog.description}
            </p>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                className="min-h-[44px] px-3 rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 font-semibold text-xs transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmAction}
                className={`min-h-[44px] px-3 rounded-xl font-bold text-xs text-white transition-all shadow-xs cursor-pointer ${
                  confirmDialog.isDestructive
                    ? 'bg-red-600 hover:bg-red-500 active:scale-[0.98]'
                    : 'bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98]'
                }`}
              >
                {confirmDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </PullToRefresh>
  );
}
