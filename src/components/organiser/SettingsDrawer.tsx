import React, { useState, useEffect, useRef } from 'react';
import { 
  X, 
  Scale, 
  Plus, 
  Trash2, 
  Check, 
  Copy, 
  ExternalLink, 
  CheckCircle2,
  Sliders,
  Sparkles,
  Radio,
  FileText,
  Eye,
  EyeOff,
  QrCode,
  Focus,
  Clock,
  Send,
  Download,
  AlertTriangle
} from 'lucide-react';
import { Organization, TieBreakerMethod, CustomParticipantField } from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';
import { ThemeToggleButton } from '../../lib/theme';
import { useToast } from '../common/ToastProvider';
import { getHapticStrength, setHapticStrength, triggerHaptic, HapticStrength } from '../../lib/haptics';
import { APP_VERSION } from '../../config/version';
import { downloadDiagnosticLog, getPendingScores, getPendingMutations } from '../../lib/offlineQueue';
import { SignatureHardware } from '../shared/SignatureHardware';

export interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  organization: Organization;
  onUpdateOrganization: (updated: Organization) => void;
  onOpenPublicView: (eventId?: string) => void;
}

export type OrganiserDrawerProps = SettingsDrawerProps;

export function SettingsDrawer({
  isOpen,
  onClose,
  organization,
  onUpdateOrganization,
  onOpenPublicView,
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

  // 4. Public Leaderboard & Broadcast Preferences State (Phase 14.3)
  const [leaderboardDelay, setLeaderboardDelay] = useState<number>(30);
  const [roundOffScores, setRoundOffScores] = useState<boolean>(true);
  const [isPublicPublished, setIsPublicPublished] = useState<boolean>(true);
  const [copiedPublicLink, setCopiedPublicLink] = useState(false);

  // The 6 Explicit Broadcast Controls
  const [blindMode, setBlindMode] = useState<boolean>(() => {
    return Boolean(dbService.getPublicSettings(organization.org_id).blindMode);
  });
  const [spotlightMode, setSpotlightMode] = useState<boolean>(() => {
    return dbService.getPublicSettings(organization.org_id).spotlightMode ?? true;
  });
  const [tickerText, setTickerText] = useState<string>(() => {
    return dbService.getPublicSettings(organization.org_id).tickerText || '';
  });
  const [showAppQr, setShowAppQr] = useState<boolean>(() => {
    return Boolean(dbService.getPublicSettings(organization.org_id).showAppQr);
  });
  const [paginationTimer, setPaginationTimer] = useState<number>(() => {
    return dbService.getPublicSettings(organization.org_id).paginationTimer || 60;
  });

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
  }, [organization]);

  useEffect(() => {
    if (isOpen) {
      setHapticSetting(getHapticStrength());
    }
  }, [isOpen]);


  // 1. Toggle Tie-Breaker
  const handleToggleTieBreaker = async () => {
    triggerHaptic('tick');
    const nextVal = !tieBreakerEnabled;
    setTieBreakerEnabled(nextVal);
    try {
      const updated = await dbService.updateOrganization(organization.org_id, {
        tie_breaker_enabled: nextVal,
      });
      onUpdateOrganization(updated);
      showToast(nextVal ? 'Tie-Breaker Engine enabled.' : 'Tie-Breaker Engine disabled.');
    } catch {
      showToast('Setting updated locally.');
    }
  };

  // Change Tie-Breaker Method
  const handleSelectTieBreaker = async (method: TieBreakerMethod) => {
    triggerHaptic('tick');
    setCurrentTieBreaker(method);
    try {
      const updated = await dbService.updateOrganization(organization.org_id, {
        tie_breaker_method: method,
        tie_breaker_enabled: true,
      });
      setTieBreakerEnabled(true);
      onUpdateOrganization(updated);
      showToast(`Tie-breaker standard set to ${method.toUpperCase()}.`);
    } catch {
      showToast(`Method updated to ${method.toUpperCase()}.`);
    }
  };

  // 2. Custom Participant Field Handlers
  const handleAddCustomField = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFieldName.trim()) return;
    triggerHaptic('tick');

    const newField: CustomParticipantField = {
      id: `field_${Date.now()}`,
      name: newFieldName.trim(),
      type: newFieldType,
      required: newFieldRequired,
    };

    const nextFields = [...customFields, newField];
    setCustomFields(nextFields);
    setNewFieldName('');
    setNewFieldRequired(false);

    try {
      const updated = await dbService.updateOrganization(organization.org_id, {
        custom_participant_fields: nextFields,
      });
      onUpdateOrganization(updated);
      showToast(`Field "${newField.name}" added.`);
    } catch {
      showToast('Added locally.');
    }
  };

  const handleDeleteCustomField = async (fieldId: string, fieldName: string) => {
    triggerHaptic('tick');
    const nextFields = customFields.filter((f) => f.id !== fieldId);
    setCustomFields(nextFields);

    try {
      const updated = await dbService.updateOrganization(organization.org_id, {
        custom_participant_fields: nextFields,
      });
      onUpdateOrganization(updated);
      showToast(`Field "${fieldName}" removed.`);
    } catch {
      showToast('Removed locally.');
    }
  };

  const handleCopyPublicLink = () => {
    const url = `${window.location.origin}/?view=public&orgId=${organization.org_id}`;
    navigator.clipboard.writeText(url);
    setCopiedPublicLink(true);
    showToast('Public projector link copied.');
    setTimeout(() => setCopiedPublicLink(false), 2200);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div 
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-300"
      />

      {/* Drawer Container (Sliding from Left) */}
      <div className="relative w-full max-w-md sm:max-w-lg bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-white border-r border-stone-200 dark:border-zinc-800/80 shadow-2xl h-full flex flex-col z-10 animate-spring-drawer select-none">
        

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
            <ThemeToggleButton className="w-10 h-10 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-all duration-200 active:scale-[0.96] shadow-sm flex items-center justify-center cursor-pointer" />
            <button
              onClick={onClose}
              className="w-10 h-10 rounded-xl text-zinc-400 hover:text-zinc-900 dark:hover:text-white bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 shadow-sm transition-all duration-200 active:scale-[0.96] flex items-center justify-center cursor-pointer"
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
                      showToast(nextVal ? 'Blind judging enabled.' : 'Blind judging disabled.');
                    } catch {
                      showToast('Updated locally.');
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
                      showToast(nextVal ? 'Auto-advance enabled.' : 'Auto-advance disabled.');
                    } catch {
                      showToast('Updated locally.');
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
                      showToast(nextVal ? '5-minute grace period active.' : 'Scores lock instantly.');
                    } catch {
                      showToast('Updated locally.');
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
                      showToast(nextVal ? 'Isolated jury enabled.' : 'Isolated jury disabled.');
                    } catch {
                      showToast('Updated locally.');
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
                    className="min-h-[36px] px-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold text-xs rounded-xl transition-all active:scale-[0.98] shadow-sm flex items-center space-x-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                    <span>Add Field</span>
                  </button>
                </div>
              </form>
            </div>
          </div>

          {/* -------------------------------------------------------- */}
          {/* SECTION 4: BROADCAST CONTROL ROOM (Phase 14.3)           */}
          {/* -------------------------------------------------------- */}
          <div>
            <div className="flex items-center justify-between ml-4 mr-2 mb-2 mt-6">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                Broadcast Control Room
              </h4>
              <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-md bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                Projector Live
              </span>
            </div>

            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              
              {/* 1. SCORE SECRECY (BLIND MODE) */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex items-center space-x-1.5">
                    {blindMode ? <EyeOff className="w-4 h-4 text-amber-500" /> : <Eye className="w-4 h-4 text-zinc-500" />}
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                      Score Secrecy (Blind Mode)
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Hide actual points; show relative standings only.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tick');
                    const next = !blindMode;
                    setBlindMode(next);
                    dbService.savePublicSettings(organization.org_id, { blindMode: next });
                    showToast(next ? 'Blind Mode active on projector.' : 'Numeric scores unhidden.');
                  }}
                  aria-pressed={blindMode}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
                    blindMode ? 'bg-amber-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
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
                    showToast(next ? 'Contender spotlight enabled.' : 'Spotlight disabled.');
                  }}
                  aria-pressed={spotlightMode}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
                    spotlightMode ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                      spotlightMode ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* 3. CUSTOM BROADCAST TICKER */}
              <div className="p-4 space-y-2">
                <div className="space-y-0.5">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Custom Broadcast Ticker
                  </span>
                  <p className="text-[11px] text-zinc-500">
                    Live announcement marquee scrolling at the bottom of the screen.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="e.g. Finals award ceremony starts at 5:00 PM • Audited by Jury"
                    value={tickerText}
                    onChange={(e) => {
                      const text = e.target.value;
                      setTickerText(text);
                      dbService.savePublicSettings(organization.org_id, { tickerText: text });
                    }}
                    className="flex-1 min-h-[38px] px-3 bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
                  />
                  {tickerText && (
                    <button
                      type="button"
                      onClick={() => {
                        setTickerText('');
                        dbService.savePublicSettings(organization.org_id, { tickerText: '' });
                      }}
                      className="text-[10px] font-mono px-2 py-2 text-zinc-400 hover:text-white"
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
                    dbService.savePublicSettings(organization.org_id, { confettiTrigger: Date.now() });
                    window.dispatchEvent(new CustomEvent('fairjudge_confetti'));
                    showToast('Celebration confetti launched on projector!', 'success');
                  }}
                  className="min-h-[38px] px-4 bg-amber-500 hover:bg-amber-400 active:scale-95 text-black font-black text-xs uppercase tracking-wider rounded-xl transition-all shadow-md shadow-amber-500/20 flex items-center space-x-1.5 cursor-pointer shrink-0"
                >
                  <Sparkles className="w-3.5 h-3.5 fill-black" />
                  <span>Fire Confetti</span>
                </button>
              </div>

              {/* 5. APP LOGIN QR */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex items-center space-x-1.5">
                    <QrCode className="w-4 h-4 text-emerald-500" />
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                      App Spectator QR
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Show public web QR badge for audience &amp; spectator access.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    triggerHaptic('tick');
                    const next = !showAppQr;
                    setShowAppQr(next);
                    dbService.savePublicSettings(organization.org_id, { showAppQr: next });
                    showToast(next ? 'Spectator QR enabled on screen.' : 'Spectator QR hidden.');
                  }}
                  aria-pressed={showAppQr}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
                    showAppQr ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                      showAppQr ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* 6. CUSTOM PAGINATION TIMER */}
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
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setPaginationTimer(val);
                      dbService.savePublicSettings(organization.org_id, { paginationTimer: val });
                    }}
                    className="w-20 accent-emerald-500 cursor-pointer"
                  />
                  <span className="font-mono text-xs font-bold w-12 text-right text-emerald-600 dark:text-emerald-400">
                    {paginationTimer}s
                  </span>
                </div>
              </div>

              {/* Projector Action Buttons */}
              <div className="p-3.5 space-y-2 bg-stone-50/50 dark:bg-zinc-900">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenPublicView();
                  }}
                  className="w-full min-h-[42px] bg-zinc-900 dark:bg-white text-white dark:text-black rounded-xl font-bold text-xs flex items-center justify-center space-x-2 transition-all active:scale-[0.98] cursor-pointer shadow-sm"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Launch Projector</span>
                </button>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handleCopyPublicLink}
                    className="min-h-[38px] bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-200 border border-stone-200 dark:border-zinc-800 rounded-xl font-semibold text-xs flex items-center justify-center space-x-1.5 transition-all active:scale-[0.98] cursor-pointer"
                  >
                    {copiedPublicLink ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5 text-zinc-400" />}
                    <span>{copiedPublicLink ? 'Copied' : 'Copy Link'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      const next = !isPublicPublished;
                      setIsPublicPublished(next);
                      showToast(next ? 'Public link published.' : 'Public link revoked.');
                    }}
                    className={`min-h-[38px] rounded-xl text-xs font-semibold transition-all active:scale-[0.98] cursor-pointer flex items-center justify-center space-x-1.5 ${
                      isPublicPublished
                        ? 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20'
                        : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                    }`}
                  >
                    <span>{isPublicPublished ? 'Revoke Link' : 'Publish Link'}</span>
                  </button>
                </div>
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
    </div>
  );
}

export { SettingsDrawer as OrganiserDrawer };
