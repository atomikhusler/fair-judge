import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { triggerHaptic } from '../../lib/haptics';

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidthClass?: string;
  closeDisabled?: boolean;
}

let activeScrollLocks = 0;
let previousOverflow = '';

export function BottomSheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  maxWidthClass = 'md:max-w-md',
  closeDisabled = false,
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Scroll lock restored on unmount
  useEffect(() => {
    if (!open) return;

    if (activeScrollLocks === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    activeScrollLocks += 1;

    return () => {
      activeScrollLocks = Math.max(0, activeScrollLocks - 1);
      if (activeScrollLocks === 0) {
        document.body.style.overflow = previousOverflow;
      }
    };
  }, [open]);

  // Focus trap & Escape handler
  useEffect(() => {
    if (!open) return;

    previousFocusRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;

    const focusFirst = () => {
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length > 0) {
        focusables[0].focus();
      } else {
        panel.focus();
      }
    };

    const timer = window.setTimeout(focusFirst, 10);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!closeDisabled) {
          e.stopPropagation();
          onClose();
        }
        return;
      }

      if (e.key === 'Tab' && panel) {
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
        );
        if (focusables.length === 0) return;

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', handleKeyDown, true);
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus();
      }
    };
  }, [open, onClose, closeDisabled]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title || 'Dialog'}
      className="fixed inset-0 z-50 bg-black/60 flex items-end md:items-center justify-center md:p-4 admin-overlay-in"
      onClick={() => {
        if (!closeDisabled) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`w-full ${maxWidthClass} max-h-[calc(100dvh-2rem)] bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-t-2xl md:rounded-2xl flex flex-col overflow-hidden focus:outline-none admin-sheet-in pb-[env(safe-area-inset-bottom)] md:pb-0`}
      >
        {/* Drag handle on mobile sheets (<768px) */}
        <div className="md:hidden pt-2.5 pb-1 flex justify-center shrink-0" aria-hidden="true">
          <div className="w-9 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700" />
        </div>

        {(title || subtitle) && (
          <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 flex items-start justify-between gap-3 shrink-0">
            <div className="min-w-0">
              {title && (
                <h2 className="admin-title text-zinc-900 dark:text-zinc-100 truncate">
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="admin-caption text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
                  {subtitle}
                </p>
              )}
            </div>
            <button
              type="button"
              disabled={closeDisabled}
              onClick={() => {
                triggerHaptic('light');
                onClose();
              }}
              aria-label="Close dialog"
              className="admin-press min-h-[44px] min-w-[44px] -mr-2 -my-1.5 rounded-xl flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer shrink-0 disabled:opacity-50"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4">
          {children}
        </div>
      </div>
    </div>
  );
}
