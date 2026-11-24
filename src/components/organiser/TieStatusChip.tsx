import React from 'react';
import { AlertTriangle, CheckCircle2, Scale } from 'lucide-react';
import type { TieRound } from '../../lib/supabaseTypes';

export interface OrganiserLiveTieGroup {
  group_key: string;
  tied_rank: number;
  tied_avg: number;
  tied_participant_ids: string[];
  score_fingerprint: string;
}

export interface OrganiserStaleRoundRef {
  round_id: string;
  group_key: string;
  status: string;
  reason: string;
}

export interface EventTieSummary {
  rounds: TieRound[];
  liveTieGroups: OrganiserLiveTieGroup[];
  staleRounds: OrganiserStaleRoundRef[];
}

export interface TieStatusChipProps {
  tieManagementEnabled: boolean;
  summary?: EventTieSummary | null;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export interface ComputedTieChipState {
  visible: boolean;
  kind: 'stale' | 'open' | 'closed' | 'unresolved' | 'resolved';
  label: string;
  detail: string;
  staleCount: number;
  openCount: number;
  closedCount: number;
  unresolvedCount: number;
  liveTieCount: number;
}

export function deriveTieChipState(
  tieManagementEnabled: boolean,
  summary?: EventTieSummary | null
): ComputedTieChipState {
  const empty: ComputedTieChipState = {
    visible: false,
    kind: 'resolved',
    label: '',
    detail: '',
    staleCount: 0,
    openCount: 0,
    closedCount: 0,
    unresolvedCount: 0,
    liveTieCount: 0,
  };
  if (!tieManagementEnabled || !summary) return empty;

  const rounds = Array.isArray(summary.rounds) ? summary.rounds : [];
  const liveTieGroups = Array.isArray(summary.liveTieGroups) ? summary.liveTieGroups : [];
  const staleRefs = Array.isArray(summary.staleRounds) ? summary.staleRounds : [];
  const staleIds = new Set(staleRefs.map((s) => s.round_id));

  const staleRounds = rounds.filter(
    (r) => r.status !== 'cancelled_stale' && (Boolean(r.is_stale) || staleIds.has(r.id))
  );
  const staleCount = Math.max(staleRounds.length, staleRefs.length);

  const activeNonStaleRounds = rounds.filter(
    (r) => r.status !== 'cancelled_stale' && !r.is_stale && !staleIds.has(r.id)
  );
  const openCount = activeNonStaleRounds.filter((r) => r.status === 'open').length;
  const closedCount = activeNonStaleRounds.filter((r) => r.status === 'closed').length;

  const publishedFingerprints = new Map<string, string>();
  for (const r of activeNonStaleRounds) {
    if (r.status === 'published') {
      publishedFingerprints.set(r.group_key, r.score_fingerprint || '');
    }
  }

  const unresolvedCount = liveTieGroups.filter((g) => {
    const pubFp = publishedFingerprints.get(g.group_key);
    return pubFp === undefined || pubFp !== (g.score_fingerprint || '');
  }).length;

  const liveTieCount = liveTieGroups.length;
  const hasAnySignal = staleCount > 0 || openCount > 0 || closedCount > 0 || liveTieCount > 0;
  if (!hasAnySignal) return empty;

  if (staleCount > 0) {
    const label = staleCount === 1 ? 'Stale tie' : `${staleCount} stale ties`;
    return {
      visible: true,
      kind: 'stale',
      label,
      detail: `${staleCount} stale tie round${staleCount === 1 ? '' : 's'} require closing.`,
      staleCount,
      openCount,
      closedCount,
      unresolvedCount,
      liveTieCount,
    };
  }

  if (openCount > 0) {
    const label = openCount === 1 ? 'Tie open' : `${openCount} ties open`;
    return {
      visible: true,
      kind: 'open',
      label,
      detail: `${openCount} re-compete tie round${openCount === 1 ? '' : 's'} currently open for judges.`,
      staleCount,
      openCount,
      closedCount,
      unresolvedCount,
      liveTieCount,
    };
  }

  if (closedCount > 0) {
    const label = closedCount === 1 ? 'Tie ready' : `${closedCount} ties ready`;
    return {
      visible: true,
      kind: 'closed',
      label,
      detail: `${closedCount} closed tie round${closedCount === 1 ? '' : 's'} ready to publish.`,
      staleCount,
      openCount,
      closedCount,
      unresolvedCount,
      liveTieCount,
    };
  }

  if (unresolvedCount > 0) {
    const label = unresolvedCount === 1 ? '1 tie' : `${unresolvedCount} ties`;
    return {
      visible: true,
      kind: 'unresolved',
      label,
      detail: `${unresolvedCount} tied group${unresolvedCount === 1 ? '' : 's'} detected on server.`,
      staleCount,
      openCount,
      closedCount,
      unresolvedCount,
      liveTieCount,
    };
  }

  const label = liveTieCount === 1 ? 'Tie resolved' : `${liveTieCount} ties resolved`;
  return {
    visible: true,
    kind: 'resolved',
    label,
    detail: `All ${liveTieCount} tied group${liveTieCount === 1 ? '' : 's'} published.`,
    staleCount,
    openCount,
    closedCount,
    unresolvedCount,
    liveTieCount,
  };
}

export const TieStatusChip = React.memo(function TieStatusChip({
  tieManagementEnabled,
  summary,
  onClick,
}: TieStatusChipProps) {
  const state = deriveTieChipState(tieManagementEnabled, summary);
  if (!state.visible) return null;

  const toneClass =
    state.kind === 'stale'
      ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30 hover:bg-rose-500/20'
      : state.kind === 'open' || state.kind === 'unresolved'
      ? 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/30 hover:bg-amber-500/20'
      : state.kind === 'closed'
      ? 'bg-sky-500/10 text-sky-800 dark:text-sky-300 border-sky-500/30 hover:bg-sky-500/20'
      : 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20';

  const Icon =
    state.kind === 'stale'
      ? AlertTriangle
      : state.kind === 'resolved'
      ? CheckCircle2
      : Scale;

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      title={state.detail}
      aria-label={`Tie status: ${state.label}. ${state.detail}`}
      className={`min-h-[44px] min-w-[44px] px-2.5 inline-flex items-center justify-center gap-1.5 rounded-xl border text-[11px] lg:text-xs font-bold whitespace-nowrap shrink-0 tabular-nums transition-colors duration-150 motion-reduce:transition-none cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${toneClass}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0 stroke-[2.2]" aria-hidden="true" />
      <span>{state.label}</span>
    </button>
  );
});
