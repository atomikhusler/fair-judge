import React, { useState, useEffect } from 'react';
import { eventBus, ToastPayload } from '../../lib/eventBus';
import { CheckCircle2, AlertTriangle, Info, AlertCircle, X } from 'lucide-react';

interface ToastItem extends ToastPayload {
  id: string;
}

export function ToastManager() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const unsub = eventBus.on('toast', (payload: ToastPayload) => {
      const id = payload.id || `toast_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const newToast: ToastItem = { ...payload, id };

      setToasts((prev) => {
        // Limit to max 3 toasts at any time to avoid screen clutter
        const next = [newToast, ...prev.filter((t) => t.title !== payload.title || t.message !== payload.message)];
        return next.slice(0, 3);
      });

      const timer = setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== id));
      }, payload.duration || 3500);

      return () => clearTimeout(timer);
    });

    return unsub;
  }, []);

  const dismissToast = (id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="fixed bottom-5 right-4 z-[99999] flex flex-col gap-2 max-w-sm w-full pointer-events-none select-none sm:right-6 sm:bottom-6"
    >
      {toasts.map((toast) => {
        const isSuccess = toast.type === 'success';
        const isWarning = toast.type === 'warning';
        const isError = toast.type === 'error';

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-start justify-between gap-3 p-3.5 rounded-2xl bg-zinc-950/95 backdrop-blur-md border shadow-2xl transition-all duration-300 animate-in fade-in slide-in-from-bottom-3 ${
              isSuccess
                ? 'border-emerald-500/40 shadow-emerald-950/30'
                : isWarning
                ? 'border-amber-500/40 shadow-amber-950/30'
                : isError
                ? 'border-rose-500/40 shadow-rose-950/30'
                : 'border-blue-500/40 shadow-blue-950/30'
            }`}
          >
            <div className="flex items-start gap-2.5 min-w-0">
              <div className="mt-0.5 shrink-0">
                {isSuccess && <CheckCircle2 className="w-4 h-4 text-emerald-400 stroke-[2.5]" />}
                {isWarning && <AlertTriangle className="w-4 h-4 text-amber-400 stroke-[2.5]" />}
                {isError && <AlertCircle className="w-4 h-4 text-rose-400 stroke-[2.5]" />}
                {!isSuccess && !isWarning && !isError && <Info className="w-4 h-4 text-blue-400 stroke-[2.5]" />}
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-bold text-white tracking-tight leading-tight">
                  {toast.title}
                </span>
                {toast.message && (
                  <span className="text-[11px] text-zinc-400 font-medium leading-relaxed mt-0.5 break-words">
                    {toast.message}
                  </span>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="text-zinc-500 hover:text-zinc-300 p-1 rounded-lg hover:bg-zinc-800/60 transition-colors shrink-0"
              aria-label="Dismiss Notification"
            >
              <X className="w-3.5 h-3.5 stroke-[2]" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
