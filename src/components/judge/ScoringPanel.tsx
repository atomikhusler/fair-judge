import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
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
  RotateCcw,
  Loader2
} from 'lucide-react';
import { triggerHaptic } from '../../lib/haptics';
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
import { PullToRefresh } from '../common/PullToRefresh';
import { showToast } from '../common/ToastProvider';
import { useAnnouncements } from '../../lib/announcements';
import { AnnouncementBanner } from '../common/AnnouncementBanner';
import { NotificationBell } from '../common/NotificationBell';

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
  // Active Event state that refreshes on pull
  const [activeEvent, setActiveEvent] = useState<SupabaseEvent>(event);

  useEffect(() => {
    setActiveEvent(event);
  }, [event]);

  // Navigation View: 'list' (Initial List View) vs 'scoring' (Scoring Carousel)
  const [viewMode, setViewMode] = useState<'list' | 'scoring'>('list');

  // Organization settings (for Jury Terminal Rules)
  const [organization, setOrganization] = useState<Organization | null>(null);

  const [participants, setParticipants] = useState<SupabaseParticipant[]>([]);
  const [isLoadingRoster, setIsLoadingRoster] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [listSearch, setListSearch] = useState('');
  const [scoresMap, setScoresMap] = useState<Record<string, number | null>>({});
  const [existingScore, setExistingScore] = useState<SupabaseScore | null>(null);
  const [allMyScores, setAllMyScores] = useState<SupabaseScore[]>([]);
  
  // Submit State Machine & "The Beat" (600ms hold & fluid slide)
  const [isReviewSheetOpen, setIsReviewSheetOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmittedBeat, setIsSubmittedBeat] = useState(false);
  const [isCardSlidingOut, setIsCardSlidingOut] = useState(false);

  const [, setPendingQueueCount] = useState(0);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | 'none'>('none');
  const {
    bannerNotices,
    inboxNotices,
    unreadCount,
    dismissBanner,
    markInboxAsRead,
    refreshAnnouncements,
  } = useAnnouncements('judge', orgId || event.org_id);

  // Screen WakeLock API: prevent screen dimming during active evaluation
  const wakeLockRef = useRef<any>(null);

  useEffect(() => {
    let isMounted = true;
    async function requestWakeLock() {
      try {
        if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && (navigator as any).wakeLock) {
          wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        }
      } catch (err) {
        console.warn('Screen wakeLock request note:', err);
      }
    }
    requestWakeLock();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isMounted) {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMounted = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
    };
  }, []);

  const rubricList: RubricCriterion[] = useMemo(() => {
    return event.rubric_schema || event.rubric || [];
  }, [event.id, event.rubric_schema]);

  // Load organization, participants & all scores submitted by this judge
  const loadData = async () => {
    try {
      const targetOrgId = orgId || event.org_id;
      let freshOrg = await dbService.getOrganizationByOrgId(targetOrgId);
      if (!freshOrg) {
        const allOrgs = await dbService.getOrganizations();
        freshOrg = allOrgs.find(
          (o) =>
            o.org_id.toUpperCase() === targetOrgId.toUpperCase().trim() ||
            o.id === targetOrgId ||
            o.id === event.org_id
        ) || null;
      }
      if (freshOrg) {
        setOrganization(freshOrg);
      }

      // Re-fetch the active SupabaseEvent
      const allEvents = await dbService.getEvents(targetOrgId, true);
      const freshEvt = allEvents.find((e) => e.id === event.id);
      if (freshEvt) {
        setActiveEvent(freshEvt);
      }

      const assignedList = freshEvt ? freshEvt.assigned_participants : event.assigned_participants;
      const allP = await dbService.getParticipants(targetOrgId);
      const participantMap = new Map(allP.map((p) => [p.id, p]));
      const sequencedParticipants = (assignedList || [])
        .map((id) => participantMap.get(id))
        .filter((p): p is SupabaseParticipant => Boolean(p));
      setParticipants(sequencedParticipants);

      const allScores = await dbService.getScores(event.id);
      const myScores = allScores.filter((s) => s.judge_id === judge.id);
      setAllMyScores(myScores);

      const count = await getPendingCount();
      setPendingQueueCount(count);
    } catch (err) {
      console.error('Error loading evaluation stage:', err);
    } finally {
      setIsLoadingRoster(false);
    }
  };

  const handlePullRefresh = async () => {
    try {
      await flushOfflineQueueToSupabase();
    } catch (err) {
      console.warn('Pull-to-refresh queue flush note:', err);
    }
    await Promise.all([loadData(), refreshAnnouncements()]);
  };

  // Dedicated Organization settings synchronization for Jury Terminal rules
  useEffect(() => {
    const targetOrgId = orgId || event.org_id;
    if (!targetOrgId) return;

    dbService.getOrganizationByOrgId(targetOrgId).then((freshOrg) => {
      if (freshOrg) {
        setOrganization(freshOrg);
      } else {
        dbService.getOrganizations().then((allOrgs) => {
          const match = allOrgs.find(
            (o) =>
              o.org_id.toUpperCase() === targetOrgId.toUpperCase().trim() ||
              o.id === targetOrgId ||
              o.id === event.org_id
          );
          if (match) setOrganization(match);
        });
      }
    });
  }, [orgId, event.org_id]);

  useEffect(() => {
    loadData();
    const unsubDb = subscribeToDatabase((table) => {
      if (
        table === 'fairjudge_supabase_orgs' ||
        table === 'fairjudge_supabase_events' ||
        table === 'fairjudge_supabase_scores' ||
        table === 'fairjudge_supabase_participants' ||
        table === 'all'
      ) {
        loadData();
      }
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

  // Score Draft Engine: Key includes eventId, judgeId and participantId; v1; 24h TTL
  const lastLoadedParticipantIdRef = useRef<string | null>(null);
  const isDirtyRef = useRef<boolean>(false);
  const scoresOwnerIdRef = useRef<string | null>(null);

  const getScoreDraftKey = useCallback(
    (participantId: string) => `fj_draft_score_${event.id}_${judge.id}_${participantId}`,
    [event.id, judge.id]
  );

  const loadScoreDraft = useCallback(
    (participantId: string): Record<string, number | null> | null => {
      try {
        const raw = localStorage.getItem(getScoreDraftKey(participantId));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed.version === 1 && Date.now() - parsed.timestamp < 24 * 3600 * 1000) {
          return parsed.scoresMap;
        }
      } catch {}
      return null;
    },
    [getScoreDraftKey]
  );

  const clearScoreDraft = useCallback(
    (participantId: string) => {
      try {
        localStorage.removeItem(getScoreDraftKey(participantId));
      } catch {}
    },
    [getScoreDraftKey]
  );

  // Debounced auto-save score draft
  useEffect(() => {
    if (!currentParticipant || !isDirtyRef.current) return;
    if (scoresOwnerIdRef.current !== currentParticipant.id) return;
    const participantId = currentParticipant.id;
    const key = getScoreDraftKey(participantId);
    const timer = setTimeout(() => {
      try {
        if (scoresOwnerIdRef.current !== participantId) return;
        const hasAnyScore = Object.values(scoresMap).some((v) => v !== null && v !== undefined);
        if (hasAnyScore) {
          const draft = {
            version: 1,
            eventId: event.id,
            judgeId: judge.id,
            participantId,
            scoresMap,
            timestamp: Date.now(),
          };
          localStorage.setItem(key, JSON.stringify(draft));
        }
      } catch {}
    }, 300);

    return () => clearTimeout(timer);
  }, [scoresMap, currentParticipant?.id, event.id, judge.id, getScoreDraftKey]);

  // On participant change in scoring mode, load their score or reset to null with cancelled flag
  useEffect(() => {
    if (!currentParticipant) return;
    let isCancelled = false;
    const participantId = currentParticipant.id;
    const isParticipantChanged = lastLoadedParticipantIdRef.current !== participantId;

    if (isParticipantChanged) {
      isDirtyRef.current = false;
      scoresOwnerIdRef.current = participantId;
    }

    dbService
      .getScoreForJudgeParticipant(event.id, judge.id, participantId)
      .then((score) => {
        if (isCancelled) return;
        setExistingScore(score);

        if (score) {
          if (isDirtyRef.current) {
            lastLoadedParticipantIdRef.current = participantId;
            return;
          }
          const filled: Record<string, number | null> = {};
          rubricList.forEach((c) => {
            filled[c.id] =
              score.score_data && score.score_data[c.id] !== undefined
                ? score.score_data[c.id]
                : score.score_payload?.criteria?.[c.id] ?? 0;
          });
          setScoresMap(filled);
          isDirtyRef.current = false;
          scoresOwnerIdRef.current = participantId;
          lastLoadedParticipantIdRef.current = participantId;
        } else {
          // If sliders are dirty and participant has not changed, skip reset entirely!
          if (!isParticipantChanged && isDirtyRef.current) {
            return;
          }

          // Reset sliders only when participant id actually changes
          if (isParticipantChanged) {
            const draft = loadScoreDraft(participantId);
            if (draft && event.status !== 'ended') {
              setScoresMap(draft);
              isDirtyRef.current = true;
              scoresOwnerIdRef.current = participantId;
            } else {
              const fresh: Record<string, number | null> = {};
              rubricList.forEach((c) => {
                fresh[c.id] = null;
              });
              setScoresMap(fresh);
              isDirtyRef.current = false;
              scoresOwnerIdRef.current = participantId;
            }
            lastLoadedParticipantIdRef.current = participantId;
          } else {
            // Same participant, not dirty: check if draft exists or maintain fresh
            const draft = loadScoreDraft(participantId);
            if (draft && event.status !== 'ended') {
              setScoresMap(draft);
              scoresOwnerIdRef.current = participantId;
            }
          }
        }
      });

    return () => {
      isCancelled = true;
    };
  }, [currentParticipant?.id, event.id, judge.id, event.status, loadScoreDraft, rubricList]);

  // Handle score changes with granular haptics
  const handleScoreChange = (criterionId: string, val: number) => {
    if (areSlidersDisabled) return;
    triggerHaptic('tick');
    isDirtyRef.current = true;
    if (currentParticipant) {
      scoresOwnerIdRef.current = currentParticipant.id;
    }
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
  // PART 3: ASYNC SUBMIT & "THE BEAT" (600ms hold & fluid slide)
  // =============================================================
  const handleOpenReview = () => {
    if (!currentParticipant || !isAllScored || isSubmitting || isSubmittedBeat || areSlidersDisabled) return;
    triggerHaptic('tap');
    setIsReviewSheetOpen(true);
  };

  const handleConfirmLockScore = async () => {
    if (!currentParticipant || !isAllScored || isSubmitting || isSubmittedBeat || areSlidersDisabled) return;

    // Granular Haptics: Final ballot submission pulse
    triggerHaptic('submit');

    setIsSubmitting(true);

    const sanitizedData: Record<string, number> = {};
    rubricList.forEach((c) => {
      sanitizedData[c.id] = scoresMap[c.id] || 0;
    });

    const ballotUuid = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `score_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const payload = {
      id: ballotUuid,
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

    const participantSnapshot = currentParticipant;
    const indexSnapshot = currentIndex;

    try {
      const freshEvent = await dbService.getEventById(event.id);
      if (freshEvent && (freshEvent.status === 'paused' || freshEvent.status === 'ended')) {
        throw new Error(`Event is ${freshEvent.status}. Ballot submission rejected.`);
      }

      let committed: SupabaseScore;
      if (!navigator.onLine) {
        await queueScoreLocally(payload);
        committed = {
          ...payload,
          id: ballotUuid,
          created_at: new Date().toISOString(),
        };
      } else {
        committed = await dbService.submitScore(payload);
      }

      setExistingScore(committed);
      setAllMyScores((prev) => {
        const without = prev.filter((s) => s.participant_id !== participantSnapshot.id);
        return [...without, committed];
      });

      clearScoreDraft(participantSnapshot.id);
      isDirtyRef.current = false;

      // Network resolved -> transition to Recorded checkmark & hold screen perfectly still for 600ms (The Beat)
      setIsSubmitting(false);
      setIsSubmittedBeat(true);

      setTimeout(() => {
        setIsSubmittedBeat(false);
        setIsReviewSheetOpen(false);

        if (isAutoAdvance) {
          // Slide out current card to the left
          setIsCardSlidingOut(true);

          setTimeout(() => {
            if (indexSnapshot < participants.length - 1) {
              setCurrentIndex(indexSnapshot + 1);
              setIsCardSlidingOut(false);
              setSlideDirection('left');
              setTimeout(() => setSlideDirection('none'), 250);
            } else {
              setIsCardSlidingOut(false);
              setViewMode('list');
            }
          }, 250);
        }
      }, 600);

    } catch (err: any) {
      console.warn('Saving to local offline queue:', err);
      await queueScoreLocally(payload);
      const offlineCommit: SupabaseScore = {
        ...payload,
        id: ballotUuid,
        created_at: new Date().toISOString(),
      };
      setExistingScore(offlineCommit);
      setAllMyScores((prev) => {
        const without = prev.filter((s) => s.participant_id !== participantSnapshot.id);
        return [...without, offlineCommit];
      });

      clearScoreDraft(participantSnapshot.id);
      isDirtyRef.current = false;

      setIsSubmitting(false);
      setIsSubmittedBeat(true);

      setTimeout(() => {
        setIsSubmittedBeat(false);
        setIsReviewSheetOpen(false);

        if (isAutoAdvance) {
          setIsCardSlidingOut(true);

          setTimeout(() => {
            if (indexSnapshot < participants.length - 1) {
              setCurrentIndex(indexSnapshot + 1);
              setIsCardSlidingOut(false);
              setSlideDirection('left');
              setTimeout(() => setSlideDirection('none'), 250);
            } else {
              setIsCardSlidingOut(false);
              setViewMode('list');
            }
          }, 250);
        }
      }, 600);
    }
  };

  // =============================================================
  // VIEW 1: PARTICIPANT ROSTER VIEW (Fixed Viewport App-Shell)
  // =============================================================
  if (viewMode === 'list') {
    return (
      <div className="h-[100dvh] overflow-hidden w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col max-w-lg mx-auto relative select-none transition-colors duration-200">
        
        {/* Permanently Pinned Top Header (shrink-0 inside h-[100dvh] overflow-hidden) */}
        <header className="shrink-0 z-50 w-full bg-stone-50 dark:bg-black border-b border-stone-200 dark:border-zinc-800/80 px-4 py-3 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={onBackToLobby}
              className="bg-zinc-900 dark:bg-white text-white dark:text-black font-bold text-sm md:text-base px-5 min-h-[48px] rounded-xl shadow-md active:scale-[0.97] transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform flex items-center justify-center gap-2 cursor-pointer shrink-0"
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
              <div className="flex items-center space-x-1.5 px-3 py-1 rounded-full text-[10px] font-mono font-bold bg-amber-500/10 text-amber-500 dark:text-amber-400 border border-amber-500/20">
                <span className={`w-1.5 h-1.5 rounded-full ${isOnline ? 'bg-amber-500' : 'bg-amber-400'}`} />
                <span>{isOnline ? 'ONLINE' : 'OFFLINE'}</span>
              </div>
              <NotificationBell
                notices={inboxNotices}
                unreadCount={unreadCount}
                onMarkRead={markInboxAsRead}
                accent="amber"
                buttonClassName="relative w-11 h-11 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 flex items-center justify-center active:scale-[0.97] transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform cursor-pointer shadow-xs"
              />
            </div>
          </div>

          <div className="border-t border-stone-200/80 dark:border-zinc-800/80 pt-2.5 mt-2.5 flex items-start justify-between">
            <div className="min-w-0 flex-1 mr-3">
              <span className="text-[10px] font-mono uppercase tracking-wider text-amber-500 dark:text-amber-400 font-extrabold flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
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

        <AnnouncementBanner
          notices={bannerNotices}
          onDismiss={dismissBanner}
        />

        {/* Scrollable Content Area */}
        <PullToRefresh onRefresh={handlePullRefresh} accentColor="amber" className="flex-1 overflow-hidden flex flex-col">
          <main className="flex-1 overflow-y-auto px-4 pt-4 pb-40 space-y-5">
          {/* Smart Search Bar */}
          <div className="relative">
            <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-3.5" />
            <input
              type="text"
              placeholder={isBlindJudging ? "Search by Sl. No. or ID..." : "Search by Sl. No., Name, or School..."}
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              className="w-full pl-10 pr-9 py-3 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl text-xs text-zinc-900 dark:text-white placeholder-zinc-400 shadow-sm focus:outline-none focus:border-amber-500"
            />
            {listSearch && (
              <button
                onClick={() => setListSearch('')}
                className="absolute right-3 top-3 text-zinc-400 hover:text-zinc-600 dark:hover:text-white p-0.5 cursor-pointer"
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

              {/* TARGET 3: STAGGERED SKELETON LOADER (Zero-jump stage synchronization) */}
              {isLoadingRoster ? (
                <div className="space-y-3">
                  <div className="flex items-center space-x-2 px-1">
                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse shrink-0" />
                    <span className="text-xs font-mono font-bold tracking-widest text-amber-500 uppercase animate-pulse">
                      Syncing Stage...
                    </span>
                  </div>
                  <div className="space-y-2.5">
                    {/* Row 1: 100% Opacity */}
                    <div className="p-4 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl flex items-center justify-between opacity-100">
                      <div className="flex items-center space-x-3.5 min-w-0">
                        <div className="w-11 h-11 rounded-2xl fj-skel shrink-0" />
                        <div className="space-y-2 min-w-0">
                          <div className="h-4 w-32 fj-skel rounded-md" />
                          <div className="h-3 w-20 fj-skel rounded-md" />
                        </div>
                      </div>
                      <div className="w-8 h-8 rounded-xl fj-skel shrink-0" />
                    </div>

                    {/* Row 2: 70% Opacity */}
                    <div className="p-4 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl flex items-center justify-between opacity-70">
                      <div className="flex items-center space-x-3.5 min-w-0">
                        <div className="w-11 h-11 rounded-2xl fj-skel shrink-0" />
                        <div className="space-y-2 min-w-0">
                          <div className="h-4 w-28 fj-skel rounded-md" />
                          <div className="h-3 w-16 fj-skel rounded-md" />
                        </div>
                      </div>
                      <div className="w-8 h-8 rounded-xl fj-skel shrink-0" />
                    </div>

                    {/* Row 3: 40% Opacity */}
                    <div className="p-4 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl flex items-center justify-between opacity-40">
                      <div className="flex items-center space-x-3.5 min-w-0">
                        <div className="w-11 h-11 rounded-2xl fj-skel shrink-0" />
                        <div className="space-y-2 min-w-0">
                          <div className="h-4 w-24 fj-skel rounded-md" />
                          <div className="h-3 w-14 fj-skel rounded-md" />
                        </div>
                      </div>
                      <div className="w-8 h-8 rounded-xl fj-skel shrink-0" />
                    </div>
                  </div>
                </div>
              ) : filteredUpcoming.length === 0 ? (
                <div className="p-6 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl text-center text-xs text-zinc-400 shadow-sm">
                  {listSearch
                    ? 'No upcoming competitors match your search.'
                    : participants.length === 0
                    ? 'No competitors assigned to this event yet.'
                    : 'All assigned competitors have been evaluated! 🎉'}
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredUpcoming.map((p, idx) => {
                    const assignedIds = activeEvent.assigned_participants || event.assigned_participants || [];
                    const orderIdx = assignedIds.indexOf(p.id);
                    const participantSerial =
                      (activeEvent.participant_sl_numbers?.[p.id] || event.participant_sl_numbers?.[p.id]) ||
                      (orderIdx !== -1 ? String(orderIdx + 1).padStart(2, '0') : p.sl_no);
                    return (
                      <div
                        key={p.id}
                        style={{ animationDelay: `${Math.min(idx, 8) * 50}ms` }}
                        onClick={() => handleOpenParticipant(p)}
                        className="p-4 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 hover:border-amber-500/50 hover:bg-stone-50 dark:hover:bg-zinc-800 rounded-2xl shadow-sm transition-colors cursor-pointer group flex items-center justify-between active:scale-95 transition-transform duration-75 ease-out will-change-transform animate-in fade-in slide-in-from-bottom-2 duration-200 fill-mode-both"
                      >
                        <div className="flex items-center space-x-3.5 min-w-0 mr-3">
                          <div className="w-11 h-11 rounded-2xl bg-amber-500/10 text-amber-500 dark:text-amber-400 border border-amber-500/20 font-mono font-black text-sm flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform shadow-xs">
                            {participantSerial}
                          </div>
                          <div className="min-w-0">
                            {isBlindJudging ? (
                              <h3 className="text-base sm:text-lg font-black text-zinc-900 dark:text-white truncate">
                                Participant {p.identity_id || `P-${p.id.slice(0, 4)}`}
                              </h3>
                            ) : (
                              <>
                                <h3 className="text-sm font-extrabold text-zinc-900 dark:text-white truncate group-hover:text-amber-500 transition-colors">
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
                            className="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-extrabold text-xs tracking-wide shadow-md shadow-amber-500/20 active:scale-95 transition-transform duration-75 ease-out will-change-transform flex items-center space-x-1.5 cursor-pointer"
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
                  <CheckCircle2 className="w-3.5 h-3.5 text-amber-500" />
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
                  {filteredCompleted.map((p, idx) => {
                    const scoreRecord = allMyScores.find((s) => s.participant_id === p.id);
                    const assignedIds = activeEvent.assigned_participants || event.assigned_participants || [];
                    const orderIdx = assignedIds.indexOf(p.id);
                    const participantSerial =
                      (activeEvent.participant_sl_numbers?.[p.id] || event.participant_sl_numbers?.[p.id]) ||
                      (orderIdx !== -1 ? String(orderIdx + 1).padStart(2, '0') : p.sl_no);
                    return (
                      <div
                        key={p.id}
                        style={{ animationDelay: `${Math.min(idx, 8) * 50}ms` }}
                        onClick={() => handleOpenParticipant(p)}
                        className="p-3.5 sm:p-4 bg-stone-100/80 dark:bg-zinc-900/50 border border-stone-200 dark:border-zinc-800 rounded-2xl flex items-center justify-between gap-3 opacity-90 hover:opacity-100 transition-all cursor-pointer active:scale-95 transition-transform duration-75 ease-out will-change-transform shadow-xs animate-in fade-in slide-in-from-bottom-2 duration-200 fill-mode-both"
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
                          <div className="font-mono text-right tabular-nums whitespace-nowrap">
                            <span className="text-base sm:text-lg font-black text-amber-500 dark:text-amber-400 tabular-nums whitespace-nowrap">
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
        </main>
      </PullToRefresh>
      </div>
    );
  }

  // =============================================================
  // VIEW 2: SCORING TERMINAL - MOBILE GAMEPAD UI (Fixed App-Shell)
  // =============================================================
  return (
    <div className="h-[100dvh] overflow-hidden w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col justify-start max-w-lg mx-auto relative select-none transition-colors duration-200">
      
      {/* ============================================================ */}
      {/* PART 5.1: THE PINNED TOP HEADER + COMPETITOR BANNER          */}
      {/* ============================================================ */}
      <header className="shrink-0 z-50 w-full bg-stone-50 dark:bg-black border-b border-stone-200 dark:border-zinc-800/80 px-4 h-16 flex justify-between items-center shadow-xs">
        {/* Left: [ ← Back ] Heavy Contrast Secondary Button */}
        <button
          onClick={() => setViewMode('list')}
          className="bg-zinc-900 dark:bg-white text-white dark:text-black font-bold text-sm md:text-base px-5 min-h-[48px] rounded-xl shadow-md active:scale-95 transition-transform duration-75 ease-out will-change-transform flex items-center justify-center gap-2 cursor-pointer shrink-0"
          title="Return to Competitor Roster"
        >
          <ChevronLeft className="w-5 h-5 stroke-[2.5]" />
          <span>Back</span>
        </button>

        {/* Center: Empty / Clean */}
        <div className="flex-1" />

        {/* Right: Tactile, deep amber [ Submit ] button */}
        <div>
          {existingScore && !isWithinGracePeriod ? (
            <div className="flex items-center space-x-2 text-base font-black text-amber-500 dark:text-amber-400 bg-amber-500/10 px-6 min-h-[48px] rounded-xl border border-amber-500/20 tracking-wide">
              <Lock className="w-4 h-4 stroke-[2.5]" />
              <span>Sealed</span>
            </div>
          ) : (
            <button
              onClick={handleOpenReview}
              disabled={!isAllScored || isSubmitting || isSubmittedBeat || areSlidersDisabled}
              className={`px-6 min-h-[48px] rounded-xl font-black text-base shadow-lg shadow-amber-500/20 active:scale-95 transition-transform duration-75 ease-out will-change-transform flex items-center justify-center gap-2 tracking-wide ${
                isAllScored && !isSubmitting && !isSubmittedBeat && !areSlidersDisabled
                  ? 'bg-amber-500 hover:bg-amber-400 text-black cursor-pointer'
                  : 'bg-stone-200 dark:bg-zinc-800 text-zinc-400 opacity-50 cursor-not-allowed'
              }`}
            >
              {isWithinGracePeriod ? (
                <>
                  <RotateCcw className="w-4 h-4 stroke-[2.5]" />
                  <span>Update</span>
                </>
              ) : (
                <>
                  <Send className="w-4 h-4 stroke-[2.5]" />
                  <span>Submit</span>
                </>
              )}
            </button>
          )}
        </div>
      </header>

      {/* Pinned Competitor Banner Strip */}
      {currentParticipant && (() => {
        const assignedIds = activeEvent.assigned_participants || event.assigned_participants || [];
        const orderIdx = assignedIds.indexOf(currentParticipant.id);
        const currentSerial =
          (activeEvent.participant_sl_numbers?.[currentParticipant.id] || event.participant_sl_numbers?.[currentParticipant.id]) ||
          (orderIdx !== -1 ? String(orderIdx + 1).padStart(2, '0') : String(currentIndex + 1).padStart(2, '0'));

        return (
        <div className="shrink-0 z-40 px-4 pt-3 pb-2 bg-stone-100 dark:bg-zinc-900 border-b border-stone-200/60 dark:border-zinc-800/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3 min-w-0 flex-1">
              <div className="w-11 h-11 rounded-2xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-700 flex items-center justify-center font-mono font-black text-sm text-amber-500 dark:text-amber-400 shrink-0 shadow-sm">
                {currentSerial}
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
        );
      })()}

      {/* ============================================================ */}
      {/* SCROLLABLE CRITERIA SLIDERS CONTAINER (flex-1 overflow-y-auto) */}
      {/* ============================================================ */}
      <PullToRefresh onRefresh={handlePullRefresh} accentColor="amber" className="w-full flex-1 overflow-hidden flex flex-col">
        <main
          className={`w-full flex-1 overflow-y-auto px-4 py-4 space-y-3 pb-[140px] relative z-10 transition-all duration-250 ease-out will-change-transform ${
            isCardSlidingOut
              ? '-translate-x-full opacity-0'
              : slideDirection === 'left'
              ? 'translate-x-0 opacity-100 animate-in slide-in-from-right duration-250'
              : slideDirection === 'right'
              ? 'translate-x-0 opacity-100 animate-in slide-in-from-left duration-250'
              : 'translate-x-0 opacity-100'
          }`}
        >
        {existingScore && !isWithinGracePeriod && (
          <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center justify-between text-xs text-amber-500 dark:text-amber-400 font-semibold shadow-sm">
            <div className="flex items-center space-x-2">
              <Lock className="w-4 h-4 shrink-0 text-amber-500" />
              <span>Ballot sealed in audit ledger (Read-Only).</span>
            </div>
            <button
              onClick={() => setViewMode('list')}
              className="px-2.5 py-1 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-black text-[11px] shadow-sm shrink-0 cursor-pointer active:scale-[0.97] transition-transform duration-75 ease-out will-change-transform"
            >
              Roster
            </button>
          </div>
        )}

        <div className="space-y-3">
          {rubricList.map((crit) => {
            const currentVal = scoresMap[crit.id];
            const isScored = currentVal !== null && currentVal !== undefined;
            const max = Number(crit.max_marks) || 10;
            const activeVal = isScored ? currentVal : 0;
            const percentFilled = max > 0 ? (activeVal / max) * 100 : 0;

            return (
              <div
                key={crit.id}
                className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-3 px-4 shadow-sm transition-all flex flex-col justify-center"
              >
                {/* Criterion Header */}
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-0 min-w-0 flex-1">
                    <h3 className="text-xs font-black text-zinc-900 dark:text-white uppercase tracking-wider">
                      {crit.name}
                    </h3>
                    {crit.description && (
                      <p className="text-[11px] text-zinc-500 dark:text-zinc-400 line-clamp-2 mt-0.5">
                        {crit.description}
                      </p>
                    )}
                    <span className="text-[10px] text-zinc-400 font-mono block mt-0.5">Max: {max} pts</span>
                  </div>

                  <div className="font-mono text-right shrink-0 pl-2">
                    {isScored ? (
                      <span className="text-2xl sm:text-3xl font-black text-amber-500 dark:text-amber-400 tracking-tight tabular-nums whitespace-nowrap">
                        <span key={currentVal} className="inline-block animate-in fade-in slide-in-from-bottom-1 duration-150">
                          {currentVal}
                        </span>
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
                <div className="space-y-1.5 mt-2">
                  <div className="flex items-center gap-3">
                    {/* Chunky [-] Button (44x44px minimum touch target for older VIP judges) */}
                    <button
                      type="button"
                      onClick={() => handleScoreChange(crit.id, Math.max(0, activeVal - 1))}
                      disabled={areSlidersDisabled || activeVal <= 0}
                      className="w-11 h-11 shrink-0 bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 rounded-xl active:scale-95 transition-transform duration-75 ease-out will-change-transform disabled:opacity-30 border border-stone-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 font-bold flex items-center justify-center cursor-pointer shadow-sm"
                      title="Decrease mark by 1"
                      aria-label="Decrease score"
                    >
                      <Minus className="w-5 h-5 stroke-[2.5]" />
                    </button>

                    {/* Fluid Compact Slider Container */}
                    <div className="relative flex-1 flex items-center h-9">
                      <div className="w-full h-2 rounded-full bg-stone-200 dark:bg-zinc-800 relative overflow-hidden pointer-events-none shadow-inner">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-amber-500 via-amber-400 to-yellow-300 transition-all duration-75 shadow-sm"
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
                        className="absolute inset-0 w-full h-9 opacity-0 cursor-pointer disabled:cursor-not-allowed z-20"
                        aria-label={crit.name}
                      />

                      {/* Visual Large Thumb Indicator */}
                      <div
                        className="absolute top-1/2 -translate-y-1/2 pointer-events-none transition-all duration-75"
                        style={{
                          left: `calc(${percentFilled}% - ${percentFilled * 0.28}px)`,
                        }}
                      >
                        <div className="w-7 h-7 rounded-full bg-white dark:bg-zinc-100 border-2 border-amber-500 shadow-md shadow-amber-500/40 ring-4 ring-amber-500/20 flex items-center justify-center">
                          <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                        </div>
                      </div>
                    </div>

                    {/* Chunky [+] Button (44x44px minimum touch target for older VIP judges) */}
                    <button
                      type="button"
                      onClick={() => handleScoreChange(crit.id, Math.min(max, activeVal + 1))}
                      disabled={areSlidersDisabled || activeVal >= max}
                      className="w-11 h-11 shrink-0 bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 rounded-xl active:scale-95 transition-transform duration-75 ease-out will-change-transform disabled:opacity-30 border border-stone-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 font-bold flex items-center justify-center cursor-pointer shadow-sm"
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
      </PullToRefresh>

      {/* ============================================================ */}
      {/* PART 5.2: THE STICKY GAMEPAD FOOTER (Bottom Fixed)           */}
      {/* ============================================================ */}
      <footer className="fixed bottom-0 left-0 w-full h-[12dvh] min-h-[80px] bg-white/95 dark:bg-zinc-950/95 backdrop-blur-xl border-t border-stone-200 dark:border-zinc-800 z-50 flex items-center justify-between px-6 select-none shadow-2xl">
        {/* Left: [ < ] Arrow */}
        <button
          onClick={handlePrev}
          disabled={currentIndex === 0}
          className="w-12 h-12 rounded-full bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 disabled:opacity-25 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-800 dark:text-zinc-200 active:scale-95 transition-transform duration-75 ease-out will-change-transform cursor-pointer shadow-sm shrink-0"
          title="Previous Competitor"
          aria-label="Previous Competitor"
        >
          <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
        </button>

        {/* Center: Total: XX / YY pts (Massive, bold, monospace font, perfectly centered) */}
        <div className="text-center font-mono flex flex-col items-center justify-center min-w-0 px-2">
          <div className="text-2xl sm:text-3xl font-black text-zinc-900 dark:text-white tracking-tight leading-none tabular-nums whitespace-nowrap">
            <span key={currentTotal} className="text-amber-500 dark:text-amber-400 tabular-nums whitespace-nowrap inline-block animate-in fade-in slide-in-from-bottom-1 duration-150">
              {currentTotal}
            </span>
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
          className="w-12 h-12 rounded-full bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 disabled:opacity-25 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-800 dark:text-zinc-200 active:scale-95 transition-transform duration-75 ease-out will-change-transform cursor-pointer shadow-sm shrink-0"
          title="Next Competitor"
          aria-label="Next Competitor"
        >
          <ChevronRight className="w-6 h-6 stroke-[2.5]" />
        </button>
      </footer>

      {/* ============================================================ */}
      {/* APPLE-PAY STYLE LAST REVIEW BOTTOM SHEET */}
      {/* ============================================================ */}
      {/* ============================================================ */}
      {/* TARGET 2: FLUID REVIEW POP-UP REDESIGN (DUAL-THEME & SPRING KINEMATICS) */}
      {/* ============================================================ */}
      {isReviewSheetOpen && currentParticipant && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 transition-opacity animate-in fade-in duration-200">
          <div
            className="w-full max-w-lg bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-t-3xl shadow-2xl p-5 flex flex-col max-h-[85vh] animate-sheet-slide-up will-change-transform"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Grab Handle */}
            <div className="w-12 h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-700 mx-auto mb-4 shrink-0" />

            {/* Header: Competitor Serial & Identity */}
            <div className="flex items-center justify-between pb-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
              <div className="flex items-center space-x-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center font-mono font-black text-sm text-amber-500 dark:text-amber-400 shrink-0">
                  {(() => {
                    const assignedIds = activeEvent.assigned_participants || event.assigned_participants || [];
                    const orderIdx = assignedIds.indexOf(currentParticipant.id);
                    return (
                      (activeEvent.participant_sl_numbers?.[currentParticipant.id] || event.participant_sl_numbers?.[currentParticipant.id]) ||
                      (orderIdx !== -1 ? String(orderIdx + 1).padStart(2, '0') : String(currentIndex + 1).padStart(2, '0'))
                    );
                  })()}
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-black text-zinc-900 dark:text-white truncate">
                    {isBlindJudging ? `Participant ${currentParticipant.identity_id || `P-${currentParticipant.id.slice(0, 4)}`}` : currentParticipant.name}
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {isBlindJudging ? 'Blind Evaluation' : currentParticipant.school}
                  </p>
                </div>
              </div>

              {/* Close Button (Review / Cancel) */}
              <button
                type="button"
                disabled={isSubmitting || isSubmittedBeat}
                onClick={() => setIsReviewSheetOpen(false)}
                className="p-2 rounded-xl text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 cursor-pointer transition-colors"
                title="Cancel"
                aria-label="Cancel"
              >
                <X className="w-5 h-5 stroke-[2.5]" />
              </button>
            </div>

            {/* Total Score Hero */}
            <div className="py-4 my-2 text-center bg-zinc-50 dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shrink-0">
              <span className="text-xs font-mono uppercase tracking-widest text-zinc-400 font-bold block mb-1">
                Final Score Review
              </span>
              <div className="text-3xl font-black text-zinc-900 dark:text-white tabular-nums whitespace-nowrap">
                <span className="text-amber-500 dark:text-amber-400 font-mono text-3xl font-black">{currentTotal}</span>
                <span className="text-zinc-400 text-base font-normal"> / {maxPossible}</span>
                <span className="text-xs font-normal text-zinc-400 ml-1">pts</span>
              </div>
            </div>

            {/* Criteria Marks: Seamless Flat List Rows with subtle bottom border */}
            <div className="flex-1 overflow-y-auto divide-y divide-zinc-200 dark:divide-zinc-800 py-1 pr-1 my-2">
              <span className="text-xs font-mono uppercase tracking-wider text-zinc-400 font-bold px-1 block pb-2">
                Criteria Marks
              </span>
              {rubricList.map((criterion) => {
                const mark = scoresMap[criterion.id] ?? 0;
                return (
                  <div
                    key={criterion.id}
                    className="flex items-center justify-between py-2.5 px-1 border-b border-zinc-200 dark:border-zinc-800 last:border-b-0"
                  >
                    <div className="min-w-0 pr-3">
                      <p className="text-xs font-bold text-zinc-900 dark:text-white truncate">
                        {criterion.name}
                      </p>
                      {criterion.description && (
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                          {criterion.description}
                        </p>
                      )}
                    </div>
                    <div className="font-mono text-xs font-bold shrink-0 tabular-nums whitespace-nowrap">
                      <span className="text-amber-500 dark:text-amber-400 font-black">{mark}</span>
                      <span className="text-zinc-400 font-normal"> / {criterion.max_marks}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Actions: Review (Cancel) vs Lock Score (Confirm) */}
            <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-3 shrink-0">
              <button
                type="button"
                disabled={isSubmitting || isSubmittedBeat}
                onClick={() => setIsReviewSheetOpen(false)}
                className="flex-1 py-3.5 px-4 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 font-extrabold text-sm hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40 cursor-pointer active:scale-95 transition-transform duration-75 ease-out will-change-transform"
              >
                Review
              </button>

              <button
                type="button"
                disabled={isSubmitting || isSubmittedBeat}
                onClick={handleConfirmLockScore}
                className={`flex-1 py-3.5 px-4 rounded-xl font-extrabold text-sm flex items-center justify-center gap-2 active:scale-95 transition-transform duration-75 ease-out will-change-transform cursor-pointer ${
                  isSubmittedBeat
                    ? 'bg-amber-500/20 text-amber-500 border border-amber-500/30'
                    : 'bg-amber-500 hover:bg-amber-400 text-black shadow-lg shadow-amber-500/25'
                }`}
              >
                {isSubmitting ? (
                  <Loader2 className="w-5 h-5 animate-spin shrink-0 stroke-[2.5]" />
                ) : isSubmittedBeat ? (
                  <>
                    <Lock className="w-4 h-4 stroke-[2.5] shrink-0" />
                    <span>Locked</span>
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4 stroke-[2.5] shrink-0" />
                    <span>Lock Score</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
