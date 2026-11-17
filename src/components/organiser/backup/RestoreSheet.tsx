import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  X,
  Upload,
  Check,
  RefreshCw,
  AlertTriangle,
  Undo2,
  Lock,
  KeyRound,
  Eye,
  EyeOff,
  CheckCircle2,
  ShieldCheck,
  Settings2,
} from 'lucide-react';
import { Organization } from '../../../lib/supabaseTypes';
import { dbService, setStoredSession, getStoredSession } from '../../../lib/supabase';
import { syncNow } from '../../../lib/syncEngine';
import { eventBus } from '../../../lib/eventBus';
import { DB_TABLES } from '../../../lib/dbTables';
import {
  parseBackupFile,
  previewRestore,
  applyRestore,
  saveEncryptedSafetySnapshot,
  collectOrganizationData,
  hasSafetySnapshot,
  getSafetySnapshotInfo,
  restoreSafetySnapshot,
  ParsedBackupResult,
  RestoreMode,
  RestoreSummary,
  WHITELISTED_SETTING_KEYS,
} from '../../../lib/backup';
import { useToast } from '../../common/ToastProvider';

interface RestoreSheetProps {
  isOpen: boolean;
  onClose: () => void;
  organization: Organization;
  onRestoreComplete: (updatedOrg?: Organization) => void;
}

const SETTING_LABELS: Record<string, string> = {
  name: 'Organisation Name',
  email: 'Contact Email',
  tie_breaker_enabled: 'Tie-Breaker Enabled',
  tie_breaker_method: 'Tie-Breaker Method',
  custom_participant_fields: 'Custom Participant Fields',
  blind_judging_enabled: 'Blind Judging',
  auto_advance_enabled: 'Auto-Advance',
  grace_period_enabled: 'Grace Period',
  isolated_jury_enabled: 'Isolated Jury',
  projector_blind_mode: 'Projector Score Secrecy',
  projector_spotlight_mode: 'Projector Spotlight Mode',
  projector_ticker_text: 'Projector Ticker Text',
  projector_carousel_interval: 'Projector Carousel Interval',
};

function computeLocalDryRunPreview(
  org: Organization,
  parsed: ParsedBackupResult,
  mode: RestoreMode
): {
  eventsCreated: number;
  eventsUpdated: number;
  eventsProtected: number;
  existingLockedReplaced: number;
  judgesCreated: number;
  judgesUpdated: number;
  participantsCreated: number;
  participantsUpdated: number;
  scoresCreated: number;
  scoresUpdated: number;
  changedSettings: string[];
} {
  const cachedEvents = dbService.getCachedEvents(org.org_id);
  const cachedJudges = dbService.getCachedJudges(org.org_id);
  const cachedParticipants = dbService.getCachedParticipants(org.org_id);
  const cachedScores = dbService.getCachedScores(org.org_id);

  const existingEventMap = new Map(cachedEvents.map((e) => [e.id, e]));
  const existingJudgeIds = new Set(cachedJudges.map((j) => j.id));
  const existingParticipantIds = new Set(cachedParticipants.map((p) => p.id));
  const existingScoreIds = new Set(cachedScores.map((s) => s.id));
  const lockedEventIds = new Set(cachedEvents.filter((e) => e.is_locked).map((e) => e.id));

  let eventsCreated = 0;
  let eventsUpdated = 0;
  let eventsProtected = 0;
  let judgesCreated = 0;
  let judgesUpdated = 0;
  let participantsCreated = 0;
  let participantsUpdated = 0;
  let scoresCreated = 0;
  let scoresUpdated = 0;

  if (mode === 'replace') {
    eventsCreated = parsed.payload.events.length;
    judgesCreated = parsed.payload.judges.length;
    participantsCreated = parsed.payload.participants.length;
    scoresCreated = parsed.payload.scores.length;
  } else {
    for (const evt of parsed.payload.events) {
      const existing = existingEventMap.get(evt.id);
      if (existing?.is_locked) {
        eventsProtected++;
      } else if (existing) {
        if (mode === 'merge') eventsUpdated++;
      } else {
        eventsCreated++;
      }
    }
    for (const j of parsed.payload.judges) {
      if (existingJudgeIds.has(j.id)) {
        if (mode === 'merge') judgesUpdated++;
      } else {
        judgesCreated++;
      }
    }
    for (const p of parsed.payload.participants) {
      if (existingParticipantIds.has(p.id)) {
        if (mode === 'merge') participantsUpdated++;
      } else {
        participantsCreated++;
      }
    }
    for (const s of parsed.payload.scores) {
      if (lockedEventIds.has(s.event_id)) continue;
      if (existingScoreIds.has(s.id)) {
        if (mode === 'merge') scoresUpdated++;
      } else {
        scoresCreated++;
      }
    }
  }

  const changedSettings: string[] = [];
  if (parsed.settingsInBackup && parsed.payload.settings) {
    for (const key of WHITELISTED_SETTING_KEYS) {
      const nextVal = (parsed.payload.settings as any)[key];
      if (nextVal === undefined) continue;
      const curVal = (org as any)[key];
      if (JSON.stringify(nextVal ?? null) !== JSON.stringify(curVal ?? null)) {
        changedSettings.push(key);
      }
    }
  }

  return {
    eventsCreated,
    eventsUpdated,
    eventsProtected,
    existingLockedReplaced: mode === 'replace' ? lockedEventIds.size : 0,
    judgesCreated,
    judgesUpdated,
    participantsCreated,
    participantsUpdated,
    scoresCreated,
    scoresUpdated,
    changedSettings,
  };
}

