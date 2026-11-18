import React from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Bookmark, Trash2 } from 'lucide-react';

export interface UnsavedChangesDialogProps {
  isOpen: boolean;
  dialogRef: React.RefObject<HTMLDivElement | null>;
  canSaveDraft?: boolean;
  onSaveDraft?: () => void;
  onDiscardAndExit: () => void;
  onKeepEditing: () => void;
}

export function UnsavedChangesDialog({
  isOpen,
  dialogRef,
  canSaveDraft = false,
  onSaveDraft,
  onDiscardAndExit,
  onKeepEditing,
}: UnsavedChangesDialogProps) {
  if (!isOpen) return null;

  const modalNode = (
    <div
      className="fixed inset-0 z-[130] bg-black/75 flex items-center justify-center p-4 animate-in fade-in duration-150 motion-reduce:animate-none pointer-events-auto"
      onClick={onKeepEditing}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Unsaved Changes"
        onClick={(e) => e.stopPropagation()}
        className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl focus:outline-none"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center shrink-0">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-zinc-900 dark:text-white">
              Unsaved Changes
            </h3>
            <p className="text-xs lg:text-sm text-zinc-500 dark:text-zinc-400">
              {canSaveDraft
                ? 'Save a draft for later, or discard your changes.'
                : 'You have unsaved changes that will be lost.'}
            </p>
          </div>
        </div>

        <div className="space-y-2 pt-1">
          {canSaveDraft && onSaveDraft && (
            <button
              type="button"
              onClick={onSaveDraft}
              className="w-full min-h-[44px] bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs lg:text-sm font-bold flex items-center justify-center gap-2 cursor-pointer active:scale-[0.98] transition-[transform,colors] duration-100 motion-reduce:transition-none"
            >
              <Bookmark className="w-3.5 h-3.5" />
              <span>Save draft</span>
            </button>
          )}

          <button
            type="button"
            onClick={onDiscardAndExit}
            className="w-full min-h-[44px] bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs lg:text-sm font-bold flex items-center justify-center gap-2 cursor-pointer active:scale-[0.98] transition-[transform,colors] duration-100 motion-reduce:transition-none"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Discard &amp; Exit</span>
          </button>

          <button
            type="button"
            onClick={onKeepEditing}
            className="w-full min-h-[44px] rounded-xl text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-900 text-xs lg:text-sm font-semibold cursor-pointer transition-colors motion-reduce:transition-none"
          >
            Keep editing
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalNode, document.body) : modalNode;
}
