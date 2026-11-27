import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Lock,
  RefreshCw,
  RotateCcw,
  Scale,
  Send,
  ShieldAlert,
  X,
} from 'lucide-react';
import { TaskScreen } from '../common/TaskScreen';
import { showToast } from '../common/ToastProvider';
import { triggerHaptic } from '../../lib/haptics';
import { eventBus } from '../../lib/eventBus';
import { getStoredSessionToken, supabase } from '../../lib/supabase';
import {
  computeCountbackPreview,
  computeOlympicPreview,
  computeRecompetePreview,
  computeSharedPreview,
  detectTiedGroups,
  getTieMethodRecommendations,
  type DetectedTiedGroup,
  type TieMethodOption,
  type TieMethodPreview,
} from '../../lib/tieDecisionEngine';
import type {
  OrgTieRule,
  Organization,
  SupabaseEvent,
  SupabaseParticipant,
  SupabaseScore,
  TieAuditAction,
  TieAuditEntry,
  TieRound,
  TieRoundPlacement,
} from '../../lib/supabaseTypes';
import type {
  OrganiserLiveTieGroup,
  OrganiserStaleRoundRef,
} from './TieStatusChip';

export interface RemainingTieGroupItem {
  group_key: string;
  tied_rank: number;
  tied_participant_ids: string[];
}

export interface TieManagerScreenProps {
  event: SupabaseEvent | null;
  organization: Organization;
  eventParticipants: SupabaseParticipant[];
  eventScores: SupabaseScore[];
  assignedJudgesCount: number;
  getParticipantDisplayName: (participant: SupabaseParticipant, event?: SupabaseEvent) => string;
  onClose: () => void;
  onTieDataChanged?: () => void;
}

interface OrganiserTieListResponse {
  ok: boolean;
  rounds?: TieRound[];
  live_tie_groups?: OrganiserLiveTieGroup[];
  stale_rounds?: OrganiserStaleRoundRef[];
}

interface TieAuditListResponse {
  ok: boolean;
  entries?: TieAuditEntry[];
}

interface TiePublishLikeResponse {
  ok: boolean;
  round?: TieRound;
  event_closed?: boolean;
  remaining_groups?: RemainingTieGroupItem[];
  pending_round_count?: number;
}

interface TieRoundMutationResponse {
  ok: boolean;
  round?: TieRound;
}

interface TieRpcError extends Error {
  code?: string;
}

const TIE_ERROR_MESSAGES: Record<string, string> = {
  unauthorized: 'Your organiser session has expired. Please sign in again.',
  not_found: 'This event or tie round could not be found.',
  invalid_input: 'Some tie details were invalid. Please refresh and try again.',
  event_ended: 'This event has already ended. Tie actions are locked.',
  event_already_ended: 'This event has already ended.',
  stale_round_present:
    'Scores changed since an earlier tie round started. Close the stale round before publishing or closing.',
  open_tie_round_exists:
    'A re-compete round is already open for this event. Close it before opening another.',
  closed_round_unpublished:
    'A closed tie round is waiting to be published before closing this event.',
  participant_in_open_round:
    'One or more tied participants are already in another open re-compete round.',
  tie_not_found: 'This tie no longer exists in the latest sealed scores. Refresh to update.',
  round_not_open: 'Only an open re-compete round can be closed.',
  round_not_closed: 'Close the re-compete round first so all grades are locked before publishing.',
  invalid_reason: 'Please enter a reason between 3 and 300 characters.',
  invalid_state: 'This action is not available for the round in its current state.',
  rpc_unavailable: 'Tie management service is unavailable right now. Please try again shortly.',
};

function looksLikeRawCode(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length === 0 || /^[a-z0-9_:-]+$/i.test(trimmed);
}

function formatTieRpcError(code?: string, serverMessage?: string): string {
  const key = String(code || '').trim().toLowerCase();
  if (key && TIE_ERROR_MESSAGES[key]) {
    return TIE_ERROR_MESSAGES[key];
  }
  const cleanMsg = String(serverMessage || '').trim();
  if (cleanMsg && !looksLikeRawCode(cleanMsg)) {
    return cleanMsg;
  }
  return 'Could not complete this tie action. Please refresh and try again.';
}

async function callTieRpc<T extends { ok?: boolean }>(
  rpcName: string,
  params: Record<string, unknown>
): Promise<T> {
  const token = (getStoredSessionToken() || '').trim();
  if (!token) {
    eventBus.emit('session_expired', { role: 'organiser', reason: 'missing' });
    const err: TieRpcError = new Error(TIE_ERROR_MESSAGES.unauthorized);
    err.code = 'unauthorized';
    throw err;
  }

  const { data, error } = await supabase.rpc(rpcName, {
    p_token: token,
    ...params,
  });

  if (error) {
    const rawMsg = (error.message || '').toLowerCase();
    const isMissingRpc =
      error.code === 'PGRST202' ||
      error.code === '42883' ||
      rawMsg.includes(`function public.${rpcName}`);
    const errCode = isMissingRpc ? 'rpc_unavailable' : 'network_error';
    const err: TieRpcError = new Error(formatTieRpcError(errCode, isMissingRpc ? '' : error.message));
    err.code = errCode;
    throw err;
  }

  const res = data as (T & { error?: string; message?: string }) | null;
  if (!res || !res.ok) {
    const errCode = String(res?.error || 'invalid_state');
    if (errCode === 'unauthorized') {
      eventBus.emit('session_expired', { role: 'organiser', reason: 'expired' });
    }
    const err: TieRpcError = new Error(formatTieRpcError(errCode, res?.message));
    err.code = errCode;
    throw err;
  }

  return res;
}

function formatRuleLabel(rule: TieMethodOption | TieRound['rule'] | string): string {
  if (rule === 'countback') return 'Countback';
  if (rule === 'olympic') return 'Olympic trim';
  if (rule === 'recompete') return 'Re-compete';
  if (rule === 'shared') return 'Shared places';
  return 'Tie rule';
}