export function RestoreSheet({
  isOpen,
  onClose,
  organization,
  onRestoreComplete,
}: RestoreSheetProps) {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Flow: upload -> pin (decrypt) -> preview (dry-run) -> auth (master password) -> apply -> done
  const [step, setStep] = useState<'upload' | 'pin' | 'preview' | 'auth' | 'done'>('upload');
  const [rawText, setRawText] = useState('');
  const [fileError, setFileError] = useState('');
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');

  // Master Password state — kept purely in memory, cleared on close
  const [masterPassword, setMasterPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  const [parsedBackup, setParsedBackup] = useState<ParsedBackupResult | null>(null);
  const [mode, setMode] = useState<RestoreMode>('merge');
  const [summary, setSummary] = useState<RestoreSummary | null>(null);
  const [isApplying, setIsApplying] = useState(false);

  // Undo safety snapshot state
  const [canUndo, setCanUndo] = useState(false);
  const [snapshotTimestamp, setSnapshotTimestamp] = useState<string | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);
  const [showUndoPrompt, setShowUndoPrompt] = useState(false);
  const [undoPassword, setUndoPassword] = useState('');
  const [undoError, setUndoError] = useState('');

  const resetAllState = () => {
    setMasterPassword('');
    setShowPassword(false);
    setPasswordError('');
    setFileError('');
    setPin('');
    setPinError('');
    setRawText('');
    setParsedBackup(null);
    setSummary(null);
    setMode('merge');
    setStep('upload');
    setShowUndoPrompt(false);
    setUndoPassword('');
    setUndoError('');
  };

  const handleClose = () => {
    resetAllState();
    onClose();
  };

  useEffect(() => {
    if (isOpen) {
      hasSafetySnapshot(organization.org_id)
        .then(async (exists) => {
          setCanUndo(exists);
          if (exists) {
            const info = await getSafetySnapshotInfo(organization.org_id);
            setSnapshotTimestamp(info?.timestamp || null);
          } else {
            setSnapshotTimestamp(null);
          }
        })
        .catch(() => {
          setCanUndo(false);
          setSnapshotTimestamp(null);
        });
    } else {
      resetAllState();
    }
  }, [isOpen, organization.org_id]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', handleKeyDown);

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  const localPreview = useMemo(() => {
    if (!parsedBackup) return null;
    return computeLocalDryRunPreview(organization, parsedBackup, mode);
  }, [organization, parsedBackup, mode]);

  if (!isOpen) return null;

  const runFullPostRestoreRefresh = async (): Promise<Organization | undefined> => {
    await dbService.clearOrgWorkAndInvalidateCache(organization.org_id);
    await syncNow({ forceFull: true, reason: 'manual' });
    const freshOrgRes = await dbService.getOrganizationByOrgIdResult(organization.org_id, true);
    const updatedOrg = freshOrgRes.data || undefined;
    if (updatedOrg) {
      const existingSession = getStoredSession();
      if (existingSession && existingSession.org?.org_id?.toUpperCase() === organization.org_id.toUpperCase()) {
        setStoredSession({
          ...existingSession,
          org: updatedOrg,
        });
      }
    }
    eventBus.emit('cache_updated', { table: DB_TABLES.ALL });
    onRestoreComplete(updatedOrg);
    return updatedOrg;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError('');

    try {
      const text = await file.text();
      setRawText(text);

      try {
        const parsed = await parseBackupFile(text);
        setParsedBackup(parsed);
        setStep('preview');
      } catch (parseErr: any) {
        const msg = parseErr?.message || 'Invalid backup file';
        if (msg.includes('ENCRYPTED_BACKUP')) {
          setStep('pin');
        } else {
          setFileError(msg);
          showToast(msg, 'error');
        }
      }
    } catch {
      setFileError('Could not read selected file.');
      showToast('Could not read selected file.', 'error');
    } finally {
      if (e.target) e.target.value = '';
    }
  };

  const handleDecryptWithPin = async (e: React.FormEvent) => {
    e.preventDefault();
    setPinError('');
    if (!pin.trim()) {
      setPinError('Please enter your backup PIN.');
      return;
    }

    try {
      const parsed = await parseBackupFile(rawText, pin.trim());
      setParsedBackup(parsed);
      setPin('');
      setStep('preview');
    } catch (err: any) {
      setPinError(err?.message || 'Incorrect PIN or damaged file.');
    }
  };

  const handleExecuteRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!parsedBackup) return;

    const cleanPwd = masterPassword.trim();
    if (!cleanPwd) {
      setPasswordError('Please enter your organiser master password.');
      return;
    }

    setIsApplying(true);
    setPasswordError('');

    try {
      // 1. Server dry-run check verifies master password, schema bounds & impact
      await previewRestore(organization.org_id, cleanPwd, parsedBackup.payload, mode);

      // 2. Collect live pre-restore data and save AES-GCM encrypted safety snapshot (max 1 per org)
      const currentData = await collectOrganizationData(organization);
      await saveEncryptedSafetySnapshot(organization.org_id, currentData, cleanPwd);

      // 3. Apply atomic restore on server
      const result = await applyRestore(organization.org_id, cleanPwd, parsedBackup.payload, mode);
      setSummary(result);

      // 4. Full refresh sequence (no manual reload)
      await runFullPostRestoreRefresh();

      setMasterPassword('');
      setStep('done');
      showToast('Backup restored cleanly.', 'success');
    } catch (err: any) {
      const msg = String(err?.message || 'Restore failed.');
      if (msg.toLowerCase().includes('master password') || msg.toLowerCase().includes('wrong') || msg.includes('15 minutes')) {
        setPasswordError(msg);
      } else {
        setPasswordError(msg);
      }
      showToast(msg, 'error');
    } finally {
      setIsApplying(false);
    }
  };

  const handleExecuteUndo = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPwd = undoPassword.trim();
    if (!cleanPwd) {
      setUndoError('Master password is required.');
      return;
    }
    setIsUndoing(true);
    setUndoError('');
    try {
      await restoreSafetySnapshot(organization.org_id, cleanPwd);
      await runFullPostRestoreRefresh();
      setUndoPassword('');
      showToast('Restored from encrypted safety snapshot.', 'success');
      handleClose();
    } catch (err: any) {
      const msg = String(err?.message || 'Undo failed.');
      setUndoError(msg);
    } finally {
      setIsUndoing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-3 sm:p-4 bg-black/65 animate-in fade-in duration-150">
      <div
        className="relative w-full max-w-lg max-h-[calc(100dvh-2rem)] flex flex-col bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-title"
      >
        {/* Pinned Header */}
        <div className="shrink-0 px-5 py-4 border-b border-stone-100 dark:border-zinc-800/80 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-700 dark:text-blue-400">
              <Upload className="w-4 h-4" />
            </div>
            <div>
              <h3 id="restore-title" className="text-sm font-bold text-zinc-900 dark:text-white">
                Restore Competition
              </h3>
              <p className="text-[11px] lg:text-sm text-zinc-600 dark:text-zinc-400">
                Checksum-verified restore with preview &amp; undo protection
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close restore modal"
            className="w-11 h-11 rounded-xl text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-stone-100 dark:hover:bg-zinc-900 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-5 space-y-4">
          {/* Step 1: Upload File */}
          {step === 'upload' && !showUndoPrompt && (
            <div className="space-y-4">
              <input
                type="file"
                ref={fileInputRef}
                accept=".json,application/json"
                onChange={handleFileSelect}
                className="hidden"
              />

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="w-full min-h-[140px] p-8 rounded-2xl border-2 border-dashed border-stone-300 dark:border-zinc-700 hover:border-emerald-600 dark:hover:border-emerald-500 flex flex-col items-center justify-center space-y-2 text-center transition-colors cursor-pointer group"
              >
                <div className="w-12 h-12 rounded-2xl bg-stone-100 dark:bg-zinc-900 group-hover:bg-emerald-500/10 flex items-center justify-center text-zinc-600 dark:text-zinc-300 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                  <Upload className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs lg:text-sm font-bold text-zinc-800 dark:text-zinc-200 block">
                    Choose Backup File (.json)
                  </span>
                  <span className="text-[11px] lg:text-sm text-zinc-600 dark:text-zinc-400 block mt-0.5">
                    Supports Backup v1.0 &amp; v2.0 files
                  </span>
                </div>
              </button>

              {fileError && (
                <div
                  role="alert"
                  className="p-3.5 rounded-2xl bg-red-500/10 border border-red-500/30 text-xs lg:text-sm text-red-700 dark:text-red-400 font-medium flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{fileError}</span>
                </div>
              )}

              {canUndo && (
                <div className="p-3.5 rounded-2xl bg-stone-50 dark:bg-zinc-900/40 border border-stone-200 dark:border-zinc-800 flex items-center justify-between gap-3">
                  <div className="space-y-0.5 min-w-0">
                    <span className="text-xs lg:text-sm font-semibold text-zinc-800 dark:text-zinc-200 block">
                      Encrypted Safety Snapshot Available
                    </span>
                    <span className="text-[11px] lg:text-sm text-zinc-600 dark:text-zinc-400 block truncate">
                      {snapshotTimestamp
                        ? `Saved ${new Date(snapshotTimestamp).toLocaleString()}`
                        : 'Revert last reset or restore'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowUndoPrompt(true)}
                    className="min-h-[44px] px-3.5 py-2 rounded-xl border border-stone-200 dark:border-zinc-700 text-xs lg:text-sm font-bold text-zinc-800 dark:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors flex items-center space-x-1.5 cursor-pointer shrink-0"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    <span>Undo Restore</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Undo Master Password Prompt */}
          {showUndoPrompt && (
            <form onSubmit={handleExecuteUndo} className="space-y-4 animate-in fade-in duration-150">
              <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/25 text-xs lg:text-sm text-amber-900 dark:text-amber-200 flex items-start space-x-2.5">
                <AlertTriangle className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                <span>
                  Enter your organiser master password to unlock the encrypted safety snapshot and revert to the previous competition state.
                </span>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400 block">
                  Master Password
                </label>
                <input
                  type="password"
                  autoFocus
                  placeholder="Enter organiser master password"
                  value={undoPassword}
                  onChange={(e) => {
                    setUndoPassword(e.target.value);
                    setUndoError('');
                  }}
                  className="w-full min-h-[44px] px-3.5 py-2.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-600"
                />
                {undoError && (
                  <p className="text-[11px] lg:text-sm text-red-700 dark:text-red-400 font-medium">{undoError}</p>
                )}
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowUndoPrompt(false);
                    setUndoPassword('');
                    setUndoError('');
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-stone-200 dark:border-zinc-800 text-xs lg:text-sm font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isUndoing}
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-700 hover:bg-amber-800 dark:bg-amber-700/90 dark:hover:bg-amber-700 text-white text-xs lg:text-sm font-bold transition-colors shadow-sm cursor-pointer flex items-center space-x-1.5"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isUndoing ? 'animate-spin' : ''}`} />
                  <span>{isUndoing ? 'Reverting...' : 'Confirm Revert'}</span>
                </button>
              </div>
            </form>
          )}

          {/* Step 2: PIN Entry for Encrypted Backup */}
          {step === 'pin' && (
            <form onSubmit={handleDecryptWithPin} className="space-y-4 animate-in fade-in duration-150">
              <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/25 text-xs lg:text-sm text-amber-900 dark:text-amber-200 flex items-start space-x-2.5">
                <Lock className="w-4 h-4 text-amber-700 dark:text-amber-400 shrink-0 mt-0.5" />
                <span>
                  This backup is protected with AES-256 encryption. Enter the security PIN used when exporting it.
                </span>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400 block">
                  Security PIN
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoFocus
                  placeholder="Enter PIN"
                  value={pin}
                  onChange={(e) => {
                    setPin(e.target.value);
                    setPinError('');
                  }}
                  className="w-full min-h-[44px] px-3.5 py-2.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-600"
                />
                {pinError && (
                  <p className="text-[11px] lg:text-sm text-red-700 dark:text-red-400 font-medium">{pinError}</p>
                )}
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setPin('');
                    setPinError('');
                    setStep('upload');
                  }}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-stone-200 dark:border-zinc-800 text-xs lg:text-sm font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="min-h-[44px] px-4 py-2 rounded-xl bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-700/90 dark:hover:bg-emerald-700 text-white text-xs lg:text-sm font-bold transition-colors shadow-sm cursor-pointer"
                >
                  Unlock &amp; Verify
                </button>
              </div>
            </form>
          )}

          {/* Step 3: Dry-Run Preview (Counts, Settings Diff, Ignored Fields, Locked Event Behavior) */}
          {step === 'preview' && parsedBackup && localPreview && (
            <div className="space-y-4 animate-in fade-in duration-150">
              {/* Manifest Summary */}
              <div className="p-3.5 rounded-2xl bg-stone-50 dark:bg-zinc-900/60 border border-stone-200 dark:border-zinc-800 flex items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0">
                  <div className="flex items-center space-x-1.5">
                    <span className="text-xs lg:text-sm font-bold text-zinc-900 dark:text-white truncate">
                      {parsedBackup.manifest.org_name} ({parsedBackup.manifest.org_id})
                    </span>
                    <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  </div>
                  <span className="text-[11px] lg:text-sm text-zinc-600 dark:text-zinc-400 block">
                    Exported {new Date(parsedBackup.manifest.exported_at).toLocaleDateString()} •{' '}
                    {parsedBackup.migratedFromSchema
                      ? `Migrated v${parsedBackup.migratedFromSchema} → v2`
                      : `Schema v${parsedBackup.originalSchemaVersion}`}
                  </span>
                </div>
                <div className="text-right shrink-0">
                  <span className="text-xs lg:text-sm font-mono font-bold text-emerald-700 dark:text-emerald-400 block">
                    {parsedBackup.manifest.counts.events} Events
                  </span>
                  <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400 block">
                    {parsedBackup.manifest.counts.scores} Scores
                  </span>
                </div>
              </div>

              {/* Restore Mode Switcher */}
              <div className="space-y-2">
                <label className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400 block">
                  Restoration Strategy
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setMode('merge')}
                    className={`min-h-[56px] p-2.5 rounded-2xl border text-left transition-colors cursor-pointer ${
                      mode === 'merge'
                        ? 'border-emerald-600 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
                        : 'border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    <span className="text-xs lg:text-sm font-bold block">Merge</span>
                    <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400 block mt-0.5">
                      Update, keep locked
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setMode('add')}
                    className={`min-h-[56px] p-2.5 rounded-2xl border text-left transition-colors cursor-pointer ${
                      mode === 'add'
                        ? 'border-emerald-600 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
                        : 'border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    <span className="text-xs lg:text-sm font-bold block">Add Only</span>
                    <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400 block mt-0.5">
                      Skip existing
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setMode('replace')}
                    className={`min-h-[56px] p-2.5 rounded-2xl border text-left transition-colors cursor-pointer ${
                      mode === 'replace'
                        ? 'border-red-600 bg-red-500/10 text-red-900 dark:text-red-200'
                        : 'border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    <span className="text-xs lg:text-sm font-bold block">Replace</span>
                    <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400 block mt-0.5">
                      Wipe all first
                    </span>
                  </button>
                </div>
              </div>

              {/* Dry-Run Preview Counts */}
              <div className="p-4 rounded-2xl border border-stone-200 dark:border-zinc-800 space-y-3">
                <span className="text-xs lg:text-sm font-bold text-zinc-900 dark:text-white block">
                  Dry-Run Impact Preview
                </span>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  <div className="p-2 rounded-xl bg-stone-50 dark:bg-zinc-900/60">
                    <span className="text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                      {localPreview.eventsCreated + localPreview.eventsUpdated}
                    </span>
                    <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400 uppercase block">
                      Events
                    </span>
                  </div>

                  <div className="p-2 rounded-xl bg-stone-50 dark:bg-zinc-900/60">
                    <span className="text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                      {localPreview.judgesCreated + localPreview.judgesUpdated}
                    </span>
                    <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400 uppercase block">
                      Judges
                    </span>
                  </div>

                  <div className="p-2 rounded-xl bg-stone-50 dark:bg-zinc-900/60">
                    <span className="text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                      {localPreview.participantsCreated + localPreview.participantsUpdated}
                    </span>
                    <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400 uppercase block">
                      Roster
                    </span>
                  </div>

                  <div className="p-2 rounded-xl bg-stone-50 dark:bg-zinc-900/60">
                    <span className="text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                      {localPreview.scoresCreated + localPreview.scoresUpdated}
                    </span>
                    <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400 uppercase block">
                      Scores
                    </span>
                  </div>
                </div>

                {/* Locked-Event Behaviour */}
                {mode === 'replace' ? (
                  <div className="p-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-[11px] lg:text-sm text-red-800 dark:text-red-300 flex items-start space-x-2">
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      Replace mode wipes all current competition data
                      {localPreview.existingLockedReplaced > 0
                        ? ` (including ${localPreview.existingLockedReplaced} locked event(s))`
                        : ''}{' '}
                      and replaces it with this backup.
                    </span>
                  </div>
                ) : (
                  <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-[11px] lg:text-sm text-emerald-800 dark:text-emerald-300 flex items-start space-x-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>
                      {localPreview.eventsProtected > 0
                        ? `${localPreview.eventsProtected} locked event(s) will remain protected from changes.`
                        : 'Any locked events in this organisation remain protected in this mode.'}
                    </span>
                  </div>
                )}

                {/* Settings Changes */}
                <div className="p-2.5 rounded-xl bg-stone-50 dark:bg-zinc-900/60 border border-stone-200 dark:border-zinc-800 text-[11px] lg:text-sm text-zinc-700 dark:text-zinc-300 flex items-start space-x-2">
                  <Settings2 className="w-4 h-4 text-zinc-600 dark:text-zinc-400 shrink-0 mt-0.5" />
                  <div>
                    {!parsedBackup.settingsInBackup ? (
                      <span className="font-semibold">
                        Settings: not in this backup (current organisation settings stay unchanged).
                      </span>
                    ) : localPreview.changedSettings.length === 0 ? (
                      <span>
                        Settings: included in backup (matches your current settings; 0 changes).
                      </span>
                    ) : (
                      <span>
                        <strong className="text-zinc-900 dark:text-white">
                          Settings ({localPreview.changedSettings.length} update{localPreview.changedSettings.length > 1 ? 's' : ''}):
                        </strong>{' '}
                        {localPreview.changedSettings
                          .map((k) => SETTING_LABELS[k] || k)
                          .join(', ')}
                      </span>
                    )}
                  </div>
                </div>

                {/* Ignored Unknown Fields */}
                {parsedBackup.ignoredFields.length > 0 && (
                  <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] lg:text-sm text-amber-900 dark:text-amber-200">
                    <strong className="block mb-0.5">Ignored fields (not imported):</strong>
                    <span className="font-mono break-all">
                      {parsedBackup.ignoredFields.join(', ')}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 4: Master Password Confirmation Before Apply */}
          {step === 'auth' && parsedBackup && (
            <form
              id="restore-auth-form"
              onSubmit={handleExecuteRestore}
              className="space-y-4 animate-in fade-in duration-150"
            >
              <div className="p-3.5 rounded-2xl bg-stone-50 dark:bg-zinc-900/60 border border-stone-200 dark:border-zinc-800 text-xs lg:text-sm text-zinc-700 dark:text-zinc-300">
                Ready to apply <strong className="capitalize text-zinc-900 dark:text-white">{mode}</strong> restore for{' '}
                <strong className="text-zinc-900 dark:text-white">{organization.name}</strong>. An encrypted safety snapshot will be saved automatically before applying.
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400 flex items-center space-x-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-zinc-600 dark:text-zinc-400" />
                    <span>Organiser Master Password</span>
                  </label>
                  <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400">In memory only</span>
                </div>

                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoFocus
                    placeholder="Enter Master Password"
                    value={masterPassword}
                    onChange={(e) => {
                      setMasterPassword(e.target.value);
                      setPasswordError('');
                    }}
                    className="w-full min-h-[44px] pl-3.5 pr-11 py-2.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 md:w-11 md:h-11 flex items-center justify-center text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                {passwordError && (
                  <p className="text-[11px] lg:text-sm text-red-700 dark:text-red-400 font-medium">
                    {passwordError}
                  </p>
                )}
              </div>
            </form>
          )}

          {/* Step 5: Done */}
          {step === 'done' && (
            <div className="py-6 text-center space-y-3 animate-in zoom-in-95 duration-150">
              <div className="w-12 h-12 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 mx-auto flex items-center justify-center">
                <Check className="w-6 h-6 stroke-[3]" />
              </div>
              <h4 className="text-base font-bold text-zinc-900 dark:text-white">
                Restoration Complete
              </h4>
              <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-300 max-w-xs mx-auto leading-relaxed">
                All competition records{summary?.settings_in_backup ? ' and organisation settings' : ''} are synced live across all tabs. An encrypted safety snapshot is saved on this device if you need to undo.
              </p>
            </div>
          )}
        </div>

        {/* Pinned Footer */}
        <div className="shrink-0 p-4 border-t border-stone-100 dark:border-zinc-800/80 bg-stone-50/50 dark:bg-zinc-900/30 flex items-center justify-between gap-3">
          {step === 'done' ? (
            <button
              type="button"
              onClick={handleClose}
              className="w-full min-h-[44px] py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-700/90 dark:hover:bg-emerald-700 text-white text-xs lg:text-sm font-bold transition-colors shadow-sm cursor-pointer"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleClose}
                disabled={isApplying}
                className="min-h-[44px] px-4 py-2.5 rounded-xl border border-stone-200 dark:border-zinc-800 text-xs lg:text-sm font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
              >
                Cancel
              </button>

              {step === 'preview' && (
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setStep('upload')}
                    className="min-h-[44px] px-3.5 py-2.5 rounded-xl border border-stone-200 dark:border-zinc-800 text-xs lg:text-sm font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
                  >
                    Other File
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep('auth')}
                    className="min-h-[44px] px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-700/90 dark:hover:bg-emerald-700 text-white text-xs lg:text-sm font-bold transition-colors shadow-sm cursor-pointer"
                  >
                    Continue
                  </button>
                </div>
              )}

              {step === 'auth' && (
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPasswordError('');
                      setStep('preview');
                    }}
                    disabled={isApplying}
                    className="min-h-[44px] px-3.5 py-2.5 rounded-xl border border-stone-200 dark:border-zinc-800 text-xs lg:text-sm font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    form="restore-auth-form"
                    disabled={isApplying || !masterPassword.trim()}
                    className="min-h-[44px] px-5 py-2.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-700/90 dark:hover:bg-emerald-700 disabled:opacity-50 text-white text-xs lg:text-sm font-bold transition-colors shadow-sm flex items-center space-x-2 cursor-pointer active:scale-95 motion-reduce:transition-none"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isApplying ? 'animate-spin' : ''}`} />
                    <span>{isApplying ? 'Restoring...' : 'Apply Restoration'}</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
