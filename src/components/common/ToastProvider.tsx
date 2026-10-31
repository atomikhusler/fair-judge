import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { eventBus, ToastPayload } from '../../lib/eventBus';

export type ToastType = 'success' | 'warning' | 'info' | 'error';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
}

export interface ToastContextValue {
  showToast: (message: string, type?: ToastType, duration?: number) => void;
  toast: {
    success: (message: string, duration?: number) => void;
    error: (message: string, duration?: number) => void;
    warning: (message: string, duration?: number) => void;
    info: (message: string, duration?: number) => void;
  };
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Global showToast function that dispatches via eventBus.
 * Accessible from anywhere in the application (inside or outside React components).
 */
export function showToast(
  message: string,
  type: ToastType = 'success',
  duration: number = 2800
) {
  eventBus.emit('toast', {
    id: `toast_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
    type,
    title: message,
    message,
    duration,
  });
}

export const toast = {
  success: (msg: string, d?: number) => showToast(msg, 'success', d),
  error: (msg: string, d?: number) => showToast(msg, 'error', d),
  warning: (msg: string, d?: number) => showToast(msg, 'warning', d),
  info: (msg: string, d?: number) => showToast(msg, 'info', d),
};

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context) return context;
  return {
    showToast,
    toast,
  };
}

/**
 * Standardized Global Toast Renderer conforming to the Organiser Settings & Preferences gold standard:
 * - Premium AMOLED dark pill (bg-zinc-900/95 dark:bg-zinc-950/95)
 * - Emerald-accented CheckCircle2 icon
 * - Zero close (X) button
 * - Centered top placement (pointer-events-none)
 */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const unsub = eventBus.on('toast', (payload: ToastPayload) => {
      const msg = payload.message || payload.title || '';
      if (!msg) return;

      const id = payload.id || `toast_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const duration = payload.duration || 2800;
      const type: ToastType = payload.type || 'success';

      const newToast: ToastItem = {
        id,
        type,
        message: msg,
        duration,
      };

      setToasts((prev) => {
        // Keep at most 2 toasts at a time, replace identical messages to prevent duplicates
        const filtered = prev.filter((t) => t.message !== msg);
        return [newToast, ...filtered].slice(0, 2);
      });

      const timer = setTimeout(() => {
        setToasts((current) => current.filter((t) => t.id !== id));
      }, duration);

      return () => clearTimeout(timer);
    });

    return unsub;
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="Notifications"
      className="fixed top-5 left-1/2 -translate-x-1/2 z-[99999] w-11/12 max-w-sm pointer-events-none flex flex-col items-center gap-2 select-none"
    >
      {toasts.map((item) => {
        const isError = item.type === 'error';
        const isWarning = item.type === 'warning';
        const isInfo = item.type === 'info';

        return (
          <div
            key={item.id}
            className="w-full py-2.5 px-4 rounded-full bg-zinc-900/95 dark:bg-zinc-950/95 text-white border border-zinc-700/60 dark:border-zinc-800/80 shadow-2xl backdrop-blur-md flex items-center justify-center space-x-2 text-center text-xs font-medium animate-in fade-in slide-in-from-top-2 duration-200"
          >
            {isError ? (
              <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
            ) : isWarning ? (
              <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
            ) : isInfo ? (
              <Info className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            ) : (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            )}
            <span className="truncate">{item.message}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const handleShowToast = useCallback(
    (message: string, type: ToastType = 'success', duration: number = 2800) => {
      showToast(message, type, duration);
    },
    []
  );

  const contextValue: ToastContextValue = {
    showToast: handleShowToast,
    toast,
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastContainer />
    </ToastContext.Provider>
  );
}