function getMethodDescription(rule: TieMethodOption): string {
  if (rule === 'countback') {
    return 'Ranks tied participants by highest single judge total, then next highest.';
  }
  if (rule === 'olympic') {
    return 'Drops highest and lowest judge totals and averages the remaining marks.';
  }
  if (rule === 'recompete') {
    return 'Opens a re-compete round where judges grade tied participants A–E.';
  }
  return 'Tied participants share the same place';
}

const TIE_METHOD_ORDER: ReadonlyArray<TieMethodOption> = [
  'countback',
  'olympic',
  'recompete',
  'shared',
];

function formatAuditAction(action: TieAuditAction | string): string {
  switch (action) {
    case 'apply_countback':
      return 'Applied Countback';
    case 'apply_olympic':
      return 'Applied Olympic trim';
    case 'apply_shared':
      return 'Shared places';
    case 'open_recompete':
      return 'Opened re-compete round';
    case 'close_recompete':
      return 'Closed re-compete round';
    case 'publish_recompete':
      return 'Published re-compete results';
    case 'reopen_recompete':
      return 'Reopened re-compete round';
    case 'close_stale':
    case 'close_stale_round':
      return 'Closed stale round';
    case 'close_shared':
    case 'close_event_shared':
      return 'Closed with shared places';
    default:
      return 'Tie management update';
  }
}

function formatAuditOutcome(outcome?: string | null): string {
  const clean = String(outcome || '').trim().toLowerCase();
  switch (clean) {
    case 'published_resolved':
      return 'Resolved and published';
    case 'published_with_shared':
      return 'Published with shared place';
    case 'opened':
      return 'Round opened for judges';
    case 'reopened':
      return 'Round reopened for judges';
    case 'closed_ready_to_publish':
      return 'Closed, ready to publish';
    case 'closed_still_tied':
      return 'Closed, some places still tied';
    case 'cancelled_stale':
      return 'Cancelled as stale';
    case 'shared_default':
      return 'Shared places kept';
    default:
      return clean && !looksLikeRawCode(clean) ? outcome!.trim() : 'Recorded';
  }
}

function formatStaleReason(reason?: string | null): string {
  const clean = String(reason || '').trim().toLowerCase();
  if (clean === 'tie_no_longer_exists') {
    return 'The original tie no longer exists after a score change.';
  }
  if (clean === 'scores_changed') {
    return 'Sealed scores changed after this tie round was opened.';
  }
  if (clean === 'marked_stale') {
    return 'Flagged as stale after sealed scores changed.';
  }
  return 'Sealed scores changed since this tie round began.';
}

