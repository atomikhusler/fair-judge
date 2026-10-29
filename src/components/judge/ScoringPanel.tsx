import React, { useState, useEffect, useRef, useMemo } from 'react';
import { 
  ArrowLeft, 
  ChevronLeft, 
  ChevronRight, 
  Search, 
  CheckCircle2, 
  CheckCircle,
  Lock, 
  X, 
  Eye, 
  Minus, 
  Plus, 
  Clock,
  Send,
  ShieldCheck,
  RotateCcw
} from 'lucide-react';
import { dbService, subscribeToDatabase } from '../../lib/supabase';
import { queueScoreLocally, flushOfflineQueueToSupabase, getPendingCount, subscribeToQueueChanges } from '../../lib/offlineQueue';
import { 
  SupabaseJudge, 
  SupabaseEvent, 
  SupabaseParticipant, 
  SupabaseScore, 
  RubricCriterion,
  Organization 
} from '../../lib/supabaseTypes';

export interface ScoringPanelProps {
  orgId: string;
  judge: SupabaseJudge;
  event: SupabaseEvent;
  onBackToLobby: () => void;
  onSwitchToOrganiserView?: () => void;
}

export type JudgeStageProps = ScoringPanelProps;

export function ScoringPanel({
  orgId,
  judge,
  event,
  onBackToLobby,
}: ScoringPanelProps) {
  // Navigation View: 'list' (Initial List View) vs 'scoring' (Scoring Carousel)
  const [viewMode, setViewMode] = useState<'list' | 'scoring'>('list');

  // Organization settings (for Jury Terminal Rules)
  const [organization, setOrganization] = useState<Organization | null>(null);

  const [participants, setParticipants] = useState<SupabaseParticipant[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [listSearch, setListSearch] = useState('');
  const [scoresMap, setScoresMap] = useState<Record<string, number | null>>({});
  const [existingScore, setExistingScore] = useState<SupabaseScore | null>(null);
  const [allMyScores, setAllMyScores] = useState<SupabaseScore[]>([]);
  
  // Async Payment-Style Submit State Machine (rapid click guarded)
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [, setPendingQueueCount] = useState(0);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | 'none'>('none');

  // Screen WakeLock for continuous evaluation without dimming
  const wakeLockRef = useRef<any>(null);

  useEffect(() => {
    async function requestWakeLock() {
      try {
        if ('wakeLock' in navigator && (navigator as any).wakeLock) {
          wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        }
      } catch (err) {
        console.warn('Screen wakeLock note:', err);
      }
    }
    requestWakeLock();

    return () => {
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, []);

  const rubricList: RubricCriterion[] = event.rubric_schema || event.rubric || [];

  // Load organization, participants & all scores submitted by this judge
  const loadData = async () => {
    try {
      const org = await dbService.getOrganizationByOrgId(orgId);
      setOrganization(org);

      const allP = await dbService.getParticipants(orgId);
      const filteredP = allP.filter((p) => event.assigned_participants.includes(p.id));
      setParticipants(filteredP);

      const allScores = await dbService.getScores(event.id);
      const myScores = allScores.filter((s) => s.judge_id === judge.id);
      setAllMyScores(myScores);

      const count = await getPendingCount();
      setPendingQueueCount(count);
    } catch (err) {
      console.error('Error loading evaluation stage:', err);
    }
  };

  useEffect(() => {
    loadData();
    const unsubDb = subscribeToDatabase(() => {
      loadData();
    });
    const unsubQueue = subscribeToQueueChanges(() => {
      getPendingCount().then((c) => setPendingQueueCount(c));
    });

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      unsubDb();
      unsubQueue();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [orgId, event.id, judge.id]);

  // Modal Scroll Lock: lock background scroll when confirmation popup is open
  useEffect(() => {
    if (showConfirmModal) {
      const original = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = original;
      };
    }
  }, [showConfirmModal]);

  const currentParticipant = participants[currentIndex] || null;

  // -------------------------------------------------------------
  // JURY TERMINAL SETTINGS LOGIC
  // -------------------------------------------------------------
  const isBlindJudging = Boolean(organization?.blind_judging_enabled);
  const isAutoAdvance = organization?.auto_advance_enabled !== undefined ? Boolean(organization.auto_advance_enabled) : true;
  const isGracePeriod = Boolean(organization?.grace_period_enabled);
  const isIsolatedJury = Boolean(organization?.isolated_jury_enabled);

  // Check 5-minute grace period on existing score
  const isWithinGracePeriod = useMemo(() => {
    if (!existingScore || !isGracePeriod) return false;
    const diffMs = Date.now() - new Date(existingScore.created_at).getTime();
    return diffMs <= 5 * 60 * 1000;
  }, [existingScore, isGracePeriod]);

  // Are sliders disabled?
  const areSlidersDisabled = useMemo(() => {
    if (!existingScore) return false;
    if (isGracePeriod && isWithinGracePeriod) return false;
    return true; // Permanently locked if no grace period or grace period expired
  }, [existingScore, isGracePeriod, isWithinGracePeriod]);

  // On participant change in scoring mode, load their score or reset to null
  useEffect(() => {
    if (!currentParticipant) return;

    dbService
      .getScoreForJudgeParticipant(event.id, judge.id, currentParticipant.id)
      .then((score) => {
        setExistingScore(score);
        if (score) {
          const filled: Record<string, number | null> = {};
          rubricList.forEach((c) => {
            filled[c.id] = (score.score_data && score.score_data[c.id] !== undefined)
              ? score.score_data[c.id]
              : score.score_payload?.criteria?.[c.id] ?? 0;
          });
          setScoresMap(filled);
        } else {
          const fresh: Record<string, number | null> = {};
          rubricList.forEach((c) => {
            fresh[c.id] = null;
          });
          setScoresMap(fresh);
        }
      });
  }, [currentIndex, currentParticipant?.id, event.id, judge.id]);

  // Handle score changes
  const handleScoreChange = (criterionId: string, val: number) => {
    if (areSlidersDisabled) return;
    setScoresMap((prev) => ({
      ...prev,
      [criterionId]: val,
    }));
  };

  // Participant Navigation with animation
  const handlePrev = () => {
    if (currentIndex > 0) {
      setSlideDirection('right');
      setCurrentIndex((i) => i - 1);
      setTimeout(() => setSlideDirection('none'), 250);
    }
  };

  const handleNext = () => {
    if (currentIndex < participants.length - 1) {
      setSlideDirection('left');
      setCurrentIndex((i) => i + 1);
      setTimeout(() => setSlideDirection('none'), 250);
    }
  };

  const handleSyncPull = async () => {
    try {
      await flushOfflineQueueToSupabase();
      await loadData();
    } catch {
      // offline fallback
    }
  };

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Categorize participants into Upcoming vs Completed
  const completedList = participants.filter((p) =>
    allMyScores.some((s) => s.participant_id === p.id)
  );

  const upcomingList = participants.filter(
    (p) => !allMyScores.some((s) => s.participant_id === p.id)
  );

  // Filtered lists based on Smart Search Bar
  const filterBySearch = (list: SupabaseParticipant[]) => {
    const q = listSearch.toLowerCase().trim();
    if (!q) return list;
    return list.filter((p) => {
      if (isBlindJudging) {
        return p.sl_no.toLowerCase().includes(q);
      }
      return (
        p.name.toLowerCase().includes(q) ||
        p.sl_no.toLowerCase().includes(q) ||
        p.school.toLowerCase().includes(q)
      );
    });
  };

  const filteredUpcoming = filterBySearch(upcomingList);
  const filteredCompleted = filterBySearch(completedList);

  const scoredCount = completedList.length;
  const judgeProgressPercent = participants.length > 0 ? Math.round((scoredCount / participants.length) * 100) : 0;

  // Open scoring carousel for a specific participant
  const handleOpenParticipant = (participant: SupabaseParticipant) => {
    const idx = participants.findIndex((p) => p.id === participant.id);
    if (idx !== -1) {
      setCurrentIndex(idx);
    }
    setViewMode('scoring');
  };

  // Submit Guard check
  const unscoredCriteria = rubricList.filter(
    (c) => scoresMap[c.id] === null || scoresMap[c.id] === undefined
  );
  const isAllScored = unscoredCriteria.length === 0;

  const currentTotal = rubricList.reduce((acc, c) => {
    const val = scoresMap[c.id];
    return acc + (val !== null && val !== undefined ? val : 0);
  }, 0);

  const maxPossible = rubricList.reduce((acc, c) => acc + (Number(c.max_marks) || 0), 0);

  // =============================================================
  // PART 3: ASYNC PAYMENT-STYLE SUBMIT STATE MACHINE
  // =============================================================
  const handleInitiateSubmit = () => {
    if (!currentParticipant || !isAllScored || isSubmitting || showSuccess || areSlidersDisabled) return;
    setShowConfirmModal(true);
  };

  const handleConfirmSubmit = async () => {
    if (!currentParticipant || !isAllScored || isSubmitting || showSuccess) return;
    
    // Close modal & enter submitting state immediately (prevents rapid multi-clicks)
    setShowConfirmModal(false);
    setIsSubmitting(true);

    const sanitizedData: Record<string, number> = {};
    rubricList.forEach((c) => {
      sanitizedData[c.id] = scoresMap[c.id] || 0;
    });

    const payload = {
      event_id: event.id,
      judge_id: judge.id,
      participant_id: currentParticipant.id,
      score_data: sanitizedData,
      total_score: currentTotal,
      score_payload: {
        criteria: sanitizedData,
        total_score: currentTotal,
        submitted_at: new Date().toISOString(),
      },
    };

    try {
      const freshEvent = await dbService.getEventById(event.id);
      if (freshEvent && (freshEvent.status === 'paused' || freshEvent.status === 'ended')) {
        throw new Error(`Event is ${freshEvent.status}. Ballot submission rejected.`);
      }

      if (!navigator.onLine) {
        throw new Error('Network offline');
      }

      const committed = await dbService.submitScore(payload);
      setExistingScore(committed);
      setAllMyScores((prev) => {
        const without = prev.filter((s) => s.participant_id !== currentParticipant.id);
        return [...without, committed];
      });

      // Network request succeeded -> transition to showSuccess
      setIsSubmitting(false);
      setShowSuccess(true);

      // Micro-interaction UI: hold for exactly 1500ms
      setTimeout(() => {
        setShowSuccess(false);
        if (isAutoAdvance) {
          if (currentIndex < participants.length - 1) {
            handleNext();
          } else {
            setViewMode('list');
          }
        }
      }, 1500);

    } catch (err: any) {
      console.warn('Saving to local offline queue:', err);
      await queueScoreLocally(payload);
      const offlineCommit: SupabaseScore = {
        ...payload,
        id: `queued_${Date.now()}`,
        created_at: new Date().toISOString(),
      };
      setExistingScore(offlineCommit);
      setAllMyScores((prev) => {
        const without = prev.filter((s) => s.participant_id !== currentParticipant.id);
        return [...without, offlineCommit];
      });

      setIsSubmitting(false);
      setShowSuccess(true);

      setTimeout(() => {
        setShowSuccess(false);
        if (isAutoAdvance) {
          if (currentIndex < participants.length - 1) {
            handleNext();
          } else {
            setViewMode('list');
          }
        }
      }, 1500);
    }
  };

  // =============================================================
  // VIEW 1: PARTICIPANT ROSTER VIEW
  // =============================================================
  if (viewMode === 'list') {
    return (
      <div className="min-h-[100dvh] overflow-y-auto w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col max-w-lg mx-auto relative select-none transition-colors duration-200 pb-40">
        
        {/* Floating Toast Notification (pointer-events-none) */}
        {toastMessage ? (
          <div className="fixed top-4 left-4 right-4 z-[90] p-3.5 bg-zinc-900/95 text-white border border-zinc-700 rounded-2xl shadow-2xl flex items-center space-x-2.5 text-xs font-semibold backdrop-blur-md animate-fade-in pointer-events-none">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{toastMessage}</span>
          </div>
        ) : null}

        {/* Top Sticky Header */}
        <header className="sticky top-0 z-50 w-full bg-stone-50/95 dark:bg-black/95 backdrop-blur-md border-b border-stone-200 dark:border-zinc-800/80 px-4 py-3 shrink-0 shadow-xs mb-4">
          <div className="flex items-center justify-between gap-3">
            <button
              onClick={onBackToLobby}
              className="bg-zinc-900 dark:bg-white text-white dark:text-black font-bold text-sm md:text-base px-5 min-h-[48px] rounded-xl shadow-md active:scale-95 flex items-center justify-center gap-2 cursor-pointer transition-transform shrink-0"
              title="Return to My Events"
            >
              <ArrowLeft className="w-5 h-5 stroke-[2.5]" />
              <span>My Events</span>
            </button>

            <div className="flex items-center space-x-2 shrink-0">
              {isBlindJudging && (
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-2.5 py-1 rounded-full">
                  Blind Judging
                </span>
              )}
              <div className="flex items-center space-x-1.5 px-3 py-1 rounded-full text-[10px] font-mono font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                <span>{isOnline ? 'ONLINE' : 'OFFLINE'}</span>
              </div>
            </div>
          </div>

          <div className="border-t border-stone-200/80 dark:border-zinc-800/80 pt-2.5 mt-2.5 flex items-start justify-between">
            <div className="min-w-0 flex-1 mr-3">
              <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-600 dark:text-emerald-400 font-extrabold flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>{event.category || 'Official Competition'}</span>
              </span>
              <h1 className="text-base sm:text-lg font-black text-zinc-900 dark:text-white mt-0.5 truncate">
                {event.name}
              </h1>
            </div>

            {!isIsolatedJury && (
              <div className="text-right shrink-0 bg-stone-100 dark:bg-zinc-800 px-3 py-1.5 rounded-xl border border-stone-200 dark:border-zinc-700">
                <span className="text-sm font-mono font-black text-zinc-900 dark:text-white">
                  {scoredCount} / {participants.length}
                </span>
                <span className="text-[10px] text-zinc-400 font-mono block">Evaluated</span>
              </div>
            )}
          </div>
        </header>

        {/* Content Area with Horizontal Padding */}
        <div className="px-4 space-y-5">

          {/* Smart Search Bar */}
          <div className="relative mb-5">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-3.5" />
            <input
              type="text"
              placeholder={isBlindJudging ? "Search by Sl. No. or ID..." : "Search by Sl. No., Name, or School..."}
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              className="w-full pl-10 pr-9 py-3 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl text-xs text-zinc-900 dark:text-white placeholder-zinc-400 shadow-sm focus:outline-none focus:border-emerald-500"
            />
            {listSearch && (
              <button
                onClick={() => setListSearch('')}
                className="absolute right-3 top-3 text-zinc-400 hover:text-zinc-600 dark:hover:text-white p-0.5"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <div className="space-y-6">
            {/* SECTION 1: UPCOMING PERFORMANCES */}
            <div className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-xs font-black text-zinc-600 dark:text-zinc-400 uppercase tracking-wider flex items-center space-x-1.5">
                  <Clock className="w-3.5 h-3.5 text-amber-500" />
                  <span>Upcoming ({filteredUpcoming.length})</span>
                </h2>
                <span className="text-[10px] font-mono text-zinc-400 font-bold uppercase">
                  VIP SCORING QUEUE
                </span>
              </div>

              {filteredUpcoming.length === 0 ? (
                <div className="p-6 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl text-center text-xs text-zinc-400 shadow-sm">
                  {listSearch ? 'No upcoming competitors match your search.' : 'All assigned competitors have been evaluated! 🎉'}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredUpcoming.map((p) => {
                    const participantSerial = event.participant_sl_numbers?.[p.id] || p.sl_no;
                    return (
                      <div
                        key={p.id}
                        onClick={() => handleOpenParticipant(p)}
                        className="p-4 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 hover:border-emerald-500/50 hover:bg-stone-50 dark:hover:bg-zinc-850 rounded-2xl shadow-sm transition-all cursor-pointer group flex items-center justify-between active:scale-[0.98]"
                      >
                        <div className="flex items-center space-x-3.5 min-w-0 mr-3">
                          <div className="w-11 h-11 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 font-mono font-black text-sm flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform shadow-xs">
                            {participantSerial}
                          </div>
                          <div className="min-w-0">
                            {isBlindJudging ? (
                              <h3 className="text-base sm:text-lg font-black text-zinc-900 dark:text-white truncate">
                                Participant {p.identity_id || `P-${p.id.slice(0, 4)}`}
                              </h3>
                            ) : (
                              <>
                                <h3 className="text-sm font-extrabold text-zinc-900 dark:text-white truncate group-hover:text-emerald-500 transition-colors">
                                  {p.name}
                                </h3>
                                <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                                  {p.school}
                                </p>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="shrink-0">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenParticipant(p);
                            }}
                            className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 dark:bg-emerald-500 text-white font-bold text-xs tracking-wide shadow-md shadow-emerald-900/20 active:scale-95 transition-all flex items-center space-x-1.5 cursor-pointer"
                          >
                            <span>Score</span>
                            <ChevronRight className="w-4 h-4 stroke-[2.5]" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* SECTION 2: COMPLETED EVALUATIONS */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between px-1">
                <h2 className="text-xs font-black text-zinc-500 uppercase tracking-wider flex items-center space-x-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                  <span>Completed ({filteredCompleted.length})</span>
                </h2>
                <span className="text-[10px] font-mono text-zinc-400 font-bold uppercase">
                  SEALED IN AUDIT LEDGER
                </span>
              </div>

              {filteredCompleted.length === 0 ? (
                <div className="p-6 bg-stone-100/50 dark:bg-zinc-900/20 border border-stone-200/50 dark:border-zinc-800/40 rounded-2xl text-center text-xs text-zinc-500">
                  No ballots completed yet. Select an upcoming competitor above to begin scoring.
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredCompleted.map((p) => {
                    const scoreRecord = allMyScores.find((s) => s.participant_id === p.id);
                    const participantSerial = event.participant_sl_numbers?.[p.id] || p.sl_no;
                    return (
                      <div
                        key={p.id}
                        onClick={() => handleOpenParticipant(p)}
                        className="p-3.5 sm:p-4 bg-stone-100/80 dark:bg-zinc-900/50 border border-stone-200 dark:border-zinc-800 rounded-2xl flex items-center justify-between gap-3 opacity-90 hover:opacity-100 transition-all cursor-pointer active:scale-[0.99] shadow-xs"
                      >
                        <div className="flex items-center space-x-3.5 min-w-0 flex-1">
                          <div className="w-10 h-10 rounded-2xl bg-stone-200 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 font-mono font-bold text-xs sm:text-sm flex items-center justify-center shrink-0">
                            {participantSerial}
                          </div>
                          <div className="min-w-0 flex-1">
                            {isBlindJudging ? (
                              <h3 className="text-base font-black text-zinc-800 dark:text-zinc-200 truncate">
                                Participant {p.identity_id || `P-${p.id.slice(0, 4)}`}
                              </h3>
                            ) : (
                              <>
                                <h3 className="text-xs sm:text-sm font-extrabold text-zinc-800 dark:text-zinc-200 truncate">
                                  {p.name}
                                </h3>
                                <p className="text-[11px] text-zinc-400 truncate mt-0.5">
                                  {p.school}
                                </p>
                              </>
                            )}
                          </div>
                        </div>

                        <div className="shrink-0 flex items-center space-x-3 text-right">
                          <div className="font-mono text-right">
                            <span className="text-base sm:text-lg font-black text-emerald-600 dark:text-emerald-400">
                              {scoreRecord?.total_score ?? '—'}
                            </span>
                            <span className="text-[11px] font-mono text-zinc-400 ml-1">pts</span>
                          </div>
                          <div className="w-8 h-8 rounded-xl bg-stone-200/80 dark:bg-zinc-800 flex items-center justify-center text-zinc-500 hover:text-zinc-800 dark:hover:text-white transition-colors">
                            <Eye className="w-3.5 h-3.5" />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
    );
  }

  // =============================================================
  // VIEW 2: SCORING TERMINAL - MOBILE GAMEPAD UI
  // =============================================================
  return (
    <div className="min-h-[100dvh] overflow-y-auto w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col justify-start max-w-lg mx-auto relative select-none transition-colors duration-200">
      
      {/* ============================================================ */}
      {/* PART 5.1: THE TOP HEADER (Symmetrical, h-16)                  */}
      {/* ============================================================ */}
      <header className="shrink-0 flex justify-between items-center h-16 px-4 border-b border-stone-200 dark:border-zinc-800 bg-white/95 dark:bg-zinc-950/95 backdrop-blur-md z-20">
        {/* Left: [ ← Back ] */}
        <button
          onClick={() => setViewMode('list')}
          className="flex items-center space-x-1.5 px-3 py-2 rounded-xl text-xs font-bold text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
          title="Return to Competitor Roster"
        >
          <ChevronLeft className="w-4 h-4 stroke-[2.5]" />
          <span>Back</span>
        </button>

        {/* Center: Empty / Clean (Event Name Deleted as required) */}
        <div className="flex-1" />

        {/* Right: Tactile, deep emerald [ Submit ] button */}
        <div>
          {existingScore && !isWithinGracePeriod ? (
            <div className="flex items-center space-x-1.5 text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3.5 py-2 rounded-xl border border-emerald-500/20">
              <Lock className="w-3.5 h-3.5" />
              <span>Sealed</span>
            </div>
          ) : (
            <button
              onClick={handleInitiateSubmit}
              disabled={!isAllScored || isSubmitting || showSuccess || areSlidersDisabled}
              className={`rounded-xl px-4 py-2 font-bold text-xs shadow-md shadow-emerald-900/20 transition-all flex items-center space-x-1.5 ${
                isAllScored && !isSubmitting && !showSuccess && !areSlidersDisabled
                  ? 'bg-emerald-600 hover:bg-emerald-500 dark:bg-emerald-500 dark:hover:bg-emerald-400 text-white active:scale-95 cursor-pointer'
                  : 'bg-stone-200 dark:bg-zinc-800 text-zinc-400 opacity-50 cursor-not-allowed'
              }`}
            >
              {isWithinGracePeriod ? (
                <>
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Update</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>Submit</span>
                </>
              )}
            </button>
          )}
        </div>
      </header>

      {/* Competitor Banner Header Strip */}
      {currentParticipant && (
        <div className="shrink-0 px-4 pt-3 pb-2 bg-stone-100/60 dark:bg-zinc-900/40 border-b border-stone-200/60 dark:border-zinc-800/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3 min-w-0 flex-1">
              <div className="w-11 h-11 rounded-2xl bg-white dark:bg-zinc-850 border border-stone-200 dark:border-zinc-700 flex items-center justify-center font-mono font-black text-sm text-emerald-600 dark:text-emerald-400 shrink-0 shadow-sm">
                {event.participant_sl_numbers?.[currentParticipant.id] || currentParticipant.sl_no}
              </div>
              <div className="min-w-0 flex-1">
                {isBlindJudging ? (
                  <h2 className="text-lg font-black text-zinc-900 dark:text-white truncate">
                    Participant {currentParticipant.identity_id || `P-${currentParticipant.id.slice(0, 4)}`}
                  </h2>
                ) : (
                  <>
                    <h2 className="text-sm font-extrabold text-zinc-900 dark:text-white truncate">
                      {currentParticipant.name}
                    </h2>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                      {currentParticipant.school}
                    </p>
                  </>
                )}
              </div>
            </div>

            {/* If Not Isolated Jury, show Queue Counter */}
            {!isIsolatedJury && (
              <div className="text-right shrink-0 font-mono text-[11px] text-zinc-400 bg-white dark:bg-zinc-800 px-2.5 py-1 rounded-xl border border-stone-200 dark:border-zinc-700">
                {currentIndex + 1} of {participants.length}
              </div>
            )}
          </div>

          {/* Grace Period Notification Pill */}
          {isWithinGracePeriod && (
            <div className="mt-2 py-1 px-2.5 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-between text-[11px] text-amber-600 dark:text-amber-400 font-mono font-semibold">
              <span>5m Grace Period Active: Ballots can be re-adjusted</span>
              <Clock className="w-3 h-3 animate-pulse" />
            </div>
          )}
        </div>
      )}

      {/* ============================================================ */}
      {/* SCROLLABLE CRITERIA SLIDERS CONTAINER (pb-[140px] clearance)  */}
      {/* ============================================================ */}
      <main
        className={`w-full flex-1 px-4 py-4 space-y-4 pb-[140px] relative z-10 transition-transform duration-200 ${
          slideDirection === 'left' ? 'translate-x-2' : slideDirection === 'right' ? '-translate-x-2' : ''
        }`}
      >
        {existingScore && !isWithinGracePeriod && (
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl flex items-center justify-between text-xs text-emerald-700 dark:text-emerald-400 font-semibold shadow-sm">
            <div className="flex items-center space-x-2">
              <Lock className="w-4 h-4 shrink-0 text-emerald-500" />
              <span>Ballot sealed in audit ledger (Read-Only).</span>
            </div>
            <button
              onClick={() => setViewMode('list')}
              className="px-2.5 py-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 dark:bg-emerald-500 text-white font-bold text-[11px] shadow-sm shrink-0 cursor-pointer"
            >
              Roster
            </button>
          </div>
        )}

        <div className="space-y-4">
          {rubricList.map((crit) => {
            const currentVal = scoresMap[crit.id];
            const isScored = currentVal !== null && currentVal !== undefined;
            const max = Number(crit.max_marks) || 10;
            const activeVal = isScored ? currentVal : 0;
            const percentFilled = max > 0 ? (activeVal / max) * 100 : 0;

            return (
              <div
                key={crit.id}
                className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-5 shadow-sm space-y-4 transition-all"
              >
                {/* Criterion Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-0.5 min-w-0 flex-1">
                    <h3 className="text-xs sm:text-sm font-black text-zinc-900 dark:text-white uppercase tracking-wider">
                      {crit.name}
                    </h3>
                    {crit.description && (
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 line-clamp-2">
                        {crit.description}
                      </p>
                    )}
                    <span className="text-[10px] text-zinc-400 font-mono block">Max: {max} pts</span>
                  </div>

                  <div className="font-mono text-right shrink-0 pl-2">
                    {isScored ? (
                      <span className="text-2xl sm:text-3xl font-black text-emerald-600 dark:text-emerald-400 tracking-tight">
                        {currentVal}
                        <span className="text-xs text-zinc-400 font-normal"> / {max}</span>
                      </span>
                    ) : (
                      <span className="text-[11px] text-zinc-500 bg-stone-100 dark:bg-zinc-800 px-3 py-1 rounded-full border border-stone-200 dark:border-zinc-700 font-sans font-medium">
                        Slide to Score
                      </span>
                    )}
                  </div>
                </div>

                {/* Chunky Touch Stepper & Range Track */}
                <div className="space-y-2 pt-1">
                  <div className="flex items-center gap-3">
                    {/* Chunky [-] Button (44x44px minimum touch target for older VIP judges) */}
                    <button
                      type="button"
                      onClick={() => handleScoreChange(crit.id, Math.max(0, activeVal - 1))}
                      disabled={areSlidersDisabled || activeVal <= 0}
                      className="w-11 h-11 shrink-0 bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 rounded-xl active:scale-95 disabled:opacity-30 border border-stone-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 font-bold flex items-center justify-center transition-all cursor-pointer shadow-sm"
                      title="Decrease mark by 1"
                      aria-label="Decrease score"
                    >
                      <Minus className="w-5 h-5 stroke-[2.5]" />
                    </button>

                    {/* Fluid Thick Slider Container */}
                    <div className="relative flex-1 flex items-center h-10">
                      <div className="w-full h-3.5 rounded-full bg-stone-200 dark:bg-zinc-800 relative overflow-hidden pointer-events-none shadow-inner">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-cyan-400 transition-all duration-75 shadow-sm"
                          style={{ width: `${percentFilled}%` }}
                        />
                      </div>

                      <input
                        type="range"
                        min={0}
                        max={max}
                        step={1}
                        disabled={areSlidersDisabled}
                        value={activeVal}
                        onChange={(e) => handleScoreChange(crit.id, parseInt(e.target.value, 10))}
                        className="absolute inset-0 w-full h-10 opacity-0 cursor-pointer disabled:cursor-not-allowed z-20"
                        aria-label={crit.name}
                      />

                      {/* Visual Large Thumb Indicator */}
                      <div
                        className="absolute top-1/2 -translate-y-1/2 pointer-events-none transition-all duration-75"
                        style={{
                          left: `calc(${percentFilled}% - ${percentFilled * 0.28}px)`,
                        }}
                      >
                        <div className="w-7 h-7 rounded-full bg-white dark:bg-zinc-100 border-2 border-emerald-500 shadow-md shadow-emerald-500/40 ring-4 ring-emerald-500/20 flex items-center justify-center">
                          <div className="w-2.5 h-2.5 rounded-full bg-emerald-600" />
                        </div>
                      </div>
                    </div>

                    {/* Chunky [+] Button (44x44px minimum touch target for older VIP judges) */}
                    <button
                      type="button"
                      onClick={() => handleScoreChange(crit.id, Math.min(max, activeVal + 1))}
                      disabled={areSlidersDisabled || activeVal >= max}
                      className="w-11 h-11 shrink-0 bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 rounded-xl active:scale-95 disabled:opacity-30 border border-stone-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 font-bold flex items-center justify-center transition-all cursor-pointer shadow-sm"
                      title="Increase mark by 1"
                      aria-label="Increase score"
                    >
                      <Plus className="w-5 h-5 stroke-[2.5]" />
                    </button>
                  </div>

                  {/* Range Snap Markers */}
                  <div className="flex justify-between px-14 text-[10px] font-mono font-bold text-zinc-400">
                    <span>0</span>
                    <span>{Math.floor(max / 2)}</span>
                    <span>{max}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {/* ============================================================ */}
      {/* PART 5.2: THE STICKY GAMEPAD FOOTER (Bottom Fixed)           */}
      {/* ============================================================ */}
      <footer className="fixed bottom-0 left-0 w-full h-[12dvh] min-h-[80px] bg-white/95 dark:bg-zinc-950/95 backdrop-blur-xl border-t border-stone-200 dark:border-zinc-800 z-50 flex items-center justify-between px-6 select-none shadow-2xl">
        {/* Left: [ < ] Arrow */}
        <button
          onClick={handlePrev}
          disabled={currentIndex === 0}
          className="w-12 h-12 rounded-full bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 disabled:opacity-25 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-800 dark:text-zinc-200 active:scale-90 transition-all cursor-pointer shadow-sm shrink-0"
          title="Previous Competitor"
          aria-label="Previous Competitor"
        >
          <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
        </button>

        {/* Center: Total: XX / YY pts (Massive, bold, monospace font, perfectly centered) */}
        <div className="text-center font-mono flex flex-col items-center justify-center min-w-0 px-2">
          <div className="text-2xl sm:text-3xl font-black text-zinc-900 dark:text-white tracking-tight leading-none">
            <span className="text-emerald-600 dark:text-emerald-400">{currentTotal}</span>
            <span className="text-zinc-400 text-sm font-normal"> / {maxPossible}</span>
            <span className="text-xs font-normal text-zinc-400 ml-1">pts</span>
          </div>
          <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest mt-1 font-bold">
            Total Composite
          </span>
        </div>

        {/* Right: [ > ] Arrow */}
        <button
          onClick={handleNext}
          disabled={currentIndex === participants.length - 1}
          className="w-12 h-12 rounded-full bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 disabled:opacity-25 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-800 dark:text-zinc-200 active:scale-90 transition-all cursor-pointer shadow-sm shrink-0"
          title="Next Competitor"
          aria-label="Next Competitor"
        >
          <ChevronRight className="w-6 h-6 stroke-[2.5]" />
        </button>
      </footer>

      {/* ============================================================ */}
      {/* PART 3: FRAMER-STYLE CONFIRMATION MODAL ("Lock in this score?") */}
      {/* ============================================================ */}
      {showConfirmModal ? (
        <div className="fixed inset-0 z-[100] bg-black/85 backdrop-blur-sm flex items-center justify-center p-4 pointer-events-auto">
          <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl w-full max-w-sm p-6 shadow-2xl space-y-4 animate-fade-in select-none">
            <div className="flex items-center space-x-3 text-emerald-600 dark:text-emerald-400">
              <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl">
                <ShieldCheck className="w-6 h-6 stroke-[2.2]" />
              </div>
              <div>
                <h3 className="text-base font-extrabold text-zinc-900 dark:text-white">Lock in this score?</h3>
                <span className="text-[10px] font-mono text-zinc-500">IMMUTABLE CRYPTOGRAPHIC LEDGER</span>
              </div>
            </div>

            <div className="p-3.5 bg-stone-50 dark:bg-zinc-900/60 border border-stone-200 dark:border-zinc-800 rounded-2xl space-y-1.5 text-xs">
              <div className="flex justify-between">
                <span className="text-zinc-500">Competitor:</span>
                <span className="font-bold text-zinc-900 dark:text-white">
                  {isBlindJudging
                    ? `Participant ${currentParticipant?.identity_id || 'P-8492'}`
                    : currentParticipant?.name}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-500">Serial No.:</span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400 font-bold">
                  #{event.participant_sl_numbers?.[currentParticipant?.id || ''] || currentParticipant?.sl_no}
                </span>
              </div>
              <div className="flex justify-between border-t border-stone-200 dark:border-zinc-800 pt-1.5">
                <span className="text-zinc-500 font-medium">Final Composite:</span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400 font-black text-sm">{currentTotal} / {maxPossible} pts</span>
              </div>
            </div>

            <p className="text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
              {isGracePeriod
                ? 'Your ballot will be recorded immediately. You will have a 5-minute grace window to make any final adjustments.'
                : 'Once confirmed, this ballot is permanently sealed in the competition audit repository and cannot be altered.'}
            </p>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => setShowConfirmModal(false)}
                className="min-h-[42px] bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-bold rounded-xl active:scale-95 transition-all cursor-pointer border border-stone-200 dark:border-zinc-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleConfirmSubmit}
                className="min-h-[42px] bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black rounded-xl transition-all shadow-md shadow-emerald-600/25 active:scale-95 cursor-pointer flex items-center justify-center space-x-1.5"
              >
                {isSubmitting ? <span>Locking...</span> : <span>Confirm Lock</span>}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ============================================================ */}
      {/* PART 3: ASYNC PAYMENT-STYLE SUCCESS OVERLAY (1500ms)         */}
      {/* ============================================================ */}
      {showSuccess ? (
        <div className="fixed inset-0 z-[100] bg-white/95 dark:bg-black/95 backdrop-blur-md flex flex-col items-center justify-center animate-in fade-in duration-200 select-none pointer-events-auto">
          <div className="flex flex-col items-center text-center p-6 space-y-3">
            <CheckCircle className="w-20 h-20 text-emerald-500 animate-in zoom-in duration-300 stroke-[2.2]" />
            <h2 className="text-2xl sm:text-3xl font-black text-zinc-900 dark:text-white tracking-tight">
              Score Locked.
            </h2>
            <p className="text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400">
              Recorded in Immutable Ledger
            </p>
          </div>
        </div>
      ) : null}

    </div>
  );
}
