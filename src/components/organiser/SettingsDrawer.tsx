import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { 
  X, 
  Scale, 
  Plus, 
  Trash2, 
  Check, 
  CheckCircle2,
  Sliders,
  Sparkles,
  Focus,
  Clock,
  Monitor,
  Copy,
  Pencil
} from 'lucide-react';
import { Organization, TieBreakerMethod, CustomParticipantField, SupabaseEvent } from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';
import { ThemeToggleButton } from '../../lib/theme';
import { useToast } from '../common/ToastProvider';
import { getHapticStrength, setHapticStrength, triggerHaptic, HapticStrength } from '../../lib/haptics';
import { APP_VERSION } from '../../config/version';
import { downloadDiagnosticLog, getPendingScores, getPendingMutations } from '../../lib/offlineQueue';
import { SignatureHardware } from '../shared/SignatureHardware';
import { projectorService, ProjectorPairingItem } from '../../lib/projectorService';

export interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  organization: Organization;
  onUpdateOrganization: (updated: Organization) => void;
}

export type OrganiserDrawerProps = SettingsDrawerProps;

function formatLastSeen(iso: string | null, nowMs = Date.now()): string {
  if (!iso) return 'Waiting to connect';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return 'Waiting to connect';
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function isScreenOnline(iso: string | null, nowMs = Date.now()): boolean {
  if (!iso) return false;
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return false;
  return nowMs - ts <= 60000;
}

function sanitizeTickerInput(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 120);
}

function getCleanProjectorUrl(): string {
  if (typeof window === 'undefined') return '/#/projector';
  return `${window.location.origin}/#/projector`;
}

