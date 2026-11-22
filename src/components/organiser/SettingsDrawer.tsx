import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Trash2,
  Check,
  Sliders,
  Focus,
} from 'lucide-react';
import { Organization, TieBreakerMethod, CustomParticipantField } from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';
import { ThemeToggleButton } from '../../lib/theme';
import { useToast } from '../common/ToastProvider';
import { SidePanel } from '../common/SidePanel';
import { getHapticStrength, setHapticStrength, triggerHaptic, HapticStrength } from '../../lib/haptics';
import { getSoundLevel, setSoundLevel, playSound, SOUND_CHANGE_EVENT, SoundLevel } from '../../lib/sound';
import { APP_VERSION } from '../../config/version';
import { downloadDiagnosticLog, getPendingScores, getPendingMutations } from '../../lib/offlineQueue';
import { SignatureHardware } from '../shared/SignatureHardware';

export interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  organization: Organization;
  onUpdateOrganization: (updated: Organization) => void;
}

export type OrganiserDrawerProps = SettingsDrawerProps;

function sanitizeTickerInput(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 120);
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

  // 4. Broadcast Controls synced with organization server fields + local fallback
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

  const tickerDebounceRef = useRef<number | null>(null);

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
  const [soundSetting, setSoundSetting] = useState<SoundLevel>(() => getSoundLevel());

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
    if (organization.projector_spotlight_mode !== undefined) {
      setSpotlightMode(Boolean(organization.projector_spotlight_mode));
    }
    if (organization.projector_ticker_text !== undefined) {
      setTickerText(sanitizeTickerInput(organization.projector_ticker_text));
    }
  }, [organization]);

  useEffect(() => {
    if (isOpen) {
      setHapticSetting(getHapticStrength());
      setSoundSetting(getSoundLevel());
    }
  }, [isOpen]);

  useEffect(() => {
    const syncSound = () => setSoundSetting(getSoundLevel());
    window.addEventListener(SOUND_CHANGE_EVENT, syncSound);
    return () => {
      window.removeEventListener(SOUND_CHANGE_EVENT, syncSound);
      if (tickerDebounceRef.current) window.clearTimeout(tickerDebounceRef.current);
    };
  }, []);


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

  const persistOrgBroadcastUpdate = async (updates: Partial<Organization>) => {
    try {
      const updated = await dbService.updateOrganization(organization.org_id, updates);
      onUpdateOrganization(updated);
    } catch {
      // Fallback: local state and localStorage already updated
    }
  };

  return (
      <SidePanel
        isOpen={isOpen}
        onClose={onClose}
        title="Settings & Preferences"
        subtitle={organization.name}
        ariaLabel="Settings and Preferences"
        icon={<Sliders className="w-4.5 h-4.5 stroke-[2.2]" />}
        headerActions={
          <ThemeToggleButton className="w-11 h-11 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-colors duration-200 active:scale-[0.96] motion-reduce:transition-none shadow-sm flex items-center justify-center cursor-pointer" />
        }
        closeAriaLabel="Close Drawer"
      >

          {/* -------------------------------------------------------- */}
          {/* SECTION 1: PREFERENCES                                  */}
          {/* -------------------------------------------------------- */}
          <div>
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-4">
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
                      className={`px-2.5 py-1 md:min-h-[44px] md:min-w-[44px] text-[10px] lg:text-xs font-bold rounded-lg uppercase transition-colors cursor-pointer ${
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

              <div className="p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Sound Effects
                  </span>
                  <p className="text-[11px] lg:text-sm text-zinc-600 dark:text-zinc-400">
                    Boot chime, alerts &amp; action feedback.
                  </p>
                </div>
                <div
                  role="group"
                  aria-label="Sound effects level"
                  className="inline-flex shrink-0 rounded-xl bg-stone-100 dark:bg-zinc-900 p-0.5 border border-stone-200 dark:border-zinc-800"
                >
                  {(['off', 'soft', 'crisp'] as const).map((lvl) => (
                    <button
                      key={lvl}
                      type="button"
                      aria-pressed={soundSetting === lvl}
                      onClick={() => {
                        setSoundLevel(lvl);
                        setSoundSetting(lvl);
                        triggerHaptic('tick');
                        if (lvl !== 'off') playSound('tap');
                      }}
                      className={`min-h-[36px] md:min-h-[44px] md:min-w-[44px] px-2.5 py-1 text-[10px] lg:text-xs font-bold rounded-lg uppercase transition-colors cursor-pointer ${
                        soundSetting === lvl
                          ? 'bg-emerald-700 text-white shadow-sm'
                          : 'text-zinc-700 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white'
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
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Intelligent Forecasting
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Predictive Schedule Estimation
                  </span>
                  <p className="text-[11px] lg:text-sm text-zinc-500 truncate">
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
                  <span aria-hidden="true" className="md:block md:absolute md:-inset-y-2.5 md:inset-x-0" />
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
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Jury Terminal Rules
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              
              {/* 1. Strict Blind Judging */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Strict Blind Judging
                  </span>
                  <p className="text-[11px] lg:text-sm text-zinc-500 truncate">
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
                  <span aria-hidden="true" className="md:block md:absolute md:-inset-y-2.5 md:inset-x-0" />
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
                  <p className="text-[11px] lg:text-sm text-zinc-500 truncate">
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
                  <span aria-hidden="true" className="md:block md:absolute md:-inset-y-2.5 md:inset-x-0" />
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
                  <p className="text-[11px] lg:text-sm text-zinc-500 truncate">
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
                  <span aria-hidden="true" className="md:block md:absolute md:-inset-y-2.5 md:inset-x-0" />
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
                  <p className="text-[11px] lg:text-sm text-zinc-500 truncate">
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
                  <span aria-hidden="true" className="md:block md:absolute md:-inset-y-2.5 md:inset-x-0" />
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
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Adjudication &amp; Tie-Breaker
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Tie-Breaker Engine
                  </span>
                  <p className="text-[11px] lg:text-sm text-zinc-500 truncate">
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
                  <span aria-hidden="true" className="md:block md:absolute md:-inset-y-2.5 md:inset-x-0" />
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
                          <span className="text-[11px] lg:text-sm text-zinc-500 truncate block mt-0.5">
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
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Custom Participant Fields
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              {customFields.length === 0 ? (
                <div className="p-4 text-xs lg:text-sm text-zinc-500 text-center font-medium">
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
                        <span className={`text-[9px] lg:text-xs px-1.5 py-0.5 rounded font-mono font-bold uppercase ${
                          field.required
                            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
                            : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500'
                        }`}>
                          {field.required ? 'Req' : 'Opt'}
                        </span>
                      </div>
                      <span className="text-[11px] lg:text-sm text-zinc-500 block mt-0.5 uppercase font-mono">
                        Type: {field.type || 'text'}
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleDeleteCustomField(field.id, field.name)}
                      className="w-8 h-8 md:w-11 md:h-11 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors flex items-center justify-center cursor-pointer"
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
                    className="w-full min-h-[38px] md:min-h-[44px] px-3 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-emerald-500"
                  />
                  <select
                    value={newFieldType}
                    onChange={(e) => setNewFieldType(e.target.value as 'text' | 'number')}
                    className="w-full min-h-[38px] md:min-h-[44px] px-3 bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="text">Text (e.g. Category/Track)</option>
                    <option value="number">Numeric (e.g. Bib / Age)</option>
                  </select>
                </div>

                <div className="flex items-center justify-between pt-0.5">
                  <label className="flex items-center space-x-2 md:min-h-[44px] text-xs lg:text-sm text-zinc-600 dark:text-zinc-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newFieldRequired}
                      onChange={(e) => setNewFieldRequired(e.target.checked)}
                      className="w-4 h-4 rounded text-emerald-500 focus:ring-emerald-500 border-stone-300 dark:border-zinc-700 bg-white dark:bg-zinc-900"
                    />
                    <span className="text-[11px] lg:text-sm font-medium">Mandatory</span>
                  </label>

                  <button
                    type="submit"
                    disabled={!newFieldName.trim()}
                    className="min-h-[36px] md:min-h-[44px] px-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold text-xs lg:text-sm rounded-xl transition-transform duration-150 motion-reduce:transition-none active:scale-[0.98] shadow-sm flex items-center space-x-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                    <span>Add Field</span>
                  </button>
                </div>
              </form>
            </div>
          </div>

          {/* -------------------------------------------------------- */}
          {/* SECTION 4: BROADCAST CONTROL ROOM                        */}
          {/* -------------------------------------------------------- */}
          <div>
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Broadcast Control Room
            </h4>

            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">

              {/* 2. SPOTLIGHT / FOCUS MODE */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex items-center space-x-1.5">
                    <Focus className="w-4 h-4 text-emerald-500" />
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                      Spotlight / Focus Mode
                    </span>
                  </div>
                  <p className="text-[11px] lg:text-sm text-zinc-500 truncate">
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
                  <span aria-hidden="true" className="md:block md:absolute md:-inset-y-2.5 md:inset-x-0" />
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
                    <p className="text-[11px] lg:text-sm text-zinc-500">
                      Plain text announcement scrolling at the bottom of the screen.
                    </p>
                  </div>
                  <span className="font-mono text-[10px] lg:text-xs font-bold text-zinc-500 tabular-nums shrink-0">
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
                    className="flex-1 min-h-[38px] md:min-h-[44px] px-3 bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white placeholder-zinc-500 focus:outline-none focus:border-emerald-500"
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
                      className="text-[10px] lg:text-sm font-mono px-2.5 py-2 md:min-h-[44px] md:min-w-[44px] rounded-lg text-zinc-500 hover:text-zinc-900 dark:hover:text-white cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
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
      </SidePanel>
  );
}

export { SettingsDrawer as OrganiserDrawer };
