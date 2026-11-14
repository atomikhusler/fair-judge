import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Search,
  CheckCircle2,
  Lock,
  X,
  Eye,
  Minus,
  Plus,
  Clock,
  Send,
  RotateCcw,
  Loader2,
  AlertTriangle,
  Trash2,
} from 'lucide-react';
import { triggerHaptic } from '../../lib/haptics';
import { dbService, subscribeToDatabase, syncServerClockOffset, getServerNowMs } from '../../lib/supabase';
import { DB_TABLES, matchesDbTable } from '../../lib/dbTables';
import {
  queueScoreLocally,
  flushOfflineQueueToSupabase,
  getPendingCount,
  getPendingScores,
  discardFailedScore,
  subscribeToQueueChanges,
  PendingScoreRecord,
} from '../../lib/offlineQueue';
import {
  SupabaseJudge,
  SupabaseEvent,
  SupabaseParticipant,
  SupabaseScore,
  RubricCriterion,
  Organization,
} from '../../lib/supabaseTypes';
import { PullToRefresh } from '../common/PullToRefresh';
import { ReadRetryBanner } from '../common/ReadRetryBanner';
import { showToast } from '../common/ToastProvider';
import { useAnnouncements } from '../../lib/announcements';
import { AnnouncementBanner } from '../common/AnnouncementBanner';
import { NotificationBell } from '../common/NotificationBell';

const GRACE_PERIOD_MS = 5 * 60 * 1000;

export interface ScoringPanelProps {
  orgId: string;
  judge: SupabaseJudge;
  event: SupabaseEvent;
  onBackToLobby: () => void;
  onSwitchToOrganiserView?: () => void;
}

export type JudgeStageProps = ScoringPanelProps;

interface UnsavedBallotState {
  key: string;
  eventId: string;
  judgeId: string;
  participantId: string;
  scoreData: Record<string, number>;
  totalScore: number;
  reason: string;
  payload: {
    id: string;
    event_id: string;
    judge_id: string;
    participant_id: string;
    score_data: Record<string, number>;
    total_score: number;
    score_payload: {
      criteria: Record<string, number>;
      total_score: number;
      submitted_at: string;
    };
  };
  failedQueueId?: string;
}

function buildEmptyScoresMap(rubric: RubricCriterion[]): Record<string, number | null> {
  const map: Record<string, number | null> = {};
  for (const c of rubric) {
    map[c.id] = null;
  }
  return map;
}

function formatRejectionReason(err: any): string {
  const raw = String(err?.message || err || 'Submission rejected by server').trim();
  const stripped = raw
    .replace(/^RLS Permission Denied:\s*/i, '')
    .replace(/^ORG_NOT_ALLOWED:\s*/i, 'Organization restricted: ')
    .replace(/\s*Ballot submission rejected\.?$/i, '')
    .trim();
  if (!stripped) return 'Submission rejected by server';
  if (stripped.toLowerCase().includes('immutable')) {
    return 'Ballot already sealed and cannot be modified';
  }
  return stripped.endsWith('.') ? stripped.slice(0, -1) : stripped;
}

function isOfflineNetworkError(err: any): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  if (err?.code === 'rpc_unavailable') return true;
  const msg = String(err?.message || err || '').toLowerCase();
  const hasRejectionMarker = Boolean(
    err?.code === 'unauthorized' ||
    err?.code === 'forbidden' ||
    err?.code === 'not_found' ||
    err?.code === 'ROSTER_LOCKED' ||
    err?.code === 'RLS Permission Denied' ||
    err?.code === '42501' ||
    err?.code === '23505' ||
    err?.code === '23503' ||
    err?.code === '23502' ||
    err?.code === '22P02' ||
    msg.includes('permission denied') ||
    msg.includes('rls permission denied') ||
    msg.includes('org_not_allowed') ||
    msg.includes('not assigned') ||
    msg.includes('paused') ||
    msg.includes('ended') ||
    msg.includes('archived') ||
    msg.includes('grace period') ||
    msg.includes('immutable')
  );
  if (hasRejectionMarker) return false;
  if (err?.code) return false;
  return (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network error') ||
    msg.includes('load failed') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('network')
  );
}

