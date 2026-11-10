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
  Scale,
  Lock,
  QrCode,
  PartyPopper
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
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

/**
 * Lightweight Celebratory Confetti Particle Canvas
 */
function ConfettiCanvas({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const colors = ['#10B981', '#34D399', '#F59E0B', '#FBBF24', '#60A5FA', '#EC4899', '#A855F7', '#FFFFFF'];
    const particleCount = 140;
    const particles = Array.from({ length: particleCount }).map(() => ({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height * 0.4,
      w: Math.random() * 9 + 5,
      h: Math.random() * 6 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      vx: (Math.random() - 0.5) * 6,
      vy: Math.random() * 4 + 3,
      angle: Math.random() * 360,
      vAngle: (Math.random() - 0.5) * 8,
      opacity: 1
    }));

    let animId: number;
    const startTime = performance.now();
    const duration = 4500; // 4.5s burst

    const render = (time: number) => {
      const elapsed = time - startTime;
      if (elapsed > duration) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const fadeProgress = Math.max(0, 1 - (elapsed / duration));

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.angle += p.vAngle;

        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.angle * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = fadeProgress;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }

      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [active]);

  if (!active) return null;

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-50 w-full h-full"
    />
  );
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
  const [publicSettings, setPublicSettings] = useState<PublicLinkSettings>(() =>
    dbService.getPublicSettings(orgId)
  );

  // Confetti Particle System Trigger
  const [isConfettiActive, setIsConfettiActive] = useState<boolean>(false);
  const lastConfettiTriggerRef = useRef<number>(publicSettings.confettiTrigger || 0);

  // Rotation Window duration from settings or fallback to 60s
  const rotationDuration = publicSettings.paginationTimer || 60;

  // Autonomous TV Carousel (rotates through events using rotationDuration)
  const [carouselCountdown, setCarouselCountdown] = useState<number>(rotationDuration);
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

  // Trigger celebratory confetti function
  const fireConfetti = useCallback(() => {
    setIsConfettiActive(true);
    setTimeout(() => {
      setIsConfettiActive(false);
    }, 4500);
  }, []);

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

      const freshSettings = dbService.getPublicSettings(orgId);
      setPublicSettings(freshSettings);

      // Check if confetti trigger timestamp changed
      if (
        freshSettings.confettiTrigger &&
        freshSettings.confettiTrigger > (lastConfettiTriggerRef.current || 0)
      ) {
        lastConfettiTriggerRef.current = freshSettings.confettiTrigger;
        fireConfetti();
      }

      setLastSyncedTime(new Date().toLocaleTimeString());
    } catch (err) {
      console.warn('Leaderboard data fetch failed (using cached state):', err);
    } finally {
      if (!silent) {
        setTimeout(() => setIsRefreshing(false), 400);
      }
    }
  }, [orgId, selectedEventId, fireConfetti]);

  // Initial load, DB change subscription & custom confetti event listener
  useEffect(() => {
    loadData();
    const unsub = subscribeToDatabase(() => {
      loadData(true);
    });

    // Custom window confetti event dispatched by SettingsDrawer
    const handleCustomConfetti = () => {
      fireConfetti();
    };
    window.addEventListener('fairjudge_confetti', handleCustomConfetti);

    // Quota-safe background polling every 20 seconds
    const pollInterval = setInterval(() => {
      loadData(true);
    }, 20000);

    return () => {
      unsub();
      window.removeEventListener('fairjudge_confetti', handleCustomConfetti);
      clearInterval(pollInterval);
    };
  }, [loadData, fireConfetti]);

  // Update scores when selectedEventId switches
  useEffect(() => {
    if (selectedEventId) {
      dbService.getScores(selectedEventId).then((sc) => {
        setScores(sc);
      });
    }
  }, [selectedEventId]);

  // Sync carousel duration if publicSettings changes
  useEffect(() => {
    setCarouselCountdown(publicSettings.paginationTimer || 60);
  }, [publicSettings.paginationTimer]);

  // -------------------------------------------------------------
  // AUTONOMOUS TV BROADCAST CAROUSEL
  // -------------------------------------------------------------
  useEffect(() => {
    if (isCarouselPaused || events.length <= 1) return;
    const duration = publicSettings.paginationTimer || 60;

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
          return duration;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [events, selectedEventId, isCarouselPaused, publicSettings.paginationTimer]);

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
      loadData(true);
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

    const currentLeader = rankedStandings.find((s) => s.judgeCount > 0);
    if (!currentLeader) return;

    if (isInitialLoadRef.current) {
      previousLeaderIdRef.current = currentLeader.id;
      isInitialLoadRef.current = false;
      return;
    }

    if (previousLeaderIdRef.current && previousLeaderIdRef.current !== currentLeader.id) {
      setNewLeaderModal({
        show: true,
        name: currentLeader.name,
        school: currentLeader.school,
        score: currentLeader.avgScore,
        sl_no: currentLeader.sl_no,
      });

      // Fire celebratory confetti when a new overall leader emerges
      fireConfetti();

      const leaderTimer = setTimeout(() => {
        setNewLeaderModal(null);
      }, 5000);

      previousLeaderIdRef.current = currentLeader.id;
      return () => clearTimeout(leaderTimer);
    }

    previousLeaderIdRef.current = currentLeader.id;
  }, [rankedStandings, fireConfetti]);

  // -------------------------------------------------------------
  // AUTONOMOUS "PERFECT SCORE" FIREWORKS TRIGGER
  // -------------------------------------------------------------
  useEffect(() => {
    if (!currentEvent || scores.length === 0) return;

    const rubricList = currentEvent.rubric_schema || currentEvent.rubric || [];
    if (rubricList.length === 0) return;

    scores.forEach((sc) => {
      if (seenScoreIdsRef.current.has(sc.id)) return;
      seenScoreIdsRef.current.add(sc.id);

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

        fireConfetti();

        setTimeout(() => {
          setPerfectScoreModal(null);
        }, 5000);
      }
    });
  }, [scores, currentEvent, maxRubricScore, participants, fireConfetti]);

  // -------------------------------------------------------------
  // LIVE SCORING PULSE (Currently On Stage)
  // -------------------------------------------------------------
  const currentlyOnStageParticipant = useMemo(() => {
    if (!currentEvent) return null;
    const expectedJudges = currentEvent.assigned_judges?.length || 1;

    // Participant actively being scored (partial ballots)
    const inFlight = assignedParticipants.find((p) => {
      const pScoresCount = scores.filter((s) => s.participant_id === p.id).length;
      return pScoresCount > 0 && pScoresCount < expectedJudges;
    });

    return inFlight || null;
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
    const scrollSpeedPixelsPerSecond = 28;

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
                el.scrollTo({ top: 0, behavior: 'smooth' });
                setTimeout(() => {
                  isPausedAtBoundary = false;
                }, 1200);
              }
            }, 2500);
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

  // Score Secrecy (Blind Mode) check
  const isBlindMode = !!publicSettings.blindMode;
  const isSpotlightEnabled = publicSettings.spotlightMode !== false;

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
          className="px-6 py-3 bg-zinc-900 border border-zinc-800 text-sm font-bold rounded-2xl hover:bg-zinc-800 transition cursor-pointer"
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
          className="px-6 py-3 bg-zinc-900 border border-zinc-800 text-sm font-bold rounded-2xl hover:bg-zinc-800 transition cursor-pointer"
        >
          Exit Broadcast
        </button>
      </div>
    );
  }

  // Visual Theme Variables with high contrast protection
  const themeContainerClass = isStadiumWhite
    ? 'bg-zinc-50 text-zinc-950 font-sans selection:bg-black selection:text-white'
    : 'bg-zinc-950 text-white dark:text-white font-sans selection:bg-emerald-500 selection:text-black';

  return (
    <div className={`relative min-h-screen w-full flex flex-col justify-between overflow-x-hidden ${themeContainerClass} p-safe transition-colors duration-300`}>
      {/* ============================================================ */}
      {/* 0. CELEBRATORY CONFETTI SYSTEM                               */}
      {/* ============================================================ */}
      <ConfettiCanvas active={isConfettiActive} />

      {/* ============================================================ */}
      {/* 1. CINEMATIC BACKGROUND GLOW (Deep Black Mode Only)          */}
      {/* ============================================================ */}
      {!isStadiumWhite && (
        <div className="fixed inset-0 pointer-events-none overflow-hidden z-0">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[120vw] h-[85vh] bg-[radial-gradient(ellipse_at_50%_0%,rgba(16,185,129,0.12),rgba(13,148,136,0.05)_50%,transparent_80%)] animate-radial-drift" />
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
        <div className="fixed inset-0 z-50 bg-black flex flex-col items-center justify-center p-6 text-center animate-leader-pop">
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
                {isBlindMode ? 'Official Standing' : 'Official Winning Average'}
              </div>
              <div className="text-[clamp(3rem,8vw,6.5rem)] font-mono font-black text-amber-300 leading-none mt-1">
                {isBlindMode ? (
                  <span className="flex items-center gap-3 text-2xl md:text-4xl">
                    <Lock className="w-8 h-8" /> AUDITED
                  </span>
                ) : (
                  newLeaderModal.score
                )}
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
              {isBlindMode ? 'PERFECT' : `${perfectScoreModal.scoreVal} PTS`}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 5. LIVE SCORING PULSE (Currently On Stage Banner)            */}
      {/* ============================================================ */}
      {isSpotlightEnabled && currentlyOnStageParticipant && (
        <div className={`relative z-20 w-full py-2 px-4 text-center border-b transition-colors ${
          isStadiumWhite
            ? 'bg-amber-100 border-amber-300 text-amber-950 shadow-sm'
            : 'bg-gradient-to-r from-amber-500/20 via-amber-500/40 to-amber-500/20 border-amber-500/40 text-amber-300'
        }`}>
          <div className="inline-flex items-center gap-2 text-xs md:text-sm font-mono font-black">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-ping inline-block" />
            <span className={isStadiumWhite ? 'text-amber-900 font-extrabold' : 'text-amber-200'}>
              🟡 CURRENTLY ON STAGE:
            </span>
            <span className={`font-bold underline decoration-amber-500 ${isStadiumWhite ? 'text-zinc-950' : 'text-white'}`}>
              #{currentlyOnStageParticipant.sl_no} {currentlyOnStageParticipant.name}
            </span>
            <span className={`${isStadiumWhite ? 'text-zinc-600' : 'text-amber-300/80'} hidden sm:inline`}>
              ({truncateText(currentlyOnStageParticipant.school, 25)})
            </span>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 6. TOP APP & BROADCAST HEADER                                */}
      {/* ============================================================ */}
      <header className="relative z-10 w-full px-4 sm:px-8 pt-4 pb-2">
        <div className={`max-w-7xl mx-auto flex items-center justify-between gap-4 border-b pb-4 ${
          isStadiumWhite ? 'border-stone-300' : 'border-zinc-800/80'
        }`}>
          {/* Left: Exit + Stage Identification */}
          <div className="flex items-center gap-3">
            <button
              onClick={onExit}
              className={`p-2.5 rounded-2xl border transition-all cursor-pointer ${
                isStadiumWhite
                  ? 'bg-white hover:bg-stone-200 text-zinc-950 border-stone-300 shadow-sm'
                  : 'bg-zinc-900/90 hover:bg-zinc-800 text-zinc-300 border-zinc-800'
              }`}
              title="Exit Fullscreen Projector"
            >
              <ArrowLeft className="w-4 h-4 md:w-5 md:h-5" />
            </button>

            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] md:text-xs font-mono font-black tracking-widest text-emerald-600 dark:text-emerald-400 uppercase bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                  PUBLIC BROADCAST TERMINAL
                </span>
                {isBlindMode && (
                  <span className="inline-flex items-center gap-1 text-[10px] md:text-xs font-mono font-black tracking-widest text-amber-600 dark:text-amber-400 uppercase bg-amber-500/10 px-2 py-0.5 rounded-full border border-amber-500/20">
                    <Lock className="w-3 h-3" /> BLIND MODE
                  </span>
                )}
                <span className={`text-[10px] md:text-xs font-mono hidden sm:inline ${
                  isStadiumWhite ? 'text-zinc-500' : 'text-zinc-500'
                }`}>
                  ORG: {organization?.org_id || orgId}
                </span>
              </div>
              <h2 className={`text-sm md:text-lg font-black tracking-tight mt-0.5 ${
                isStadiumWhite ? 'text-zinc-950' : 'text-white'
              }`}>
                {organization?.name || 'Fair Judge Competition Stage'}
              </h2>
            </div>
          </div>

          {/* Right: Autonomous Carousel Status, Event Selector & Live Indicator */}
          <div className="flex items-center gap-2 md:gap-3">
            {/* Carousel Status Badge with Pause/Play */}
            {events.length > 1 && (
              <div
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-2xl border font-mono text-[11px] font-bold ${
                  isStadiumWhite
                    ? 'bg-white border-stone-300 text-zinc-950 shadow-sm'
                    : 'bg-zinc-900/90 border-zinc-800 text-zinc-300'
                }`}
                title={`${rotationDuration}-second autonomous event rotation`}
              >
                <button
                  type="button"
                  onClick={() => setIsCarouselPaused((p) => !p)}
                  className="hover:text-emerald-400 p-0.5 transition cursor-pointer"
                  title={isCarouselPaused ? `Resume ${rotationDuration}s TV Loop` : 'Pause on current event'}
                >
                  {isCarouselPaused ? <Play className="w-3 h-3 text-amber-500" /> : <Pause className="w-3 h-3 text-emerald-500" />}
                </button>
                <Clock className="w-3 h-3 text-zinc-400" />
                <span className="text-emerald-500 font-black tabular-nums whitespace-nowrap">{carouselCountdown}s</span>
                <span className={`hidden md:inline ${isStadiumWhite ? 'text-zinc-600' : 'text-zinc-400'}`}>TV Loop</span>
              </div>
            )}

            {/* Event Dropdown */}
            {events.length > 1 && (
              <select
                value={selectedEventId}
                onChange={(e) => {
                  setSelectedEventId(e.target.value);
                  setCarouselCountdown(rotationDuration);
                }}
                className={`px-3 py-1.5 rounded-2xl text-xs font-bold border focus:outline-none cursor-pointer ${
                  isStadiumWhite
                    ? 'bg-white text-zinc-950 border-stone-300 font-black shadow-sm'
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

        {/* Broadcast Carousel Progress Laser */}
        {events.length > 1 && !isCarouselPaused && (
          <div className={`max-w-7xl mx-auto h-[2px] mt-1 overflow-hidden rounded-full ${
            isStadiumWhite ? 'bg-stone-200' : 'bg-zinc-800/40'
          }`}>
            <div
              className="h-full bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500 transition-all duration-1000 ease-linear rounded-full"
              style={{ width: `${(carouselCountdown / rotationDuration) * 100}%` }}
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
            <div className="inline-flex items-center gap-2 font-mono text-[clamp(0.75rem,1.1vw,1rem)] uppercase font-bold tracking-widest text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3.5 py-1 rounded-full border border-emerald-500/20">
              <span>{currentEvent.category || 'CHAMPIONSHIP'}</span>
              <span>—</span>
              <span>OFFICIAL STAGE</span>
            </div>

            {/* [CATEGORY] — [EVENT TITLE] */}
            <h1 className="text-[clamp(1.6rem,3.4vw,3.6rem)] font-black tracking-tight leading-tight uppercase">
              {currentEvent.category ? `${currentEvent.category} — ` : ''}
              <span className={isStadiumWhite ? 'text-zinc-950 font-black' : 'text-white'}>
                {currentEvent.name}
              </span>
            </h1>

            {/* Tie-breaker & Ballots Audited */}
            <p className={`text-[clamp(0.75rem,0.95vw,1rem)] font-mono ${
              isStadiumWhite ? 'text-zinc-600 font-semibold' : 'text-zinc-400'
            }`}>
              Standings Standard: <strong className={isStadiumWhite ? 'text-zinc-950' : 'text-white'}>{organization?.tie_breaker_method || 'Olympic Trim'}</strong>
              <span className="mx-2">•</span>
              Ballots Logged: <strong className={isStadiumWhite ? 'text-emerald-700' : 'text-emerald-400'}>{scores.length}</strong>
              <span className="mx-2">•</span>
              Contenders: <strong className={isStadiumWhite ? 'text-zinc-950' : 'text-white'}>{assignedParticipants.length}</strong>
              {isBlindMode && (
                <>
                  <span className="mx-2">•</span>
                  <span className="text-amber-500 font-bold">Blind Scoring Active</span>
                </>
              )}
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
              className={`rounded-3xl p-5 md:p-6 border border-t-white/5 flex flex-col justify-between min-h-[220px] md:min-h-[260px] relative overflow-hidden transition-all ${
                isSpotlightEnabled && currentlyOnStageParticipant?.id === rank2?.id
                  ? 'ring-2 ring-amber-400 scale-[1.02] shadow-amber-400/20'
                  : ''
              } ${
                isStadiumWhite
                  ? 'bg-white border-stone-300 text-zinc-950 shadow-md'
                  : 'bg-gradient-to-b from-slate-900 via-zinc-950 to-black border-slate-400/40 text-slate-100 shadow-[0_0_35px_rgba(148,163,184,0.12)]'
              }`}
            >
              {/* Podium Rank Label */}
              <div className="flex items-center justify-between">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-black uppercase tracking-wider border ${
                  isStadiumWhite
                    ? 'bg-slate-200 text-slate-800 border-slate-300'
                    : 'bg-slate-400/20 text-slate-300 border-slate-400/30'
                }`}>
                  <span className="text-base">🥈</span> 2ND PLACE
                </span>
                {rank2 && (
                  <span className={`font-mono text-xs font-bold ${isStadiumWhite ? 'text-slate-600' : 'text-slate-400'}`}>
                    SL: #{rank2.sl_no}
                  </span>
                )}
              </div>

              {rank2 ? (
                <div className="my-auto py-3">
                  <h3 className={`text-[clamp(1.1rem,1.8vw,1.8rem)] font-black tracking-tight leading-snug ${
                    isStadiumWhite ? 'text-zinc-950' : 'text-white'
                  }`}>
                    {rank2.name}
                  </h3>
                  <p className={`text-[clamp(0.75rem,0.95vw,1rem)] font-semibold mt-1 ${
                    isStadiumWhite ? 'text-zinc-600' : 'text-zinc-400'
                  }`}>
                    {truncateText(rank2.class_or_age || 'General', 20)} • {truncateText(rank2.school, 24)}
                  </p>
                </div>
              ) : (
                <div className={`my-auto py-4 text-center font-mono text-sm ${
                  isStadiumWhite ? 'text-zinc-400' : 'text-zinc-500'
                }`}>
                  Awaiting 2nd Place Data
                </div>
              )}

              {/* Monospace Score Display */}
              <div className={`pt-2 border-t flex items-baseline justify-between ${
                isStadiumWhite ? 'border-stone-200' : 'border-slate-400/20'
              }`}>
                <span className={`text-[10px] md:text-xs font-mono uppercase tracking-wider ${
                  isStadiumWhite ? 'text-zinc-500 font-bold' : 'text-zinc-400'
                }`}>
                  {isBlindMode ? 'Status' : 'Score'}
                </span>
                <div className={`text-[clamp(1.6rem,3.4vw,3rem)] font-mono font-black leading-none tabular-nums whitespace-nowrap ${
                  isStadiumWhite ? 'text-zinc-900' : 'text-slate-200'
                }`}>
                  {rank2 && rank2.judgeCount > 0 ? (
                    isBlindMode ? (
                      <span className="inline-flex items-center gap-1.5 text-sm md:text-base text-amber-500 font-bold">
                        <Lock className="w-4 h-4" /> AUDITED
                      </span>
                    ) : (
                      <span>
                        {rank2.avgScore} <span className="text-xs md:text-sm font-normal text-zinc-500">/ {maxRubricScore}</span>
                      </span>
                    )
                  ) : (
                    <span className="text-zinc-400 text-lg">PENDING</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ---------------- 1ST PLACE (CENTER HERO) ---------------- */}
          <div className="order-1 md:order-2 flex flex-col justify-end z-10">
            <div
              className={`rounded-3xl p-6 md:p-8 border-2 border-t-white/5 flex flex-col justify-between min-h-[260px] md:min-h-[320px] relative overflow-hidden transition-all ${
                isSpotlightEnabled && currentlyOnStageParticipant?.id === rank1?.id
                  ? 'ring-4 ring-amber-400 scale-[1.02]'
                  : ''
              } ${
                isStadiumWhite
                  ? 'bg-amber-50 border-amber-500 text-zinc-950 shadow-xl'
                  : 'bg-gradient-to-b from-amber-500/20 via-amber-950/40 to-black border-amber-400/70 text-amber-200 shadow-[0_0_55px_rgba(245,158,11,0.28)]'
              }`}
            >
              {/* Gold Crown Badge */}
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs md:text-sm font-mono font-black uppercase tracking-wider bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-400/50 shadow-md">
                  <Crown className="w-4 h-4 text-amber-500 dark:text-amber-400 fill-amber-500 dark:fill-amber-400" /> 1ST OVERALL LEADER
                </span>
                {rank1 && (
                  <span className="font-mono text-xs md:text-sm font-black text-amber-600 dark:text-amber-400">
                    SL: #{rank1.sl_no}
                  </span>
                )}
              </div>

              {rank1 ? (
                <div className="my-auto py-3">
                  <h3 className={`text-[clamp(1.35rem,2.4vw,2.5rem)] font-black tracking-tight leading-tight ${
                    isStadiumWhite ? 'text-zinc-950' : 'text-white drop-shadow-md'
                  }`}>
                    {rank1.name}
                  </h3>
                  <p className={`text-[clamp(0.85rem,1.1vw,1.2rem)] font-bold mt-1 ${
                    isStadiumWhite ? 'text-zinc-700' : 'text-amber-300/90'
                  }`}>
                    {truncateText(rank1.class_or_age || 'Championship', 22)} • {truncateText(rank1.school, 25)}
                  </p>
                </div>
              ) : (
                <div className={`my-auto py-6 text-center font-mono text-base ${
                  isStadiumWhite ? 'text-amber-700' : 'text-amber-400/60'
                }`}>
                  Awaiting 1st Place Data
                </div>
              )}

              {/* Massive Score Monospace */}
              <div className={`pt-3 border-t flex items-baseline justify-between ${
                isStadiumWhite ? 'border-amber-300' : 'border-amber-400/30'
              }`}>
                <span className={`text-xs font-mono uppercase tracking-widest font-bold ${
                  isStadiumWhite ? 'text-amber-800' : 'text-amber-300/80'
                }`}>
                  {isBlindMode ? 'Status' : 'Winning Mark'}
                </span>
                <div className={`text-[clamp(2.4rem,5.5vw,4.8rem)] font-mono font-black leading-none tabular-nums whitespace-nowrap ${
                  isStadiumWhite ? 'text-amber-800' : 'text-amber-300'
                }`}>
                  {rank1 && rank1.judgeCount > 0 ? (
                    isBlindMode ? (
                      <span className="inline-flex items-center gap-2 text-xl md:text-2xl text-amber-500 font-bold">
                        <Lock className="w-6 h-6" /> AUDITED
                      </span>
                    ) : (
                      <span>
                        {rank1.avgScore} <span className="text-sm md:text-base font-normal text-amber-400/70">/ {maxRubricScore}</span>
                      </span>
                    )
                  ) : (
                    <span className="text-zinc-400 text-xl font-normal">PENDING</span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* ---------------- 3RD PLACE (RIGHT) ---------------- */}
          <div className="order-3 md:order-3 flex flex-col justify-end transform md:scale-90 transition-transform">
            <div
              className={`rounded-3xl p-5 md:p-6 border border-t-white/5 flex flex-col justify-between min-h-[200px] md:min-h-[240px] relative overflow-hidden transition-all ${
                isSpotlightEnabled && currentlyOnStageParticipant?.id === rank3?.id
                  ? 'ring-2 ring-amber-400 scale-[1.02] shadow-amber-400/20'
                  : ''
              } ${
                isStadiumWhite
                  ? 'bg-white border-stone-300 text-zinc-950 shadow-md'
                  : 'bg-gradient-to-b from-amber-950/40 via-zinc-950 to-black border-amber-700/50 text-amber-100 shadow-[0_0_25px_rgba(180,83,9,0.12)]'
              }`}
            >
              {/* Bronze Badge */}
              <div className="flex items-center justify-between">
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono font-black uppercase tracking-wider border ${
                  isStadiumWhite
                    ? 'bg-amber-100 text-amber-900 border-amber-300'
                    : 'bg-amber-700/20 text-amber-400 border-amber-700/40'
                }`}>
                  <span className="text-base">🥉</span> 3RD PLACE
                </span>
                {rank3 && (
                  <span className={`font-mono text-xs font-bold ${isStadiumWhite ? 'text-amber-800' : 'text-amber-600'}`}>
                    SL: #{rank3.sl_no}
                  </span>
                )}
              </div>

              {rank3 ? (
                <div className="my-auto py-3">
                  <h3 className={`text-[clamp(1.05rem,1.7vw,1.7rem)] font-black tracking-tight leading-snug ${
                    isStadiumWhite ? 'text-zinc-950' : 'text-white'
                  }`}>
                    {rank3.name}
                  </h3>
                  <p className={`text-[clamp(0.72rem,0.9vw,0.95rem)] font-semibold mt-1 ${
                    isStadiumWhite ? 'text-zinc-600' : 'text-zinc-400'
                  }`}>
                    {truncateText(rank3.class_or_age || 'General', 20)} • {truncateText(rank3.school, 24)}
                  </p>
                </div>
              ) : (
                <div className={`my-auto py-4 text-center font-mono text-sm ${
                  isStadiumWhite ? 'text-zinc-400' : 'text-zinc-500'
                }`}>
                  Awaiting 3rd Place Data
                </div>
              )}

              {/* Monospace Score */}
              <div className={`pt-2 border-t flex items-baseline justify-between ${
                isStadiumWhite ? 'border-stone-200' : 'border-amber-700/30'
              }`}>
                <span className={`text-[10px] md:text-xs font-mono uppercase tracking-wider ${
                  isStadiumWhite ? 'text-zinc-500 font-bold' : 'text-zinc-400'
                }`}>
                  {isBlindMode ? 'Status' : 'Score'}
                </span>
                <div className={`text-[clamp(1.5rem,3.2vw,2.6rem)] font-mono font-black leading-none tabular-nums whitespace-nowrap ${
                  isStadiumWhite ? 'text-amber-900' : 'text-amber-200'
                }`}>
                  {rank3 && rank3.judgeCount > 0 ? (
                    isBlindMode ? (
                      <span className="inline-flex items-center gap-1.5 text-sm md:text-base text-amber-500 font-bold">
                        <Lock className="w-4 h-4" /> AUDITED
                      </span>
                    ) : (
                      <span>
                        {rank3.avgScore} <span className="text-xs md:text-sm font-normal text-zinc-500">/ {maxRubricScore}</span>
                      </span>
                    )
                  ) : (
                    <span className="text-zinc-400 text-lg">PENDING</span>
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
          <div className={`flex items-center justify-between pb-2 border-b mb-3 ${
            isStadiumWhite ? 'border-stone-300' : 'border-zinc-800/60'
          }`}>
            <span className={`text-xs md:text-sm font-mono font-bold tracking-wider uppercase ${
              isStadiumWhite ? 'text-zinc-700' : 'text-zinc-400'
            }`}>
              Contender Ledger (Ranks 4+)
            </span>
            <span className={`text-[11px] font-mono ${
              isStadiumWhite ? 'text-zinc-500' : 'text-zinc-500'
            }`}>
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
            className="space-y-2.5 max-h-[34vh] overflow-y-auto pr-1 select-none"
          >
            {rankFourAndBelow.length === 0 ? (
              <div className={`p-6 text-center font-mono text-xs md:text-sm rounded-2xl border ${
                isStadiumWhite
                  ? 'bg-white border-stone-300 text-zinc-500'
                  : 'border-zinc-800/40 text-zinc-500'
              }`}>
                All scheduled contenders currently ranked within Hero Podium Top 3.
              </div>
            ) : (
              rankFourAndBelow.map((row) => {
                const isOnStage = isSpotlightEnabled && currentlyOnStageParticipant?.id === row.id;
                return (
                  <div
                    key={row.id}
                    className={`flex items-center justify-between gap-4 p-3 md:p-4 rounded-2xl border transition-all ${
                      isOnStage ? 'ring-2 ring-amber-400 shadow-md scale-[1.01]' : ''
                    } ${
                      isStadiumWhite
                        ? 'bg-white border-stone-200 text-zinc-950 hover:bg-stone-50 shadow-sm'
                        : 'bg-zinc-900 hover:bg-zinc-800/80 border-white/10 border-t-white/5 text-white'
                    }`}
                  >
                    {/* Left: Rank Badge */}
                    <div className="flex items-center gap-3 md:gap-4 min-w-0">
                      <div
                        className={`w-9 h-9 md:w-11 md:h-11 rounded-xl flex items-center justify-center font-mono font-black text-sm md:text-base shrink-0 border ${
                          isStadiumWhite
                            ? 'bg-stone-100 border-stone-300 text-zinc-900'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-300'
                        }`}
                      >
                        {row.rank > 0 ? `#${row.rank}` : '—'}
                      </div>

                      {/* Middle: Name & Sub-Data */}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-emerald-600 dark:text-emerald-500">
                            {row.sl_no}
                          </span>
                          <h4 className={`text-[clamp(0.85rem,1.3vw,1.25rem)] font-extrabold tracking-tight truncate ${
                            isStadiumWhite ? 'text-zinc-950' : 'text-white'
                          }`}>
                            {row.name}
                          </h4>
                          {isOnStage && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-amber-500/20 text-amber-500 border border-amber-500/30">
                              ON STAGE
                            </span>
                          )}
                        </div>
                        <p className={`text-[clamp(0.7rem,0.9vw,0.9rem)] font-medium truncate mt-0.5 ${
                          isStadiumWhite ? 'text-zinc-600' : 'text-zinc-400'
                        }`}>
                          {truncateText(row.class_or_age || 'Category Entry', 20)} • {truncateText(row.school, 25)}
                        </p>
                      </div>
                    </div>

                    {/* Right: Score or Blind Lock */}
                    <div className="text-right shrink-0">
                      <div className={`text-[clamp(1.1rem,1.8vw,1.7rem)] font-mono font-black leading-none tabular-nums whitespace-nowrap ${
                        isStadiumWhite ? 'text-emerald-700' : 'text-emerald-400'
                      }`}>
                        {row.judgeCount > 0 ? (
                          isBlindMode ? (
                            <span className="inline-flex items-center gap-1.5 text-xs md:text-sm text-amber-500 font-bold">
                              <Lock className="w-3.5 h-3.5" /> AUDITED
                            </span>
                          ) : (
                            <span>
                              {row.avgScore}{' '}
                              <span className={`text-[10px] md:text-xs font-normal ${isStadiumWhite ? 'text-zinc-500' : 'text-zinc-500'}`}>
                                / {maxRubricScore}
                              </span>
                            </span>
                          )
                        ) : (
                          <span className="text-zinc-400 text-sm font-normal">Pending</span>
                        )}
                      </div>
                      <div className={`text-[10px] font-mono mt-0.5 tabular-nums whitespace-nowrap ${isStadiumWhite ? 'text-zinc-500' : 'text-zinc-500'}`}>
                        {row.judgeCount} / {currentEvent?.assigned_judges.length || 0} Ballots
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </main>

      {/* ============================================================ */}
      {/* 10. CUSTOM BROADCAST TICKER                                  */}
      {/* ============================================================ */}
      {publicSettings.tickerText && publicSettings.tickerText.trim() && (
        <div className={`relative z-20 w-full overflow-hidden py-2 px-4 border-t border-b flex items-center shadow-sm ${
          isStadiumWhite
            ? 'bg-amber-100 border-amber-300 text-amber-950'
            : 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
        }`}>
          <div className="flex items-center gap-2 shrink-0 pr-4 font-mono text-[10px] md:text-xs font-black uppercase tracking-widest border-r border-current">
            <Radio className="w-3.5 h-3.5 animate-pulse text-emerald-500" />
            <span>STAGE DISPATCH</span>
          </div>
          <div className="overflow-hidden whitespace-nowrap flex-1 ml-4">
            <div className="inline-block animate-marquee font-mono text-xs md:text-sm font-bold tracking-wide">
              {publicSettings.tickerText}
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 11. AUDIENCE SPECTATOR QR CODE (When Enabled)               */}
      {/* ============================================================ */}
      {publicSettings.showAppQr && (
        <div className="fixed bottom-14 left-4 sm:left-8 z-40 animate-in fade-in slide-in-from-bottom-4 duration-300">
          <div className={`p-3 rounded-2xl border shadow-2xl flex items-center gap-3 ${
            isStadiumWhite
              ? 'bg-white border-stone-300 text-zinc-950 shadow-slate-200'
              : 'bg-zinc-950 border-zinc-800 text-white dark:text-white shadow-black'
          }`}>
            <div className="p-1.5 bg-white rounded-xl shadow-inner shrink-0">
              <QRCodeSVG
                value={typeof window !== 'undefined' ? window.location.href : 'https://fairjudge.app'}
                size={52}
                level="M"
              />
            </div>
            <div className="text-left pr-1">
              <div className="text-[9px] font-mono font-black uppercase tracking-widest text-emerald-500">
                AUDIENCE LINK
              </div>
              <div className={`text-xs font-black leading-tight mt-0.5 ${isStadiumWhite ? 'text-zinc-950' : 'text-white'}`}>
                Scan on Mobile
              </div>
              <div className={`text-[10px] font-mono ${isStadiumWhite ? 'text-zinc-500' : 'text-zinc-400'}`}>
                Live Leaderboard
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================ */}
      {/* 12. THE FOOTER (Branding & Developer Signature)              */}
      {/* ============================================================ */}
      <footer
        className={`relative z-10 w-full px-4 sm:px-8 py-3 border-t transition-colors ${
          isStadiumWhite
            ? 'bg-white border-stone-300 text-zinc-950 shadow-inner'
            : 'bg-black border-zinc-900 text-zinc-400'
        }`}
      >
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 relative">
          {!isStadiumWhite && (
            <div className="absolute -left-10 bottom-0 w-64 h-16 bg-gradient-to-r from-emerald-500/20 to-teal-500/10 rounded-full blur-2xl animate-ambient-glow pointer-events-none" />
          )}

          {/* Left: Fair Judge App Logo & Name */}
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 md:w-8 md:h-8 rounded-xl bg-emerald-500/15 border border-emerald-500/40 flex items-center justify-center text-emerald-400 shadow-md shadow-emerald-500/20 shrink-0">
              <Scale className="w-4 h-4 md:w-4.5 md:h-4.5 stroke-[2.2]" />
            </div>
            <div className="flex items-baseline gap-2">
              <span className={`text-sm md:text-base font-black tracking-tight ${
                isStadiumWhite ? 'text-zinc-950 font-black' : 'text-white'
              }`}>
                Fair Judge
              </span>
              <span className="text-[10px] md:text-xs font-mono font-bold text-emerald-500">
                AUDITED DIGITAL LEDGER
              </span>
            </div>
          </div>

          {/* Right: Persistent Animated Developer Signature */}
          <div className="flex items-center gap-3">
            <span className={`text-[11px] md:text-xs font-mono font-semibold tracking-wide ${
              isStadiumWhite ? 'text-zinc-600' : 'text-zinc-400'
            }`}>
              Engineered with intent.{' '}
              <span className="animate-pulse bg-gradient-to-r from-emerald-500 to-emerald-300 bg-clip-text text-transparent font-mono font-bold">
                &lt;/&gt;
              </span>{' '}
              <strong className={isStadiumWhite ? 'text-zinc-950 font-black' : 'text-zinc-200'}>
                Sahil Kumar Rout
              </strong>
            </span>
          </div>
        </div>
      </footer>

      {/* ============================================================ */}
      {/* 13. SUBTLE STADIUM WHITE / DEEP BLACK DAYLIGHT TOGGLE        */}
      {/* ============================================================ */}
      <div className="fixed bottom-3 right-4 sm:bottom-4 sm:right-6 z-40">
        <button
          type="button"
          onClick={() => setIsStadiumWhite((v) => !v)}
          className={`p-2.5 rounded-full border shadow-2xl transition-all cursor-pointer flex items-center justify-center ${
            isStadiumWhite
              ? 'bg-black text-white border-black hover:scale-105 shadow-md'
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
