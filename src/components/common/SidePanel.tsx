import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export interface SidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  titleId?: string;
  titleBadge?: React.ReactNode;
  ariaLabel?: string;
  icon: React.ReactNode;
  headerActions?: React.ReactNode;
  closeAriaLabel?: string;
  hasActiveOverlay?: boolean;
  disableEscapeClose?: boolean;
  onEscapeBeforeClose?: () => boolean;
  bodyClassName?: string;
  children: React.ReactNode;
  overlays?: React.ReactNode;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function SidePanel({
  isOpen,
  onClose,
  title,
  subtitle,
  titleId,
  titleBadge,
  ariaLabel,
  icon,
  headerActions,
  closeAriaLabel = 'Close panel',
  hasActiveOverlay = false,
  disableEscapeClose = false,
  onEscapeBeforeClose,
  bodyClassName,
  children,
  overlays,
}: SidePanelProps) {
  const [shouldRender, setShouldRender] = useState<boolean>(isOpen);
  const [isClosing, setIsClosing] = useState<boolean>(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef<boolean>(false);

  // Manage open/exit animation lifecycle with reduced-motion support
  useEffect(() => {
    if (isOpen) {
      setShouldRender(true);
      setIsClosing(false);
      return;
    }

    if (!shouldRender) return;

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion) {
      setIsClosing(false);
      setShouldRender(false);
      return;
    }

    setIsClosing(true);
    const closeTimer = window.setTimeout(() => {
      setIsClosing(false);
      setShouldRender(false);
    }, 320);

    return () => window.clearTimeout(closeTimer);
  }, [isOpen, shouldRender]);

  // Body scroll lock while panel is mounted/visible
  useEffect(() => {
    if (!shouldRender || typeof document === 'undefined') return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [shouldRender]);

  // Initial focus capture & restoration on close
  useEffect(() => {
    if (isOpen) {
      if (!wasOpenRef.current) {
        wasOpenRef.current = true;
        previousFocusRef.current =
          typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
      }

      const focusTimer = window.setTimeout(() => {
        closeBtnRef.current?.focus();
      }, 20);

      return () => {
        window.clearTimeout(focusTimer);
      };
    }

    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      const target = previousFocusRef.current;
      previousFocusRef.current = null;
      if (target && target.isConnected) {
        target.focus();
      }
    }
  }, [isOpen]);

  // Restore focus if SidePanel unmounts while open
  useEffect(() => {
    return () => {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        const target = previousFocusRef.current;
        previousFocusRef.current = null;
        if (target && target.isConnected) {
          target.focus();
        }
      }
    };
  }, []);

  // Escape key & Tab focus trap inside panel
  useEffect(() => {
    if (!shouldRender || !isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (disableEscapeClose) return;
        e.preventDefault();
        if (onEscapeBeforeClose?.()) return;
        onClose();
        return;
      }

      if (e.key === 'Tab' && !hasActiveOverlay && panelRef.current) {
        const candidates = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).filter((el) => el.offsetParent !== null || el.getClientRects().length > 0);

        if (candidates.length === 0) {
          e.preventDefault();
          closeBtnRef.current?.focus();
          return;
        }

        const first = candidates[0];
        const last = candidates[candidates.length - 1];
        const active = document.activeElement as HTMLElement | null;

        if (!active || !panelRef.current.contains(active)) {
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

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    shouldRender,
    isOpen,
    hasActiveOverlay,
    disableEscapeClose,
    onEscapeBeforeClose,
    onClose,
  ]);

  if (!shouldRender) return null;

  const content = (
    <>
      <div
        className={`fixed inset-0 z-50 flex ${
          isClosing ? 'pointer-events-none' : 'pointer-events-auto'
        }`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-label={titleId ? undefined : ariaLabel || title}
      >
        {/* Solid Dark Scrim */}
        <div
          onClick={onClose}
          className={`fixed inset-0 bg-black/60 ${
            isClosing ? 'animate-backdrop-exit' : 'animate-in fade-in duration-300'
          }`}
        />

        {/* Side Panel Container */}
        <div
          ref={panelRef}
          className={`relative w-full md:w-[480px] bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-white border-r border-stone-200 dark:border-zinc-800/80 shadow-2xl h-full flex flex-col z-10 select-none ${
            isClosing ? 'animate-spring-drawer-exit' : 'animate-spring-drawer'
          }`}
        >
          {/* Header */}
          <div className="px-5 pt-5 pb-4 shrink-0 flex items-center justify-between gap-3 border-b border-stone-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-950">
            <div className="flex items-center space-x-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/25 flex items-center justify-center text-emerald-600 dark:text-emerald-400 shrink-0">
                {icon}
              </div>
              <div className="min-w-0">
                <div className="flex items-center space-x-1.5">
                  <h2
                    id={titleId}
                    className="text-base font-bold tracking-tight text-zinc-900 dark:text-white leading-tight"
                  >
                    {title}
                  </h2>
                  {titleBadge}
                </div>
                {subtitle ? (
                  <p className="text-[11px] lg:text-sm text-zinc-600 dark:text-zinc-400 font-mono truncate">
                    {subtitle}
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex items-center space-x-2 shrink-0">
              {headerActions}
              <button
                ref={closeBtnRef}
                type="button"
                onClick={onClose}
                className="w-11 h-11 rounded-xl text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-white bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 shadow-sm transition-colors duration-200 active:scale-[0.96] motion-reduce:transition-none flex items-center justify-center cursor-pointer"
                title={closeAriaLabel}
                aria-label={closeAriaLabel}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Scrollable Panel Body */}
          <div
            className={`flex-1 overflow-y-auto px-4 py-3 space-y-1 overscroll-contain ${
              bodyClassName || 'bg-stone-100/50 dark:bg-black pb-20'
            }`}
          >
            {children}
          </div>
        </div>
      </div>

      {overlays}
    </>
  );

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
}