function formatAuditTimestamp(iso?: string): string {
  if (!iso) return 'Just now';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return 'Recently';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRankOrdinal(rank: number): string {
  if (rank <= 0) return 'Unranked';
  const mod100 = rank % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${rank}th`;
  const mod10 = rank % 10;
  if (mod10 === 1) return `${rank}st`;
  if (mod10 === 2) return `${rank}nd`;
  if (mod10 === 3) return `${rank}rd`;
  return `${rank}th`;
}

export function TieManagerScreen({
  event,
  organization,
  eventParticipants,
  eventScores,
  assignedJudgesCount,
  getParticipantDisplayName,
  onClose,
  onTieDataChanged,
}: TieManagerScreenProps) {
  const [rounds, setRounds] = useState<TieRound[]>([]);
  const [liveTieGroups, setLiveTieGroups] = useState<OrganiserLiveTieGroup[]>([]);
  const [staleRefs, setStaleRefs] = useState<OrganiserStaleRoundRef[]>([]);
  const [auditEntries, setAuditEntries] = useState<TieAuditEntry[]>([]);

  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [publishSummary, setPublishSummary] = useState<{
    message: string;
    remainingGroups: RemainingTieGroupItem[];
  } | null>(null);

  // Modal states: Method preview confirm, Reopen reason, Close-stale reason
  const [previewConfirm, setPreviewConfirm] = useState<{
    group: OrganiserLiveTieGroup;
    rule: TieMethodOption;
    preview: TieMethodPreview;
  } | null>(null);
  const [reopenTarget, setReopenTarget] = useState<TieRound | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [staleCloseTarget, setStaleCloseTarget] = useState<TieRound | null>(null);
  const [staleCloseReason, setStaleCloseReason] = useState('');

  const loadReqIdRef = useRef(0);

  const orgRule: OrgTieRule =
    organization.tie_rule === 'olympic' || organization.tie_rule === 'recompete'
      ? organization.tie_rule
      : 'countback';

  const actorLabel = useMemo(() => {
    const name = String(organization.name || '').trim();
    return name ? `${name} Organiser` : 'Organiser';
  }, [organization.name]);

  const participantById = useMemo(
    () => new Map(eventParticipants.map((p) => [p.id, p])),
    [eventParticipants]
  );

  const resolveParticipantName = useCallback(
    (participantId: string): string => {
      const found = participantById.get(participantId);
      if (found) return getParticipantDisplayName(found, event || undefined);
      return `Participant ${participantId.slice(0, 6)}`;
    },
    [participantById, getParticipantDisplayName, event]
  );

  // Local pure score breakdown keyed by group_key to populate Countback/Olympic preview details
  const localDetectedByKey = useMemo(() => {
    const map = new Map<string, DetectedTiedGroup>();
    if (!event) return map;
    const { groups } = detectTiedGroups(eventParticipants, eventScores, assignedJudgesCount);
    for (const g of groups) {
      map.set(g.groupKey, g);
    }
    return map;
  }, [event, eventParticipants, eventScores, assignedJudgesCount]);

  const loadTieData = useCallback(
    async (silent: boolean = false) => {
      if (!event) return;
      const reqId = ++loadReqIdRef.current;
      if (!silent) setIsLoading(true);
      else setIsRefreshing(true);

      try {
        const [listRes, auditRes] = await Promise.all([
          callTieRpc<OrganiserTieListResponse>('tie_rounds_list_organiser', {
            p_event_id: event.id,
          }),
          callTieRpc<TieAuditListResponse>('tie_audit_list', {
            p_event_id: event.id,
            p_limit: 20,
          }),
        ]);

        if (reqId !== loadReqIdRef.current) return;

        setRounds(Array.isArray(listRes.rounds) ? listRes.rounds : []);
        setLiveTieGroups(Array.isArray(listRes.live_tie_groups) ? listRes.live_tie_groups : []);
        setStaleRefs(Array.isArray(listRes.stale_rounds) ? listRes.stale_rounds : []);
        setAuditEntries(Array.isArray(auditRes.entries) ? auditRes.entries.slice(0, 20) : []);
        setErrorBanner(null);
      } catch (err: any) {
        if (reqId !== loadReqIdRef.current) return;
        setErrorBanner(formatTieRpcError(err?.code, err?.message));
      } finally {
        if (reqId === loadReqIdRef.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [event]
  );

  // Initial load on open
  useEffect(() => {
    if (!event) {
      setRounds([]);
      setLiveTieGroups([]);
      setStaleRefs([]);
      setAuditEntries([]);
      setErrorBanner(null);
      setPublishSummary(null);
      setPreviewConfirm(null);
      setReopenTarget(null);
      setStaleCloseTarget(null);
      return;
    }
    void loadTieData(false);
  }, [event, loadTieData]);

  // Derived stale & active round maps
  const staleReasonByRoundId = useMemo(() => {
    const map = new Map<string, string>();
    for (const st of staleRefs) {
      map.set(st.round_id, st.reason);
    }
    return map;
  }, [staleRefs]);

  const staleRounds = useMemo(
    () =>
      rounds.filter(
        (r) =>
          r.status !== 'cancelled_stale' &&
          (Boolean(r.is_stale) || staleReasonByRoundId.has(r.id))
      ),
    [rounds, staleReasonByRoundId]
  );

  const hasStaleRounds = staleRounds.length > 0;
  const hasOpenRound = useMemo(
    () =>
      rounds.some(
        (r) => r.status === 'open' && !r.is_stale && !staleReasonByRoundId.has(r.id)
      ),
    [rounds, staleReasonByRoundId]
  );

  // Live polling every 8s while an open re-compete round is running (live submission counter)
  useEffect(() => {
    if (!event || !hasOpenRound) return;
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      void loadTieData(true);
    }, 8000);
    return () => window.clearInterval(id);
  }, [event, hasOpenRound, loadTieData]);

  // Escape key closes active modal dialog
  useEffect(() => {
    if (!previewConfirm && !reopenTarget && !staleCloseTarget) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (previewConfirm) setPreviewConfirm(null);
        else if (reopenTarget) setReopenTarget(null);
        else if (staleCloseTarget) setStaleCloseTarget(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [previewConfirm, reopenTarget, staleCloseTarget]);

  const latestActiveRoundByGroup = useMemo(() => {
    const map = new Map<string, TieRound>();
    for (const r of rounds) {
      if (r.status === 'cancelled_stale') continue;
      if (r.is_stale || staleReasonByRoundId.has(r.id)) continue;
      if (!map.has(r.group_key)) {
        map.set(r.group_key, r);
      }
    }
    return map;
  }, [rounds, staleReasonByRoundId]);

  const isEventLockedEnded =
    event?.is_archived === true ||
    event?.status === 'ended' ||
    event?.status === 'archived';

  // --- Action Handlers ---

  const getEffectiveJudgeCount = useCallback(
    (detected?: DetectedTiedGroup): number => {
      const ballotCounts =
        detected?.members.map((m) => m.ballotCount).filter((n) => n > 0) || [];
      const minBallots = ballotCounts.length > 0 ? Math.min(...ballotCounts) : 0;
      if (minBallots > 0 && assignedJudgesCount > 0) {
        return Math.min(minBallots, assignedJudgesCount);
      }
      return minBallots > 0 ? minBallots : assignedJudgesCount;
    },
    [assignedJudgesCount]
  );

  const handleOpenMethodPreview = (
    group: OrganiserLiveTieGroup,
    rule: TieMethodOption
  ) => {
    triggerHaptic('tick');
    setErrorBanner(null);

    const detected = localDetectedByKey.get(group.group_key);
    const effectiveJudges = getEffectiveJudgeCount(detected);
    let preview: TieMethodPreview;

    if (detected) {
      if (rule === 'countback') {
        preview = computeCountbackPreview(detected);
      } else if (rule === 'olympic') {
        preview = computeOlympicPreview(
          detected,
          effectiveJudges > 0 ? effectiveJudges : undefined
        );
      } else if (rule === 'recompete') {
        preview = computeRecompetePreview(detected);
      } else {
        preview = computeSharedPreview(detected);
      }
    } else {
      const existingRound = latestActiveRoundByGroup.get(group.group_key);
      const serverPlacements = existingRound?.result_payload?.placements;
      const placements: TieRoundPlacement[] =
        rule !== 'shared' && rule !== 'recompete' && Array.isArray(serverPlacements) && serverPlacements.length > 0
          ? serverPlacements
          : group.tied_participant_ids.map((pid) => ({
              participant_id: pid,
              before_rank: group.tied_rank,
              after_rank: group.tied_rank,
              base_avg: group.tied_avg,
              ballot_count: effectiveJudges,
              scores_desc: [],
              trimmed_avg: null,
            }));
      const lowJudgeWarning =
        rule === 'olympic' &&
        (Boolean(existingRound?.preview_payload?.low_judge_warning) ||
          Boolean(existingRound?.result_payload?.low_judge_warning) ||
          effectiveJudges < 5);

      preview = {
        rule,
        groupKey: group.group_key,
        tiedRank: group.tied_rank,
        scoreFingerprint: group.score_fingerprint,
        placements,
        stillTied:
          rule === 'recompete'
            ? false
            : placements.length >= 2 && new Set(placements.map((p) => p.after_rank)).size < placements.length,
        resolved:
          rule === 'recompete' || rule === 'shared'
            ? false
            : new Set(placements.map((p) => p.after_rank)).size === placements.length,
        lowJudgeWarning,
        isRangeAfterRank: rule === 'recompete',
      };
    }

    setPreviewConfirm({ group, rule, preview });
  };

  const handleConfirmMethod = async () => {
    if (!event || !previewConfirm) return;
    const { group, rule } = previewConfirm;
    const key = rule === 'recompete' ? `open:${group.group_key}` : `apply:${group.group_key}`;
    setBusyActionKey(key);
    setErrorBanner(null);
    try {
      if (rule === 'recompete') {
        await callTieRpc<TieRoundMutationResponse>('tie_round_open', {
          p_event_id: event.id,
          p_group_key: group.group_key,
          p_actor_label: actorLabel,
        });
        setPreviewConfirm(null);
        showToast(`Re-compete round opened for Rank #${group.tied_rank}.`, 'success');
      } else {
        const res = await callTieRpc<TiePublishLikeResponse>('tie_round_apply_auto', {
          p_event_id: event.id,
          p_group_key: group.group_key,
          p_rule: rule,
          p_actor_label: actorLabel,
          p_close_event: false,
        });
        setPreviewConfirm(null);
        const remaining = Array.isArray(res.remaining_groups) ? res.remaining_groups : [];
        setPublishSummary({
          message: `${formatRuleLabel(rule)} applied for Rank #${group.tied_rank}.`,
          remainingGroups: remaining,
        });
        showToast(`${formatRuleLabel(rule)} published for Rank #${group.tied_rank}.`, 'success');
      }
      await loadTieData(true);
      onTieDataChanged?.();
    } catch (err: any) {
      const msg = formatTieRpcError(err?.code, err?.message);
      setErrorBanner(msg);
      showToast(msg, 'error');
    } finally {
      setBusyActionKey(null);
    }
  };

  const handleCloseRecompete = async (round: TieRound) => {
    triggerHaptic('tick');
    const key = `close:${round.id}`;
    setBusyActionKey(key);
    setErrorBanner(null);
    try {
      await callTieRpc<TieRoundMutationResponse>('tie_round_close', {
        p_round_id: round.id,
        p_actor_label: actorLabel,
      });
      showToast(`Re-compete round closed for Rank #${round.tied_rank}. Review and publish.`, 'success');
      await loadTieData(true);
      onTieDataChanged?.();
    } catch (err: any) {
      const msg = formatTieRpcError(err?.code, err?.message);
      setErrorBanner(msg);
      showToast(msg, 'error');
    } finally {
      setBusyActionKey(null);
    }
  };

  const handlePublishRecompete = async (round: TieRound) => {
    triggerHaptic('tick');
    const key = `publish:${round.id}`;
    setBusyActionKey(key);
    setErrorBanner(null);
    try {
      const res = await callTieRpc<TiePublishLikeResponse>('tie_round_publish', {
        p_round_id: round.id,
        p_close_event: false,
        p_actor_label: actorLabel,
      });
      const remaining = Array.isArray(res.remaining_groups) ? res.remaining_groups : [];
      setPublishSummary({
        message: `Published re-compete results for Rank #${round.tied_rank}.`,
        remainingGroups: remaining,
      });
      showToast(
        remaining.length === 0
          ? 'Tie results published. No tied groups remain.'
          : `Tie results published. ${remaining.length} tied group${remaining.length === 1 ? '' : 's'} remaining.`,
        'success'
      );
      await loadTieData(true);
      onTieDataChanged?.();
    } catch (err: any) {
      const msg = formatTieRpcError(err?.code, err?.message);
      setErrorBanner(msg);
      showToast(msg, 'error');
    } finally {
      setBusyActionKey(null);
    }
  };

  const handleConfirmReopen = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reopenTarget) return;
    const trimmed = reopenReason.trim();
    if (trimmed.length < 3 || trimmed.length > 300) {
      setReopenError('Please enter a reason between 3 and 300 characters.');
      return;
    }
    const key = `reopen:${reopenTarget.id}`;
    setBusyActionKey(key);
    setReopenError(null);
    setErrorBanner(null);
    try {
      await callTieRpc<TieRoundMutationResponse>('tie_round_reopen', {
        p_round_id: reopenTarget.id,
        p_reason: trimmed,
        p_actor_label: actorLabel,
      });
      const rank = reopenTarget.tied_rank;
      setReopenTarget(null);
      setReopenReason('');
      showToast(`Re-compete round reopened for Rank #${rank}.`, 'success');
      await loadTieData(true);
      onTieDataChanged?.();
    } catch (err: any) {
      const msg = formatTieRpcError(err?.code, err?.message);
      setReopenError(msg);
      showToast(msg, 'error');
    } finally {
      setBusyActionKey(null);
    }
  };

  const handleConfirmCloseStale = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!staleCloseTarget) return;
    const key = `stale:${staleCloseTarget.id}`;
    setBusyActionKey(key);
    setErrorBanner(null);
    try {
      await callTieRpc<TieRoundMutationResponse>('tie_round_close_stale', {
        p_round_id: staleCloseTarget.id,
        p_reason: staleCloseReason.trim().slice(0, 300),
        p_actor_label: actorLabel,
      });
      setStaleCloseTarget(null);
      setStaleCloseReason('');
      showToast('Stale tie round closed and recorded in audit log.', 'success');
      await loadTieData(true);
      onTieDataChanged?.();
    } catch (err: any) {
      const msg = formatTieRpcError(err?.code, err?.message);
      setErrorBanner(msg);
      showToast(msg, 'error');
    } finally {
      setBusyActionKey(null);
    }
  };

  if (!event) return null;

  return (
    <TaskScreen
      isOpen={Boolean(event)}
      title={`Tie Manager · ${event.name}`}
      subtitle={`${event.category || 'General'} · Organisation rule: ${formatRuleLabel(orgRule)}`}
      onBack={onClose}
      backLabel="Back"
      hasNestedOverlay={Boolean(previewConfirm || reopenTarget || staleCloseTarget)}
      headerAction={
        <button
          type="button"
          onClick={() => {
            triggerHaptic('tick');
            void loadTieData(true);
          }}
          disabled={isLoading || isRefreshing}
          aria-label="Refresh tie data"
          className="min-h-[44px] min-w-[44px] px-3 inline-flex items-center justify-center gap-1.5 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-stone-700 dark:text-zinc-200 hover:bg-stone-200 dark:hover:bg-zinc-800 text-xs lg:text-sm font-bold transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">Refresh</span>
        </button>
      }
    >
      {/* Organisation Tie Rule Overview */}
      <section className="rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          <div className="flex items-center gap-2 text-sm font-bold text-stone-900 dark:text-white">
            <Scale className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>Active rule: {formatRuleLabel(orgRule)}</span>
          </div>
          <p className="text-xs text-stone-500 dark:text-zinc-400">
            {orgRule === 'countback'
              ? 'Ranks tied participants by highest single judge total, then next highest.'
              : orgRule === 'olympic'
              ? 'Drops highest and lowest judge totals and averages the remaining marks.'
              : 'Opens a re-compete round where judges grade tied participants A–E.'}
          </p>
        </div>
        <div className="text-xs font-semibold text-stone-500 dark:text-zinc-400 tabular-nums whitespace-nowrap">
          {liveTieGroups.length} tied {liveTieGroups.length === 1 ? 'group' : 'groups'}
          {staleRounds.length > 0 ? ` · ${staleRounds.length} stale` : ''}
        </div>
      </section>

      {/* Error Alert */}
      {errorBanner && (
        <div
          role="alert"
          className="rounded-2xl bg-rose-500/10 border border-rose-500/30 p-4 flex items-start justify-between gap-3"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <p className="text-xs lg:text-sm font-semibold text-rose-800 dark:text-rose-200 leading-snug">
              {errorBanner}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            aria-label="Dismiss error"
            className="min-h-[44px] min-w-[44px] -my-2 -mr-2 flex items-center justify-center rounded-xl text-rose-600 dark:text-rose-300 hover:bg-rose-500/15 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Post-Publish Remaining Groups Summary */}
      {publishSummary && (
        <section
          role="status"
          className="rounded-2xl bg-emerald-500/10 border border-emerald-500/25 p-4 space-y-2"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs lg:text-sm font-bold text-emerald-900 dark:text-emerald-200">
                  {publishSummary.message}
                </p>
                {publishSummary.remainingGroups.length === 0 ? (
                  <p className="text-xs text-emerald-800/90 dark:text-emerald-300/90 mt-0.5">
                    No unresolved tied groups remain on this event.
                  </p>
                ) : (
                  <div className="mt-1.5 space-y-1">
                    <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-200">
                      Remaining tied groups ({publishSummary.remainingGroups.length}):
                    </p>
                    <ul className="space-y-1 text-xs text-emerald-900/90 dark:text-emerald-200/90">
                      {publishSummary.remainingGroups.map((rg) => (
                        <li key={rg.group_key} className="tabular-nums">
                          Rank #{rg.tied_rank}:{' '}
                          {rg.tied_participant_ids.map(resolveParticipantName).join(', ')}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPublishSummary(null)}
              aria-label="Dismiss publish summary"
              className="min-h-[44px] min-w-[44px] -my-2 -mr-2 flex items-center justify-center rounded-xl text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15 cursor-pointer shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </section>
      )}

      {/* Stale Rounds Blocking Banner & List */}
      {hasStaleRounds && (
        <section className="rounded-2xl bg-rose-500/10 border border-rose-500/30 p-4 space-y-3">
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="w-5 h-5 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1 min-w-0">
              <h2 className="text-sm font-bold text-rose-900 dark:text-rose-200">
                Stale tie {staleRounds.length === 1 ? 'round' : 'rounds'} detected
              </h2>
              <p className="text-xs lg:text-sm text-rose-800/90 dark:text-rose-200/90 leading-relaxed">
                Sealed scores changed after {staleRounds.length === 1 ? 'this round' : 'these rounds'} began. Stale rounds block publishing tie results and closing this event until you close each stale round below.
              </p>
            </div>
          </div>

          <div className="space-y-2">
            {staleRounds.map((sr) => (
              <div
                key={sr.id}
                className="rounded-xl bg-white dark:bg-zinc-950 border border-rose-500/25 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div className="space-y-0.5 min-w-0">
                  <div className="text-xs lg:text-sm font-bold text-stone-900 dark:text-white tabular-nums">
                    Rank #{sr.tied_rank} · {formatRuleLabel(sr.rule)} ({sr.status})
                  </div>
                  <p className="text-xs text-stone-600 dark:text-zinc-300">
                    {(sr.tied_participant_ids || []).map(resolveParticipantName).join(', ')}
                  </p>
                  <p className="text-[11px] text-rose-700 dark:text-rose-300">
                    {formatStaleReason(staleReasonByRoundId.get(sr.id))}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busyActionKey !== null}
                  onClick={() => {
                    triggerHaptic('tick');
                    setStaleCloseTarget(sr);
                    setStaleCloseReason('');
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs lg:text-sm font-bold whitespace-nowrap shrink-0 transition-colors cursor-pointer disabled:opacity-50"
                >
                  Close stale round
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Main Tied Groups Section */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-stone-900 dark:text-white">
            Tied Groups
          </h2>
          {isEventLockedEnded && (
            <span className="text-xs font-semibold text-stone-500 dark:text-zinc-400">
              Event ended · Read-only
            </span>
          )}
        </div>

        {isLoading && liveTieGroups.length === 0 ? (
          <div className="rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 p-6 text-center text-xs lg:text-sm text-stone-500 dark:text-zinc-400">
            Loading tied groups from server...
          </div>
        ) : liveTieGroups.length === 0 ? (
          <div className="rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 p-6 text-center space-y-1">
            <p className="text-sm font-bold text-stone-900 dark:text-white">
              No active ties detected
            </p>
            <p className="text-xs text-stone-500 dark:text-zinc-400">
              All currently scored participants have distinct averages on the server.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {liveTieGroups.map((group) => {
              const round = latestActiveRoundByGroup.get(group.group_key) || null;
              const isPublishedCurrent =
                round !== null &&
                round.status === 'published' &&
                (round.score_fingerprint || '') === (group.score_fingerprint || '');
              const isOpen = round?.status === 'open';
              const isClosed = round?.status === 'closed';
              const isBusy = busyActionKey !== null;

              const placements: TieRoundPlacement[] = Array.isArray(round?.result_payload?.placements)
                ? round.result_payload!.placements
                : [];

              const detected = localDetectedByKey.get(group.group_key);
              const effectiveJudges = getEffectiveJudgeCount(detected);
              const recommendations = getTieMethodRecommendations(
                group.tied_rank,
                group.tied_participant_ids.length,
                effectiveJudges
              );

              return (
                <div
                  key={group.group_key}
                  className="rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 p-4 space-y-3.5"
                >
                  {/* Group Header */}
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <div className="text-sm font-bold text-stone-900 dark:text-white tabular-nums">
                        Tied at {formatRankOrdinal(group.tied_rank)} place · {Number(group.tied_avg).toFixed(2)} pts
                      </div>
                      <div className="text-xs text-stone-500 dark:text-zinc-400 tabular-nums">
                        {group.tied_participant_ids.length} participants tied
                      </div>
                    </div>

                    <span
                      className={`text-xs font-bold whitespace-nowrap inline-flex items-center gap-1 ${
                        isOpen
                          ? 'text-amber-700 dark:text-amber-300'
                          : isClosed
                          ? 'text-sky-700 dark:text-sky-300'
                          : isPublishedCurrent
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : 'text-stone-500 dark:text-zinc-400'
                      }`}
                    >
                      {isPublishedCurrent && <Lock className="w-3.5 h-3.5 shrink-0" />}
                      {isOpen
                        ? 'Re-compete open'
                        : isClosed
                        ? 'Closed · Ready to publish'
                        : isPublishedCurrent
                        ? `Published (${formatRuleLabel(round!.rule)})`
                        : 'Unresolved'}
                    </span>
                  </div>

                  {/* Tied Participants or Resolved Standings */}
                  <div className="divide-y divide-stone-100 dark:divide-zinc-800/80 border-t border-b border-stone-100 dark:border-zinc-800/80">
                    {placements.length > 0 && (isClosed || isPublishedCurrent) ? (
                      placements.map((pl) => (
                        <div
                          key={pl.participant_id}
                          className="py-2 flex items-center justify-between gap-3 text-xs lg:text-sm"
                        >
                          <div className="min-w-0">
                            <span className="font-semibold text-stone-900 dark:text-white truncate block">
                              {resolveParticipantName(pl.participant_id)}
                            </span>
                            <span className="text-[11px] text-stone-500 dark:text-zinc-400 tabular-nums">
                              {round?.rule === 'recompete'
                                ? `Re-compete total: ${pl.grade_sum ?? 0} pts (${pl.grade_count ?? 0} grades)`
                                : round?.rule === 'olympic' && pl.trimmed_avg !== undefined && pl.trimmed_avg !== null
                                ? `Trimmed avg: ${Number(pl.trimmed_avg).toFixed(2)} pts`
                                : pl.scores_desc && pl.scores_desc.length > 0
                                ? `Highest totals: ${pl.scores_desc.map((v) => Number(v).toFixed(2)).join(', ')}`
                                : `Average: ${Number(pl.base_avg).toFixed(2)} pts`}
                            </span>
                          </div>
                          <div className="text-right shrink-0 font-mono font-bold tabular-nums text-stone-800 dark:text-zinc-200">
                            #{pl.before_rank} → #{pl.after_rank}
                          </div>
                        </div>
                      ))
                    ) : (
                      group.tied_participant_ids.map((pid) => (
                        <div
                          key={pid}
                          className="py-2 flex items-center justify-between gap-3 text-xs lg:text-sm"
                        >
                          <span className="font-semibold text-stone-900 dark:text-white truncate">
                            {resolveParticipantName(pid)}
                          </span>
                          <span className="font-mono text-xs text-stone-500 dark:text-zinc-400 tabular-nums shrink-0">
                            #{group.tied_rank}
                          </span>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Live Submission Counter for Open Re-compete (aggregate counts ONLY — no judge names/grades) */}
                  {isOpen && round && (
                    <div className="rounded-xl bg-amber-500/10 border border-amber-500/25 p-3 space-y-1">
                      <div className="flex items-center justify-between gap-2 text-xs lg:text-sm font-bold text-amber-900 dark:text-amber-200 tabular-nums">
                        <span>Judges submitted</span>
                        <span className="font-mono">
                          {round.completed_judge_count ?? round.submitted_judge_count ?? 0} /{' '}
                          {round.expected_judge_count ?? assignedJudgesCount}
                        </span>
                      </div>
                      <p className="text-[11px] text-amber-800/90 dark:text-amber-300/90 tabular-nums">
                        {round.submitted_judge_count ?? 0}{' '}
                        {(round.submitted_judge_count ?? 0) === 1 ? 'judge has' : 'judges have'} submitted at least one grade. Individual judge grades remain hidden.
                      </p>
                      {(round.reopen_count ?? 0) > 0 && (
                        <p className="text-[11px] text-amber-800/80 dark:text-amber-300/80">
                          Reopened {round.reopen_count}{' '}
                          {round.reopen_count === 1 ? 'time' : 'times'}
                          {round.last_reopen_reason ? ` · Last reason: ${round.last_reopen_reason}` : ''}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Closed Re-compete Warning if Still Tied */}
                  {isClosed && round?.result_payload?.still_tied && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Some participants remain tied after grade totals and countback; publishing will keep their shared place.
                    </p>
                  )}

                  {/* Action Buttons (all min-h-[44px]) */}
                  {!isEventLockedEnded && (
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      {/* Open re-compete round: Close */}
                      {isOpen && round && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void handleCloseRecompete(round)}
                          className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-xs lg:text-sm font-bold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <Lock className="w-4 h-4 shrink-0" />
                          <span>
                            {busyActionKey === `close:${round.id}` ? 'Closing...' : 'Close round'}
                          </span>
                        </button>
                      )}

                      {/* Closed re-compete round: Publish only (Reopen is for published rounds only) */}
                      {isClosed && round && (
                        <button
                          type="button"
                          disabled={isBusy || hasStaleRounds}
                          onClick={() => void handlePublishRecompete(round)}
                          className="min-h-[44px] px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs lg:text-sm font-bold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <Send className="w-4 h-4 shrink-0" />
                          <span>
                            {busyActionKey === `publish:${round.id}` ? 'Publishing...' : 'Publish'}
                          </span>
                        </button>
                      )}

                      {/* Published re-compete round: Reopen (3-300 char reason, logged) */}
                      {isPublishedCurrent && round?.rule === 'recompete' && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            triggerHaptic('tick');
                            setReopenTarget(round);
                            setReopenReason('');
                            setReopenError(null);
                          }}
                          className="min-h-[44px] px-4 py-2 rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-stone-800 dark:text-zinc-100 text-xs lg:text-sm font-bold inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                        >
                          <RotateCcw className="w-4 h-4 shrink-0" />
                          <span>Reopen round</span>
                        </button>
                      )}

                      {/* Unresolved: all 4 methods available; "Recommended" is tag only, never forced */}
                      {!isOpen && !isClosed && !isPublishedCurrent && (
                        <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {TIE_METHOD_ORDER.map((method) => {
                            const rec = recommendations[method];
                            return (
                              <button
                                key={method}
                                type="button"
                                disabled={isBusy || hasStaleRounds}
                                onClick={() => handleOpenMethodPreview(group, method)}
                                className="min-h-[44px] px-3.5 py-2.5 rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 border border-stone-200 dark:border-zinc-800 text-stone-900 dark:text-white text-xs lg:text-sm font-bold flex items-center justify-between gap-2 text-left transition-colors cursor-pointer disabled:opacity-50"
                              >
                                <span className="truncate">{formatRuleLabel(method)}</span>
                                <span className="flex items-center gap-1.5 shrink-0">
                                  {rec.recommended && (
                                    <span className="text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
                                      Recommended
                                    </span>
                                  )}
                                  {rec.lowJudgeWarning && (
                                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                                  )}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Read-Only Audit Log (Last 20 Rows for Event) */}
      <section className="space-y-2.5 pt-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-stone-900 dark:text-white">
            Tie Audit Log
          </h2>
          <span className="text-xs text-stone-500 dark:text-zinc-400 tabular-nums">
            Last {auditEntries.length} of 20
          </span>
        </div>

        <div className="rounded-2xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 overflow-hidden divide-y divide-stone-100 dark:divide-zinc-800/80">
          {auditEntries.length === 0 ? (
            <div className="p-5 text-center text-xs lg:text-sm text-stone-500 dark:text-zinc-400">
              No tie actions recorded for this event yet.
            </div>
          ) : (
            auditEntries.map((entry) => (
              <div key={entry.id} className="p-3.5 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs lg:text-sm font-bold text-stone-900 dark:text-white">
                    {formatAuditAction(entry.action)}
                  </span>
                  <span className="text-[11px] text-stone-500 dark:text-zinc-400 inline-flex items-center gap-1 tabular-nums">
                    <Clock className="w-3 h-3 shrink-0" />
                    {formatAuditTimestamp(entry.created_at)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-stone-600 dark:text-zinc-300">
                  <span>{entry.actor_label || 'Organiser'}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatAuditOutcome(entry.outcome)}</span>
                </div>
                {entry.reason && entry.reason.trim().length > 0 && (
                  <p className="text-xs text-stone-500 dark:text-zinc-400">
                    Reason: {entry.reason}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {/* ======================================================== */}
      {/* TIE METHOD PREVIEW & CONFIRMATION POPUP (ALL 4 METHODS)  */}
      {/* ======================================================== */}
      {previewConfirm &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[155] bg-black/75 flex items-center justify-center p-4"
            onClick={() => setPreviewConfirm(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label={`Confirm ${formatRuleLabel(previewConfirm.rule)}`}
              onClick={(e) => e.stopPropagation()}
              className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl max-w-md w-full max-h-[90vh] flex flex-col p-5 shadow-2xl"
            >
              <div className="space-y-1 shrink-0">
                <h3 className="text-base font-bold text-stone-900 dark:text-white">
                  Preview {formatRuleLabel(previewConfirm.rule)}
                </h3>
                <p className="text-xs text-stone-500 dark:text-zinc-400 tabular-nums">
                  Tied at {formatRankOrdinal(previewConfirm.group.tied_rank)} place ·{' '}
                  {Number(previewConfirm.group.tied_avg).toFixed(2)} pts
                </p>
              </div>

              <div className="mt-4 space-y-3 overflow-y-auto flex-1 min-h-0">
                {/* What the method does (existing pre-Step-4 descriptions only) */}
                {getMethodDescription(previewConfirm.rule) && (
                  <p className="text-xs text-stone-600 dark:text-zinc-300 leading-relaxed">
                    {getMethodDescription(previewConfirm.rule)}
                  </p>
                )}

                {/* Olympic Under-5-Judges Non-Blocking Warning */}
                {previewConfirm.rule === 'olympic' && previewConfirm.preview.lowJudgeWarning && (
                  <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
                      Fewer than 5 judges scored this group. Olympic trimming drops the highest and lowest scores, so results with under 5 judges may be less representative. You may still continue.
                    </p>
                  </div>
                )}

                {/* Still-Tied Non-Blocking Notice (Countback / Olympic only) */}
                {(previewConfirm.rule === 'countback' || previewConfirm.rule === 'olympic') &&
                  previewConfirm.preview.stillTied && (
                    <div className="rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 p-3 text-xs text-stone-700 dark:text-zinc-300 leading-relaxed">
                      Some participants remain equal under {formatRuleLabel(previewConfirm.rule)} and will keep a shared place.
                    </div>
                  )}

                {/* Ranks Before -> After Table */}
                <div className="rounded-xl border border-stone-200 dark:border-zinc-800 divide-y divide-stone-100 dark:divide-zinc-800">
                  {previewConfirm.preview.placements.map((pl) => (
                    <div key={pl.participant_id} className="p-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs lg:text-sm font-bold text-stone-900 dark:text-white truncate">
                          {resolveParticipantName(pl.participant_id)}
                        </div>
                        <div className="text-[11px] text-stone-500 dark:text-zinc-400 tabular-nums mt-0.5">
                          {previewConfirm.rule === 'olympic'
                            ? `Trimmed avg: ${Number(pl.trimmed_avg ?? pl.base_avg).toFixed(2)} pts (${pl.ballot_count ?? 0} judges)`
                            : previewConfirm.rule === 'countback' && pl.scores_desc && pl.scores_desc.length > 0
                            ? `Judge totals: ${pl.scores_desc.map((v) => Number(v).toFixed(2)).join(', ')}`
                            : `Sealed avg: ${Number(pl.base_avg).toFixed(2)} pts`}
                        </div>
                      </div>
                      <div className="text-right shrink-0 font-mono text-xs lg:text-sm font-bold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {previewConfirm.preview.isRangeAfterRank
                          ? `#${pl.before_rank} → #${previewConfirm.group.tied_rank}–#${
                              previewConfirm.group.tied_rank + previewConfirm.preview.placements.length - 1
                            }`
                          : `#${pl.before_rank} → #${pl.after_rank}`}
                      </div>
                    </div>
                  ))}
                </div>

                <p className="text-xs font-semibold text-stone-700 dark:text-zinc-200 leading-relaxed">
                  This cannot be changed after you confirm.
                </p>
              </div>

              <div className="mt-4 pt-3 border-t border-stone-100 dark:border-zinc-800 grid grid-cols-2 gap-2.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setPreviewConfirm(null)}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-xl font-bold text-xs lg:text-sm bg-stone-100 hover:bg-stone-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-stone-800 dark:text-zinc-100 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busyActionKey !== null}
                  onClick={() => void handleConfirmMethod()}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-xl font-bold text-xs lg:text-sm bg-emerald-600 hover:bg-emerald-500 text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  {busyActionKey ? 'Applying...' : 'Confirm'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* ======================================================== */}
      {/* REOPEN ROUND REASON MODAL (3..300 chars required)        */}
      {/* ======================================================== */}
      {reopenTarget &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[155] bg-black/75 flex items-center justify-center p-4"
            onClick={() => setReopenTarget(null)}
          >
            <form
              role="dialog"
              aria-modal="true"
              aria-label="Reopen re-compete round"
              onClick={(e) => e.stopPropagation()}
              onSubmit={handleConfirmReopen}
              className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4"
            >
              <div className="space-y-1">
                <h3 className="text-base font-bold text-stone-900 dark:text-white">
                  Reopen re-compete round
                </h3>
                <p className="text-xs text-stone-500 dark:text-zinc-400">
                  Rank #{reopenTarget.tied_rank}. Enter a short reason for the audit log (3 to 300 characters).
                </p>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="tie-reopen-reason"
                  className="text-xs font-semibold text-stone-700 dark:text-zinc-300 block"
                >
                  Reason for reopening
                </label>
                <textarea
                  id="tie-reopen-reason"
                  rows={3}
                  maxLength={300}
                  value={reopenReason}
                  onChange={(e) => {
                    setReopenReason(e.target.value);
                    if (reopenError) setReopenError(null);
                  }}
                  placeholder="e.g. Judge 3 requested to submit missing re-compete grade"
                  className="w-full p-3 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-xs lg:text-sm text-stone-900 dark:text-white placeholder:text-stone-400 focus:outline-none focus:border-emerald-500"
                />
                <div className="flex items-center justify-between text-[11px] text-stone-500 dark:text-zinc-400 tabular-nums">
                  <span>Minimum 3 characters</span>
                  <span>{reopenReason.trim().length}/300</span>
                </div>
                {reopenError && (
                  <p role="alert" className="text-xs font-semibold text-rose-600 dark:text-rose-400">
                    {reopenError}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setReopenTarget(null)}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-xl font-bold text-xs lg:text-sm bg-stone-100 hover:bg-stone-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-stone-800 dark:text-zinc-100 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyActionKey !== null || reopenReason.trim().length < 3}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-xl font-bold text-xs lg:text-sm bg-emerald-600 hover:bg-emerald-500 text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  {busyActionKey ? 'Reopening...' : 'Reopen round'}
                </button>
              </div>
            </form>
          </div>,
          document.body
        )}

      {/* ======================================================== */}
      {/* CLOSE STALE ROUND REASON MODAL                           */}
      {/* ======================================================== */}
      {staleCloseTarget &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[155] bg-black/75 flex items-center justify-center p-4"
            onClick={() => setStaleCloseTarget(null)}
          >
            <form
              role="dialog"
              aria-modal="true"
              aria-label="Close stale tie round"
              onClick={(e) => e.stopPropagation()}
              onSubmit={handleConfirmCloseStale}
              className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4"
            >
              <div className="space-y-1">
                <h3 className="text-base font-bold text-stone-900 dark:text-white">
                  Close stale tie round
                </h3>
                <p className="text-xs text-stone-500 dark:text-zinc-400">
                  Rank #{staleCloseTarget.tied_rank}. Closing this stale round cancels it with an audit log entry so publishing and closing can proceed.
                </p>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="tie-stale-reason"
                  className="text-xs font-semibold text-stone-700 dark:text-zinc-300 block"
                >
                  Note for audit log
                </label>
                <textarea
                  id="tie-stale-reason"
                  rows={3}
                  maxLength={300}
                  value={staleCloseReason}
                  onChange={(e) => setStaleCloseReason(e.target.value)}
                  placeholder="e.g. Score correction resolved the earlier tie"
                  className="w-full p-3 rounded-xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-xs lg:text-sm text-stone-900 dark:text-white placeholder:text-stone-400 focus:outline-none focus:border-rose-500"
                />
                <div className="text-right text-[11px] text-stone-500 dark:text-zinc-400 tabular-nums">
                  {staleCloseReason.trim().length}/300
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setStaleCloseTarget(null)}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-xl font-bold text-xs lg:text-sm bg-stone-100 hover:bg-stone-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-stone-800 dark:text-zinc-100 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyActionKey !== null}
                  className="w-full min-h-[44px] px-4 py-2.5 rounded-xl font-bold text-xs lg:text-sm bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer disabled:opacity-50"
                >
                  {busyActionKey ? 'Closing...' : 'Close stale round'}
                </button>
              </div>
            </form>
          </div>,
          document.body
        )}
    </TaskScreen>
  );
}
