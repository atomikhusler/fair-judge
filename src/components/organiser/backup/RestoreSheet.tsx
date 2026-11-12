import React, { useState, useEffect, useRef } from 'react';
import { X, Upload, ShieldAlert, Check, RefreshCw, AlertTriangle, Undo2, Lock, FileText, CheckCircle2 } from 'lucide-react';
import { Organization } from '../../../lib/supabaseTypes';
import { 
  parseBackupFile, 
  previewRestore, 
  applyRestore, 
  createSafetySnapshot,
  hasSafetySnapshot,
  restoreSafetySnapshot,
  BackupManifest, 
  BackupPayload, 
  RestoreMode, 
  RestoreSummary 
} from '../../../lib/backup';
import { useToast } from '../../common/ToastProvider';

interface RestoreSheetProps {
  isOpen: boolean;
  onClose: () => void;
  organization: Organization;
  onRestoreComplete: () => void;
}

export function RestoreSheet({ isOpen, onClose, organization, onRestoreComplete }: RestoreSheetProps) {
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<'upload' | 'pin' | 'preview' | 'restoring' | 'done'>('upload');
  const [rawText, setRawText] = useState('');
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState('');
  
  const [manifest, setManifest] = useState<BackupManifest | null>(null);
  const [payload, setPayload] = useState<BackupPayload | null>(null);
  const [mode, setMode] = useState<RestoreMode>('replace');
  const [summary, setSummary] = useState<RestoreSummary | null>(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [isUndoing, setIsUndoing] = useState(false);

  // Check safety snapshot availability on open
  useEffect(() => {
    if (isOpen) {
      hasSafetySnapshot(organization.org_id).then(setCanUndo).catch(() => setCanUndo(false));
    }
  }, [isOpen, organization.org_id]);

  // Modal Scroll Lock and Escape handling
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      setRawText(text);

      // Try parsing (unencrypted)
      try {
        const parsed = await parseBackupFile(text);
        setManifest(parsed.manifest);
        setPayload(parsed.payload);
        setStep('preview');
        runSimulation(parsed.payload, mode);
      } catch (parseErr: any) {
        if (parseErr.message?.includes('ENCRYPTED_BACKUP')) {
          setStep('pin');
        } else {
          showToast(parseErr.message || 'Invalid backup file', 'error');
        }
      }
    } catch {
      showToast('Could not read selected file.', 'error');
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
      setManifest(parsed.manifest);
      setPayload(parsed.payload);
      setStep('preview');
      runSimulation(parsed.payload, mode);
    } catch (err: any) {
      setPinError(err.message || 'Incorrect PIN.');
    }
  };

  const runSimulation = async (targetPayload: BackupPayload, selectedMode: RestoreMode) => {
    setIsSimulating(true);
    try {
      const preview = await previewRestore(organization.org_id, targetPayload, selectedMode);
      setSummary(preview);
    } catch (err: any) {
      showToast(`Preview notice: ${err.message}`, 'error');
    } finally {
      setIsSimulating(false);
    }
  };

  const handleModeChange = (newMode: RestoreMode) => {
    setMode(newMode);
    if (payload) {
      runSimulation(payload, newMode);
    }
  };

  const handleExecuteRestore = async () => {
    if (!payload) return;
    setIsApplying(true);
    try {
      // 1. Create immediate local safety snapshot before applying restore
      await createSafetySnapshot(organization);

      // 2. Apply restore atomically via database RPC
      const result = await applyRestore(organization.org_id, payload, mode);
      setSummary(result);
      setStep('done');
      showToast('Backup restored successfully!', 'success');
      onRestoreComplete();
    } catch (err: any) {
      showToast(`Restore failed: ${err.message}`, 'error');
    } finally {
      setIsApplying(false);
    }
  };

  const handleUndo = async () => {
    if (!confirm('Undo restore and return to the safety snapshot taken before restoration?')) return;
    setIsUndoing(true);
    try {
      await restoreSafetySnapshot(organization.org_id);
      showToast('Restoration undone. Snapshot restored.', 'success');
      onRestoreComplete();
      onClose();
    } catch (err: any) {
      showToast(`Undo failed: ${err.message}`, 'error');
    } finally {
      setIsUndoing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/60 backdrop-blur-none animate-in fade-in duration-150">
      <div 
        className="relative w-full max-w-lg max-h-[calc(100dvh-2rem)] flex flex-col bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-labelledby="restore-title"
      >
        {/* Pinned Header */}
        <div className="shrink-0 px-5 py-4 border-b border-stone-100 dark:border-zinc-800/80 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-600 dark:text-blue-400">
              <Upload className="w-4 h-4" />
            </div>
            <div>
              <h3 id="restore-title" className="text-sm font-bold text-zinc-900 dark:text-white">
                Restore Competition
              </h3>
              <p className="text-[11px] text-zinc-500">
                Atomic database restore with locked event protection
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close restore modal"
            className="w-8 h-8 rounded-xl text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-900 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-5 space-y-4">
          {/* Step 1: Upload File */}
          {step === 'upload' && (
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
                className="w-full p-8 rounded-2xl border-2 border-dashed border-stone-300 dark:border-zinc-700 hover:border-emerald-500 dark:hover:border-emerald-500 flex flex-col items-center justify-center space-y-2 text-center transition-colors cursor-pointer group"
              >
                <div className="w-12 h-12 rounded-2xl bg-stone-100 dark:bg-zinc-900 group-hover:bg-emerald-500/10 flex items-center justify-center text-zinc-500 dark:text-zinc-400 group-hover:text-emerald-500 transition-colors">
                  <Upload className="w-6 h-6" />
                </div>
                <div>
                  <span className="text-xs font-bold text-zinc-800 dark:text-zinc-200 block">
                    Choose Backup File (.json)
                  </span>
                  <span className="text-[11px] text-zinc-400 block mt-0.5">
                    Click to browse or drop file here
                  </span>
                </div>
              </button>

              {canUndo && (
                <div className="p-3.5 rounded-2xl bg-stone-50 dark:bg-zinc-900/40 border border-stone-200 dark:border-zinc-800 flex items-center justify-between">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 block">
                      Safety Snapshot Available
                    </span>
                    <span className="text-[11px] text-zinc-500 block">
                      Revert changes from your last restoration
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleUndo}
                    disabled={isUndoing}
                    className="px-3 py-1.5 rounded-xl border border-stone-200 dark:border-zinc-800 text-xs font-bold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors flex items-center space-x-1.5 cursor-pointer"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    <span>{isUndoing ? 'Undoing...' : 'Undo Restore'}</span>
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Step 2: PIN Entry for Encrypted Backup */}
          {step === 'pin' && (
            <form onSubmit={handleDecryptWithPin} className="space-y-4 animate-in fade-in duration-150">
              <div className="p-4 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-800 dark:text-amber-300 flex items-start space-x-2.5">
                <Lock className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <span>
                  This backup is protected with AES-256 encryption. Enter the security PIN configured during export.
                </span>
              </div>

              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 block">
                  Security PIN
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  autoFocus
                  placeholder="Enter PIN"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500"
                />
                {pinError && <p className="text-[11px] text-red-500 font-medium">{pinError}</p>}
              </div>

              <div className="flex items-center justify-end space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setStep('upload')}
                  className="px-3.5 py-2 rounded-xl border border-stone-200 dark:border-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-sm cursor-pointer"
                >
                  Unlock Backup
                </button>
              </div>
            </form>
          )}

          {/* Step 3: Dry-Run Preview & Mode Selector */}
          {step === 'preview' && manifest && payload && (
            <div className="space-y-4 animate-in fade-in duration-150">
              {/* Manifest Badge */}
              <div className="p-3.5 rounded-2xl bg-stone-50 dark:bg-zinc-900/60 border border-stone-200 dark:border-zinc-800 flex items-center justify-between">
                <div className="space-y-0.5">
                  <span className="text-xs font-bold text-zinc-900 dark:text-white block">
                    {manifest.org_name} ({manifest.org_id})
                  </span>
                  <span className="text-[11px] text-zinc-500 block">
                    Exported {new Date(manifest.exported_at).toLocaleDateString()}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-xs font-mono font-bold text-emerald-600 dark:text-emerald-400 block">
                    {manifest.counts.events} Events
                  </span>
                  <span className="text-[10px] text-zinc-400 block">
                    {manifest.counts.judges} Judges • {manifest.counts.participants} Roster
                  </span>
                </div>
              </div>

              {/* Restore Mode Selector */}
              <div className="space-y-2">
                <label className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 block">
                  Restoration Strategy
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => handleModeChange('replace')}
                    className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                      mode === 'replace'
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
                        : 'border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    <span className="text-xs font-bold block">Replace</span>
                    <span className="text-[10px] text-zinc-500 block mt-0.5">Clean fresh state</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleModeChange('merge')}
                    className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                      mode === 'merge'
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
                        : 'border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    <span className="text-xs font-bold block">Merge</span>
                    <span className="text-[10px] text-zinc-500 block mt-0.5">Update & combine</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleModeChange('add')}
                    className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                      mode === 'add'
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
                        : 'border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-stone-50 dark:hover:bg-zinc-900'
                    }`}
                  >
                    <span className="text-xs font-bold block">Add Only</span>
                    <span className="text-[10px] text-zinc-500 block mt-0.5">Skip collisions</span>
                  </button>
                </div>
              </div>

              {/* Dry-Run Simulation Box */}
              <div className="p-4 rounded-2xl border border-stone-200 dark:border-zinc-800 space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-zinc-900 dark:text-white">
                    Dry-Run Impact Simulation
                  </span>
                  {isSimulating && (
                    <span className="text-[11px] text-zinc-400 flex items-center space-x-1">
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span>Simulating...</span>
                    </span>
                  )}
                </div>

                {summary ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-center">
                    <div className="p-2 rounded-xl bg-stone-50 dark:bg-zinc-900/60">
                      <span className="text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                        {(summary.events_created || 0) + (summary.events_updated || 0)}
                      </span>
                      <span className="text-[10px] text-zinc-500 uppercase block">Events</span>
                    </div>

                    <div className="p-2 rounded-xl bg-stone-50 dark:bg-zinc-900/60">
                      <span className="text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                        {(summary.judges_created || 0) + (summary.judges_updated || 0)}
                      </span>
                      <span className="text-[10px] text-zinc-500 uppercase block">Judges</span>
                    </div>

                    <div className="p-2 rounded-xl bg-stone-50 dark:bg-zinc-900/60">
                      <span className="text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                        {(summary.participants_created || 0) + (summary.participants_updated || 0)}
                      </span>
                      <span className="text-[10px] text-zinc-500 uppercase block">Roster</span>
                    </div>

                    <div className="p-2 rounded-xl bg-stone-50 dark:bg-zinc-900/60">
                      <span className="text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                        {(summary.scores_created || 0) + (summary.scores_updated || 0)}
                      </span>
                      <span className="text-[10px] text-zinc-500 uppercase block">Scores</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-400 italic">Calculating impact...</p>
                )}

                {summary && (summary.events_protected || 0) > 0 && (
                  <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[11px] text-emerald-700 dark:text-emerald-300 flex items-center space-x-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                    <span>{summary.events_protected} locked event(s) immune from deletion or modification.</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 4: Done */}
          {step === 'done' && (
            <div className="py-6 text-center space-y-3 animate-in zoom-in-95 duration-150">
              <div className="w-12 h-12 rounded-full bg-emerald-500/15 text-emerald-500 mx-auto flex items-center justify-center">
                <Check className="w-6 h-6 stroke-[3]" />
              </div>
              <h4 className="text-base font-bold text-zinc-900 dark:text-white">
                Restoration Complete
              </h4>
              <p className="text-xs text-zinc-500 max-w-xs mx-auto">
                All records were synchronized. A safety snapshot was saved to local storage should you need to undo.
              </p>
            </div>
          )}
        </div>

        {/* Pinned Footer */}
        <div className="shrink-0 p-4 border-t border-stone-100 dark:border-zinc-800/80 bg-stone-50/50 dark:bg-zinc-900/30 flex items-center justify-between gap-3">
          {step === 'done' ? (
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-all shadow-sm cursor-pointer"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={isApplying}
                className="px-4 py-2.5 rounded-xl border border-stone-200 dark:border-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
              >
                Cancel
              </button>

              {step === 'preview' && (
                <button
                  type="button"
                  onClick={handleExecuteRestore}
                  disabled={isApplying || isSimulating}
                  className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold transition-all shadow-sm flex items-center space-x-2 cursor-pointer active:scale-98"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isApplying ? 'animate-spin' : ''}`} />
                  <span>{isApplying ? 'Restoring...' : 'Apply Restoration'}</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