export function SettingsDrawer({
  isOpen,
  onClose,
  organization,
  onUpdateOrganization,
}: SettingsDrawerProps) {
  // 1. Tie-Breaker Engine State
  const [tieBreakerEnabled, setTieBreakerEnabled] = useState<boolean>(
    Boolean(organization.tie_breaker_enabled)
  );
  const [currentTieBreaker, setCurrentTieBreaker] = useState<TieBreakerMethod>(
    organization.tie_breaker_method || 'olympic'
  );

  // 2. Dynamic Custom Participant Fields State
  const [customFields, setCustomFields] = useState<CustomParticipantField[]>(
    organization.custom_participant_fields || []
  );
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldRequired, setNewFieldRequired] = useState(false);
  const [newFieldType, setNewFieldType] = useState<'text' | 'number'>('text');

  // 3. Global Notification Service
  const { showToast } = useToast();

  // 4. Broadcast Preferences State (Phase 14.3) & Projector Pairings (Epic 15.12 / 15.12.1)
  const [pairings, setPairings] = useState<ProjectorPairingItem[]>([]);
  const [isLoadingPairings, setIsLoadingPairings] = useState<boolean>(false);
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = useState<boolean>(false);
  const [isRevokingAll, setIsRevokingAll] = useState<boolean>(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Inline screen rename / update state
  const [editingPairingId, setEditingPairingId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string>('');
  const [updatingPairingId, setUpdatingPairingId] = useState<string | null>(null);

  // Copy projector link state
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'fallback'>('idle');
  const copyTimerRef = useRef<number | null>(null);
  const projectorLinkRef = useRef<HTMLSpanElement | null>(null);

  const [isPairSheetOpen, setIsPairSheetOpen] = useState<boolean>(false);
  const [pairCode, setPairCode] = useState<string>('');
  const [pairEventId, setPairEventId] = useState<string>('');
  const [pairLabel, setPairLabel] = useState<string>('');
  const [pairError, setPairError] = useState<string | null>(null);
  const [isPairingSubmitting, setIsPairingSubmitting] = useState<boolean>(false);
  const [pairedSuccessName, setPairedSuccessName] = useState<string | null>(null);
  const [orgEvents, setOrgEvents] = useState<SupabaseEvent[]>(() =>
    dbService.getCachedEvents(organization.org_id).filter((e) => e.status !== 'archived' && !e.is_archived)
  );

  // Broadcast Controls synced with organization server fields + local fallback
  const [blindMode, setBlindMode] = useState<boolean>(() => {
    return organization.projector_blind_mode !== undefined
      ? Boolean(organization.projector_blind_mode)
      : Boolean(dbService.getPublicSettings(organization.org_id).blindMode);
  });
  const [spotlightMode, setSpotlightMode] = useState<boolean>(() => {
    return organization.projector_spotlight_mode !== undefined
      ? Boolean(organization.projector_spotlight_mode)
      : (dbService.getPublicSettings(organization.org_id).spotlightMode ?? true);
  });
  const [tickerText, setTickerText] = useState<string>(() => {
    const initial =
      organization.projector_ticker_text !== undefined
        ? organization.projector_ticker_text
        : dbService.getPublicSettings(organization.org_id).tickerText || '';
    return sanitizeTickerInput(initial);
  });
  const [paginationTimer, setPaginationTimer] = useState<number>(() => {
    return (
      organization.projector_carousel_interval ||
      dbService.getPublicSettings(organization.org_id).paginationTimer ||
      60
    );
  });

  const tickerDebounceRef = useRef<number | null>(null);
  const intervalDebounceRef = useRef<number | null>(null);

  // 5. Intelligent Features State
  const [predictiveScheduleEnabled, setPredictiveScheduleEnabled] = useState<boolean>(() => {
    try {
      const val = localStorage.getItem('fj_predictive_schedule');
      return val !== null ? val === 'true' : true;
    } catch {
      return true;
    }
  });

  const [hapticSetting, setHapticSetting] = useState<HapticStrength>(getHapticStrength);
  const [shouldRender, setShouldRender] = useState<boolean>(isOpen);
  const [isClosing, setIsClosing] = useState<boolean>(false);

  // 5-Tap Intelligent Diagnostic State (EPIC 15.1)
  const [diagTapCount, setDiagTapCount] = useState(0);
  const [diagUnlocked, setDiagUnlocked] = useState(false);
  const [diagAnimating, setDiagAnimating] = useState(false);
  const [diagQueuePending, setDiagQueuePending] = useState<number | null>(null);
  const [isDownloadingLog, setIsDownloadingLog] = useState(false);
  const diagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleVersionTap = async () => {
    if (diagTimerRef.current) clearTimeout(diagTimerRef.current);
    const next = diagTapCount + 1;
    if (next >= 5) {
      setDiagTapCount(0);
      triggerHaptic('tick');
      const [scores, muts] = await Promise.all([
        getPendingScores().catch(() => []),
        getPendingMutations().catch(() => []),
      ]);
      const totalPending = scores.length + muts.length;
      setDiagQueuePending(totalPending);
      setDiagUnlocked(true);
      if (totalPending === 0) {
        setDiagAnimating(true);
        setTimeout(() => setDiagAnimating(false), 650);
      }
    } else {
      setDiagTapCount(next);
      diagTimerRef.current = setTimeout(() => {
        setDiagTapCount(0);
      }, 2500);
    }
  };

  const handleDownloadDiagnostic = async () => {
    try {
      setIsDownloadingLog(true);
      await downloadDiagnosticLog();
      showToast('Diagnostic log exported successfully', 'success');
    } catch {
      showToast('Failed to export diagnostic log', 'error');
    } finally {
      setIsDownloadingLog(false);
    }
  };

  // Sync state if organization prop changes
  useEffect(() => {
    setTieBreakerEnabled(Boolean(organization.tie_breaker_enabled));
    if (organization.tie_breaker_method) {
      setCurrentTieBreaker(organization.tie_breaker_method);
    }
    if (organization.custom_participant_fields) {
      setCustomFields(organization.custom_participant_fields);
    }
    if (organization.projector_blind_mode !== undefined) {
      setBlindMode(Boolean(organization.projector_blind_mode));
    }
    if (organization.projector_spotlight_mode !== undefined) {
      setSpotlightMode(Boolean(organization.projector_spotlight_mode));
    }
    if (organization.projector_ticker_text !== undefined) {
      setTickerText(sanitizeTickerInput(organization.projector_ticker_text));
    }
    if (organization.projector_carousel_interval !== undefined) {
      setPaginationTimer(organization.projector_carousel_interval);
    }
  }, [organization]);

  const loadProjectorPairings = useCallback(
    async (silent = false) => {
      if (!silent) setIsLoadingPairings(true);
      try {
        const res = await projectorService.list(organization.org_id);
        if (res.ok) {
          setPairings(res.pairings);
          setNowMs(Date.now());
        }
      } finally {
        if (!silent) setIsLoadingPairings(false);
      }
    },
    [organization.org_id]
  );

  // Live screen count (seen within last 60 seconds)
  const liveCount = useMemo(
    () => pairings.filter((p) => isScreenOnline(p.last_seen_at, nowMs)).length,
    [pairings, nowMs]
  );

  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
      setHapticSetting(getHapticStrength());
      setConfirmRevokeId(null);
      setConfirmRevokeAll(false);
      setEditingPairingId(null);
      setCopyStatus('idle');
      setNowMs(Date.now());
      void loadProjectorPairings(false);
      dbService
        .getEvents(organization.org_id)
        .then((evs) => {
          setOrgEvents((evs || []).filter((e) => e.status !== 'archived' && !e.is_archived));
        })
        .catch(() => {});
      return;
    }

    if (!shouldRender) return;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion) {
      setIsClosing(false);
      setShouldRender(false);
      setIsPairSheetOpen(false);
      return;
    }

    setIsClosing(true);
    const closeTimer = window.setTimeout(() => {
      setIsClosing(false);
      setShouldRender(false);
      setIsPairSheetOpen(false);
    }, 320);

    return () => window.clearTimeout(closeTimer);
  }, [isOpen, shouldRender, organization.org_id, loadProjectorPairings]);

  // Keep live dot & live count accurate every 5s while Settings is open
  useEffect(() => {
    if (!isOpen) return;
    const pollId = window.setInterval(() => {
      setNowMs(Date.now());
      void loadProjectorPairings(true);
    }, 5000);
    return () => window.clearInterval(pollId);
  }, [isOpen, loadProjectorPairings]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
      if (tickerDebounceRef.current) window.clearTimeout(tickerDebounceRef.current);
      if (intervalDebounceRef.current) window.clearTimeout(intervalDebounceRef.current);
    };
  }, []);

  useEffect(() => {
    if (!shouldRender || !isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (isPairSheetOpen) {
          setIsPairSheetOpen(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shouldRender, isOpen, isPairSheetOpen, onClose]);


  // 1. Toggle Tie-Breaker
  const handleToggleTieBreaker = async () => {
    triggerHaptic('tick');
    const prevVal = tieBreakerEnabled;
    const nextVal = !prevVal;
    setTieBreakerEnabled(nextVal);
    try {
      const updated = await dbService.updateOrganization(organization.org_id, {
        tie_breaker_enabled: nextVal,
      });
      onUpdateOrganization(updated);
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      showToast(
        isOffline
          ? 'Saved locally — will sync when online.'
          : nextVal
          ? 'Tie-Breaker Engine enabled.'
          : 'Tie-Breaker Engine disabled.'
      );
    } catch (err: any) {
      setTieBreakerEnabled(prevVal);
      showToast(err?.message || 'Could not update Tie-Breaker setting.', 'error');
    }
  };

  // Change Tie-Breaker Method
  const handleSelectTieBreaker = async (method: TieBreakerMethod) => {
    triggerHaptic('tick');
    const prevMethod = currentTieBreaker;
    const prevEnabled = tieBreakerEnabled;
    setCurrentTieBreaker(method);
    try {
      const updated = await dbService.updateOrganization(organization.org_id, {
        tie_breaker_method: method,
        tie_breaker_enabled: true,
      });
      setTieBreakerEnabled(true);
      onUpdateOrganization(updated);
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      showToast(
        isOffline
          ? 'Saved locally — will sync when online.'
          : `Tie-breaker standard set to ${method.toUpperCase()}.`
      );
    } catch (err: any) {
      setCurrentTieBreaker(prevMethod);
      setTieBreakerEnabled(prevEnabled);
      showToast(err?.message || 'Could not update tie-breaker method.', 'error');
    }
  };

  // 2. Custom Participant Field Handlers
  const handleAddCustomField = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFieldName.trim()) return;
    triggerHaptic('tick');

    const prevFields = customFields;
    const prevName = newFieldName;
    const prevRequired = newFieldRequired;
    const newField: CustomParticipantField = {
      id: `field_${Date.now()}`,
      name: newFieldName.trim(),
      type: newFieldType,
      required: newFieldRequired,
    };

    const nextFields = [...prevFields, newField];
    setCustomFields(nextFields);
    setNewFieldName('');
    setNewFieldRequired(false);

    try {
      const updated = await dbService.updateOrganization(organization.org_id, {
        custom_participant_fields: nextFields,
      });
      onUpdateOrganization(updated);
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      showToast(
        isOffline
          ? 'Field saved locally — will sync when online.'
          : `Field "${newField.name}" added.`
      );
    } catch (err: any) {
      setCustomFields(prevFields);
      setNewFieldName(prevName);
      setNewFieldRequired(prevRequired);
      showToast(err?.message || 'Could not add custom field.', 'error');
    }
  };

  const handleDeleteCustomField = async (fieldId: string, fieldName: string) => {
    triggerHaptic('tick');
    const prevFields = customFields;
    const nextFields = prevFields.filter((f) => f.id !== fieldId);
    setCustomFields(nextFields);

    try {
      const updated = await dbService.updateOrganization(organization.org_id, {
        custom_participant_fields: nextFields,
      });
      onUpdateOrganization(updated);
      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
      showToast(
        isOffline
          ? 'Removal saved locally — will sync when online.'
          : `Field "${fieldName}" removed.`
      );
    } catch (err: any) {
      setCustomFields(prevFields);
      showToast(err?.message || 'Could not remove custom field.', 'error');
    }
  };

  const handleOpenPairSheet = () => {
    triggerHaptic('tick');
    setPairCode('');
    setPairEventId('');
    setPairLabel('');
    setPairError(null);
    setPairedSuccessName(null);
    setIsPairSheetOpen(true);
  };

  const handleSubmitPairScreen = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = pairCode.replace(/\D/g, '');
    if (cleanCode.length !== 6) {
      setPairError('Enter the 6-digit code shown on the projector.');
      return;
    }

    setIsPairingSubmitting(true);
    setPairError(null);
    try {
      const res = await projectorService.approve({
        orgId: organization.org_id,
        code: cleanCode,
        eventId: pairEventId || null,
        label: pairLabel.trim() || null,
      });

      if (!res.ok) {
        setPairError(res.message || 'Could not pair screen. Check the code and try again.');
        return;
      }

      triggerHaptic('tick');
      const finalName = res.label || pairLabel.trim() || 'Projector Screen';
      setPairedSuccessName(finalName);
      showToast(`Paired ${finalName}`, 'success');
      void loadProjectorPairings();
    } finally {
      setIsPairingSubmitting(false);
    }
  };

  const handleConfirmRevoke = async (pairingId: string, screenName: string) => {
    triggerHaptic('tick');
    setRevokingId(pairingId);
    try {
      const res = await projectorService.revoke(organization.org_id, pairingId);
      if (res.ok) {
        setPairings((prev) => prev.filter((p) => p.id !== pairingId));
        setConfirmRevokeId(null);
        showToast(`Revoked ${screenName}.`);
      } else {
        showToast(res.message || 'Could not revoke screen.', 'error');
      }
    } finally {
      setRevokingId(null);
    }
  };

  const handleConfirmRevokeAll = async () => {
    triggerHaptic('tick');
    setIsRevokingAll(true);
    try {
      const res = await projectorService.revoke(organization.org_id, null);
      if (res.ok) {
        setPairings([]);
        setConfirmRevokeAll(false);
        setConfirmRevokeId(null);
        showToast('All paired screens disconnected.');
      } else {
        showToast(res.message || 'Could not revoke screens.', 'error');
      }
    } finally {
      setIsRevokingAll(false);
    }
  };

  const handleCopyProjectorLink = async () => {
    triggerHaptic('tick');
    const url = getCleanProjectorUrl();
    if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);

    let copied = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        copied = true;
      }
    } catch {
      copied = false;
    }

    if (!copied && typeof document !== 'undefined') {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        copied = false;
      }
    }

    if (copied) {
      setCopyStatus('copied');
      copyTimerRef.current = window.setTimeout(() => setCopyStatus('idle'), 2500);
    } else {
      setCopyStatus('fallback');
      if (projectorLinkRef.current && typeof window !== 'undefined') {
        try {
          const range = document.createRange();
          range.selectNodeContents(projectorLinkRef.current);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        } catch {}
      }
    }
  };

  const persistOrgBroadcastUpdate = async (updates: Partial<Organization>) => {
    try {
      const updated = await dbService.updateOrganization(organization.org_id, updates);
      onUpdateOrganization(updated);
    } catch {
      // Fallback: local state and localStorage already updated
    }
  };

  const handleSaveRename = async (item: ProjectorPairingItem) => {
    const clean = editingLabel.replace(/<[^>]*>/g, '').trim().slice(0, 60);
    if (!clean) {
      setEditingPairingId(null);
      return;
    }
    setUpdatingPairingId(item.id);
    try {
      const res = await projectorService.update({
        orgId: organization.org_id,
        pairingId: item.id,
        label: clean,
      });
      if (res.ok) {
        setPairings((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, label: res.label || clean } : p))
        );
        setEditingPairingId(null);
        showToast(`Renamed to ${res.label || clean}`);
      } else {
        showToast(res.message || 'Could not rename screen.', 'error');
      }
    } finally {
      setUpdatingPairingId(null);
    }
  };

  const handleChangeScreenEvent = async (item: ProjectorPairingItem, nextEventId: string) => {
    triggerHaptic('tick');
    setUpdatingPairingId(item.id);
    try {
      const evObj = orgEvents.find((e) => e.id === nextEventId);
      const res = await projectorService.update({
        orgId: organization.org_id,
        pairingId: item.id,
        eventId: nextEventId || null,
        setEvent: true,
      });
      if (res.ok) {
        setPairings((prev) =>
          prev.map((p) =>
            p.id === item.id
              ? {
                  ...p,
                  event_id: nextEventId || null,
                  event_name: nextEventId ? evObj?.name || p.event_name : null,
                }
              : p
          )
        );
        showToast(nextEventId ? `Scoped to ${evObj?.name || 'event'}` : 'Scoped to All events');
      } else {
        showToast(res.message || 'Could not update screen event.', 'error');
      }
    } finally {
      setUpdatingPairingId(null);
    }
  };

  const handleToggleScreenBlank = async (item: ProjectorPairingItem) => {
    triggerHaptic('tick');
    const nextBlank = !item.is_blank;
    setUpdatingPairingId(item.id);
    setPairings((prev) =>
      prev.map((p) => (p.id === item.id ? { ...p, is_blank: nextBlank } : p))
    );
    try {
      const res = await projectorService.update({
        orgId: organization.org_id,
        pairingId: item.id,
        isBlank: nextBlank,
      });
      if (res.ok) {
        showToast(
          nextBlank
            ? `${item.label || 'Projector Screen'} blanked.`
            : `${item.label || 'Projector Screen'} restored.`
        );
      } else {
        setPairings((prev) =>
          prev.map((p) => (p.id === item.id ? { ...p, is_blank: item.is_blank } : p))
        );
        showToast(res.message || 'Could not toggle blank screen.', 'error');
      }
    } finally {
      setUpdatingPairingId(null);
    }
  };

  if (!shouldRender) return null;

  return (
    <div
      className={`fixed inset-0 z-50 flex ${isClosing ? 'pointer-events-none' : 'pointer-events-auto'}`}
      role="dialog"
      aria-modal="true"
      aria-label="Settings and Preferences"
    >
      {/* Solid Dark Backdrop */}
      <div
        onClick={onClose}
        className={`fixed inset-0 bg-black/60 ${
          isClosing ? 'animate-backdrop-exit' : 'animate-in fade-in duration-300'
        }`}
      />

      {/* Drawer Container (Symmetric Slide-In / Slide-Out from Left) */}
      <div
        className={`relative w-full max-w-md sm:max-w-lg bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-white border-r border-stone-200 dark:border-zinc-800/80 shadow-2xl h-full flex flex-col z-10 select-none ${
          isClosing ? 'animate-spring-drawer-exit' : 'animate-spring-drawer'
        }`}
      >
        

        {/* ========================================================== */}
        {/* DRAWER HEADER (Typographic hierarchy, Framer aesthetics)   */}
        {/* ========================================================== */}
        <div className="px-5 pt-5 pb-4 shrink-0 flex items-center justify-between border-b border-stone-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-950">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500 shadow-sm shadow-emerald-500/20">
              <Sliders className="w-4.5 h-4.5 stroke-[2.2]" />
            </div>
            <div>
              <h2 className="text-base font-bold tracking-tight text-zinc-900 dark:text-white">
                Settings &amp; Preferences
              </h2>
              <p className="text-[11px] text-zinc-500 font-mono">
                {organization.name}
              </p>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <ThemeToggleButton className="w-11 h-11 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-colors duration-200 active:scale-[0.96] motion-reduce:transition-none shadow-sm flex items-center justify-center cursor-pointer" />
            <button
              type="button"
              onClick={onClose}
              className="w-11 h-11 rounded-xl text-zinc-400 hover:text-zinc-900 dark:hover:text-white bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 shadow-sm transition-colors duration-200 active:scale-[0.96] motion-reduce:transition-none flex items-center justify-center cursor-pointer"
              title="Close Drawer"
              aria-label="Close Drawer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* ========================================================== */}
        {/* DRAWER CONTENT (Framer/iOS Inset Grouped Card Layout)      */}
        {/* ========================================================== */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1 bg-stone-100/50 dark:bg-black overscroll-contain pb-20">

          {/* -------------------------------------------------------- */}
          {/* SECTION 1: PREFERENCES                                  */}
          {/* -------------------------------------------------------- */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-4">
              Preferences
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              <div className="p-4 flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-zinc-900 dark:text-white">
                  Haptics
                </span>
                <div className="inline-flex rounded-xl bg-stone-100 dark:bg-zinc-900 p-0.5 border border-stone-200 dark:border-zinc-800">
                  {(['off', 'low', 'medium', 'strong'] as const).map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      onClick={() => {
                        setHapticStrength(lvl);
                        setHapticSetting(lvl);
                        triggerHaptic('tick');
                      }}
                      className={`px-2.5 py-1 text-[10px] font-bold rounded-lg uppercase transition-colors cursor-pointer ${
                        hapticSetting === lvl
                          ? 'bg-emerald-500 text-white shadow-sm'
                          : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-white'
                      }`}
                    >
                      {lvl}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* -------------------------------------------------------- */}
          {/* SECTION 2: INTELLIGENT FORECASTING                       */}
          {/* -------------------------------------------------------- */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Intelligent Forecasting
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Predictive Schedule Estimation
                  </span>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Predicts event runtimes using live scoring speed.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tick');
                    const nextVal = !predictiveScheduleEnabled;
                    setPredictiveScheduleEnabled(nextVal);
                    try {
                      localStorage.setItem('fj_predictive_schedule', String(nextVal));
                    } catch {}
                    showToast(nextVal ? 'Predictive schedule enabled.' : 'Predictive schedule disabled.');
                  }}
                  aria-pressed={predictiveScheduleEnabled}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    predictiveScheduleEnabled ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      predictiveScheduleEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>
          </div>

          {/* -------------------------------------------------------- */}
          {/* SECTION 1.5: JURY TERMINAL RULES                         */}
          {/* -------------------------------------------------------- */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Jury Terminal Rules
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              
              {/* 1. Strict Blind Judging */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Strict Blind Judging
                  </span>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Hide names and schools to prevent bias.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    triggerHaptic('tick');
                    const nextVal = !Boolean(organization.blind_judging_enabled);
                    try {
                      const updated = await dbService.updateOrganization(organization.org_id, {
                        blind_judging_enabled: nextVal,
                      });
                      onUpdateOrganization(updated);
                      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
                      showToast(
                        isOffline
                          ? 'Saved locally — will sync when online.'
                          : nextVal
                          ? 'Blind judging enabled.'
                          : 'Blind judging disabled.'
                      );
                    } catch (err: any) {
                      showToast(err?.message || 'Could not update blind judging rule.', 'error');
                    }
                  }}
                  aria-pressed={Boolean(organization.blind_judging_enabled)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    organization.blind_judging_enabled ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      organization.blind_judging_enabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* 2. Auto-Advance */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Auto-Advance Competitor
                  </span>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Slide to next competitor upon score lock.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    triggerHaptic('tick');
                    const currentVal = organization.auto_advance_enabled !== undefined ? Boolean(organization.auto_advance_enabled) : true;
                    const nextVal = !currentVal;
                    try {
                      const updated = await dbService.updateOrganization(organization.org_id, {
                        auto_advance_enabled: nextVal,
                      });
                      onUpdateOrganization(updated);
                      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
                      showToast(
                        isOffline
                          ? 'Saved locally — will sync when online.'
                          : nextVal
                          ? 'Auto-advance enabled.'
                          : 'Auto-advance disabled.'
                      );
                    } catch (err: any) {
                      showToast(err?.message || 'Could not update auto-advance rule.', 'error');
                    }
                  }}
                  aria-pressed={organization.auto_advance_enabled !== undefined ? Boolean(organization.auto_advance_enabled) : true}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    (organization.auto_advance_enabled !== undefined ? organization.auto_advance_enabled : true) ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      (organization.auto_advance_enabled !== undefined ? organization.auto_advance_enabled : true) ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* 3. 5-Minute Grace Period */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    5-Minute Grace Period
                  </span>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Allow score adjustments for 5 minutes after locking.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    triggerHaptic('tick');
                    const nextVal = !Boolean(organization.grace_period_enabled);
                    try {
                      const updated = await dbService.updateOrganization(organization.org_id, {
                        grace_period_enabled: nextVal,
                      });
                      onUpdateOrganization(updated);
                      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
                      showToast(
                        isOffline
                          ? 'Saved locally — will sync when online.'
                          : nextVal
                          ? '5-minute grace period active.'
                          : 'Scores lock instantly.'
                      );
                    } catch (err: any) {
                      showToast(err?.message || 'Could not update grace period rule.', 'error');
                    }
                  }}
                  aria-pressed={Boolean(organization.grace_period_enabled)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    organization.grace_period_enabled ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      organization.grace_period_enabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* 4. Isolated Jury */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Isolated Jury Mode
                  </span>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Hide global progress and standings from judge.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    triggerHaptic('tick');
                    const nextVal = !Boolean(organization.isolated_jury_enabled);
                    try {
                      const updated = await dbService.updateOrganization(organization.org_id, {
                        isolated_jury_enabled: nextVal,
                      });
                      onUpdateOrganization(updated);
                      const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
                      showToast(
                        isOffline
                          ? 'Saved locally — will sync when online.'
                          : nextVal
                          ? 'Isolated jury enabled.'
                          : 'Isolated jury disabled.'
                      );
                    } catch (err: any) {
                      showToast(err?.message || 'Could not update isolated jury rule.', 'error');
                    }
                  }}
                  aria-pressed={Boolean(organization.isolated_jury_enabled)}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    organization.isolated_jury_enabled ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      organization.isolated_jury_enabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

            </div>
          </div>

          {/* -------------------------------------------------------- */}
          {/* SECTION 2: ADJUDICATION & TIE-BREAKER                    */}
          {/* -------------------------------------------------------- */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Adjudication &amp; Tie-Breaker
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Tie-Breaker Engine
                  </span>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Automated resolution applied on equal scores.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleToggleTieBreaker}
                  aria-pressed={tieBreakerEnabled}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    tieBreakerEnabled ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      tieBreakerEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {tieBreakerEnabled && (
                <>
                  {[
                    {
                      id: 'olympic' as TieBreakerMethod,
                      title: 'Olympic Standard',
                      desc: 'Drops high & low scores; averages remaining.',
                    },
                    {
                      id: 'shared' as TieBreakerMethod,
                      title: 'Head-to-Head / Shared',
                      desc: 'Joint standing podium. Preserves equal merit.',
                    },
                    {
                      id: 'manual' as TieBreakerMethod,
                      title: 'Chief Judge Adjudication',
                      desc: 'Head judge manually resolves ties with note.',
                    },
                  ].map((method) => {
                    const isSelected = currentTieBreaker === method.id;
                    return (
                      <button
                        key={method.id}
                        type="button"
                        onClick={() => handleSelectTieBreaker(method.id)}
                        className="w-full p-3.5 text-left transition-colors hover:bg-stone-50 dark:hover:bg-zinc-900/50 flex items-center justify-between gap-3 cursor-pointer"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                            {method.title}
                          </span>
                          <span className="text-[11px] text-zinc-500 truncate block mt-0.5">
                            {method.desc}
                          </span>
                        </div>
                        <div className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 ${
                          isSelected ? 'border-emerald-500 bg-emerald-500/10' : 'border-stone-300 dark:border-zinc-700'
                        }`}>
                          {isSelected && <Check className="w-3 h-3 text-emerald-500 stroke-[3]" />}
                        </div>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* -------------------------------------------------------- */}
          {/* SECTION 3: CUSTOM PARTICIPANT FIELDS                     */}
          {/* -------------------------------------------------------- */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Custom Participant Fields
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              {customFields.length === 0 ? (
                <div className="p-4 text-xs text-zinc-500 text-center font-medium">
                  Primary participant identifier. (No custom metadata added)
                </div>
              ) : (
                customFields.map((field) => (
                  <div
                    key={field.id}
                    className="p-3.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center space-x-2">
                        <span className="text-sm font-semibold text-zinc-900 dark:text-white truncate">
                          {field.name}
                        </span>
                        <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono font-bold uppercase ${
                          field.required
                            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                            : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'
                        }`}>
                          {field.required ? 'Req' : 'Opt'}
                        </span>
                      </div>
                      <span className="text-[11px] text-zinc-500 block mt-0.5 uppercase font-mono">
                        Type: {field.type || 'text'}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteCustomField(field.id, field.name)}
                      className="w-8 h-8 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors flex items-center justify-center cursor-pointer"
                      title="Remove Field"
                      aria-label={`Remove field ${field.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}

              {/* Add Field Form Row */}
              <form onSubmit={handleAddCustomField} className="p-3.5 space-y-2.5 bg-stone-50/50 dark:bg-zinc-900">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Field Name (e.g. Costume Code)"
                    value={newFieldName}
                    onChange={(e) => setNewFieldName(e.target.value)}
                    className="w-full min-h-[38px] px-3 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-emerald-500"
                  />
                  <select
                    value={newFieldType}
                    onChange={(e) => setNewFieldType(e.target.value as 'text' | 'number')}
                    className="w-full min-h-[38px] px-3 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="text">Text (e.g. Category/Track)</option>
                    <option value="number">Numeric (e.g. Bib / Age)</option>
                  </select>
                </div>

                <div className="flex items-center justify-between pt-0.5">
                  <label className="flex items-center space-x-2 text-xs text-zinc-600 dark:text-zinc-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newFieldRequired}
                      onChange={(e) => setNewFieldRequired(e.target.checked)}
                      className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-500 border-stone-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                    />
                    <span className="text-[11px] font-medium">Mandatory</span>
                  </label>

                  <button
                    type="submit"
                    disabled={!newFieldName.trim()}
                    className="min-h-[36px] px-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold text-xs rounded-xl transition-transform duration-150 motion-reduce:transition-none active:scale-[0.98] shadow-sm flex items-center space-x-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                    <span>Add Field</span>
                  </button>
                </div>
              </form>
            </div>
          </div>

          {/* -------------------------------------------------------- */}
          {/* SECTION 4: BROADCAST CONTROL ROOM (Phase 14.3 / 15.12.1) */}
          {/* -------------------------------------------------------- */}
          <div>
            <div className="flex items-center justify-between ml-4 mr-2 mb-2 mt-6">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                Broadcast Control Room
              </h4>
              <span
                aria-label="Live projector screens count"
                className="inline-flex items-center gap-1.5 text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 tabular-nums"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    liveCount > 0 ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-600'
                  }`}
                />
                <span>{liveCount} live</span>
              </span>
            </div>

            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              
              {/* 1. SCORE SECRECY (BLIND MODE) */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Score Secrecy (Blind Mode)
                  </span>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Enforced on server; hides points and reveals rankings only.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tick');
                    const next = !blindMode;
                    setBlindMode(next);
                    dbService.savePublicSettings(organization.org_id, { blindMode: next });
                    void persistOrgBroadcastUpdate({ projector_blind_mode: next });
                    showToast(next ? 'Blind Mode active on projector.' : 'Numeric scores unhidden.');
                  }}
                  aria-pressed={blindMode}
                  aria-label="Score Secrecy (Blind Mode)"
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-opacity duration-150 motion-reduce:transition-none ${
                    blindMode ? 'bg-amber-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-150 motion-reduce:transition-none ${
                      blindMode ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* 2. SPOTLIGHT / FOCUS MODE */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex items-center space-x-1.5">
                    <Focus className="w-4 h-4 text-emerald-500" />
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                      Spotlight / Focus Mode
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Auto-enlarge participant actively under jury evaluation.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tick');
                    const next = !spotlightMode;
                    setSpotlightMode(next);
                    dbService.savePublicSettings(organization.org_id, { spotlightMode: next });
                    void persistOrgBroadcastUpdate({ projector_spotlight_mode: next });
                    showToast(next ? 'Contender spotlight enabled.' : 'Spotlight disabled.');
                  }}
                  aria-pressed={spotlightMode}
                  aria-label="Spotlight / Focus Mode"
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-opacity duration-150 motion-reduce:transition-none ${
                    spotlightMode ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-150 motion-reduce:transition-none ${
                      spotlightMode ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* 3. CUSTOM BROADCAST TICKER (Plain text, max 120 chars, no HTML) */}
              <div className="p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="space-y-0.5">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                      Custom Broadcast Ticker
                    </span>
                    <p className="text-[11px] text-zinc-500">
                      Plain text announcement scrolling at the bottom of the screen.
                    </p>
                  </div>
                  <span className="font-mono text-[10px] font-bold text-zinc-500 tabular-nums shrink-0">
                    {tickerText.length}/120
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    maxLength={120}
                    placeholder="e.g. Finals award ceremony starts at 5:00 PM"
                    value={tickerText}
                    onChange={(e) => {
                      const clean = sanitizeTickerInput(e.target.value);
                      setTickerText(clean);
                      dbService.savePublicSettings(organization.org_id, { tickerText: clean });
                      if (tickerDebounceRef.current) window.clearTimeout(tickerDebounceRef.current);
                      tickerDebounceRef.current = window.setTimeout(() => {
                        void persistOrgBroadcastUpdate({ projector_ticker_text: clean });
                      }, 400);
                    }}
                    onBlur={() => {
                      if (tickerDebounceRef.current) window.clearTimeout(tickerDebounceRef.current);
                      void persistOrgBroadcastUpdate({ projector_ticker_text: tickerText });
                    }}
                    className="flex-1 min-h-[38px] px-3 bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
                  />
                  {tickerText && (
                    <button
                      type="button"
                      onClick={() => {
                        if (tickerDebounceRef.current) window.clearTimeout(tickerDebounceRef.current);
                        setTickerText('');
                        dbService.savePublicSettings(organization.org_id, { tickerText: '' });
                        void persistOrgBroadcastUpdate({ projector_ticker_text: '' });
                      }}
                      className="text-[10px] font-mono px-2.5 py-2 rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* 4. CONFETTI TRIGGER */}
              <div className="p-4 flex items-center justify-between gap-3 bg-amber-500/5 dark:bg-amber-950/20">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex items-center space-x-1.5">
                    <Sparkles className="w-4 h-4 text-amber-500" />
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                      Celebration Confetti
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Blast celebratory particle shower across the broadcast screen.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tick');
                    const nowIso = new Date().toISOString();
                    dbService.savePublicSettings(organization.org_id, { confettiTrigger: Date.now() });
                    void persistOrgBroadcastUpdate({ projector_confetti_at: nowIso });
                    window.dispatchEvent(new CustomEvent('fairjudge_confetti'));
                    showToast('Celebration confetti launched on projector!', 'success');
                  }}
                  className="min-h-[38px] px-4 bg-amber-500 hover:bg-amber-400 active:scale-95 text-black font-black text-xs uppercase tracking-wider rounded-xl transition-transform duration-150 motion-reduce:transition-none shadow-md shadow-amber-500/20 flex items-center space-x-1.5 cursor-pointer shrink-0"
                >
                  <Sparkles className="w-3.5 h-3.5 fill-black" />
                  <span>Fire Confetti</span>
                </button>
              </div>

              {/* 5. CAROUSEL INTERVAL (Single Rotation Setting) */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex items-center space-x-1.5">
                    <Clock className="w-4 h-4 text-emerald-500" />
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                      Carousel Interval
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Event rotation window duration.
                  </p>
                </div>
                <div className="flex items-center space-x-2 shrink-0">
                  <input
                    type="range"
                    min={15}
                    max={180}
                    step={5}
                    value={paginationTimer}
                    aria-label="Carousel Interval"
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setPaginationTimer(val);
                      dbService.savePublicSettings(organization.org_id, { paginationTimer: val });
                      if (intervalDebounceRef.current) window.clearTimeout(intervalDebounceRef.current);
                      intervalDebounceRef.current = window.setTimeout(() => {
                        void persistOrgBroadcastUpdate({ projector_carousel_interval: val });
                      }, 300);
                    }}
                    onPointerUp={() => {
                      if (intervalDebounceRef.current) window.clearTimeout(intervalDebounceRef.current);
                      void persistOrgBroadcastUpdate({ projector_carousel_interval: paginationTimer });
                    }}
                    className="w-20 accent-emerald-500 cursor-pointer"
                  />
                  <span className="font-mono text-xs font-bold w-12 text-right text-emerald-600 dark:text-emerald-400 tabular-nums">
                    {paginationTimer}s
                  </span>
                </div>
              </div>

            </div>
          </div>

          {/* -------------------------------------------------------- */}
          {/* SECTION 4.5: PROJECTOR (15.12 + 15.12.1)                 */}
          {/* -------------------------------------------------------- */}
          <div>
            <div className="flex items-center justify-between ml-4 mr-2 mb-2 mt-6">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                Projector
              </h4>
              <span className="text-[11px] font-mono font-bold text-zinc-500 tabular-nums">
                {pairings.length} {pairings.length === 1 ? 'screen' : 'screens'}
              </span>
            </div>

            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              {/* A1-A5: Clean Projector Address + Copy Button */}
              <div className="p-4 flex flex-wrap items-center justify-between gap-2.5 bg-stone-50/70 dark:bg-zinc-900/60">
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-0.5">
                    Projector address
                  </div>
                  <span
                    ref={projectorLinkRef}
                    className="block font-mono text-xs text-zinc-800 dark:text-zinc-200 select-all break-all"
                  >
                    {getCleanProjectorUrl()}
                  </span>
                  {copyStatus === 'fallback' && (
                    <span className="block text-[11px] text-amber-600 dark:text-amber-400 mt-1">
                      Clipboard unavailable — copy the address above.
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyProjectorLink()}
                  className="min-h-[38px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-xs font-bold text-zinc-900 dark:text-white inline-flex items-center gap-1.5 shrink-0 cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
                >
                  {copyStatus === 'copied' ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                      <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5 text-zinc-500" />
                      <span>Copy projector link</span>
                    </>
                  )}
                </button>
              </div>

              {isLoadingPairings && pairings.length === 0 ? (
                <div className="p-4 text-xs text-zinc-500">
                  Loading paired screens...
                </div>
              ) : pairings.length === 0 ? (
                <div className="p-4 text-xs text-zinc-500">
                  No screens paired yet
                </div>
              ) : (
                pairings.map((item) => {
                  const screenName = item.label || 'Projector Screen';
                  const online = isScreenOnline(item.last_seen_at, nowMs);
                  const isConfirming = confirmRevokeId === item.id;
                  const isRevoking = revokingId === item.id;
                  const isEditing = editingPairingId === item.id;
                  const isBusy = updatingPairingId === item.id || isRevoking;

                  return (
                    <div
                      key={item.id}
                      className="p-4 space-y-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          {isEditing ? (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                void handleSaveRename(item);
                              }}
                              className="flex items-center gap-1.5"
                            >
                              <input
                                type="text"
                                maxLength={60}
                                value={editingLabel}
                                onChange={(e) => setEditingLabel(e.target.value)}
                                autoFocus
                                aria-label="Rename screen"
                                className="flex-1 min-w-0 min-h-[34px] px-2.5 rounded-lg bg-stone-100 dark:bg-zinc-900 border border-stone-300 dark:border-zinc-700 text-xs font-semibold text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500"
                              />
                              <button
                                type="submit"
                                disabled={isBusy}
                                className="min-h-[34px] px-2.5 rounded-lg bg-emerald-600 text-white text-[11px] font-bold cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingPairingId(null)}
                                className="min-h-[34px] px-2 rounded-lg bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 text-[11px] font-semibold cursor-pointer"
                              >
                                Cancel
                              </button>
                            </form>
                          ) : (
                            <div className="flex items-center gap-2 min-w-0">
                              <span
                                title={online ? 'Online (seen within 60s)' : 'Offline'}
                                aria-label={online ? 'Online' : 'Offline'}
                                className={`w-2 h-2 rounded-full shrink-0 ${
                                  online ? 'bg-emerald-500' : 'bg-zinc-400 dark:bg-zinc-600'
                                }`}
                              />
                              <span className="text-sm font-semibold text-zinc-900 dark:text-white truncate">
                                {screenName}
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingPairingId(item.id);
                                  setEditingLabel(screenName);
                                }}
                                aria-label={`Rename ${screenName}`}
                                title="Rename screen"
                                className="p-1 rounded-md text-zinc-400 hover:text-zinc-900 dark:hover:text-white cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                            </div>
                          )}

                          <div className="text-[11px] text-zinc-500 font-mono flex items-center gap-1.5 flex-wrap">
                            <span>{online ? 'Online' : 'Offline'}</span>
                            <span>•</span>
                            <span>{formatLastSeen(item.last_seen_at, nowMs)}</span>
                            {item.is_blank && (
                              <>
                                <span>•</span>
                                <span className="text-amber-600 dark:text-amber-400 font-bold">
                                  Blanked
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        {isConfirming ? (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={isRevoking}
                              onClick={() => void handleConfirmRevoke(item.id, screenName)}
                              className="min-h-[36px] px-3 rounded-xl text-xs font-bold bg-amber-500 hover:bg-amber-400 text-black cursor-pointer transition-opacity duration-150 motion-reduce:transition-none disabled:opacity-50"
                            >
                              {isRevoking ? 'Revoking...' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              disabled={isRevoking}
                              onClick={() => setConfirmRevokeId(null)}
                              className="min-h-[36px] px-2.5 rounded-xl text-xs font-semibold bg-stone-100 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-300 border border-stone-200 dark:border-zinc-800 cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmRevokeId(item.id)}
                            className="min-h-[36px] px-3 rounded-xl text-xs font-semibold bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 shrink-0 cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
                          >
                            Revoke
                          </button>
                        )}
                      </div>

                      {/* C2 & C4: Per-screen Event selector + Blank screen toggle */}
                      <div className="flex items-center justify-between gap-2.5 pt-1">
                        <select
                          aria-label={`Event for ${screenName}`}
                          value={item.event_id || ''}
                          disabled={isBusy}
                          onChange={(e) => void handleChangeScreenEvent(item, e.target.value)}
                          className="flex-1 min-w-0 min-h-[36px] px-2.5 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-xs font-semibold text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                        >
                          <option value="">All events</option>
                          {orgEvents.map((ev) => (
                            <option key={ev.id} value={ev.id}>
                              {ev.name}
                            </option>
                          ))}
                        </select>

                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">
                            Blank
                          </span>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={item.is_blank}
                            aria-label={`Blank ${screenName}`}
                            disabled={isBusy}
                            onClick={() => void handleToggleScreenBlank(item)}
                            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-opacity duration-150 motion-reduce:transition-none disabled:opacity-50 ${
                              item.is_blank ? 'bg-amber-500' : 'bg-stone-300 dark:bg-zinc-700'
                            }`}
                          >
                            <span
                              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform duration-150 motion-reduce:transition-none ${
                                item.is_blank ? 'translate-x-5' : 'translate-x-0'
                              }`}
                            />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}

              <div className="p-3.5 bg-stone-50/50 dark:bg-zinc-900 space-y-2">
                <button
                  type="button"
                  onClick={handleOpenPairSheet}
                  className="w-full min-h-[44px] bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-transform duration-150 motion-reduce:transition-none active:scale-[0.98] cursor-pointer shadow-sm"
                >
                  <Monitor className="w-4 h-4" />
                  <span>Pair a screen</span>
                </button>

                {pairings.length > 0 && (
                  confirmRevokeAll ? (
                    <div className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/10 flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                        Revoke all {pairings.length} {pairings.length === 1 ? 'screen' : 'screens'}?
                      </span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={isRevokingAll}
                          onClick={() => void handleConfirmRevokeAll()}
                          className="min-h-[34px] px-3 rounded-lg bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold cursor-pointer transition-opacity duration-150 motion-reduce:transition-none disabled:opacity-50"
                        >
                          {isRevokingAll ? 'Revoking...' : 'Confirm'}
                        </button>
                        <button
                          type="button"
                          disabled={isRevokingAll}
                          onClick={() => setConfirmRevokeAll(false)}
                          className="min-h-[34px] px-2.5 rounded-lg bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-semibold cursor-pointer"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmRevokeId(null);
                        setConfirmRevokeAll(true);
                      }}
                      className="w-full min-h-[40px] rounded-xl text-xs font-semibold bg-amber-500/10 hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 border border-amber-500/30 cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
                    >
                      Revoke all
                    </button>
                  )
                )}
              </div>
            </div>
          </div>

          {/* -------------------------------------------------------- */}
          {/* SECTION 5: EXECUTIVE ABOUT CARD                          */}
          {/* Signature Hardware: About + Self-Test Terminal (Epic 15.4) */}
          <div className="pt-3 pb-2">
            <SignatureHardware role="organiser" />
          </div>

        </div>
      </div>

      {/* ========================================================== */}
      {/* PAIR A SCREEN SHEET (No backdrop-filter, reduced-motion)   */}
      {/* ========================================================== */}
      {isPairSheetOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Pair a screen"
        >
          <div
            onClick={() => !isPairingSubmitting && setIsPairSheetOpen(false)}
            className="fixed inset-0 bg-black/60 animate-in fade-in duration-200 motion-reduce:animate-none"
          />

          <div className="relative z-10 w-full sm:max-w-sm bg-white dark:bg-zinc-950 text-zinc-900 dark:text-white border-t sm:border border-stone-200 dark:border-zinc-800 rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden animate-spring-sheet motion-reduce:animate-none">
            <div className="px-5 py-4 border-b border-stone-200 dark:border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500">
                  <Monitor className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-bold tracking-tight">Pair a screen</h3>
              </div>
              <button
                type="button"
                onClick={() => !isPairingSubmitting && setIsPairSheetOpen(false)}
                className="w-9 h-9 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-500 hover:text-zinc-900 dark:hover:text-white flex items-center justify-center cursor-pointer transition-colors duration-150 motion-reduce:transition-none"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {pairedSuccessName ? (
              <div className="p-5 space-y-4 text-center">
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500 mx-auto">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <div className="text-base font-bold text-zinc-900 dark:text-white">
                    Paired
                  </div>
                  <p className="text-xs text-zinc-500 font-mono">
                    {pairedSuccessName}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsPairSheetOpen(false)}
                  className="w-full min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
                >
                  Done
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmitPairScreen} className="p-5 space-y-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="fj-pair-code"
                    className="block text-[11px] font-bold uppercase tracking-wider text-zinc-500"
                  >
                    6-Digit Code
                  </label>
                  <input
                    id="fj-pair-code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoFocus
                    maxLength={6}
                    placeholder="000000"
                    value={pairCode}
                    onChange={(e) => {
                      setPairCode(e.target.value.replace(/\D/g, '').slice(0, 6));
                      if (pairError) setPairError(null);
                    }}
                    className="w-full min-h-[52px] px-4 bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl font-mono text-2xl font-black tracking-[0.3em] text-center text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-emerald-500 tabular-nums"
                  />
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="fj-pair-event"
                    className="block text-[11px] font-bold uppercase tracking-wider text-zinc-500"
                  >
                    Event Scope (Optional)
                  </label>
                  <select
                    id="fj-pair-event"
                    value={pairEventId}
                    onChange={(e) => setPairEventId(e.target.value)}
                    className="w-full min-h-[44px] px-3 bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs font-semibold text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">All events</option>
                    {orgEvents.map((ev) => (
                      <option key={ev.id} value={ev.id}>
                        {ev.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="fj-pair-label"
                    className="block text-[11px] font-bold uppercase tracking-wider text-zinc-500"
                  >
                    Screen Name (Optional)
                  </label>
                  <input
                    id="fj-pair-label"
                    type="text"
                    maxLength={40}
                    placeholder="e.g. Main Hall"
                    value={pairLabel}
                    onChange={(e) => setPairLabel(e.target.value)}
                    className="w-full min-h-[44px] px-3 bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                {pairError && (
                  <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                    {pairError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={isPairingSubmitting || pairCode.length !== 6}
                  className="w-full min-h-[46px] rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold text-xs cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
                >
                  {isPairingSubmitting ? 'Pairing...' : 'Pair screen'}
                </button>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export { SettingsDrawer as OrganiserDrawer };