export function ScoringPanel({
  orgId,
  judge,
  event,
  onBackToLobby,
}: ScoringPanelProps) {
  // Refreshed Event state (always prefer activeEvent over initial event prop)
  const [activeEvent, setActiveEvent] = useState<SupabaseEvent>(event);
  const activeEventRef = useRef<SupabaseEvent>(event);

  useEffect(() => {
    setActiveEvent(event);
    activeEventRef.current = event;
  }, [event]);

  useEffect(() => {
    activeEventRef.current = activeEvent;
  }, [activeEvent]);

  // Navigation View: 'list' (Initial List View) vs 'scoring' (Scoring Carousel)
  const [viewMode, setViewMode] = useState<'list' | 'scoring'>('list');
  const viewModeRef = useRef<'list' | 'scoring'>('list');
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);

  // Organization settings (for Jury Terminal Rules)
  const [organization, setOrganization] = useState<Organization | null>(null);

  const [participants, setParticipants] = useState<SupabaseParticipant[]>([]);
  const participantsRef = useRef<SupabaseParticipant[]>([]);
  const hasLoadedRosterRef = useRef<boolean>(false);

  const [isLoadingRoster, setIsLoadingRoster] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [listSearch, setListSearch] = useState('');
  const [scoresMap, setScoresMap] = useState<Record<string, number | null>>({});
  const [existingScore, setExistingScore] = useState<SupabaseScore | null>(null);
  const [allMyScores, setAllMyScores] = useState<SupabaseScore[]>([]);
  const [pendingParticipantIds, setPendingParticipantIds] = useState<Set<string>>(() => new Set());
  const [unsavedBallotsByKey, setUnsavedBallotsByKey] = useState<Record<string, UnsavedBallotState>>({});
  const unsavedBallotsRef = useRef<Record<string, UnsavedBallotState>>({});
  useEffect(() => {
    unsavedBallotsRef.current = unsavedBallotsByKey;
  }, [unsavedBallotsByKey]);

  // Submit State Machine & "The Beat" (600ms hold & fluid slide)
  const [isReviewSheetOpen, setIsReviewSheetOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmittedBeat, setIsSubmittedBeat] = useState(false);
  const [isCardSlidingOut, setIsCardSlidingOut] = useState(false);

  const [, setPendingQueueCount] = useState(0);
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | 'none'>('none');
  const [, setClockSyncVersion] = useState(0);
  const [graceExpired, setGraceExpired] = useState(false);

  const [readError, setReadError] = useState<string | null>(null);
  const [isRetryingRead, setIsRetryingRead] = useState(false);
  const readErrorRef = useRef<string | null>(null);
  const loadRequestIdRef = useRef(0);

  useEffect(() => {
    readErrorRef.current = readError;
  }, [readError]);

  const effectiveOrgId = orgId || activeEvent.org_id;

  const {
    bannerNotices,
    inboxNotices,
    unreadCount,
    dismissBanner,
    markInboxAsRead,
    refreshAnnouncements,
  } = useAnnouncements('judge', effectiveOrgId);

  // Ref-tracked timers (all cleared on unmount and leaving screen)
  const isMountedRef = useRef(true);
  const wakeLockRef = useRef<any>(null);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const slideOutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAllTimers = useCallback(() => {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (slideTimerRef.current) {
      clearTimeout(slideTimerRef.current);
      slideTimerRef.current = null;
    }
    if (beatTimerRef.current) {
      clearTimeout(beatTimerRef.current);
      beatTimerRef.current = null;
    }
    if (slideOutTimerRef.current) {
      clearTimeout(slideOutTimerRef.current);
      slideOutTimerRef.current = null;
    }
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearAllTimers();
    };
  }, [clearAllTimers]);

  // Reset roster guard when switching events
  useEffect(() => {
    hasLoadedRosterRef.current = false;
    participantsRef.current = [];
  }, [activeEvent.id]);

  // Screen WakeLock API: prevent screen dimming during active evaluation
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
    requestWakeLock().catch(() => {});

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isMounted) {
        requestWakeLock().catch(() => {});
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
    return activeEvent.rubric_schema || activeEvent.rubric || [];
  }, [activeEvent.id, activeEvent.rubric_schema, activeEvent.rubric]);

  const currentParticipant = participants[currentIndex] || null;
  const currentParticipantRef = useRef<SupabaseParticipant | null>(currentParticipant);
  useEffect(() => {
    currentParticipantRef.current = currentParticipant;
  }, [currentParticipant]);

  const getCompositeKey = useCallback(
    (participantId: string, eventId: string = activeEvent.id, judgeId: string = judge.id) =>
      `${eventId}:${judgeId}:${participantId}`,
    [activeEvent.id, judge.id]
  );

  // Active composite key & request ID refs for stale async response prevention
  const activeCompositeKeyRef = useRef<string | null>(null);
  const scoreLoadRequestIdRef = useRef<number>(0);
  const lastLoadedKeyRef = useRef<string | null>(null);
  const isDirtyRef = useRef<boolean>(false);
  const scoresOwnerKeyRef = useRef<string | null>(null);

  const handleExitToList = useCallback(() => {
    clearAllTimers();
    activeCompositeKeyRef.current = null;
    lastLoadedKeyRef.current = null;
    scoresOwnerKeyRef.current = null;
    isDirtyRef.current = false;
    setIsReviewSheetOpen(false);
    setIsSubmittedBeat(false);
    setIsCardSlidingOut(false);
    setSlideDirection('none');
    setExistingScore(null);
    setScoresMap(buildEmptyScoresMap(rubricList));
    setViewMode('list');
  }, [clearAllTimers, rubricList]);

  const handleBackNavigation = useCallback(() => {
    clearAllTimers();
    activeCompositeKeyRef.current = null;
    onBackToLobby();
  }, [clearAllTimers, onBackToLobby]);

  // Load organization, participants & all scores (merging offline pending ballots)
  const loadData = useCallback(
    async (force: boolean = false) => {
      const reqId = ++loadRequestIdRef.current;
      if (force) setIsRetryingRead(true);

      try {
        const currentEvt = activeEventRef.current;
        const targetOrgId = orgId || currentEvt.org_id;

        const [orgRes, eventsRes, participantsRes] = await Promise.all([
          dbService.getOrganizationByOrgIdResult(targetOrgId, force),
          dbService.getEventsResult(targetOrgId, true),
          dbService.getParticipantsResult(targetOrgId, force),
        ]);

        if (!isMountedRef.current || reqId !== loadRequestIdRef.current) return;

        const freshOrg = orgRes.data;
        if (freshOrg && isMountedRef.current) {
          setOrganization(freshOrg);
        }

        const freshEvt = eventsRes.data.find((e) => e.id === currentEvt.id) || currentEvt;
        if (isMountedRef.current && freshEvt) {
          setActiveEvent(freshEvt);
          activeEventRef.current = freshEvt;
        }

        const assignedList = freshEvt.assigned_participants;
        const participantMap = new Map(participantsRes.data.map((p) => [p.id, p]));
        const sequencedParticipants = (assignedList || [])
          .map((id) => participantMap.get(id))
          .filter((p): p is SupabaseParticipant => Boolean(p));

        const prevParticipants = participantsRef.current;
        const wasLoaded = hasLoadedRosterRef.current;
        const openParticipantId = currentParticipantRef.current?.id || null;

        participantsRef.current = sequencedParticipants;
        hasLoadedRosterRef.current = true;

        if (isMountedRef.current) {
          setParticipants(sequencedParticipants);
          setCurrentIndex((idx) =>
            sequencedParticipants.length === 0 ? 0 : Math.min(idx, sequencedParticipants.length - 1)
          );

          const didShrink = wasLoaded && sequencedParticipants.length < prevParticipants.length;
          const openMissing =
            wasLoaded &&
            Boolean(openParticipantId) &&
            !sequencedParticipants.some((p) => p.id === openParticipantId);

          if (viewModeRef.current === 'scoring' && (didShrink || openMissing)) {
            clearAllTimers();
            activeCompositeKeyRef.current = null;
            lastLoadedKeyRef.current = null;
            scoresOwnerKeyRef.current = null;
            isDirtyRef.current = false;
            setIsReviewSheetOpen(false);
            setIsSubmitting(false);
            setIsSubmittedBeat(false);
            setIsCardSlidingOut(false);
            setSlideDirection('none');
            setCurrentIndex(0);
            setViewMode('list');
            showToast('Participant list updated — returned to list.', 'info');
          }
        }

        const [scoresRes, pendingScores, count] = await Promise.all([
          dbService.getScoresResult(freshEvt.id, force),
          getPendingScores().catch(() => [] as PendingScoreRecord[]),
          getPendingCount().catch(() => 0),
        ]);

        if (!isMountedRef.current || reqId !== loadRequestIdRef.current) return;

        const firstFailure = [
          orgRes,
          eventsRes,
          participantsRes,
          scoresRes,
        ].find((r) => !r.ok);

        if (firstFailure) {
          setReadError(firstFailure.error || 'Showing cached stage data. Unable to reach server.');
        } else {
          setReadError(null);
        }

        const myServerScores = scoresRes.data.filter((s) => s.judge_id === judge.id);
        const myQueueItems = pendingScores.filter(
          (s) => s.event_id === freshEvt.id && s.judge_id === judge.id
        );

        const pendingOk = myQueueItems.filter((s) => s.syncStatus !== 'failed');
        const failedQueue = myQueueItems.filter((s) => s.syncStatus === 'failed');

        const mergedByParticipant = new Map<string, SupabaseScore>();
        for (const s of myServerScores) {
          mergedByParticipant.set(s.participant_id, s);
        }

        const pendingSet = new Set<string>();
        for (const pItem of pendingOk) {
          pendingSet.add(pItem.participant_id);
          const existingServer = mergedByParticipant.get(pItem.participant_id);
          const pTime = new Date(pItem.queuedAt).getTime();
          const sTime = existingServer ? new Date(existingServer.created_at).getTime() : -1;
          if (!existingServer || pTime >= sTime) {
            mergedByParticipant.set(pItem.participant_id, {
              id: pItem.id,
              event_id: pItem.event_id,
              judge_id: pItem.judge_id,
              participant_id: pItem.participant_id,
              score_data: pItem.score_data || pItem.score_payload?.criteria || {},
              score_payload: pItem.score_payload,
              total_score: pItem.total_score,
              created_at: pItem.score_payload?.submitted_at || pItem.queuedAt,
            });
          }
        }

        if (isMountedRef.current) {
          setAllMyScores(Array.from(mergedByParticipant.values()));
          setPendingParticipantIds(pendingSet);
          setPendingQueueCount(count);

          setUnsavedBallotsByKey((prev) => {
            const next = { ...prev };
            // Keep live in-memory rejected ballots plus sync-failed IndexedDB ballots
            const seenFailedKeys = new Set<string>();
            for (const f of failedQueue) {
              const k = `${f.event_id}:${f.judge_id}:${f.participant_id}`;
              seenFailedKeys.add(k);
              next[k] = {
                key: k,
                eventId: f.event_id,
                judgeId: f.judge_id,
                participantId: f.participant_id,
                scoreData: f.score_data || f.score_payload?.criteria || {},
                totalScore: f.total_score,
                reason: formatRejectionReason({ message: f.lastError || 'Server rejected ballot' }),
                payload: {
                  id: f.id,
                  event_id: f.event_id,
                  judge_id: f.judge_id,
                  participant_id: f.participant_id,
                  score_data: f.score_data || f.score_payload?.criteria || {},
                  total_score: f.total_score,
                  score_payload: f.score_payload,
                },
                failedQueueId: f.id,
              };
            }
            for (const [k, v] of Object.entries(next)) {
              if (v.failedQueueId && !seenFailedKeys.has(k)) {
                delete next[k];
              }
            }
            return next;
          });
        }
      } catch (err: any) {
        console.error('Error loading evaluation stage:', err);
        if (isMountedRef.current && reqId === loadRequestIdRef.current) {
          setReadError(err?.message || 'Showing cached stage data. Unable to reach server.');
        }
      } finally {
        if (isMountedRef.current && reqId === loadRequestIdRef.current) {
          setIsLoadingRoster(false);
          if (force) setIsRetryingRead(false);
        }
      }
    },
    [orgId, judge.id, clearAllTimers]
  );

  const handlePullRefresh = async () => {
    try {
      await flushOfflineQueueToSupabase();
    } catch (err) {
      console.warn('Pull-to-refresh queue flush note:', err);
    }
    await Promise.all([
      syncServerClockOffset(true)
        .then(() => {
          if (isMountedRef.current) setClockSyncVersion((v) => v + 1);
        })
        .catch(() => {}),
      loadData(true).catch(() => {}),
      Promise.resolve(refreshAnnouncements()).catch(() => {}),
    ]);
  };

  // Dedicated server clock synchronization
  useEffect(() => {
    syncServerClockOffset()
      .then(() => {
        if (isMountedRef.current) setClockSyncVersion((v) => v + 1);
      })
      .catch(() => {});
  }, [orgId, activeEvent.org_id]);

  useEffect(() => {
    loadData(false).catch(() => {});
    const unsubDb = subscribeToDatabase((table) => {
      if (
        matchesDbTable(
          table,
          DB_TABLES.ORGANIZATIONS,
          DB_TABLES.EVENTS,
          DB_TABLES.SCORES,
          DB_TABLES.PARTICIPANTS
        )
      ) {
        loadData(false).catch(() => {});
      }
    });
    const unsubQueue = subscribeToQueueChanges(() => {
      getPendingCount()
        .then((c) => {
          if (isMountedRef.current) setPendingQueueCount(c);
        })
        .catch(() => {});
      loadData(false).catch(() => {});
    });

    const handleOnline = () => {
      setIsOnline(true);
      syncServerClockOffset(true)
        .then(() => {
          if (isMountedRef.current) setClockSyncVersion((v) => v + 1);
        })
        .catch(() => {});
      if (readErrorRef.current) {
        loadData(true).catch(() => {});
      }
    };
    const handleOffline = () => setIsOnline(false);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && readErrorRef.current) {
        loadData(true).catch(() => {});
      }
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      unsubDb();
      unsubQueue();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [orgId, activeEvent.id, judge.id, loadData]);

  // -------------------------------------------------------------
  // JURY TERMINAL SETTINGS & SERVER-CLOCK GRACE PERIOD LOGIC
  // -------------------------------------------------------------
  const isBlindJudging = Boolean(organization?.blind_judging_enabled);
  const isAutoAdvance =
    organization?.auto_advance_enabled !== undefined ? Boolean(organization.auto_advance_enabled) : true;
  const isGracePeriod = Boolean(organization?.grace_period_enabled);
  const isIsolatedJury = Boolean(organization?.isolated_jury_enabled);

  // Schedule exact grace period expiry timer using server-offset-corrected clock
  useEffect(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }

    if (!existingScore || !isGracePeriod || viewMode !== 'scoring') {
      setGraceExpired(false);
      return;
    }

    const createdMs = new Date(existingScore.created_at).getTime();
    if (Number.isNaN(createdMs)) {
      setGraceExpired(true);
      return;
    }

    const evaluateWindow = () => {
      const remainingMs = GRACE_PERIOD_MS - (getServerNowMs() - createdMs);
      if (remainingMs <= 0) {
        setGraceExpired(true);
        setIsReviewSheetOpen(false);
        return true;
      }
      setGraceExpired(false);
      return false;
    };

    if (evaluateWindow()) return;

    const initialRemaining = GRACE_PERIOD_MS - (getServerNowMs() - createdMs);
    graceTimerRef.current = setTimeout(() => {
      if (!isMountedRef.current) return;
      setGraceExpired(true);
      setIsReviewSheetOpen(false);
      showToast('Grace period ended. Ballot sealed.', 'info');
    }, Math.max(50, initialRemaining));

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && isMountedRef.current) {
        if (evaluateWindow() && graceTimerRef.current) {
          clearTimeout(graceTimerRef.current);
          graceTimerRef.current = null;
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
    };
  }, [existingScore, isGracePeriod, viewMode]);

  const isWithinGracePeriod = Boolean(existingScore && isGracePeriod && !graceExpired);

  // Are sliders disabled?
  const areSlidersDisabled = useMemo(() => {
    if (!existingScore) return false;
    if (isGracePeriod && !graceExpired) return false;
    return true;
  }, [existingScore, isGracePeriod, graceExpired]);

  // Score Draft Engine: Key includes activeEvent.id, judge.id and participantId; v1; 24h TTL
  const getScoreDraftKey = useCallback(
    (participantId: string) => `fj_draft_score_${activeEvent.id}_${judge.id}_${participantId}`,
    [activeEvent.id, judge.id]
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

  // Debounced auto-save score draft (timer tracked in ref)
  useEffect(() => {
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    if (viewMode !== 'scoring' || !currentParticipant || !isDirtyRef.current) return;
    const participantId = currentParticipant.id;
    const expectedKey = getCompositeKey(participantId);
    if (scoresOwnerKeyRef.current !== expectedKey) return;

    const storageKey = getScoreDraftKey(participantId);
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      try {
        if (scoresOwnerKeyRef.current !== expectedKey) return;
        const hasAnyScore = Object.values(scoresMap).some((v) => v !== null && v !== undefined);
        if (hasAnyScore) {
          const draft = {
            version: 1,
            eventId: activeEvent.id,
            judgeId: judge.id,
            participantId,
            scoresMap,
            timestamp: Date.now(),
          };
          localStorage.setItem(storageKey, JSON.stringify(draft));
        }
      } catch {}
    }, 300);

    return () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
    };
  }, [scoresMap, viewMode, currentParticipant?.id, activeEvent.id, judge.id, getCompositeKey, getScoreDraftKey]);

  // Helper to clear sliders cleanly BEFORE switching or opening another participant
  const prepareParticipantForm = useCallback(
    (nextParticipantId: string | null) => {
      if (slideTimerRef.current) {
        clearTimeout(slideTimerRef.current);
        slideTimerRef.current = null;
      }
      if (beatTimerRef.current) {
        clearTimeout(beatTimerRef.current);
        beatTimerRef.current = null;
      }
      if (slideOutTimerRef.current) {
        clearTimeout(slideOutTimerRef.current);
        slideOutTimerRef.current = null;
      }
      isDirtyRef.current = false;
      setIsReviewSheetOpen(false);
      setIsSubmittedBeat(false);
      setIsCardSlidingOut(false);
      setExistingScore(null);
      setScoresMap(buildEmptyScoresMap(rubricList));
      const nextKey = nextParticipantId ? getCompositeKey(nextParticipantId) : null;
      activeCompositeKeyRef.current = nextKey;
      scoresOwnerKeyRef.current = nextKey;
    },
    [getCompositeKey, rubricList]
  );

  // Load participant score keyed by event + judge + participant with request ID guard
  useEffect(() => {
    if (viewMode !== 'scoring' || !currentParticipant) {
      activeCompositeKeyRef.current = null;
      return;
    }

    let isCancelled = false;
    const participantId = currentParticipant.id;
    const targetKey = getCompositeKey(participantId);
    const isKeyChanged = lastLoadedKeyRef.current !== targetKey;

    activeCompositeKeyRef.current = targetKey;
    const reqId = ++scoreLoadRequestIdRef.current;

    if (isKeyChanged) {
      isDirtyRef.current = false;
      scoresOwnerKeyRef.current = targetKey;
      lastLoadedKeyRef.current = targetKey;
      setExistingScore(null);
      setIsReviewSheetOpen(false);
      setIsSubmittedBeat(false);

      const unsaved = unsavedBallotsRef.current[targetKey];
      if (unsaved) {
        const restored: Record<string, number | null> = {};
        rubricList.forEach((c) => {
          restored[c.id] = unsaved.scoreData[c.id] ?? null;
        });
        setScoresMap(restored);
      } else {
        setScoresMap(buildEmptyScoresMap(rubricList));
      }
    }

    dbService
      .getScoreForJudgeParticipant(activeEvent.id, judge.id, participantId)
      .then((score) => {
        if (
          isCancelled ||
          !isMountedRef.current ||
          scoreLoadRequestIdRef.current !== reqId ||
          activeCompositeKeyRef.current !== targetKey ||
          viewModeRef.current !== 'scoring'
        ) {
          return;
        }

        // Preserve any unsaved/rejected ballot until judge clicks Retry or Discard
        const unsaved = unsavedBallotsRef.current[targetKey];
        if (unsaved) {
          setExistingScore(null);
          if (!isDirtyRef.current) {
            const restored: Record<string, number | null> = {};
            rubricList.forEach((c) => {
              restored[c.id] = unsaved.scoreData[c.id] ?? null;
            });
            setScoresMap(restored);
            scoresOwnerKeyRef.current = targetKey;
          }
          return;
        }

        setExistingScore(score);

        if (score) {
          if (isDirtyRef.current && scoresOwnerKeyRef.current === targetKey) {
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
          scoresOwnerKeyRef.current = targetKey;
        } else {
          if (!isKeyChanged && isDirtyRef.current && scoresOwnerKeyRef.current === targetKey) {
            return;
          }

          const isEventEditable = activeEvent.status !== 'ended' && activeEvent.status !== 'archived';
          const draft = isEventEditable ? loadScoreDraft(participantId) : null;
          if (draft) {
            setScoresMap(draft);
            isDirtyRef.current = isKeyChanged;
          } else {
            setScoresMap(buildEmptyScoresMap(rubricList));
            isDirtyRef.current = false;
          }
          scoresOwnerKeyRef.current = targetKey;
        }
      })
      .catch((err) => {
        if (
          isCancelled ||
          !isMountedRef.current ||
          scoreLoadRequestIdRef.current !== reqId ||
          activeCompositeKeyRef.current !== targetKey
        ) {
          return;
        }
        console.warn('Error loading participant ballot:', err);
      });

    return () => {
      isCancelled = true;
    };
  }, [
    viewMode,
    currentParticipant?.id,
    activeEvent.id,
    activeEvent.status,
    judge.id,
    getCompositeKey,
    loadScoreDraft,
    rubricList,
  ]);

  // Handle score changes with granular haptics
  const handleScoreChange = (criterionId: string, val: number) => {
    if (areSlidersDisabled || !currentParticipant) return;
    triggerHaptic('tick');
    isDirtyRef.current = true;
    scoresOwnerKeyRef.current = getCompositeKey(currentParticipant.id);
    setScoresMap((prev) => ({
      ...prev,
      [criterionId]: val,
    }));
  };

  // Participant Navigation with synchronous form clear & ref-tracked slide animation
  const handlePrev = () => {
    if (currentIndex <= 0) return;
    const prevP = participants[currentIndex - 1];
    prepareParticipantForm(prevP?.id || null);
    setSlideDirection('right');
    setCurrentIndex((i) => Math.max(0, i - 1));
    slideTimerRef.current = setTimeout(() => {
      slideTimerRef.current = null;
      if (isMountedRef.current) setSlideDirection('none');
    }, 250);
  };

  const handleNext = () => {
    if (currentIndex >= participants.length - 1) return;
    const nextP = participants[currentIndex + 1];
    prepareParticipantForm(nextP?.id || null);
    setSlideDirection('left');
    setCurrentIndex((i) => Math.min(participants.length - 1, i + 1));
    slideTimerRef.current = setTimeout(() => {
      slideTimerRef.current = null;
      if (isMountedRef.current) setSlideDirection('none');
    }, 250);
  };

  // Categorize participants into Upcoming vs Completed (never treat rejected/unsaved ballots as Completed)
  const completedList = participants.filter((p) => {
    const k = getCompositeKey(p.id);
    if (unsavedBallotsByKey[k]) return false;
    return allMyScores.some((s) => s.participant_id === p.id);
  });

  const upcomingList = participants.filter((p) => {
    const k = getCompositeKey(p.id);
    if (unsavedBallotsByKey[k]) return true;
    return !allMyScores.some((s) => s.participant_id === p.id);
  });

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
    prepareParticipantForm(participant.id);
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

  const currentCompositeKey = currentParticipant ? getCompositeKey(currentParticipant.id) : null;
  const currentUnsaved = currentCompositeKey ? unsavedBallotsByKey[currentCompositeKey] || null : null;

  const scheduleSuccessTransition = useCallback(
    (expectedKey: string, indexSnapshot: number) => {
      if (!isMountedRef.current) return;
      setIsSubmitting(false);
      setIsSubmittedBeat(true);

      if (beatTimerRef.current) clearTimeout(beatTimerRef.current);
      beatTimerRef.current = setTimeout(() => {
        beatTimerRef.current = null;
        if (!isMountedRef.current) return;
        setIsSubmittedBeat(false);
        setIsReviewSheetOpen(false);

        if (activeCompositeKeyRef.current !== expectedKey || viewModeRef.current !== 'scoring') {
          return;
        }

        if (isAutoAdvance) {
          setIsCardSlidingOut(true);

          if (slideOutTimerRef.current) clearTimeout(slideOutTimerRef.current);
          slideOutTimerRef.current = setTimeout(() => {
            slideOutTimerRef.current = null;
            if (!isMountedRef.current || viewModeRef.current !== 'scoring') return;

            const latestParticipants = participantsRef.current;
            if (indexSnapshot < latestParticipants.length - 1) {
              const nextP = latestParticipants[indexSnapshot + 1];
              prepareParticipantForm(nextP?.id || null);
              setCurrentIndex(indexSnapshot + 1);
              setSlideDirection('left');
              slideTimerRef.current = setTimeout(() => {
                slideTimerRef.current = null;
                if (isMountedRef.current) setSlideDirection('none');
              }, 250);
            } else {
              handleExitToList();
            }
          }, 250);
        }
      }, 600);
    },
    [isAutoAdvance, prepareParticipantForm, handleExitToList]
  );

  // =============================================================
  // PART 3: ASYNC SUBMIT & "THE BEAT" + REJECTED BALLOT PROTECTION
  // =============================================================
  const handleOpenReview = () => {
    if (!currentParticipant || !isAllScored || isSubmitting || isSubmittedBeat || areSlidersDisabled) return;
    triggerHaptic('tap');
    setIsReviewSheetOpen(true);
  };

  const handleConfirmLockScore = async (retryBallot?: UnsavedBallotState) => {
    if (isSubmitting || isSubmittedBeat) return;
    if (!retryBallot && (!currentParticipant || !isAllScored || areSlidersDisabled)) return;

    triggerHaptic('submit');
    setIsSubmitting(true);

    const targetEvent = activeEventRef.current;
    const participantId = retryBallot ? retryBallot.participantId : currentParticipant!.id;
    const targetKey = retryBallot ? retryBallot.key : getCompositeKey(participantId, targetEvent.id, judge.id);
    const indexSnapshot = participantsRef.current.findIndex((p) => p.id === participantId);

    const isOpenParticipant =
      viewModeRef.current === 'scoring' &&
      activeCompositeKeyRef.current === targetKey &&
      isAllScored;

    const sanitizedData: Record<string, number> =
      retryBallot && (!isOpenParticipant || !isDirtyRef.current)
        ? { ...retryBallot.scoreData }
        : (() => {
            const d: Record<string, number> = {};
            rubricList.forEach((c) => {
              d[c.id] = scoresMap[c.id] || 0;
            });
            return d;
          })();

    const totalToSubmit =
      retryBallot && (!isOpenParticipant || !isDirtyRef.current) ? retryBallot.totalScore : currentTotal;
    const ballotUuid =
      retryBallot?.payload.id ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `score_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`);

    const submittedIso = new Date(getServerNowMs()).toISOString();
    const payload =
      retryBallot && (!isOpenParticipant || !isDirtyRef.current)
        ? retryBallot.payload
        : {
            id: ballotUuid,
            event_id: targetEvent.id,
            judge_id: judge.id,
            participant_id: participantId,
            score_data: sanitizedData,
            total_score: totalToSubmit,
            score_payload: {
              criteria: sanitizedData,
              total_score: totalToSubmit,
              submitted_at: submittedIso,
            },
          };

    try {
      // Check latest event status (prefer fresh online copy when reachable)
      const freshEvent =
        typeof navigator === 'undefined' || navigator.onLine
          ? (await dbService.getEventById(targetEvent.id).catch(() => null)) || targetEvent
          : targetEvent;

      if (freshEvent.status !== 'active') {
        const statusMsg =
          freshEvent.status === 'ended' || freshEvent.status === 'archived'
            ? 'Event has ended. Ballot submission rejected.'
            : freshEvent.status === 'paused'
            ? 'Event is paused. Ballot submission rejected.'
            : `Event is ${freshEvent.status}. Ballot submission rejected.`;
        throw new Error(statusMsg);
      }

      if (
        existingScore &&
        activeCompositeKeyRef.current === targetKey &&
        (!isGracePeriod || getServerNowMs() - new Date(existingScore.created_at).getTime() > GRACE_PERIOD_MS)
      ) {
        throw new Error('Grace period expired. Ballot is sealed.');
      }

      let committed: SupabaseScore;
      let queuedOffline = false;

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await queueScoreLocally(payload);
        queuedOffline = true;
        committed = {
          ...payload,
          id: ballotUuid,
          created_at: submittedIso,
        };
      } else {
        committed = await dbService.submitScore(payload);
      }

      if (!isMountedRef.current) return;

      // Clear any previous rejected state or failed IndexedDB entry
      if (retryBallot?.failedQueueId) {
        await discardFailedScore(retryBallot.failedQueueId).catch(() => {});
      }
      setUnsavedBallotsByKey((prev) => {
        if (!prev[targetKey]) return prev;
        const next = { ...prev };
        delete next[targetKey];
        return next;
      });

      setAllMyScores((prev) => {
        const without = prev.filter((s) => s.participant_id !== participantId);
        return [...without, committed];
      });
      if (queuedOffline) {
        setPendingParticipantIds((prev) => {
          const next = new Set(prev);
          next.add(participantId);
          return next;
        });
      }

      clearScoreDraft(participantId);
      isDirtyRef.current = false;

      if (activeCompositeKeyRef.current === targetKey) {
        setExistingScore(committed);
      }

      if (viewModeRef.current === 'scoring' && activeCompositeKeyRef.current === targetKey) {
        scheduleSuccessTransition(targetKey, indexSnapshot);
      } else {
        setIsSubmitting(false);
        showToast('Ballot saved successfully.', 'success');
      }
    } catch (err: any) {
      if (!isMountedRef.current) return;

      if (isOfflineNetworkError(err)) {
        try {
          await queueScoreLocally(payload);
          const offlineCommit: SupabaseScore = {
            ...payload,
            id: ballotUuid,
            created_at: submittedIso,
          };

          if (retryBallot?.failedQueueId) {
            await discardFailedScore(retryBallot.failedQueueId).catch(() => {});
          }
          setUnsavedBallotsByKey((prev) => {
            if (!prev[targetKey]) return prev;
            const next = { ...prev };
            delete next[targetKey];
            return next;
          });
          setAllMyScores((prev) => {
            const without = prev.filter((s) => s.participant_id !== participantId);
            return [...without, offlineCommit];
          });
          setPendingParticipantIds((prev) => {
            const next = new Set(prev);
            next.add(participantId);
            return next;
          });
          clearScoreDraft(participantId);
          isDirtyRef.current = false;

          if (activeCompositeKeyRef.current === targetKey) {
            setExistingScore(offlineCommit);
            scheduleSuccessTransition(targetKey, indexSnapshot);
          } else {
            setIsSubmitting(false);
            showToast('Ballot queued offline.', 'info');
          }
          return;
        } catch (queueErr) {
          console.error('Failed to queue score locally:', queueErr);
        }
      }

      // Server/validation rejection: NEVER show "Locked". Preserve ballot and show "Not saved: [reason]" with Retry / Discard.
      const reason = formatRejectionReason(err);
      setIsSubmitting(false);
      setIsSubmittedBeat(false);

      setUnsavedBallotsByKey((prev) => ({
        ...prev,
        [targetKey]: {
          key: targetKey,
          eventId: targetEvent.id,
          judgeId: judge.id,
          participantId,
          scoreData: sanitizedData,
          totalScore: totalToSubmit,
          reason,
          payload,
          failedQueueId: retryBallot?.failedQueueId,
        },
      }));
      showToast(`Not saved: ${reason}`, 'error');
    }
  };

  const handleDiscardUnsaved = async (unsaved: UnsavedBallotState) => {
    if (unsaved.failedQueueId) {
      await discardFailedScore(unsaved.failedQueueId).catch(() => {});
    }
    clearScoreDraft(unsaved.participantId);
    setUnsavedBallotsByKey((prev) => {
      const next = { ...prev };
      delete next[unsaved.key];
      return next;
    });

    if (activeCompositeKeyRef.current === unsaved.key) {
      isDirtyRef.current = false;
      setIsReviewSheetOpen(false);
      const serverScore = await dbService
        .getScoreForJudgeParticipant(unsaved.eventId, unsaved.judgeId, unsaved.participantId)
        .catch(() => null);
      if (isMountedRef.current && activeCompositeKeyRef.current === unsaved.key) {
        setExistingScore(serverScore);
        if (serverScore) {
          const filled: Record<string, number | null> = {};
          rubricList.forEach((c) => {
            filled[c.id] =
              serverScore.score_data && serverScore.score_data[c.id] !== undefined
                ? serverScore.score_data[c.id]
                : serverScore.score_payload?.criteria?.[c.id] ?? 0;
          });
          setScoresMap(filled);
        } else {
          setScoresMap(buildEmptyScoresMap(rubricList));
        }
      }
    }
    showToast('Unsaved ballot discarded.', 'info');
  };

  // =============================================================
  // VIEW 1: PARTICIPANT ROSTER VIEW (Fixed Viewport App-Shell)
  // =============================================================
  if (viewMode === 'list') {
    return (
      <div className="h-[100dvh] overflow-hidden w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col max-w-lg mx-auto relative select-none">
        {/* Permanently Pinned Top Header */}
        <header className="shrink-0 z-50 w-full bg-stone-50 dark:bg-black border-b border-stone-200 dark:border-zinc-800/80 px-4 py-3 shadow-xs">
          <div className="flex items-center justify-between gap-2">
            <button
              onClick={handleBackNavigation}
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
                <span>{activeEvent.category || 'Official Competition'}</span>
              </span>
              <h1 className="text-base sm:text-lg font-black text-zinc-900 dark:text-white mt-0.5 truncate">
                {activeEvent.name}
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

        <AnnouncementBanner notices={bannerNotices} onDismiss={dismissBanner} />

        {/* Scrollable Content Area */}
        <PullToRefresh onRefresh={handlePullRefresh} accentColor="amber" className="flex-1 overflow-hidden flex flex-col">
          <main className="flex-1 overflow-y-auto px-4 pt-4 pb-40 space-y-5">
            {readError && (
              <ReadRetryBanner
                message={readError}
                isRetrying={isRetryingRead}
                onRetry={() => {
                  loadData(true).catch(() => {});
                }}
              />
            )}

            {/* Smart Search Bar */}
            <div className="relative">
              <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-3.5" />
              <input
                type="text"
                placeholder={isBlindJudging ? 'Search by Sl. No. or ID...' : 'Search by Sl. No., Name, or School...'}
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

                {isLoadingRoster ? (
                  <div className="space-y-3">
                    <div className="flex items-center space-x-2 px-1">
                      <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse motion-reduce:animate-none shrink-0" />
                      <span className="text-xs font-mono font-bold tracking-widest text-amber-500 uppercase animate-pulse motion-reduce:animate-none">
                        Syncing Stage...
                      </span>
                    </div>
                    <div className="space-y-2.5">
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
                      : 'All assigned competitors have been evaluated!'}
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {filteredUpcoming.map((p, idx) => {
                      const assignedIds = activeEvent.assigned_participants || [];
                      const orderIdx = assignedIds.indexOf(p.id);
                      const participantSerial =
                        activeEvent.participant_sl_numbers?.[p.id] ||
                        (orderIdx !== -1 ? String(orderIdx + 1).padStart(2, '0') : p.sl_no);
                      const unsaved = unsavedBallotsByKey[getCompositeKey(p.id)];

                      return (
                        <div
                          key={p.id}
                          style={{ animationDelay: `${Math.min(idx, 8) * 50}ms` }}
                          onClick={() => handleOpenParticipant(p)}
                          className={`p-4 bg-white dark:bg-zinc-900 border rounded-2xl shadow-sm cursor-pointer group active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform animate-in fade-in slide-in-from-bottom-2 duration-200 fill-mode-both motion-reduce:animate-none ${
                            unsaved
                              ? 'border-red-500/40 dark:border-red-500/40'
                              : 'border-stone-200 dark:border-zinc-800 hover:border-amber-500/50 hover:bg-stone-50 dark:hover:bg-zinc-800'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center space-x-3.5 min-w-0 mr-3">
                              <div className="w-11 h-11 rounded-2xl bg-amber-500/10 text-amber-500 dark:text-amber-400 border border-amber-500/20 font-mono font-black text-sm flex items-center justify-center shrink-0 group-hover:scale-105 transition-transform motion-reduce:transition-none shadow-xs">
                                {participantSerial}
                              </div>
                              <div className="min-w-0">
                                {isBlindJudging ? (
                                  <h3 className="text-base sm:text-lg font-black text-zinc-900 dark:text-white truncate">
                                    Participant {p.identity_id || `P-${p.id.slice(0, 4)}`}
                                  </h3>
                                ) : (
                                  <>
                                    <h3 className="text-sm font-extrabold text-zinc-900 dark:text-white truncate group-hover:text-amber-500">
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
                                className="px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-extrabold text-xs tracking-wide shadow-md shadow-amber-500/20 active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform flex items-center space-x-1.5 cursor-pointer"
                              >
                                <span>{unsaved ? 'Review' : 'Score'}</span>
                                <ChevronRight className="w-4 h-4 stroke-[2.5]" />
                              </button>
                            </div>
                          </div>

                          {unsaved && (
                            <div
                              onClick={(e) => e.stopPropagation()}
                              className="mt-3 pt-2.5 border-t border-red-500/20 flex items-center justify-between gap-2 text-xs"
                            >
                              <div className="min-w-0 flex items-center gap-1.5 text-red-600 dark:text-red-400 font-semibold">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                <span className="truncate">Not saved: {unsaved.reason}</span>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                  type="button"
                                  disabled={isSubmitting}
                                  onClick={() => handleConfirmLockScore(unsaved)}
                                  className="px-2.5 py-1.5 min-h-[36px] rounded-lg bg-amber-500 hover:bg-amber-400 text-black font-bold text-[11px] cursor-pointer active:scale-95 transition-transform motion-reduce:transition-none"
                                >
                                  Retry
                                </button>
                                <button
                                  type="button"
                                  disabled={isSubmitting}
                                  onClick={() => handleDiscardUnsaved(unsaved)}
                                  className="px-2.5 py-1.5 min-h-[36px] rounded-lg bg-stone-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-stone-200 dark:border-zinc-700 font-bold text-[11px] cursor-pointer active:scale-95 transition-transform motion-reduce:transition-none"
                                >
                                  Discard
                                </button>
                              </div>
                            </div>
                          )}
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
                      const isPendingSync = pendingParticipantIds.has(p.id);
                      const assignedIds = activeEvent.assigned_participants || [];
                      const orderIdx = assignedIds.indexOf(p.id);
                      const participantSerial =
                        activeEvent.participant_sl_numbers?.[p.id] ||
                        (orderIdx !== -1 ? String(orderIdx + 1).padStart(2, '0') : p.sl_no);
                      return (
                        <div
                          key={p.id}
                          style={{ animationDelay: `${Math.min(idx, 8) * 50}ms` }}
                          onClick={() => handleOpenParticipant(p)}
                          className="p-3.5 sm:p-4 bg-stone-100/80 dark:bg-zinc-900/50 border border-stone-200 dark:border-zinc-800 rounded-2xl flex items-center justify-between gap-3 opacity-90 hover:opacity-100 cursor-pointer active:scale-95 transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none will-change-transform shadow-xs animate-in fade-in slide-in-from-bottom-2 duration-200 fill-mode-both motion-reduce:animate-none"
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
                                    {isPendingSync ? 'Saved offline — queued for sync' : p.school}
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
                            <div className="w-8 h-8 rounded-xl bg-stone-200/80 dark:bg-zinc-800 flex items-center justify-center text-zinc-500 hover:text-zinc-800 dark:hover:text-white">
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
    <div className="h-[100dvh] overflow-hidden w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col justify-start max-w-lg mx-auto relative select-none">
      {/* PART 5.1: THE PINNED TOP HEADER + COMPETITOR BANNER */}
      <header className="shrink-0 z-50 w-full bg-stone-50 dark:bg-black border-b border-stone-200 dark:border-zinc-800/80 px-4 h-16 flex justify-between items-center shadow-xs">
        {/* Left: [ <- Back ] Heavy Contrast Secondary Button */}
        <button
          onClick={handleExitToList}
          className="bg-zinc-900 dark:bg-white text-white dark:text-black font-bold text-sm md:text-base px-5 min-h-[48px] rounded-xl shadow-md active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform flex items-center justify-center gap-2 cursor-pointer shrink-0"
          title="Return to Competitor Roster"
        >
          <ChevronLeft className="w-5 h-5 stroke-[2.5]" />
          <span>Back</span>
        </button>

        <div className="flex-1" />

        {/* Right: Sealed or Submit/Update */}
        <div>
          {!currentParticipant ? null : existingScore && !isWithinGracePeriod ? (
            <div className="flex items-center space-x-2 text-base font-black text-amber-500 dark:text-amber-400 bg-amber-500/10 px-6 min-h-[48px] rounded-xl border border-amber-500/20 tracking-wide">
              <Lock className="w-4 h-4 stroke-[2.5]" />
              <span>Sealed</span>
            </div>
          ) : (
            <button
              onClick={handleOpenReview}
              disabled={!isAllScored || isSubmitting || isSubmittedBeat || areSlidersDisabled}
              className={`px-6 min-h-[48px] rounded-xl font-black text-base shadow-lg shadow-amber-500/20 active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform flex items-center justify-center gap-2 tracking-wide ${
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
      {currentParticipant &&
        (() => {
          const assignedIds = activeEvent.assigned_participants || [];
          const orderIdx = assignedIds.indexOf(currentParticipant.id);
          const currentSerial =
            activeEvent.participant_sl_numbers?.[currentParticipant.id] ||
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
                  <Clock className="w-3 h-3 animate-pulse motion-reduce:animate-none" />
                </div>
              )}
            </div>
          );
        })()}

      {/* SCROLLABLE CRITERIA SLIDERS CONTAINER */}
      <PullToRefresh onRefresh={handlePullRefresh} accentColor="amber" className="w-full flex-1 overflow-hidden flex flex-col">
        <main
          className={`w-full flex-1 overflow-y-auto px-4 py-4 space-y-3 pb-[140px] relative z-10 transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none will-change-transform ${
            isCardSlidingOut
              ? '-translate-x-full opacity-0'
              : slideDirection === 'left'
              ? 'translate-x-0 opacity-100 animate-in slide-in-from-right duration-250 motion-reduce:animate-none'
              : slideDirection === 'right'
              ? 'translate-x-0 opacity-100 animate-in slide-in-from-left duration-250 motion-reduce:animate-none'
              : 'translate-x-0 opacity-100'
          }`}
        >
          {readError && (
            <ReadRetryBanner
              message={readError}
              isRetrying={isRetryingRead}
              onRetry={() => {
                loadData(true).catch(() => {});
              }}
            />
          )}

          {!currentParticipant ? (
            <div className="p-6 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl text-center space-y-3 shadow-sm">
              <p className="text-sm font-bold text-zinc-900 dark:text-white">
                Competitor not available
              </p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                The assigned competitor list changed or is empty. Return to the event list to select a competitor.
              </p>
              <button
                type="button"
                onClick={handleExitToList}
                className="px-4 min-h-[44px] rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs cursor-pointer active:scale-95 transition-transform duration-75 motion-reduce:transition-none"
              >
                Back to List
              </button>
            </div>
          ) : (
            <>
              {/* Rejected / Unsaved Ballot Banner (Never shown as Locked) */}
              {currentUnsaved && (
                <div className="p-3.5 bg-red-500/10 border border-red-500/35 rounded-2xl space-y-2.5 text-xs shadow-sm">
                  <div className="flex items-start gap-2.5 text-red-700 dark:text-red-300 font-bold">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
                    <span className="leading-snug">Not saved: {currentUnsaved.reason}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => handleConfirmLockScore(currentUnsaved)}
                      className="flex-1 min-h-[44px] px-3 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-extrabold text-xs cursor-pointer active:scale-95 transition-transform duration-75 motion-reduce:transition-none flex items-center justify-center gap-1.5"
                    >
                      {isSubmitting ? (
                        <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />
                      ) : (
                        <RotateCcw className="w-3.5 h-3.5 stroke-[2.5]" />
                      )}
                      <span>Retry</span>
                    </button>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => handleDiscardUnsaved(currentUnsaved)}
                      className="flex-1 min-h-[44px] px-3 rounded-xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 font-extrabold text-xs cursor-pointer active:scale-95 transition-transform duration-75 motion-reduce:transition-none flex items-center justify-center gap-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Discard</span>
                    </button>
                  </div>
                </div>
              )}

              {existingScore && !isWithinGracePeriod && (
                <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl flex items-center justify-between text-xs text-amber-500 dark:text-amber-400 font-semibold shadow-sm">
                  <div className="flex items-center space-x-2">
                    <Lock className="w-4 h-4 shrink-0 text-amber-500" />
                    <span>Ballot sealed in audit ledger (Read-Only).</span>
                  </div>
                  <button
                    onClick={handleExitToList}
                    className="px-2.5 py-1 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-black text-[11px] shadow-sm shrink-0 cursor-pointer active:scale-[0.97] transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform"
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
                      className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-3 px-4 shadow-sm flex flex-col justify-center"
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
                          <span className="text-[10px] text-zinc-400 font-mono block mt-0.5">
                            Max: {max} pts
                          </span>
                        </div>

                        <div className="font-mono text-right shrink-0 pl-2">
                          {isScored ? (
                            <span className="text-2xl sm:text-3xl font-black text-amber-500 dark:text-amber-400 tracking-tight tabular-nums whitespace-nowrap">
                              <span
                                key={currentVal}
                                className="inline-block animate-in fade-in slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
                              >
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
                          <button
                            type="button"
                            onClick={() => handleScoreChange(crit.id, Math.max(0, activeVal - 1))}
                            disabled={areSlidersDisabled || activeVal <= 0}
                            className="w-11 h-11 shrink-0 bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 rounded-xl active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform disabled:opacity-30 border border-stone-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 font-bold flex items-center justify-center cursor-pointer shadow-sm"
                            title="Decrease mark by 1"
                            aria-label="Decrease score"
                          >
                            <Minus className="w-5 h-5 stroke-[2.5]" />
                          </button>

                          {/* Fluid Compact Slider Container */}
                          <div className="relative flex-1 flex items-center h-9">
                            <div className="w-full h-2 rounded-full bg-stone-200 dark:bg-zinc-800 relative overflow-hidden pointer-events-none shadow-inner">
                              <div
                                className="h-full w-full origin-left rounded-full bg-gradient-to-r from-amber-500 via-amber-400 to-yellow-300 transition-transform duration-75 motion-reduce:transition-none shadow-sm"
                                style={{ transform: `scaleX(${percentFilled / 100})` }}
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
                              className="absolute top-1/2 -translate-y-1/2 pointer-events-none"
                              style={{
                                left: `calc(${percentFilled}% - ${percentFilled * 0.28}px)`,
                              }}
                            >
                              <div className="w-7 h-7 rounded-full bg-white dark:bg-zinc-100 border-2 border-amber-500 shadow-md shadow-amber-500/40 ring-4 ring-amber-500/20 flex items-center justify-center">
                                <div className="w-2.5 h-2.5 rounded-full bg-amber-500" />
                              </div>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleScoreChange(crit.id, Math.min(max, activeVal + 1))}
                            disabled={areSlidersDisabled || activeVal >= max}
                            className="w-11 h-11 shrink-0 bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 rounded-xl active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform disabled:opacity-30 border border-stone-200 dark:border-zinc-700 text-zinc-800 dark:text-zinc-200 font-bold flex items-center justify-center cursor-pointer shadow-sm"
                            title="Increase mark by 1"
                            aria-label="Increase score"
                          >
                            <Plus className="w-5 h-5 stroke-[2.5]" />
                          </button>
                        </div>

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
            </>
          )}
        </main>
      </PullToRefresh>

      {/* PART 5.2: THE STICKY GAMEPAD FOOTER (Solid theme surface, zero backdrop-filter) */}
      <footer className="fixed bottom-0 left-0 w-full h-[12dvh] min-h-[80px] bg-white dark:bg-zinc-950 border-t border-stone-200 dark:border-zinc-800 z-50 flex items-center justify-between px-6 select-none shadow-2xl">
        <button
          onClick={handlePrev}
          disabled={!currentParticipant || currentIndex === 0}
          className="w-12 h-12 rounded-full bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 disabled:opacity-25 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-800 dark:text-zinc-200 active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform cursor-pointer shadow-sm shrink-0"
          title="Previous Competitor"
          aria-label="Previous Competitor"
        >
          <ChevronLeft className="w-6 h-6 stroke-[2.5]" />
        </button>

        <div className="text-center font-mono flex flex-col items-center justify-center min-w-0 px-2">
          <div className="text-2xl sm:text-3xl font-black text-zinc-900 dark:text-white tracking-tight leading-none tabular-nums whitespace-nowrap">
            <span
              key={currentTotal}
              className="text-amber-500 dark:text-amber-400 tabular-nums whitespace-nowrap inline-block animate-in fade-in slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
            >
              {currentTotal}
            </span>
            <span className="text-zinc-400 text-sm font-normal"> / {maxPossible}</span>
            <span className="text-xs font-normal text-zinc-400 ml-1">pts</span>
          </div>
          <span className="text-[10px] font-mono text-zinc-400 uppercase tracking-widest mt-1 font-bold">
            Total Composite
          </span>
        </div>

        <button
          onClick={handleNext}
          disabled={!currentParticipant || currentIndex >= participants.length - 1}
          className="w-12 h-12 rounded-full bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 disabled:opacity-25 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-800 dark:text-zinc-200 active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform cursor-pointer shadow-sm shrink-0"
          title="Next Competitor"
          aria-label="Next Competitor"
        >
          <ChevronRight className="w-6 h-6 stroke-[2.5]" />
        </button>
      </footer>

      {/* REVIEW BOTTOM SHEET */}
      {isReviewSheetOpen && currentParticipant && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 transition-opacity duration-200 motion-reduce:transition-none animate-in fade-in motion-reduce:animate-none">
          <div
            className="w-full max-w-lg bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-t-3xl shadow-2xl p-5 flex flex-col max-h-[85vh] animate-sheet-slide-up motion-reduce:animate-none will-change-transform"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-1.5 rounded-full bg-zinc-300 dark:bg-zinc-700 mx-auto mb-4 shrink-0" />

            <div className="flex items-center justify-between pb-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
              <div className="flex items-center space-x-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center font-mono font-black text-sm text-amber-500 dark:text-amber-400 shrink-0">
                  {(() => {
                    const assignedIds = activeEvent.assigned_participants || [];
                    const orderIdx = assignedIds.indexOf(currentParticipant.id);
                    return (
                      activeEvent.participant_sl_numbers?.[currentParticipant.id] ||
                      (orderIdx !== -1 ? String(orderIdx + 1).padStart(2, '0') : String(currentIndex + 1).padStart(2, '0'))
                    );
                  })()}
                </div>
                <div className="min-w-0">
                  <h3 className="text-sm font-black text-zinc-900 dark:text-white truncate">
                    {isBlindJudging
                      ? `Participant ${currentParticipant.identity_id || `P-${currentParticipant.id.slice(0, 4)}`}`
                      : currentParticipant.name}
                  </h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate">
                    {isBlindJudging ? 'Blind Evaluation' : currentParticipant.school}
                  </p>
                </div>
              </div>

              <button
                type="button"
                disabled={isSubmitting || isSubmittedBeat}
                onClick={() => setIsReviewSheetOpen(false)}
                className="p-2 rounded-xl text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-30 cursor-pointer"
                title="Cancel"
                aria-label="Cancel"
              >
                <X className="w-5 h-5 stroke-[2.5]" />
              </button>
            </div>

            {currentUnsaved && (
              <div className="mt-3 p-3 rounded-2xl bg-red-500/10 border border-red-500/35 text-xs text-red-700 dark:text-red-300 font-bold flex items-start gap-2 shrink-0">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-600 dark:text-red-400" />
                <span>Not saved: {currentUnsaved.reason}</span>
              </div>
            )}

            <div className="py-4 my-2 text-center bg-zinc-50 dark:bg-zinc-900 rounded-2xl border border-zinc-200 dark:border-zinc-800 shrink-0">
              <span className="text-xs font-mono uppercase tracking-widest text-zinc-400 font-bold block mb-1">
                Final Score Review
              </span>
              <div className="text-3xl font-black text-zinc-900 dark:text-white tabular-nums whitespace-nowrap">
                <span className="text-amber-500 dark:text-amber-400 font-mono text-3xl font-black">
                  {currentTotal}
                </span>
                <span className="text-zinc-400 text-base font-normal"> / {maxPossible}</span>
                <span className="text-xs font-normal text-zinc-400 ml-1">pts</span>
              </div>
            </div>

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

            {/* Actions: When rejected, show Retry & Discard; otherwise Review & Lock Score */}
            <div className="pt-3 border-t border-zinc-200 dark:border-zinc-800 flex items-center gap-3 shrink-0">
              {currentUnsaved && !isSubmittedBeat ? (
                <>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => handleDiscardUnsaved(currentUnsaved)}
                    className="flex-1 py-3.5 px-4 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 font-extrabold text-sm hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-40 cursor-pointer active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform flex items-center justify-center gap-2"
                  >
                    <Trash2 className="w-4 h-4 shrink-0" />
                    <span>Discard</span>
                  </button>
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => handleConfirmLockScore(currentUnsaved)}
                    className="flex-1 py-3.5 px-4 rounded-xl font-extrabold text-sm flex items-center justify-center gap-2 active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform cursor-pointer bg-amber-500 hover:bg-amber-400 text-black shadow-lg shadow-amber-500/25 disabled:opacity-50"
                  >
                    {isSubmitting ? (
                      <Loader2 className="w-5 h-5 animate-spin motion-reduce:animate-none shrink-0 stroke-[2.5]" />
                    ) : (
                      <>
                        <RotateCcw className="w-4 h-4 stroke-[2.5] shrink-0" />
                        <span>Retry</span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={isSubmitting || isSubmittedBeat}
                    onClick={() => setIsReviewSheetOpen(false)}
                    className="flex-1 py-3.5 px-4 rounded-xl border border-zinc-300 dark:border-zinc-700 bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 font-extrabold text-sm hover:bg-zinc-200 dark:hover:bg-zinc-800 disabled:opacity-40 cursor-pointer active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform"
                  >
                    Review
                  </button>

                  <button
                    type="button"
                    disabled={isSubmitting || isSubmittedBeat}
                    onClick={() => handleConfirmLockScore()}
                    className={`flex-1 py-3.5 px-4 rounded-xl font-extrabold text-sm flex items-center justify-center gap-2 active:scale-95 transition-transform duration-75 ease-out motion-reduce:transition-none will-change-transform cursor-pointer ${
                      isSubmittedBeat
                        ? 'bg-amber-500/20 text-amber-500 border border-amber-500/30'
                        : 'bg-amber-500 hover:bg-amber-400 text-black shadow-lg shadow-amber-500/25'
                    }`}
                  >
                    {isSubmitting ? (
                      <Loader2 className="w-5 h-5 animate-spin motion-reduce:animate-none shrink-0 stroke-[2.5]" />
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
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
