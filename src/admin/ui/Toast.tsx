import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';
import { triggerHaptic } from '../../lib/haptics';

export type AdminToastTone = 'success' | 'error' | 'info';

export interface AdminToastItem {
  id: number;
  message: string;
  tone: AdminToastTone;
  undoLabel?: string;
  onUndo?: () => void | Promise<void>;
}

type ToastListener = (toast: AdminToastItem | null) => void;
const listeners = new Set<ToastListener>();
let toastSeq = 0;

export function showAdminToast(
  message: string,
  options?: {
    tone?: AdminToastTone;
    undoLabel?: string;
    onUndo?: () => void | Promise<void>;
  }
) {
  toastSeq += 1;
  const item: AdminToastItem = {
    id: toastSeq,
    message,
    tone: options?.tone || 'info',
    undoLabel: options?.undoLabel,
    onUndo: options?.onUndo,
  };
  listeners.forEach((fn) => fn(item));
}

export function dismissAdminToast() {
  listeners.forEach((fn) => fn(null));
}

export function AdminToastHost() {
  const [toast, setToast] = useState<AdminToastItem | null>(null);
  const [isUndoing, setIsUndoing] = useState(false);

  useEffect(() => {
    const listener: ToastListener = (next) => {
      setIsUndoing(false);
      setToast(next);
    };
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => {
      setToast(null);
    }, 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;

  const Icon =
    toast.tone === 'success'
      ? CheckCircle2
      : toast.tone === 'error'
      ? AlertTriangle
      : Info;

  const iconColor =
    toast.tone === 'success'
      ? 'text-green-500'
      : toast.tone === 'error'
      ? 'text-red-500'
      : 'text-violet-500';

  const handleUndo = async () => {
    if (!toast.onUndo || isUndoing) return;
    setIsUndoing(true);
    triggerHaptic('light');
    try {
      await toast.onUndo();
    } finally {
      setIsUndoing(false);
      setToast(null);
    }
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] md:bottom-6 left-4 right-4 md:left-auto md:right-6 md:max-w-sm z-50 pointer-events-none flex justify-center md:justify-end"
    >
      <div className="pointer-events-auto w-full rounded-2xl bg-zinc-900 dark:bg-zinc-800 text-zinc-100 border border-zinc-800 dark:border-zinc-700 px-4 py-2.5 flex items-center justify-between gap-3 shadow-lg admin-toast-in">
        <div className="flex items-center gap-2.5 min-w-0">
          <Icon className={`w-4 h-4 shrink-0 ${iconColor}`} />
          <span className="admin-body text-[14px] leading-[20px] truncate">{toast.message}</span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {toast.onUndo && (
            <button
              type="button"
              disabled={isUndoing}
              onClick={() => void handleUndo()}
              className="admin-press min-h-[44px] px-3 rounded-xl text-[13px] font-semibold text-violet-400 hover:bg-zinc-800 dark:hover:bg-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer disabled:opacity-50"
            >
              {toast.undoLabel || 'Undo'}
            </button>
          )}
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
            className="min-h-[44px] min-w-[44px] -mr-2 rounded-xl flex items-center justify-center text-zinc-400 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
