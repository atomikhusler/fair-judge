import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { 
  Trophy, 
  ArrowLeft, 
  Clock, 
  ShieldAlert, 
  EyeOff, 
  RefreshCw, 
  Sun, 
  Moon, 
  Sparkles, 
  Radio, 
  Wifi, 
  WifiOff, 
  Pause, 
  Play, 
  Crown,
  ChevronRight,
  Flame,
  Scale
} from 'lucide-react';
import { dbService, subscribeToDatabase, PublicLinkSettings } from '../../lib/supabase';
import { 
  Organization, 
  SupabaseEvent, 
  SupabaseParticipant, 
  SupabaseScore,
  RubricCriterion 
} from '../../lib/supabaseTypes';

interface PublicLeaderboardProps {
  orgId: string;
  initialEventId?: string | null;
  onExit: () => void;
}

/**
 * Typo-Truncator helper: prevents layout breakage on 4:3 or narrow projectors.
 */
function truncateText(text: string | undefined | null, maxLength = 25): string {
  if (!text) return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength - 3).trimEnd() + '...';
}

export function PublicLeaderboard({
  orgId,
  initialEventId,
  onExit,
}: PublicLeaderboardProps) {
  // Theme State: 'black' (Deep Black default) vs 'white' (Stadium White)
  const [isStadiumWhite, setIsStadiumWhite] = useState<boolean>(false);

  // Core Data
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [events, setEvents] = useState<SupabaseEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>(initialEventId || '');
  const [participants, setParticipants] = useState<SupabaseParticipant[]>([]);
  const [scores, setScores] = useState<SupabaseScore[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastSyncedTime, setLastSyncedTime] = useState<string>(new Date().toLocaleTimeString());
  const [publicSettings, setPublicSettings] = useState<PublicLinkSettings>(
    dbService.getPublicSettings(orgId)
  );

  // Autonomous TV Carousel (60 seconds per event window)
  const [carouselCountdown, setCarouselCountdown] = useState<number>(60);
  const [isCarouselPaused, setIsCarouselPaused] = useState<boolean>(false);
  const [isEventTransitioning, setIsEventTransitioning] = useState<boolean>(false);

  // Offline / Online Recovery Banner
  const [networkBanner, setNetworkBanner] = useState<{
    show: boolean;
    status: 'offline' | 'online';
    text: string;
  }>({
    show: !navigator.onLine,
    status: navigator.onLine ? 'online' : 'offline',
    text: navigator.onLine ? 'Back to Online!' : 'Offline - Syncing...',
  });

  // "New Leader" Pop-Up Modal
  const [newLeaderModal, setNewLeaderModal] = useState<{
    show: boolean;
    name: string;
    school: string;
    score: string | number;
    sl_no?: string;
  } | null>(null);

  // "Perfect Score" Fireworks Banner
  const [perfectScoreModal, setPerfectScoreModal] = useState<{
    show: boolean;
    participantName: string;
    scoreVal: number;
  } | null>(null);

  // Tracking refs to detect real leaderboard transitions & new scores
  const previousLeaderIdRef = useRef<string | null>(null);
  const isInitialLoadRef = useRef<boolean>(true);
  const seenScoreIdsRef = useRef<Set<string>>(new Set());
  const ledgerScrollRef = useRef<HTMLDivElement>(null);
  const isHoveredLedgerRef = useRef<boolean>(false);

  // -------------------------------------------------------------
  // DATA FETCHING & QUOTA-SAFE REALTIME SUBSCRIPTION
  // -------------------------------------------------------------
  const loadData = useCallback(async (silent = false) => {
    try {
      if (!silent) setIsRefreshing(true);
      const org = await dbService.getOrganizationByOrgId(orgId);
      setOrganization(org);

      const eList = await dbService.getEvents(orgId);
      // Filter non-archived events
      const validEvents = eList.filter((e) => e.status !== 'archived');
      setEvents(validEvents);

      let activeId = selectedEventId;
      if (!activeId || !validEvents.some((e) => e.id === activeId)) {
        const foundActive = validEvents.find((e) => e.status === 'active') || validEvents[0];
        activeId = foundActive ? foundActive.id : '';
        setSelectedEventId(activeId);
      }

      const pList = await dbService.getParticipants(orgId);
      setParticipants(pList);

      if (activeId) {
        const scList = await dbService.getScores(activeId);
        setScores(scList);
      }

      setPublicSettings(dbService.getPublicSettings(orgId));
      setLastSyncedTime(new Date().toLocaleTimeString());
    } catch (err) {
      console.warn('Leaderboard data fetch failed (using cached state):', err);
    } finally {
      if (!silent) {
        setTimeout(() => setIsRefreshing(false), 400);
      }
    }
  }, [orgId, selectedEventId]);

  // Initial load and subscription
  useEffect(() => {
    loadData();
    const unsub = subscribeToDatabase(() => {
      loadData(true);
    });

    // Quota-safe background polling every 20 seconds
    const pollInterval = setInterval(() => {
      loadData(true);
    }, 20000);

    return () => {
      unsub();
      clearInterval(pollInterval);
    };
  }, [loadData]);

  // Update scores when selectedEventId switches
  useEffect(() => {
    if (selectedEventId) {
      dbService.getScores(selectedEventId).then((sc) => {
        setScores(sc);
      });
    }
  }, [selectedEventId]);

  // -------------------------------------------------------------
  // AUTONOMOUS TV BROADCAST CAROUSEL (60s Window & Wipe)
  // -------------------------------------------------------------
  useEffect(() => {
    if (isCarouselPaused || events.length <= 1) return;

    const timer = setInterval(() => {
      setCarouselCountdown((prev) => {
        if (prev <= 1) {
          // Trigger smooth fade/wipe to next event
          setIsEventTransitioning(true);
          setTimeout(() => {
            setEvents((currentEvents) => {
              const currentIndex = currentEvents.findIndex((e) => e.id === selectedEventId);
              const nextIndex = (currentIndex + 1) % currentEvents.length;
              const nextEvent = currentEvents[nextIndex];
              if (nextEvent) {
                setSelectedEventId(nextEvent.id);
              }
              return currentEvents;
            });
            setTimeout(() => {
              setIsEventTransitioning(false);
            }, 300);
          }, 350);
          return 60;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [events, selectedEventId, isCarouselPaused]);

  // -------------------------------------------------------------
  // OFFLINE / ONLINE RECOVERY ENGINE
  // -------------------------------------------------------------
  useEffect(() => {
    let onlineTimer: ReturnType<typeof setTimeout>;

    const handleOffline = () => {
      setNetworkBanner({
        show: true,
        status: 'offline',
        text: 'Offline - Syncing...',
      });
    };

    const handleOnline = () => {
      setNetworkBanner({
        show: true,
        status: 'online',
        text: 'Back to Online!',
      });
      // Re-sync immediately
      loadData(true);
      // Fade out after exactly 3 seconds
      clearTimeout(onlineTimer);
      onlineTimer = setTimeout(() => {
        setNetworkBanner((prev) => ({ ...prev, show: false }));
      }, 3000);
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      clearTimeout(onlineTimer);
    };
  }, [loadData]);

  // Current active event
  const currentEvent = useMemo(() => {
    return events.find((e) => e.id === selectedEventId) || events[0];
  }, [events, selectedEventId]);

  // Compute maximum points for current rubric
  const maxRubricScore = useMemo(() => {
    if (!currentEvent) return 100;
    const rubricList = currentEvent.rubric_schema || currentEvent.rubric || [];
    const total = rubricList.reduce((sum, c) => sum + (Number(c.max_marks) || 0), 0);
    return total > 0 ? total : 100;
  }, [currentEvent]);

  // Assigned participants for current event
  const assignedParticipants = useMemo(() => {
    if (!currentEvent) return [];
    const assignedIds = currentEvent.assigned_participants || [];
    if (assignedIds.length > 0) {
      return participants.filter((p) => assignedIds.includes(p.id));
    }
    return participants;
  }, [participants, currentEvent]);

  // Ranked Standings
  const rankedStandings = useMemo(() => {
    if (!currentEvent) return [];
    return dbService.calculateRankings(
      assignedParticipants,
      scores,
      currentEvent.assigned_judges?.length || 0,
      organization?.tie_breaker_method || 'olympic'
    );
  }, [assignedParticipants, scores, currentEvent, organization?.tie_breaker_method]);

  // -------------------------------------------------------------
  // AUTONOMOUS "NEW LEADER" DETECTION
  // -------------------------------------------------------------
  useEffect(() => {
    if (rankedStandings.length === 0) return;

    // Leader must have at least 1 judge ballot
    const currentLeader = rankedStandings.find((s) => s.judgeCount > 0);
    if (!currentLeader) return;

    if (isInitialLoadRef.current) {
      // First boot: set initial leader without pop-up interruption
      previousLeaderIdRef.current = currentLeader.id;
      isInitialLoadRef.current = false;
      return;
    }

    if (previousLeaderIdRef.current && previousLeaderIdRef.current !== currentLeader.id) {
      // Leader has changed! Darken screen and flash cinematic pop-up for 5 seconds
      setNewLeaderModal({
        show: true,
        name: currentLeader.name,
        school: currentLeader.school,
        score: currentLeader.avgScore,
        sl_no: currentLeader.sl_no,
      });

      const leaderTimer = setTimeout(() => {
        setNewLeaderModal(null);
      }, 5000);

      previousLeaderIdRef.current = currentLeader.id;
      return () => clearTimeout(leaderTimer);
    }

    previousLeaderIdRef.current = currentLeader.id;
  }, [rankedStandings]);

  // -------------------------------------------------------------
  // AUTONOMOUS "PERFECT SCORE" FIREWORKS TRIGGER
  // -------------------------------------------------------------
  useEffect(() => {
    if (!currentEvent || scores.length === 0) return;

    const rubricList = currentEvent.rubric_schema || currentEvent.rubric || [];
    if (rubricList.length === 0) return;

    // Check newly arrived scores
    scores.forEach((sc) => {
      if (seenScoreIdsRef.current.has(sc.id)) return;
      seenScoreIdsRef.current.add(sc.id);

      // Check if every rubric category has max marks
      const criteriaData = sc.score_payload?.criteria || sc.score_data || {};
      const isPerfectMarks = rubricList.every((crit) => {
        const val = Number(criteriaData[crit.id] ?? 0);
        return val >= Number(crit.max_marks || 0) && Number(crit.max_marks) > 0;
      });

      const totalVal = Number(sc.total_score || sc.score_payload?.total_score || 0);
      const isTotalMax = totalVal >= maxRubricScore && maxRubricScore > 0;

      if (isPerfectMarks || isTotalMax) {
        const participantObj = participants.find((p) => p.id === sc.participant_id);
        setPerfectScoreModal({
          show: true,
          participantName: participantObj ? participantObj.name : 'Competitor',
          scoreVal: totalVal,
        });

        setTimeout(() => {
          setPerfectScoreModal(null);
        }, 5000);
      }
    });
  }, [scores, currentEvent, maxRubricScore, participants]);

  // -------------------------------------------------------------
  // LIVE SCORING PULSE (Currently On Stage)
  // -------------------------------------------------------------
  const currentlyOnStageParticipant = useMemo(() => {
    if (!currentEvent) return null;
    const expectedJudges = currentEvent.assigned_judges?.length || 1;

    // A participant is actively performing when they have partial ballots recorded
    const inFlight = assignedParticipants.find((p) => {
      const pScoresCount = scores.filter((s) => s.participant_id === p.id).length;
      return pScoresCount > 0 && pScoresCount < expectedJudges;
    });

    if (inFlight) {
      return inFlight;
    }

    return null;
  }, [assignedParticipants, scores, currentEvent]);

  // -------------------------------------------------------------
  // SMART AUTO-SCROLL PACING FOR LEDGER (Rank 4+)
  // -------------------------------------------------------------
  const rankFourAndBelow = useMemo(() => {
    return rankedStandings.filter((item) => item.rank >= 4 || item.rank === 0);
  }, [rankedStandings]);

  useEffect(() => {
    const el = ledgerScrollRef.current;
    if (!el || rankFourAndBelow.length <= 2) return;

    let animId: number;
    let isPausedAtBoundary = false;
    let lastTimestamp = performance.now();
    const scrollSpeedPixelsPerSecond = 28; // Dynamic, comfortable reading pace

    const scrollLoop = (timestamp: number) => {
      const delta = (timestamp - lastTimestamp) / 1000;
      lastTimestamp = timestamp;

      if (!isHoveredLedgerRef.current && !isPausedAtBoundary && el) {
        const maxScroll = el.scrollHeight - el.clientHeight;
        if (maxScroll > 5) {
          el.scrollTop += scrollSpeedPixelsPerSecond * delta;

          if (el.scrollTop >= maxScroll - 1) {
            isPausedAtBoundary = true;
            setTimeout(() => {
              if (el) {
                // Smoothly reset back to top after brief pause
                el.scrollTo({ top: 0, behavior: 'smooth' });
                setTimeout(() => {
                  isPausedAtBoundary = false;
                }, 1200);
              }
            }, 2500); // 2.5s comfortable rest to read final ranks
          }
        }
      }

      animId = requestAnimationFrame(scrollLoop);
    };

    animId = requestAnimationFrame(scrollLoop);
    return () => cancelAnimationFrame(animId);
  }, [rankFourAndBelow.length]);

  // Podium Positions (Top 3)
  const rank1 = rankedStandings.find((s) => s.rank === 1);
  const rank2 = rankedStandings.find((s) => s.rank === 2);
  const rank3 = rankedStandings.find((s) => s.rank === 3);

  // If link revoked or paused
  if (publicSettings.isRevoked) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center select-none">
        <div className="p-5 bg-red-500/10 border border-red-500/30 rounded-3xl mb-4 text-red-400">
          <ShieldAlert className="w-12 h-12" />
        </div>
        <h2 className="text-2xl md:text-3xl font-black tracking-tight">Broadcast Access Revoked</h2>
        <p className="text-sm text-zinc-400 max-w-md mt-2 mb-6 leading-relaxed">
          The event organizer has closed this public broadcast feed. Please consult the stage desk.
        </p>
        <button
          onClick={onExit}
          className="px-6 py-3 bg-zinc-900 border border-zinc-800 text-sm font-bold rounded-2xl hover:bg-zinc-800 transition"
        >
          Return to Terminal
        </button>
      </div>
    );
  }

  if (publicSettings.isPaused) {
    return (
      <div className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-6 text-center select-none">
        <div className="p-5 bg-amber-500/10 border border-amber-500/30 rounded-3xl mb-4 text-amber-400">
          <EyeOff className="w-12 h-12" />
        </div>
        <h2 className="text-2xl md:text-3xl font-black tracking-tight">Live Broadcast Paused</h2>
        <p className="text-sm text-zinc-400 max-w-md mt-2 mb-6 leading-relaxed">
          The stage committee has momentarily held public standings. Official results will resume in seconds.
        </p>
        <button
          onClick={onExit}
          className="px-6 py-3 bg-zinc-900 border border-zinc-800 text-sm font-bold rounded-2xl hover:bg-zinc-800 transition"
        >
          Exit Broadcast
        </button>
      </div>
    );
  }

  // Visual Theme Variables
  const themeContainerClass = isStadiumWhite
    ? 'bg-white text-black font-sans selection:bg-black selection:text-white'
    : 'bg-black text-white font-sans selection:bg-emerald-500 selection:text-black';

  return (
    <div className={`relative min-h-screen w-full flex flex-col justify-between overflow-x-hidden ${themeContainerClass} transition-colors duration-300`}>
      {/* ============================================================ */}
      {/* 1. CINEMATIC BACKGROUND GLOW (Deep Black Mode)               */}
      {/* ============================================================ */}
      {!isStadiumWhite && (
        <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
          {/* Slow-moving radial emerald/teal gradient */}
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120vw] h-[85vh] bg-[radial-gradient(ellipse_at_50%_0%,rgba(16,185,129,0.14),rgba(13,148,136,0.06)_50%,transparent_80%)] animate-radial-drift" />
          <div className="absolute -bottom-24 -left-20 w-[450px] h-[450px] bg-emerald-600/10 rounded-full blur-[120px] pointer-events-none" />
          <div className="absolute -bottom-24 -right-20 w-[450px] h-[450px] bg-teal-500/10 rounded-full blur-[120px] pointer-events-none" />
        </div>
      )}

      {/* ============================================================ */}
      {/* 2. RECOVERY ENGINE: OFFLINE / ONLINE SLIDE-DOWN BANNER       */}
      {/* ============================================================ */}
      <div
        className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 transition-all duration-500 transform ease-out ${
          networkBanner.show ? 'translate-y-0 opacity-100' : '-translate-y-16 opacity-0 pointer-events-none'
        }`}
      >
        <div
          className={`flex items-center gap-2.5 px-6 py-2 rounded-full font-mono font-black text-xs md:text-sm tracking-wide shadow-2xl border ${
            networkBanner.status === 'offline'
              ? 'bg-amber-500 text-black border-amber-300 shadow-amber-500/30 animate-pulse'
              : 'bg-emerald-500 text-black border-emerald-300 shadow-emerald-500/30'
          }`}
        >
          {networkBanner.status === 'offline' ? (
            <WifiOff className="w-4 h-4 stroke-[2.5]" />
          ) : (
            <Wifi className="w-4 h-4 stroke-[2.5]" />
          )}
          <span>{networkBanner.text}</span>
        </div>
      </div>

      {/* ============================================================ */}
      {/* 3. "NEW OVERALL LEADER!" CINEMATIC POP-UP MODAL (5 Seconds)  */}
      {/* ============================================================ */}
      {newLeaderModal && newLeaderModal.show && (
        <div className="fixed inset-0 z-50 bg-black/90 backdrop-blur-xl flex flex-col items-center justify-center p-6 text-center animate-leader-pop">
          {/* Pulsing golden aura ring */}
          <div className="absolute w-[min(90vw,650px)] h-[min(90vw,650px)] bg-amber-500/20 blur-[130px] rounded-full pointer-events-none" />

          <div className="relative z-10 max-w-3xl flex flex-col items-center space-y-4">
            <div className="inline-flex items-center gap-2 px-5 py-2 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 font-mono text-xs md:text-base font-black uppercase tracking-widest shadow-lg">
              <Crown className="w-5 h-5 text-amber-400 fill-amber-400" />
              <span>Standings Update</span>
            </div>

            <h2 className="text-[clamp(2.4rem,7vw,5.5rem)] font-black tracking-tight leading-none text-white drop-shadow-2xl">
              NEW OVERALL <span className="animate-gold-shimmer font-black">LEADER!</span>
            </h2>

            <div className="pt-2 pb-1">
              <span className="font-mono text-amber-400 font-bold text-sm md:text-xl tracking-wider block">
                {newLeaderModal.sl_no ? `SL: #${newLeaderModal.sl_no}` : ''}
              </span>
              <h3 className="text-[clamp(2rem,5vw,4.2rem)] font-black text-white tracking-tight mt-1">
                {newLeaderModal.name}
              </h3>
              <p className="text-zinc-400 font-semibold text-sm md:text-2xl mt-1 tracking-wide">
                {truncateText(newLeaderModal.school, 35)}
              </p>
            </div>

            <div className="px-8 py-4 rounded-3xl bg-amber-500/10 border-2 border-amber-400/60 shadow-[0_0_60px_rgba(245,158,11,0.35)] mt-4">
              <div className="text-[10px] md:text-xs font-mono uppercase tracking-widest text-amber-300 font-bold">
                Official Winning Average
              </div>
              <div className="text-[clamp(3rem,8vw,6.5rem)] font-mono font-black text-amber-300 leading-none mt-1">
                {newLeaderModal.score}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 4. "PERFECT SCORE" FIREWORKS / BANNER                        */}
      {/* ============================================================ */}
      {perfectScoreModal && perfectScoreModal.show && (
        <div className="fixed top-8 inset-x-4 md:inset-x-20 z-50 animate-in fade-in zoom-in-95 duration-300 pointer-events-none">
          <div className="max-w-4xl mx-auto p-4 md:p-6 bg-gradient-to-r from-amber-600 via-amber-400 to-amber-600 rounded-3xl text-black shadow-[0_0_80px_rgba(245,158,11,0.6)] border-2 border-white/80 flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="p-3 bg-black text-amber-400 rounded-2xl shrink-0">
                <Trophy className="w-8 h-8 fill-amber-400" />
              </div>
              <div>
                <span className="text-xs md:text-sm font-mono font-black uppercase tracking-widest bg-black text-amber-300 px-2.5 py-0.5 rounded-full inline-block">
                  🏆 PERFECT BALLOT
                </span>
                <h4 className="text-lg md:text-2xl font-black tracking-tight text-black mt-1">
                  100% Unanimous Max Score Awarded to {perfectScoreModal.participantName}!
                </h4>
              </div>
            </div>
            <div className="font-mono text-2xl md:text-4xl font-black bg-black text-amber-400 px-4 py-2 rounded-2xl shrink-0">
              {perfectScoreModal.scoreVal} PTS
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 5. LIVE SCORING PULSE (Currently On Stage Banner)            */}
      {/* ============================================================ */}
      {currentlyOnStageParticipant && (
        <div className="relative z-20 w-full bg-gradient-to-r from-amber-500/20 via-amber-500/40 to-amber-500/20 border-b border-amber-500/40 py-2 px-4 text-center">
          <div className="inline-flex items-center gap-2 text-xs md:text-sm font-mono font-black text-amber-300">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping inline-block" />
            <span className="text-amber-200">🟡 CURRENTLY ON STAGE:</span>
            <span className="text-white font-bold underline decoration-amber-400">
              #{currentlyOnStageParticipant.sl_no} {currentlyOnStageParticipant.name}
            </span>
            <span className="text-amber-300/80 hidden sm:inline">
              ({truncateText(currentlyOnStageParticipant.school, 25)})
            </span>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 6. TOP APP & BROADCAST HEADER                                */}
      {/* ============================================================ */}
      <header className="relative z-10 w-full px-4 sm:px-8 pt-4 pb-2">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 border-b pb-4 border-zinc-800/80 dark:border-zinc-800">
          {/* Left: Exit + Stage Identification */}
          <div className="flex items-center gap-3">
            <button
              onClick={onExit}
              className={`p-2.5 rounded-2xl border transition-all cursor-pointer ${
                isStadiumWhite
                  ? 'bg-stone-100 hover:bg-stone-200 text-black border-black'
                  : 'bg-zinc-900/90 hover:bg-zinc-800 text-zinc-300 border-zinc-800'
              }`}
              title="Exit Fullscreen Projector"
            >
              <ArrowLeft className="w-4 h-4 md:w-5 md:h-5" />
            </button>

            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] md:text-xs font-mono font-black tracking-widest text-emerald-500 uppercase bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                  PUBLIC BROADCAST TERMINAL
                </span>
                <span className="text-[10px] md:text-xs font-mono text-zinc-500 hidden sm:inline">
                  ORG: {organization?.org_id || orgId}
                </span>
              </div>
              <h2 className="text-sm md:text-lg font-black tracking-tight mt-0.5">
                {organization?.name || 'Fair Judge Competition Stage'}
              </h2>
            </div>
          </div>

          {/* Right: Autonomous Carousel Status, Event Selector & Live Indicator */}
          <div className="flex items-center gap-2 md:gap-3">
            {/* 60s Carousel Status Badge with Pause/Play */}
            {events.length > 1 && (
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-2xl border font-mono text-[11px] font-bold ${
                  isStadiumWhite
                    ? 'bg-stone-100 border-black text-black'
                    : 'bg-zinc-900/90 border-zinc-800 text-zinc-300'
                }`}
                title="60-second autonomous event rotation"
              >
                <button
                  type="button"
                  onClick={() => setIsCarouselPaused((p) => !p)}
                  className="hover:text-emerald-400 p-0.5 transition cursor-pointer"
                  title={isCarouselPaused ? 'Resume 60s TV Loop' : 'Pause on current event'}
                >
                  {isCarouselPaused ? <Play className="w-3 h-3 text-amber-400" /> : <Pause className="w-3 h-3 text-emerald-400" />}
                </button>
                <Clock className="w-3 h-3 text-zinc-400" />
                <span className="text-emerald-400 font-black">{carouselCountdown}s</span>
                <span className="hidden md:inline text-zinc-400">TV Loop</span>
              </div>
            )}

            {/* Event Dropdown (Organizer manual override if needed) */}
            {events.length > 1 && (
              <select
                value={selectedEventId}
                onChange={(e) => {
                  setSelectedEventId(e.target.value);
                  setCarouselCountdown(60);
                }}
                className={`px-3 py-1.5 rounded-2xl text-xs font-bold border focus:outline-none cursor-pointer ${
                  isStadiumWhite
                    ? 'bg-white text-black border-black font-black'
                    : 'bg-zinc-900 text-white border-zinc-800 focus:border-emerald-500'
                }`}
              >
                {events.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.name}
                  </option>
                ))}
              </select>
            )}

            {/* Live Indicator */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl text-xs font-mono font-bold text-emerald-500">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
              <span>LIVE</span>
            </div>
          </div>
        </div>

        {/* 60-Second Broadcast Carousel Progress Laser */}
        {events.length > 1 && !isCarouselPaused && (
          <div className="max-w-7xl mx-auto h-[2px] bg-zinc-800/40 mt-1 overflow-hidden rounded-full">
            <div
              className="h-full bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500 transition-all duration-1000 ease-linear rounded-full"
              style={{ width: `${(carouselCountdown / 60) * 100}%` }}
            />
          </div>
        )}
      </header>

      {/* ============================================================ */}
      {/* 7. EVENT HEADER: [CATEGORY] — [EVENT TITLE]                  */}
      {/* ============================================================ */}
      <main className="relative z-10 flex-1 max-w-7xl w-full mx-auto px-4 sm:px-8 py-4 flex flex-col justify-start">
        {currentEvent && (
          <div
            className={`text-center space-y-1 mb-6 transition-opacity duration-300 ${
              isEventTransitioning ? 'opacity-0 scale-98' : 'opacity-100 scale-100'
            }`}
          >
            {/* Category Breadcrumb */}
            <div className="inline-flex items-center gap-2 font-mono text-[clamp(0.75rem,1.1vw,1rem)] uppercase font-bold tracking-widest text-emerald-500 bg-emerald-500/10 px-3.5 py-1 rounded-full border border-emerald-500/20">
              <span>{currentEvent.category || 'CHAMPIONSHIP'}</span>
              <span>—</span>
              <span>OFFICIAL STAGE</span>
            </div>

            {/* [CATEGORY] — [EVENT TITLE] Requirement */}
            <h1 className="text-[clamp(1.6rem,3.4vw,3.6rem)] font-black tracking-tight leading-tight uppercase">
              {currentEvent.category ? `${currentEvent.category} — ` : ''}
              <span className={isStadiumWhite ? 'text-black' : 'text-white'}>
                {currentEvent.name}
              </span>
            </h1>

            {/* Tie-breaker & Ballots Audited */}
            <p className="text-[clamp(0.75rem,0.95vw,1rem)] font-mono text-zinc-400">
              Standings Standard: <strong className={isStadiumWhite ? 'text-black' : 'text-white'}>{organization?.tie_breaker_method || 'Olympic Trim'}</strong>
              <span className="mx-2">•</span>
              Ballots Logged: <strong className={isStadiumWhite ? 'text-black' : 'text-emerald-400'}>{scores.length}</strong>
              <span className="mx-2">•</span>
              Contenders: <strong className={isStadiumWhite ? 'text-black' : 'text-white'}>{assignedParticipants.length}</strong>
            </p>
          </div>
        )}

        {/* ============================================================ */}
        {/* 8. THE HERO PODIUM (Top 3 Cinematic Layout)                  */}
        {/* ============================================================ */}
        <div
          className={`grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-6 items-end my-2 transition-all duration-300 ${
            isEventTransitioning ? 'opacity-0 translate-y-3' : 'opacity-100 translate-y-0'
          }`}
        >
          {/* ---------------- 2ND PLACE (LEFT) ---------------- */}
          <div className="order-2 md:order-1 flex flex-col justify-end transform md:scale-95 transition-transform">
            <div
              className={`rounded-3xl p-5 md:p-6 border flex flex-col justify-between min-h-[220px] md:min-h-[260px] relative overflow-hidden backdrop-blur-md shadow-xl ${
                isStadiumWhite
                  ? 'bg-stone-50 border-slate-400 text-black shadow-slate-200'
                  : 'bg-gradient-to-b from-slate-900/80 via-zinc-950/90 to-black border-slate-400/40 text-slate-100 shadow-[0_0_35px_rgba(148,163,184,0.12)]'
              }`}
            >
              {/* Podium Rank Label */}
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-black uppercase tracking-wider bg-slate-400/20 text-slate-300 border border-slate-400/30">
                  <span className="text-base">🥈</span> 2ND PLACE
                </span>
                {rank2 && (
                  <span className="font-mono text-xs font-bold text-slate-400">
                    SL: #{rank2.sl_no}
                  </span>
                )}
              </div>

              {rank2 ? (
                <div className="my-auto py-3">
                  <h3 className="text-[clamp(1.1rem,1.8vw,1.8rem)] font-black tracking-tight leading-snug">
                    {rank2.name}
                  </h3>
                  <p className="text-[clamp(0.75rem,0.95vw,1rem)] text-zinc-400 font-semibold mt-1">
                    {truncateText(rank2.class_or_age || 'General', 20)} • {truncateText(rank2.school, 24)}
                  </p>
                </div>
              ) : (
                <div className="my-auto py-4 text-center text-zinc-500 font-mono text-sm">
                  Awaiting 2nd Place Data
                </div>
              )}

              {/* Monospace Score Display */}
              <div className="pt-2 border-t border-slate-400/20 flex items-baseline justify-between">
                <span className="text-[10px] md:text-xs font-mono uppercase tracking-wider text-zinc-400">
                  Score
                </span>
                <div className="text-[clamp(1.8rem,3.8vw,3.2rem)] font-mono font-black leading-none text-slate-200">
                  {rank2 && rank2.judgeCount > 0 ? (
                    <span>
                      {rank2.avgScore} <span className="text-xs md:text-sm font-normal text-zinc-500">/ {maxRubricScore}</span>
                    </span>
                  ) : (
                    <span className="text-zinc-500 text-lg">PENDING</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ---------------- 1ST PLACE (CENTER HERO) ---------------- */}
          <div className="order-1 md:order-2 flex flex-col justify-end z-10">
            <div
              className={`rounded-3xl p-6 md:p-8 border-2 flex flex-col justify-between min-h-[260px] md:min-h-[320px] relative overflow-hidden backdrop-blur-xl shadow-2xl transition-all ${
                isStadiumWhite
                  ? 'bg-amber-50 border-amber-500 text-black shadow-amber-200'
                  : 'bg-gradient-to-b from-amber-500/20 via-amber-950/40 to-black border-amber-400/70 text-amber-200 shadow-[0_0_55px_rgba(245,158,11,0.28)]'
              }`}
            >
              {/* Gold Crown Badge */}
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs md:text-sm font-mono font-black uppercase tracking-wider bg-amber-500/20 text-amber-300 border border-amber-400/50 shadow-md">
                  <Crown className="w-4 h-4 text-amber-400 fill-amber-400" /> 1ST OVERALL LEADER
                </span>
                {rank1 && (
                  <span className="font-mono text-xs md:text-sm font-black text-amber-400">
                    SL: #{rank1.sl_no}
                  </span>
                )}
              </div>

              {rank1 ? (
                <div className="my-auto py-3">
                  <h3 className="text-[clamp(1.35rem,2.4vw,2.5rem)] font-black tracking-tight leading-tight text-white drop-shadow-md">
                    {rank1.name}
                  </h3>
                  <p className="text-[clamp(0.85rem,1.1vw,1.2rem)] text-amber-300/90 font-bold mt-1">
                    {truncateText(rank1.class_or_age || 'Championship', 22)} • {truncateText(rank1.school, 25)}
                  </p>
                </div>
              ) : (
                <div className="my-auto py-6 text-center text-amber-400/60 font-mono text-base">
                  Awaiting 1st Place Data
                </div>
              )}

              {/* Massive Score Monospace */}
              <div className="pt-3 border-t border-amber-400/30 flex items-baseline justify-between">
                <span className="text-xs font-mono uppercase tracking-widest text-amber-300/80 font-bold">
                  Winning Mark
                </span>
                <div className="text-[clamp(2.4rem,5.5vw,4.8rem)] font-mono font-black leading-none text-amber-300">
                  {rank1 && rank1.judgeCount > 0 ? (
                    <span>
                      {rank1.avgScore} <span className="text-sm md:text-base font-normal text-amber-400/70">/ {maxRubricScore}</span>
                    </span>
                  ) : (
                    <span className="text-zinc-500 text-xl font-normal">PENDING</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ---------------- 3RD PLACE (RIGHT) ---------------- */}
          <div className="order-3 md:order-3 flex flex-col justify-end transform md:scale-90 transition-transform">
            <div
              className={`rounded-3xl p-5 md:p-6 border flex flex-col justify-between min-h-[200px] md:min-h-[240px] relative overflow-hidden backdrop-blur-md shadow-lg ${
                isStadiumWhite
                  ? 'bg-amber-50/50 border-amber-700 text-black shadow-stone-200'
                  : 'bg-gradient-to-b from-amber-950/40 via-zinc-950/90 to-black border-amber-700/50 text-amber-100 shadow-[0_0_25px_rgba(180,83,9,0.12)]'
              }`}
            >
              {/* Bronze Badge */}
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-black uppercase tracking-wider bg-amber-700/20 text-amber-400 border border-amber-700/40">
                  <span className="text-base">🥉</span> 3RD PLACE
                </span>
                {rank3 && (
                  <span className="font-mono text-xs font-bold text-amber-600">
                    SL: #{rank3.sl_no}
                  </span>
                )}
              </div>

              {rank3 ? (
                <div className="my-auto py-3">
                  <h3 className="text-[clamp(1.05rem,1.7vw,1.7rem)] font-black tracking-tight leading-snug">
                    {rank3.name}
                  </h3>
                  <p className="text-[clamp(0.72rem,0.9vw,0.95rem)] text-zinc-400 font-semibold mt-1">
                    {truncateText(rank3.class_or_age || 'General', 20)} • {truncateText(rank3.school, 24)}
                  </p>
                </div>
              ) : (
                <div className="my-auto py-4 text-center text-zinc-500 font-mono text-sm">
                  Awaiting 3rd Place Data
                </div>
              )}

              {/* Monospace Score */}
              <div className="pt-2 border-t border-amber-700/30 flex items-baseline justify-between">
                <span className="text-[10px] md:text-xs font-mono uppercase tracking-wider text-zinc-400">
                  Score
                </span>
                <div className="text-[clamp(1.6rem,3.4vw,2.8rem)] font-mono font-black leading-none text-amber-200">
                  {rank3 && rank3.judgeCount > 0 ? (
                    <span>
                      {rank3.avgScore} <span className="text-xs md:text-sm font-normal text-zinc-500">/ {maxRubricScore}</span>
                    </span>
                  ) : (
                    <span className="text-zinc-500 text-lg">PENDING</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ============================================================ */}
        {/* 9. THE ROLLING LEDGER (Rank 4+)                              */}
        {/* ============================================================ */}
        <div className="mt-6 flex-1 flex flex-col min-h-0">
          <div className="flex items-center justify-between pb-2 border-b border-zinc-800/60 mb-3">
            <span className="text-xs md:text-sm font-mono font-bold tracking-wider uppercase text-zinc-400">
              Contender Ledger (Ranks 4+)
            </span>
            <span className="text-[11px] font-mono text-zinc-500">
              Auto-Paced Broadcast Scroll
            </span>
          </div>

          <div
            ref={ledgerScrollRef}
            onMouseEnter={() => {
              isHoveredLedgerRef.current = true;
            }}
            onMouseLeave={() => {
              isHoveredLedgerRef.current = false;
            }}
            className="space-y-2.5 max-h-[36vh] overflow-y-auto pr-1 select-none"
          >
            {rankFourAndBelow.length === 0 ? (
              <div className="p-6 text-center text-zinc-500 font-mono text-xs md:text-sm rounded-2xl border border-zinc-800/40">
                All scheduled contenders currently ranked within Hero Podium Top 3.
              </div>
            ) : (
              rankFourAndBelow.map((row) => (
                <div
                  key={row.id}
                  className={`flex items-center justify-between gap-4 p-3 md:p-4 rounded-2xl border transition-all ${
                    isStadiumWhite
                      ? 'bg-stone-50 border-stone-200 text-black hover:bg-stone-100'
                      : 'bg-white/[0.03] hover:bg-white/[0.06] border-white/10 text-white backdrop-blur-md'
                  }`}
                >
                  {/* Left: Rank Badge */}
                  <div className="flex items-center gap-3 md:gap-4 min-w-0">
                    <div
                      className={`w-9 h-9 md:w-11 md:h-11 rounded-xl flex items-center justify-center font-mono font-black text-sm md:text-base shrink-0 border ${
                        isStadiumWhite
                          ? 'bg-white border-black text-black'
                          : 'bg-zinc-900 border-zinc-800 text-zinc-300'
                      }`}
                    >
                      {row.rank > 0 ? `#${row.rank}` : '—'}
                    </div>

                    {/* Middle: Name & Sub-Data */}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-emerald-500">
                          {row.sl_no}
                        </span>
                        <h4 className="text-[clamp(0.85rem,1.3vw,1.25rem)] font-extrabold tracking-tight truncate">
                          {row.name}
                        </h4>
                      </div>
                      <p className="text-[clamp(0.7rem,0.9vw,0.9rem)] text-zinc-400 font-medium truncate mt-0.5">
                        {truncateText(row.class_or_age || 'Category Entry', 20)} • {truncateText(row.school, 25)}
                      </p>
                    </div>
                  </div>

                  {/* Right: Monospace Score */}
                  <div className="text-right shrink-0">
                    <div className="text-[clamp(1.1rem,1.8vw,1.7rem)] font-mono font-black text-emerald-500 leading-none">
                      {row.judgeCount > 0 ? (
                        <span>
                          {row.avgScore}{' '}
                          <span className="text-[10px] md:text-xs font-normal text-zinc-500">
                            / {maxRubricScore}
                          </span>
                        </span>
                      ) : (
                        <span className="text-zinc-500 text-sm font-normal">Pending</span>
                      )}
                    </div>
                    <div className="text-[10px] font-mono text-zinc-500 mt-0.5">
                      {row.judgeCount} / {currentEvent?.assigned_judges.length || 0} Ballots
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>

      {/* ============================================================ */}
      {/* 10. THE FOOTER (Branding & Morphing Ambient Glow)            */}
      {/* ============================================================ */}
      <footer
        className={`relative z-10 w-full px-4 sm:px-8 py-3 border-t transition-colors ${
          isStadiumWhite
            ? 'bg-stone-50 border-black text-black'
            : 'bg-black/90 border-zinc-900 text-zinc-400'
        }`}
      >
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 relative">
          {/* Morphing Ambient Glow behind footer branding (Deep Black mode) */}
          {!isStadiumWhite && (
            <div className="absolute -left-10 bottom-0 w-64 h-16 bg-gradient-to-r from-emerald-500/20 to-teal-500/10 rounded-full blur-2xl animate-ambient-glow pointer-events-none" />
          )}

          {/* Left: Fair Judge App Logo & Name */}
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 md:w-8 md:h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-md shadow-emerald-500/20 shrink-0">
              <Scale className="w-4 h-4 md:w-4.5 md:h-4.5 stroke-[2.2]" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className={`text-sm md:text-base font-black tracking-tight ${isStadiumWhite ? 'text-black' : 'text-white'}`}>
                Fair Judge
              </span>
              <span className="text-[10px] md:text-xs font-mono font-bold text-emerald-500">
                AUDITED DIGITAL LEDGER
              </span>
            </div>
          </div>

          {/* Right: Engineered by attribution */}
          <div className="flex items-center gap-3">
            <span className="text-[11px] md:text-xs font-mono font-semibold tracking-wide">
              Engineered by <strong className={isStadiumWhite ? 'text-black font-black' : 'text-zinc-200'}>Sahil Kumar Rout</strong>
            </span>
          </div>
        </div>
      </footer>

      {/* ============================================================ */}
      {/* 11. SUBTLE STADIUM WHITE / DEEP BLACK DAYLIGHT TOGGLE        */}
      {/* ============================================================ */}
      <div className="fixed bottom-3 right-4 sm:bottom-4 sm:right-6 z-40">
        <button
          type="button"
          onClick={() => setIsStadiumWhite((v) => !v)}
          className={`p-2.5 rounded-full border shadow-2xl transition-all cursor-pointer flex items-center justify-center ${
            isStadiumWhite
              ? 'bg-black text-white border-black hover:scale-105'
              : 'bg-white text-black border-zinc-200 hover:scale-105 shadow-white/10'
          }`}
          title={isStadiumWhite ? 'Switch to Deep Black (Dark Auditorium)' : 'Switch to Stadium White (Daylight Outdoor)'}
        >
          {isStadiumWhite ? (
            <Moon className="w-4 h-4 fill-white text-white" />
          ) : (
            <Sun className="w-4 h-4 fill-amber-400 text-amber-500" />
          )}
        </button>
      </div>
    </div>
  );
}
