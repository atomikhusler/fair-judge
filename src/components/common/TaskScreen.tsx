import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft } from 'lucide-react';

// ========================================================
// SHARED BODY SCROLL LOCK (Ref-counted across stacked modals)
// ========================================================
let activeScrollLocks = 0;
let savedBodyOverflow = '';

export function useBodyScrollLock(isLocked: boolean): void {
  useEffect(() => {
    if (!isLocked || typeof document === 'undefined') return;
    if (activeScrollLocks === 0) {
      savedBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    activeScrollLocks += 1;
    return () => {
      activeScrollLocks = Math.max(0, activeScrollLocks - 1);
      if (activeScrollLocks === 0) {
        document.body.style.overflow = savedBodyOverflow;
      }
    };
  }, [isLocked]);
}

// ========================================================
// SHARED VISUAL VIEWPORT KEYBOARD OFFSET HOOK
// ========================================================
export function useVisualViewportOffset(isActive: boolean): number {
  const [keyboardInset, setKeyboardInset] = useState(0);

  useEffect(() => {
    if (!isActive || typeof window === 'undefined') {
      setKeyboardInset(0);
      return;
    }

    const vv = window.visualViewport;
    if (!vv) {
      setKeyboardInset(0);
      return;
    }

    const updateInset = () => {
      const rawInset = Math.round(window.innerHeight - (vv.height + vv.offsetTop));
      setKeyboardInset(rawInset > 2 ? rawInset : 0);
    };

    updateInset();
    vv.addEventListener('resize', updateInset);
    vv.addEventListener('scroll', updateInset);
    window.addEventListener('resize', updateInset);

    return () => {
      vv.removeEventListener('resize', updateInset);
      vv.removeEventListener('scroll', updateInset);
      window.removeEventListener('resize', updateInset);
    };
  }, [isActive]);

  return keyboardInset;
}

// ========================================================
// FOCUSED INPUT SCROLL-INTO-VIEW HELPER
// ========================================================
export function scrollFocusedInputIntoView(target: EventTarget | null): void {
  if (typeof window === 'undefined' || !(target instanceof HTMLElement)) return;
  if (!target.matches('input, textarea, select')) return;

  if (target instanceof HTMLInputElement) {
    const type = (target.type || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio' || type === 'hidden' || type === 'file') {
      return;
    }
    if (target.readOnly) return;
  }

  window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      if (target.isConnected) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, 90);
  });
}

// ========================================================
// FOCUSABLE SELECTOR & TOPMOST MODAL ACCESSIBILITY HOOK
// ========================================================
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface UseModalAccessibilityOptions {
  isOpen: boolean;
  isTopmost: boolean;
  onClose: () => void;
  containerRef: React.RefObject<HTMLElement | null>;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

export function useModalAccessibility({
  isOpen,
  isTopmost,
  onClose,
  containerRef,
  initialFocusRef,
}: UseModalAccessibilityOptions): void {
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useBodyScrollLock(isOpen);

  // Capture focus on open, move focus inside, and restore on close
  useEffect(() => {
    if (isOpen) {
      if (!wasOpenRef.current) {
        wasOpenRef.current = true;
        previousFocusRef.current =
          typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
      }

      const focusTimer = window.setTimeout(() => {
        const container = containerRef.current;
        if (!container) return;

        if (container.contains(document.activeElement)) return;

        const autoFocused = container.querySelector<HTMLElement>('[data-autofocus], [autofocus]');
        if (autoFocused && (autoFocused.offsetParent !== null || autoFocused.getClientRects().length > 0)) {
          autoFocused.focus();
          return;
        }

        if (initialFocusRef?.current && initialFocusRef.current.isConnected) {
          initialFocusRef.current.focus();
          return;
        }

        const firstFocusable = Array.from(
          container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).find((el) => el.offsetParent !== null || el.getClientRects().length > 0);

        if (firstFocusable) {
          firstFocusable.focus();
        } else {
          container.focus();
        }
      }, 20);

      return () => window.clearTimeout(focusTimer);
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      if (prev && prev.isConnected) {
        window.requestAnimationFrame(() => {
          if (prev.isConnected) prev.focus();
        });
      }
    }
  }, [isOpen, containerRef, initialFocusRef]);

  // Restore focus if unmounted while open
  useEffect(() => {
    return () => {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        const prev = previousFocusRef.current;
        previousFocusRef.current = null;
        if (prev && prev.isConnected) {
          prev.focus();
        }
      }
    };
  }, []);

  // Topmost Escape and Tab trap
  useEffect(() => {
    if (!isOpen || !isTopmost) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (e.key === 'Tab' && containerRef.current) {
        const candidates = Array.from(
          containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);

        if (candidates.length === 0) {
          e.preventDefault();
          containerRef.current.focus();
          return;
        }

        const first = candidates[0];
        const last = candidates[candidates.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (!active || !containerRef.current.contains(active)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }

        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, isTopmost, containerRef]);
}

// ========================================================
// TASK SCREEN COMPONENT
// ========================================================
export interface TaskScreenAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  icon?: React.ReactNode;
  variant?: 'emerald' | 'indigo' | 'amber' | 'neutral';
}

export interface TaskScreenProps {
  isOpen: boolean;
  title: string;
  subtitle?: string;
  titleBadge?: React.ReactNode;
  onBack: () => void;
  backLabel?: string;
  primaryAction?: TaskScreenAction;
  secondaryAction?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
  };
  headerAction?: React.ReactNode;
  footer?: React.ReactNode;
  hasNestedOverlay?: boolean;
  maxWidthClass?: string;
  children: React.ReactNode;
}

