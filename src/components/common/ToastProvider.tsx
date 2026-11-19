import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  ReactNode,
} from 'react';
import { CheckCircle2, AlertTriangle, AlertCircle, Info } from 'lucide-react';
import { eventBus, ToastPayload, ToastAction } from '../../lib/eventBus';
import { playSound } from '../../lib/sound';

export type ToastType = 'success' | 'warning' | 'info' | 'error';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
  action?: ToastAction;
}

export interface ToastContextValue {
  showToast: (message: string, type?: ToastType, duration?: number, action?: ToastAction) => void;
  toast: {
    success: (message: string, duration?: number, action?: ToastAction) => void;
    error: (message: string, duration?: number, action?: ToastAction) => void;
    warning: (message: string, duration?: number, action?: ToastAction) => void;
    info: (message: string, duration?: number, action?: ToastAction) => void;
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
  duration: number = 3200,
  action?: ToastAction
) {
  eventBus.emit('toast', {
    id: `toast_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    type,
    title: message,
    message,
    duration,
    action,
  });
}

export const toast = {
  success: (msg: string, d?: number, action?: ToastAction) => showToast(msg, 'success', d, action),
  error: (msg: string, d?: number, action?: ToastAction) => showToast(msg, 'error', d, action),
  warning: (msg: string, d?: number, action?: ToastAction) => showToast(msg, 'warning', d, action),
  info: (msg: string, d?: number, action?: ToastAction) => showToast(msg, 'info', d, action),
};

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (context) return context;
  return {
    showToast,
    toast,
  };
}

interface StackedToastCardProps {
  item: ToastItem;
  index: number;
  total: number;
  onDismiss: (id: string) => void;
}

/**
 * ColorOS-Grade GPU-Accelerated Stacked Toast Item with Native Touch Swipe-to-Dismiss
 */
function StackedToastCard({ item, index, onDismiss }: StackedToastCardProps) {
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [dismissDirection, setDismissDirection] = useState<'left' | 'right' | null>(null);

  const startXRef = useRef(0);
  const currentXRef = useRef(0);
  const isPointerDownRef = useRef(false);

  // Stacking calculation (Phase 14.6 ColorOS Stack Specification)
  // index 0 (front): scale 1.00, translateY 0px, opacity 1.0, zIndex 30
  // index 1: scale 0.95, translateY -12px, opacity 0.78, zIndex 20
  // index 2: scale 0.90, translateY -24px, opacity 0.52, zIndex 10
  const offsetY = -index * 12;
  const scale = Math.max(0.85, 1 - index * 0.05);
  const baseOpacity = Math.max(0.4, 1 - index * 0.25);
  const zIndex = 30 - index * 10;
  const isFront = index === 0;

  // Touch Handlers (Mobile Native)
  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isFront) return;
    startXRef.current = e.touches[0].clientX;
    currentXRef.current = e.touches[0].clientX;
    isPointerDownRef.current = true;
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isPointerDownRef.current || !isFront) return;
    currentXRef.current = e.touches[0].clientX;
    const delta = currentXRef.current - startXRef.current;
    setDragX(delta);
  };

  const handleTouchEnd = () => {
    if (!isPointerDownRef.current || !isFront) return;
    isPointerDownRef.current = false;
    setIsDragging(false);

    // 80px swipe threshold
    if (Math.abs(dragX) > 80) {
      const dir = dragX > 0 ? 'right' : 'left';
      setDismissDirection(dir);
      setTimeout(() => {
        onDismiss(item.id);
      }, 200);
    } else {
      // Spring back to 0
      setDragX(0);
    }
  };

  // Mouse Handlers (Desktop Fluidity)
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!isFront || e.button !== 0) return;
    startXRef.current = e.clientX;
    currentXRef.current = e.clientX;
    isPointerDownRef.current = true;
    setIsDragging(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isPointerDownRef.current) return;
      currentXRef.current = moveEvent.clientX;
      const delta = currentXRef.current - startXRef.current;
      setDragX(delta);
    };

    const handleMouseUp = () => {
      isPointerDownRef.current = false;
      setIsDragging(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);

      if (Math.abs(currentXRef.current - startXRef.current) > 80) {
        const dir = (currentXRef.current - startXRef.current) > 0 ? 'right' : 'left';
        setDismissDirection(dir);
        setTimeout(() => {
          onDismiss(item.id);
        }, 200);
      } else {
        setDragX(0);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  // Color & Icon Taxonomy
  const isError = item.type === 'error';
  const isWarning = item.type === 'warning';
  const isInfo = item.type === 'info';

  const badgeTheme = isError
    ? 'bg-rose-50 text-rose-600 border-rose-200 shadow-none dark:bg-rose-500/10 dark:text-rose-400 dark:border-rose-500/30 dark:shadow-[0_0_12px_rgba(244,63,94,0.2)]'
    : isWarning
    ? 'bg-amber-50 text-amber-600 border-amber-200 shadow-none dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/30 dark:shadow-[0_0_12px_rgba(245,158,11,0.2)]'
    : isInfo
    ? 'bg-sky-50 text-sky-600 border-sky-200 shadow-none dark:bg-sky-500/10 dark:text-sky-400 dark:border-sky-500/30 dark:shadow-[0_0_12px_rgba(14,165,233,0.2)]'
    : 'bg-emerald-50 text-emerald-600 border-emerald-200 shadow-none dark:bg-emerald-500/10 dark:text-emerald-400 dark:border-emerald-500/30 dark:shadow-[0_0_12px_rgba(16,185,129,0.2)]';

  // Compute GPU translation & opacity
  let translateXStyle = `${dragX}px`;
  let currentOpacity = baseOpacity;

  if (dismissDirection === 'right') {
    translateXStyle = '120%';
    currentOpacity = 0;
  } else if (dismissDirection === 'left') {
    translateXStyle = '-120%';
    currentOpacity = 0;
  } else if (isDragging && isFront) {
    const fadeRatio = Math.max(0.2, 1 - Math.abs(dragX) / 220);
    currentOpacity = baseOpacity * fadeRatio;
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onMouseDown={handleMouseDown}
      style={{
        transform: `translate3d(${translateXStyle}, ${offsetY}px, 0) scale(${scale})`,
        opacity: currentOpacity,
        zIndex,
        pointerEvents: isFront ? 'auto' : 'none',
        transition: isDragging
          ? 'none'
          : 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1), opacity 200ms cubic-bezier(0.32, 0.72, 0, 1)',
        willChange: 'transform, opacity',
      }}
      className={`absolute bottom-0 left-0 right-0 w-full max-w-sm mx-auto select-none rounded-2xl bg-[var(--card-main)] dark:bg-zinc-950 border border-[var(--border-main)] dark:border-zinc-800 shadow-[0_12px_32px_rgba(15,23,42,0.12)] dark:shadow-[0_16px_40px_rgba(0,0,0,0.7)] p-3.5 flex items-center gap-3.5 motion-reduce:transition-none ${
        isFront ? 'cursor-grab active:cursor-grabbing hover:border-stone-300 dark:hover:border-zinc-700' : 'cursor-default'
      }`}
    >
      {/* Visual Accent Glowing Icon Pill */}
      <div className={`w-8 h-8 rounded-xl border flex items-center justify-center shrink-0 ${badgeTheme}`}>
        {isError ? (
          <AlertCircle className="w-4 h-4 stroke-[2.2]" />
        ) : isWarning ? (
          <AlertTriangle className="w-4 h-4 stroke-[2.2]" />
        ) : isInfo ? (
          <Info className="w-4 h-4 stroke-[2.2]" />
        ) : (
          <CheckCircle2 className="w-4 h-4 stroke-[2.2]" />
        )}
      </div>

      {/* Message Text with High Legibility Micro-Typography */}
      <div className="flex-1 min-w-0 pr-1">
        <p className="text-xs font-semibold text-[var(--text-primary)] dark:text-zinc-100 leading-snug break-words line-clamp-2">
          {item.message}
        </p>
      </div>

      {/* Optional Action Button (e.g. Undo) */}
      {isFront && item.action && (
        <button
          type="button"
          onTouchStart={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            item.action?.onClick();
            onDismiss(item.id);
          }}
          className="shrink-0 min-h-[44px] -my-2 px-3 rounded-lg text-xs font-bold text-emerald-700 hover:text-emerald-800 hover:bg-emerald-500/10 dark:text-emerald-400 dark:hover:text-emerald-300 dark:hover:bg-emerald-500/10 active:scale-95 transition-colors cursor-pointer"
        >
          {item.action.label}
        </button>
      )}

      {/* Front Toast Subtle Swipe Indicator Pill */}
      {isFront && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            onDismiss(item.id);
          }}
          title="Dismiss"
          className="shrink-0 w-5 h-5 rounded-full bg-stone-100 hover:bg-stone-200 text-zinc-500 hover:text-zinc-800 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/80 dark:text-zinc-400 dark:hover:text-zinc-200 flex items-center justify-center text-[10px] cursor-pointer transition-colors active:scale-90"
        >
          ×
        </div>
      )}
    </div>
  );
}

/**
 * Standardized Global ColorOS Stacked Toast Notification Center
 * - Root container has absolute maximum z-index (z-[9999] pointer-events-none)
 * - Fixed bottom floating placement (clears headers and sticky elements)
 * - Holds at most 3 layered notifications with spring-physics transforms
 */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const lastSoundRef = useRef<{ msg: string; at: number }>({ msg: '', at: 0 });

  const handleDismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const unsub = eventBus.on('toast', (payload: ToastPayload) => {
      const msg = payload.message || payload.title || '';
      if (!msg) return;

      const id = payload.id || `toast_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const duration = payload.duration || 3200;
      const type: ToastType = payload.type || 'success';

      const newToast: ToastItem = {
        id,
        type,
        message: msg,
        duration,
        action: payload.action,
      };

      const isSyncCompleteToast =
        type === 'success' &&
        payload.title === 'Synced to Cloud' &&
        typeof payload.message === 'string' &&
        payload.message.startsWith('Synchronized ');

      if (type === 'error' || type === 'warning' || type === 'info' || isSyncCompleteToast) {
        const now = Date.now();
        if (lastSoundRef.current.msg !== msg || now - lastSoundRef.current.at > 800) {
          lastSoundRef.current = { msg, at: now };
          const toastSound =
            type === 'error' ? 'alert' : type === 'warning' ? 'warning' : 'notify';
          playSound(toastSound);
        }
      }

      setToasts((prev) => {
        // Prevent duplicate spam of identical message
        const filtered = prev.filter((t) => t.message !== msg);
        // Prepend new toast and keep maximum 3 in the stack
        return [newToast, ...filtered].slice(0, 3);
      });

      // Auto dismiss after duration
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
      aria-label="System Notifications"
      className="fixed bottom-6 left-0 right-0 mx-auto w-full max-w-sm px-4 pointer-events-none z-[9999] h-20 flex items-end justify-center select-none"
    >
      {toasts.map((item, index) => (
        <StackedToastCard
          key={item.id}
          item={item}
          index={index}
          total={toasts.length}
          onDismiss={handleDismiss}
        />
      ))}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const handleShowToast = useCallback(
    (message: string, type: ToastType = 'success', duration: number = 3200, action?: ToastAction) => {
      showToast(message, type, duration, action);
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
