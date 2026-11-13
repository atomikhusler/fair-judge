import React, { useState, useEffect } from 'react';
import { X, Download, ShieldCheck, Lock, Database, Check } from 'lucide-react';
import { Organization } from '../../../lib/supabaseTypes';
import { createBackup } from '../../../lib/backup';
import { useToast } from '../../common/ToastProvider';

interface BackupSheetProps {
  isOpen: boolean;
  onClose: () => void;
  organization: Organization;
}

export function BackupSheet({ isOpen, onClose, organization }: BackupSheetProps) {
  const { showToast } = useToast();
  const [pin, setPin] = useState('');
  const [isEncrypted, setIsEncrypted] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);

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

  const handleDownload = async () => {
    if (isEncrypted && pin.trim().length < 4) {
      showToast('PIN must be at least 4 digits.', 'error');
      return;
    }

    setIsExporting(true);
    try {
      const { filename, blob } = await createBackup(organization, isEncrypted ? pin.trim() : undefined);
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setDownloadSuccess(true);
      showToast('Backup downloaded successfully.', 'success');
      setTimeout(() => {
        setDownloadSuccess(false);
        onClose();
      }, 1500);
    } catch (err: any) {
      showToast(`Export failed: ${err.message || 'Unknown error'}`, 'error');
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-3 sm:p-4 bg-black/65 animate-in fade-in duration-150">
      <div 
        className="relative w-full max-w-md max-h-[calc(100dvh-2rem)] flex flex-col bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-labelledby="backup-title"
      >
        {/* Pinned Header */}
        <div className="shrink-0 px-5 py-4 border-b border-stone-100 dark:border-zinc-800/80 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <Database className="w-4 h-4" />
            </div>
            <div>
              <h3 id="backup-title" className="text-sm font-bold text-zinc-900 dark:text-white">
                Create Backup
              </h3>
              <p className="text-[11px] text-zinc-500">
                Export events, roster, judges and scores
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close backup modal"
            className="w-11 h-11 rounded-xl text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-900 flex items-center justify-center transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-5 space-y-4">
          <div className="p-3.5 rounded-2xl bg-stone-50 dark:bg-zinc-900/60 border border-stone-200 dark:border-zinc-800 text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
            <p className="font-semibold text-zinc-900 dark:text-white mb-1">
              Zero-Trust Offline Storage
            </p>
            <p>
              Your backup contains full competition archives. It does not contain passwords or auth keys and can be restored anytime on any device.
            </p>
          </div>

          {/* Encryption Option */}
          <div className="p-4 rounded-2xl border border-stone-200 dark:border-zinc-800 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <span className="text-xs font-bold text-zinc-900 dark:text-white block">
                  PIN Encryption
                </span>
                <span className="text-[11px] text-zinc-500 block">
                  Protect backup with AES-256 GCM
                </span>
              </div>
              <input
                type="checkbox"
                checked={isEncrypted}
                onChange={(e) => setIsEncrypted(e.target.checked)}
                className="w-4 h-4 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer"
                id="encrypt-toggle"
              />
            </div>

            {isEncrypted && (
              <div className="pt-2 animate-in fade-in duration-150 space-y-2">
                <label className="text-[11px] font-semibold text-zinc-500 block">
                  Set 4-Digit Security PIN
                </label>
                <div className="relative">
                  <Lock className="w-3.5 h-3.5 absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={12}
                    placeholder="Enter 4 to 8 digits"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    className="w-full pl-9 pr-3.5 py-2.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Pinned Footer */}
        <div className="shrink-0 p-4 border-t border-stone-100 dark:border-zinc-800/80 bg-stone-50/50 dark:bg-zinc-900/30 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="min-h-[44px] px-4 py-2.5 rounded-xl border border-stone-200 dark:border-zinc-800 text-xs font-semibold text-zinc-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors cursor-pointer"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleDownload}
            disabled={isExporting || (isEncrypted && pin.trim().length < 4)}
            className="min-h-[44px] px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold transition-colors shadow-sm flex items-center space-x-2 cursor-pointer active:scale-95 motion-reduce:transition-none"
          >
            {downloadSuccess ? (
              <>
                <Check className="w-4 h-4 text-white" />
                <span>Saved</span>
              </>
            ) : isExporting ? (
              <span>Preparing...</span>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>Download Backup</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