const PRIMARY_VARIANT_CLASSES: Record<NonNullable<TaskScreenAction['variant']>, string> = {
  emerald:
    'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/20',
  indigo:
    'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-600/20',
  amber:
    'bg-amber-500 hover:bg-amber-400 text-black font-black shadow-md shadow-amber-500/20',
  neutral:
    'bg-zinc-900 hover:bg-zinc-800 dark:bg-white dark:hover:bg-zinc-100 text-white dark:text-black shadow-sm',
};

export function TaskScreen({
  isOpen,
  title,
  subtitle,
  titleBadge,
  onBack,
  backLabel = 'Back',
  primaryAction,
  secondaryAction,
  headerAction,
  footer,
  hasNestedOverlay = false,
  maxWidthClass = 'md:max-w-[720px]',
  children,
}: TaskScreenProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const backBtnRef = useRef<HTMLButtonElement>(null);
  const keyboardInset = useVisualViewportOffset(isOpen);

  useModalAccessibility({
    isOpen,
    isTopmost: isOpen && !hasNestedOverlay,
    onClose: onBack,
    containerRef: panelRef,
    initialFocusRef: backBtnRef,
  });

  if (!isOpen) return null;

  const hasFooter = Boolean(footer || primaryAction || secondaryAction);
  const primaryVariant = primaryAction?.variant || 'emerald';

  const content = (
    <div
      className="fixed inset-0 z-[120] flex flex-col bg-stone-50 dark:bg-black pointer-events-auto animate-in fade-in duration-150 motion-reduce:animate-none md:bg-black/75 md:dark:bg-black/75 md:items-center md:justify-center md:p-6"
      style={keyboardInset > 0 ? { paddingBottom: `${keyboardInset}px` } : undefined}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`flex flex-col flex-1 min-h-0 w-full bg-stone-50 dark:bg-black text-stone-900 dark:text-stone-100 focus:outline-none md:flex-initial md:w-full ${maxWidthClass} md:h-auto ${
          keyboardInset > 0 ? 'md:max-h-full' : 'md:max-h-[90dvh]'
        } md:border md:border-stone-200 md:dark:border-zinc-800 md:rounded-2xl md:shadow-2xl md:overflow-hidden`}
      >
        {/* Top Bar */}
        <header className="shrink-0 z-20 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md border-b border-stone-200 dark:border-zinc-800 px-3 sm:px-4 py-2.5 flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <button
              ref={backBtnRef}
              type="button"
              onClick={onBack}
              aria-label={backLabel}
              className="min-w-[44px] min-h-[44px] px-2.5 rounded-xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center gap-1.5 text-zinc-700 dark:text-zinc-200 hover:text-zinc-950 dark:hover:text-white active:scale-95 transition-[transform,colors] duration-100 motion-reduce:transition-none cursor-pointer shrink-0"
            >
              <ArrowLeft className="w-4 h-4 shrink-0" />
              <span className="hidden sm:inline text-xs font-bold">{backLabel}</span>
            </button>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="text-sm sm:text-base font-bold text-zinc-900 dark:text-white leading-tight truncate">
                  {title}
                </h2>
                {titleBadge}
              </div>
              {subtitle ? (
                <p className="text-[11px] lg:text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>

          {headerAction ? <div className="shrink-0 flex items-center">{headerAction}</div> : null}
        </header>

        {/* Scrollable Body */}
        <div
          onFocusCapture={(e) => scrollFocusedInputIntoView(e.target)}
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-5 space-y-6"
        >
          {children}
        </div>

        {/* Sticky Keyboard-Safe Bottom Footer */}
        {hasFooter ? (
          <footer
            className={`shrink-0 z-20 bg-stone-50/95 dark:bg-zinc-950/95 backdrop-blur-md border-t border-stone-200 dark:border-zinc-800 px-4 py-3 ${
              keyboardInset > 0 ? '' : 'pb-safe'
            } flex items-center justify-between gap-3`}
          >
            <div className="min-w-0 flex-1 flex items-center">{footer}</div>

            {(secondaryAction || primaryAction) && (
              <div className="flex items-center gap-2.5 shrink-0">
                {secondaryAction && (
                  <button
                    type="button"
                    disabled={secondaryAction.disabled}
                    onClick={secondaryAction.onClick}
                    className="min-h-[44px] px-4 rounded-xl border border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 text-xs sm:text-sm font-bold text-stone-700 dark:text-zinc-300 hover:bg-stone-100 dark:hover:bg-zinc-800 active:scale-[0.98] transition-[transform,colors] duration-100 motion-reduce:transition-none disabled:opacity-40 cursor-pointer"
                  >
                    {secondaryAction.label}
                  </button>
                )}

                {primaryAction && (
                  <button
                    type="button"
                    disabled={primaryAction.disabled || primaryAction.loading}
                    onClick={primaryAction.onClick}
                    className={`min-h-[44px] px-5 rounded-xl text-xs sm:text-sm font-bold active:scale-[0.98] transition-[transform,opacity] duration-100 motion-reduce:transition-none disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-1.5 ${PRIMARY_VARIANT_CLASSES[primaryVariant]}`}
                  >
                    {primaryAction.icon}
                    <span>
                      {primaryAction.loading
                        ? primaryAction.loadingLabel || 'Saving...'
                        : primaryAction.label}
                    </span>
                  </button>
                )}
              </div>
            )}
          </footer>
        ) : null}
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}
