import React, { useState } from 'react';
import { 
  X, 
  Settings, 
  Sliders, 
  ShieldCheck, 
  Eye, 
  Clock, 
  Share2, 
  Check, 
  Copy, 
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Plus,
  Trash2
} from 'lucide-react';
import { Organization, TieBreakerMethod } from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';
import { useToast } from '../common/ToastProvider';

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  organization: Organization;
  onUpdateOrganization: (updated: Organization) => void;
  onOpenPublicView: (eventId?: string) => void;
}

export function SettingsDrawer({
  isOpen,
  onClose,
  organization,
  onUpdateOrganization,
  onOpenPublicView,
}: SettingsDrawerProps) {
  const { showToast } = useToast();
  const [copiedLink, setCopiedLink] = useState(false);
  const [newFieldName, setNewFieldName] = useState('');

  if (!isOpen) return null;

  const handleToggle = async (key: keyof Organization, label: string) => {
    const current = Boolean(organization[key]);
    const next = !current;
    try {
      const updated = await dbService.updateOrganization(organization.id, {
        [key]: next,
      });
      onUpdateOrganization(updated);
      showToast(`${label} ${next ? 'enabled' : 'disabled'}.`);
    } catch {
      showToast('Setting update deferred.');
    }
  };

  const handleMethodChange = async (method: TieBreakerMethod) => {
    try {
      const updated = await dbService.updateOrganization(organization.id, {
        tie_breaker_method: method,
      });
      onUpdateOrganization(updated);
      showToast(`Tie-breaker standard set to ${method.toUpperCase()}.`);
    } catch {
      showToast('Method update deferred.');
    }
  };

  const handleCopyProjectorLink = () => {
    const url = `${window.location.origin}/?view=public&orgId=${organization.org_id}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedLink(true);
      showToast('Projector broadcast URL copied to clipboard.');
      setTimeout(() => setCopiedLink(false), 2000);
    });
  };

  const handleAddField = async () => {
    const name = newFieldName.trim();
    if (!name) return;
    const currentFields = organization.custom_participant_fields || [];
    if (currentFields.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      showToast('Field already exists.', 'warning');
      return;
    }
    const newField = {
      id: `field_${Date.now()}`,
      name,
      required: false,
      type: 'text' as const,
    };
    const updatedFields = [...currentFields, newField];
    try {
      const updated = await dbService.updateOrganization(organization.id, {
        custom_participant_fields: updatedFields,
      });
      onUpdateOrganization(updated);
      setNewFieldName('');
      showToast(`Custom field "${name}" added.`);
    } catch {
      showToast('Failed to add field.', 'error');
    }
  };

  const handleRemoveField = async (fieldId: string) => {
    const currentFields = organization.custom_participant_fields || [];
    const updatedFields = currentFields.filter((f) => f.id !== fieldId && f.name !== fieldId);
    try {
      const updated = await dbService.updateOrganization(organization.id, {
        custom_participant_fields: updatedFields,
      });
      onUpdateOrganization(updated);
      showToast('Field removed.');
    } catch {
      showToast('Failed to remove field.', 'error');
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      <div 
        onClick={onClose} 
        className="absolute inset-0 bg-black/60 backdrop-blur-xs transition-opacity" 
      />

      <div className="absolute inset-y-0 right-0 max-w-full flex pl-10">
        <div className="w-screen max-w-md bg-zinc-950 border-l border-zinc-800 p-6 flex flex-col justify-between shadow-2xl overflow-y-auto">
          <div>
            <div className="flex items-center justify-between pb-5 border-b border-zinc-800">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center">
                  <Settings className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-base font-black text-white">Competition Settings</h2>
                  <p className="text-[11px] font-mono text-zinc-400">Rules, Ledgers & Live Displays</p>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 rounded-full bg-zinc-900 text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Section 1: Jury Rules */}
            <div className="mt-6 space-y-4">
              <span className="text-[10px] font-mono uppercase font-bold text-zinc-500 tracking-wider">
                JURY TERMINAL RULES
              </span>

              {/* Blind Judging */}
              <div className="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-white block">Blind Judging Mode</span>
                  <span className="text-[11px] text-zinc-400">Hide competitor names & schools from judges</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggle('blind_judging_enabled', 'Blind Judging')}
                  className="text-emerald-400 cursor-pointer"
                >
                  {organization.blind_judging_enabled ? (
                    <ToggleRight className="w-7 h-7 text-emerald-400" />
                  ) : (
                    <ToggleLeft className="w-7 h-7 text-zinc-600" />
                  )}
                </button>
              </div>

              {/* Auto-Advance */}
              <div className="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-white block">Auto-Advance on Submit</span>
                  <span className="text-[11px] text-zinc-400">Automatically progress to next competitor</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggle('auto_advance_enabled', 'Auto-advance')}
                  className="text-emerald-400 cursor-pointer"
                >
                  {organization.auto_advance_enabled ? (
                    <ToggleRight className="w-7 h-7 text-emerald-400" />
                  ) : (
                    <ToggleLeft className="w-7 h-7 text-zinc-600" />
                  )}
                </button>
              </div>

              {/* Grace Period */}
              <div className="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-white block">5-Minute Grace Period</span>
                  <span className="text-[11px] text-zinc-400">Allow score edits for 5m before sealing</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggle('grace_period_enabled', 'Grace Period')}
                  className="text-emerald-400 cursor-pointer"
                >
                  {organization.grace_period_enabled ? (
                    <ToggleRight className="w-7 h-7 text-emerald-400" />
                  ) : (
                    <ToggleLeft className="w-7 h-7 text-zinc-600" />
                  )}
                </button>
              </div>

              {/* Isolated Jury */}
              <div className="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-white block">Isolated Jury Terminal</span>
                  <span className="text-[11px] text-zinc-400">Judges cannot see peer scores or totals</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggle('isolated_jury_enabled', 'Isolated Jury')}
                  className="text-emerald-400 cursor-pointer"
                >
                  {organization.isolated_jury_enabled ? (
                    <ToggleRight className="w-7 h-7 text-emerald-400" />
                  ) : (
                    <ToggleLeft className="w-7 h-7 text-zinc-600" />
                  )}
                </button>
              </div>
            </div>

            {/* Section 2: Mathematical Tie-Breaker Engine */}
            <div className="mt-6 space-y-4">
              <span className="text-[10px] font-mono uppercase font-bold text-zinc-500 tracking-wider">
                TIE-BREAKER ENGINE
              </span>

              <div className="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between">
                <div>
                  <span className="text-xs font-bold text-white block">Automated Tie Resolution</span>
                  <span className="text-[11px] text-zinc-400">Apply algorithmic standards to tied scores</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggle('tie_breaker_enabled', 'Tie-Breaker Engine')}
                  className="text-emerald-400 cursor-pointer"
                >
                  {organization.tie_breaker_enabled ? (
                    <ToggleRight className="w-7 h-7 text-emerald-400" />
                  ) : (
                    <ToggleLeft className="w-7 h-7 text-zinc-600" />
                  )}
                </button>
              </div>

              {organization.tie_breaker_enabled && (
                <div className="p-3.5 rounded-2xl bg-zinc-900/40 border border-zinc-800 space-y-2">
                  <span className="text-[11px] font-mono text-zinc-400 block font-bold">ALGORITHM STANDARD</span>
                  <div className="grid grid-cols-2 gap-2">
                    {(['olympic', 'standard', 'high_score_drop', 'sum'] as TieBreakerMethod[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => handleMethodChange(m)}
                        className={`p-2.5 rounded-xl border text-xs font-bold capitalize transition-all cursor-pointer ${
                          organization.tie_breaker_method === m
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400'
                            : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-white'
                        }`}
                      >
                        {m.replace('_', ' ')}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Section 3: Custom Participant Metadata Fields */}
            <div className="mt-6 space-y-3">
              <span className="text-[10px] font-mono uppercase font-bold text-zinc-500 tracking-wider">
                CUSTOM PARTICIPANT FIELDS
              </span>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newFieldName}
                  onChange={(e) => setNewFieldName(e.target.value)}
                  placeholder="e.g. Grade, Team, Age"
                  className="flex-1 h-9 px-3 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-white placeholder-zinc-500"
                />
                <button
                  type="button"
                  onClick={handleAddField}
                  className="px-3 h-9 rounded-xl bg-emerald-500 text-black font-bold text-xs flex items-center gap-1 active:scale-95"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add</span>
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                {(organization.custom_participant_fields || []).map((field) => (
                  <span
                    key={field.id || field.name}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300"
                  >
                    <span>{field.name}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveField(field.id)}
                      className="text-zinc-500 hover:text-rose-400 ml-1 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            </div>

            {/* Section 4: Public Broadcast Projector */}
            <div className="mt-6 space-y-3">
              <span className="text-[10px] font-mono uppercase font-bold text-zinc-500 tracking-wider">
                PROJECTOR & BROADCAST SCREEN
              </span>
              <div className="p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800 space-y-3">
                <p className="text-xs text-zinc-400">
                  Open the public projector broadcast view for live auditorium or stadium display.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onOpenPublicView()}
                    className="flex-1 h-10 rounded-xl bg-white text-black font-extrabold text-xs flex items-center justify-center gap-2 active:scale-95 cursor-pointer shadow-md"
                  >
                    <Eye className="w-4 h-4" />
                    <span>Open Projector View</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyProjectorLink}
                    className="h-10 px-4 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-bold text-xs flex items-center justify-center gap-1.5 active:scale-95 cursor-pointer"
                  >
                    {copiedLink ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    <span>{copiedLink ? 'Copied' : 'Copy'}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-zinc-800 text-center">
            <p className="text-[11px] font-mono text-zinc-500">
              {organization.name} • {organization.org_id}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
