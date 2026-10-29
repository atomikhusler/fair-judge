import React, { useState, useEffect } from 'react';
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
  FileText
} from 'lucide-react';
import { Organization, TieBreakerMethod, CustomParticipantField } from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';
import { ThemeToggleButton } from '../../lib/theme';

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

  // 3. Notification State
  const [drawerToast, setDrawerToast] = useState<string | null>(null);

  // 4. Public Leaderboard Preferences State
  const [leaderboardDelay, setLeaderboardDelay] = useState<number>(30);
  const [roundOffScores, setRoundOffScores] = useState<boolean>(true);
  const [displayMode, setDisplayMode] = useState<'full' | 'rank_only'>('full');
  const [isPublicPublished, setIsPublicPublished] = useState<boolean>(true);
  const [copiedPublicLink, setCopiedPublicLink] = useState(false);

  // 5. Intelligent Features State
  const [predictiveScheduleEnabled, setPredictiveScheduleEnabled] = useState<boolean>(() => {
    try {
      const val = localStorage.getItem('fj_predictive_schedule');
      return val !== null ? val === 'true' : true;
    } catch {
      return true;
    }
  });

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

  const showToast = (msg: string) => {
    setDrawerToast(msg);
    setTimeout(() => setDrawerToast(null), 2800);
  };

  // 1. Toggle Tie-Breaker
  const handleToggleTieBreaker = async () => {
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
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity duration-300"
      />

      {/* Drawer Container (Sliding from Left) */}
      <div className="relative w-full max-w-md sm:max-w-lg bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-white border-r border-stone-200 dark:border-zinc-800/80 shadow-2xl h-full flex flex-col z-10 animate-in slide-in-from-left duration-300 select-none">
        
        {/* Floating Toast Notification */}
        {drawerToast && (
          <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 w-11/12 max-w-sm pointer-events-none animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="py-2.5 px-4 rounded-full bg-zinc-900/95 dark:bg-zinc-800/95 text-white border border-zinc-700/60 shadow-2xl backdrop-blur-md flex items-center justify-center space-x-2 text-center text-xs font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate">{drawerToast}</span>
            </div>
          </div>
        )}

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
          {/* SECTION 1: INTELLIGENT FORECASTING                       */}
          {/* -------------------------------------------------------- */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-4">
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
              <form onSubmit={handleAddCustomField} className="p-3.5 space-y-2.5 bg-stone-50/50 dark:bg-zinc-900/30">
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
          {/* SECTION 4: PUBLIC PROJECTOR PREFERENCES                  */}
          {/* -------------------------------------------------------- */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Public Projector Preferences
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              {/* Broadcast Delay */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Broadcast Latency
                  </span>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Hold score reveal on live projector.
                  </p>
                </div>
                <div className="flex items-center space-x-1.5 shrink-0">
                  <input
                    type="number"
                    min={0}
                    max={300}
                    value={leaderboardDelay}
                    onChange={(e) => setLeaderboardDelay(Number(e.target.value))}
                    className="w-16 min-h-[38px] px-2 bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl font-mono text-xs text-center text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500"
                  />
                  <span className="text-xs font-mono text-zinc-500">sec</span>
                </div>
              </div>

              {/* Score Round-off */}
              <div className="p-4 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Score Round-Off
                  </span>
                  <p className="text-[11px] text-zinc-500 truncate">
                    Standardize to 2 decimals on display.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setRoundOffScores(!roundOffScores)}
                  aria-pressed={roundOffScores}
                  className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${
                    roundOffScores ? 'bg-emerald-500' : 'bg-stone-300 dark:bg-zinc-700'
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                      roundOffScores ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* Display Mode */}
              <div className="p-4 space-y-2">
                <div className="space-y-0.5">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Display Mode
                  </span>
                  <p className="text-[11px] text-zinc-500">
                    Full scores or blind rank-only.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setDisplayMode('full')}
                    className={`min-h-[40px] px-3 rounded-xl text-xs font-semibold transition-all active:scale-[0.98] cursor-pointer ${
                      displayMode === 'full'
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 font-bold'
                        : 'bg-stone-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border border-stone-200/50 dark:border-zinc-800/50'
                    }`}
                  >
                    Full List &amp; Scores
                  </button>
                  <button
                    type="button"
                    onClick={() => setDisplayMode('rank_only')}
                    className={`min-h-[40px] px-3 rounded-xl text-xs font-semibold transition-all active:scale-[0.98] cursor-pointer ${
                      displayMode === 'rank_only'
                        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 font-bold'
                        : 'bg-stone-100 dark:bg-zinc-900 text-zinc-500 dark:text-zinc-400 border border-stone-200/50 dark:border-zinc-800/50'
                    }`}
                  >
                    Rank Only (Blind)
                  </button>
                </div>
              </div>

              {/* Projector Action Buttons */}
              <div className="p-3.5 space-y-2 bg-stone-50/50 dark:bg-zinc-900/30">
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
          {/* -------------------------------------------------------- */}
          <div className="pt-4 pb-2">
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200/90 dark:border-zinc-800/90 p-5 shadow-xs text-center space-y-3">
              {/* App Icon */}
              <div className="w-11 h-11 rounded-2xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center mx-auto text-emerald-600 dark:text-emerald-400 shadow-xs">
                <Scale className="w-5 h-5 stroke-[2.2]" />
              </div>

              {/* Title & Version */}
              <div className="space-y-1">
                <div className="flex items-center justify-center space-x-2">
                  <span className="text-base font-black text-zinc-900 dark:text-white tracking-tight">
                    Fair Judge
                  </span>
                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                    v1.0.4 PRO
                  </span>
                </div>
                <p className="text-[11px] font-mono text-zinc-500 tracking-wide">
                  Offline-First Cryptographic Scoring Engine
                </p>
              </div>

              {/* Status Indicator */}
              <div className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full bg-stone-100 dark:bg-zinc-900 border border-stone-200/60 dark:border-zinc-800 text-[10px] font-semibold text-zinc-600 dark:text-zinc-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span>Operational • Local Ledger Sync</span>
              </div>

              {/* Engineered by Sahil Kumar Rout */}
              <div className="pt-2 border-t border-stone-100 dark:border-zinc-800/60">
                <p className="text-[11px] text-zinc-500">
                  Engineered by{' '}
                  <span className="font-bold text-zinc-800 dark:text-zinc-200 tracking-tight">
                    Sahil Kumar Rout
                  </span>
                </p>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

export { SettingsDrawer as OrganiserDrawer };
