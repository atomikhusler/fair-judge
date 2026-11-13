import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X, AlertTriangle, Megaphone, CheckCircle2 } from 'lucide-react';
import {
  StoredInboxAnnouncement,
  isCriticalSeverity,
  isNoticeRead,
} from '../../lib/announcements';
import { triggerHaptic } from '../../lib/haptics';

interface NotificationBellProps {
  notices: StoredInboxAnnouncement[];
  unreadCount: number;
  onMarkRead: (ids: string[]) => void;
  accent?: 'emerald' | 'amber';
  buttonClassName?: string;
}

function formatNoticeTime(iso?: string, fallbackMs?: number): string {
  const ms = iso ? Date.parse(iso) : NaN;
  const target = !Number.isNaN(ms) ? ms : fallbackMs || Date.now();
  const diffMin = Math.max(0, Math.floor((Date.now() - target) / 60000));
  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(target).toLocaleDateString();
}

export const NotificationBell: React.FC<NotificationBellProps> = ({
  notices,
  unreadCount,
  onMarkRead,
  accent = 'emerald',
  buttonClassName,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [openedUnreadIds, setOpenedUnreadIds] = useState<Set<string>>(new Set());
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(false);

  const handleOpen = () => {
    triggerHaptic('tick');
    const unreadNow = notices.filter((n) => !isNoticeRead(n.id)).map((n) => n.id);
    setOpenedUnreadIds(new Set(unreadNow));
    setIsOpen(true);
    if (unreadNow.length > 0) {
      onMarkRead(unreadNow);
    }
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  useEffect(() => {
    if (!isOpen) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        triggerRef.current?.focus();
      }
      return;
    }

    wasOpenRef.current = true;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 20);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  const badgeBg =
    accent === 'amber'
      ? 'bg-amber-500 text-black'
      : 'bg-emerald-500 text-white';

  const iconAccentBg =
    accent === 'amber'
      ? 'bg-amber-500/10 text-amber-500 dark:text-amber-400 border-amber-500/20'
      : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20';

  const modalContent = isOpen ? (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="notifications-inbox-title"
    >
      {/* Solid dark scrim — no backdrop-filter */}
      <div
        onClick={handleClose}
        className="fixed inset-0 bg-black/60 transition-opacity duration-200 motion-reduce:transition-none"
      />

      {/* Dialog matching Settings Sheet surface tokens */}
      <div className="relative w-full max-w-md bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-white border border-stone-200 dark:border-zinc-800 rounded-3xl shadow-2xl flex flex-col max-h-[85dvh] overflow-hidden animate-spring-sheet select-none">
        {/* Header */}
        <div className="px-5 py-4 shrink-0 flex items-center justify-between border-b border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
          <div className="flex items-center space-x-3">
            <div className={`w-10 h-10 rounded-xl border flex items-center justify-center ${iconAccentBg}`}>
              <Bell className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <h2
                id="notifications-inbox-title"
                className="text-base font-bold text-zinc-900 dark:text-white leading-tight"
              >
                Notifications
              </h2>
              <p className="text-[11px] text-zinc-500 font-mono">
                Announcements • Last 30 days
              </p>
            </div>
          </div>

          <button
            ref={closeBtnRef}
            type="button"
            onClick={handleClose}
            className="w-11 h-11 flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-white rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 transition-colors cursor-pointer"
            aria-label="Close notifications"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* List Body */}
        <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-2.5 bg-stone-100 dark:bg-black">
          {notices.length === 0 ? (
            <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-2xl p-8 text-center space-y-2.5 shadow-sm">
              <div className="w-11 h-11 rounded-2xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center mx-auto text-zinc-400">
                <CheckCircle2 className="w-5 h-5" />
              </div>
              <h3 className="text-sm font-bold text-zinc-900 dark:text-white">
                You&apos;re all caught up
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mx-auto leading-relaxed">
                Platform announcements from the last 30 days will appear here.
              </p>
            </div>
          ) : (
            notices.map((notice) => {
              const isCritical = isCriticalSeverity(notice.severity);
              const isWarning = notice.severity === 'warning';
              const wasJustOpenedUnread = openedUnreadIds.has(notice.id);

              const badgeClass = isCritical
                ? 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/25'
                : isWarning
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/25'
                : 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/25';

              const badgeLabel = isCritical ? 'Critical' : isWarning ? 'Notice' : 'Info';

              const cardBorder = wasJustOpenedUnread
                ? accent === 'amber'
                  ? 'border-amber-500/40'
                  : 'border-emerald-500/40'
                : 'border-stone-200 dark:border-zinc-800';

              return (
                <div
                  key={notice.id}
                  className={`p-4 rounded-2xl bg-white dark:bg-zinc-950 border ${cardBorder} shadow-sm space-y-1.5`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-lg border text-[10px] font-bold uppercase tracking-wider shrink-0 ${badgeClass}`}
                      >
                        {isCritical || isWarning ? (
                          <AlertTriangle className="w-3 h-3" />
                        ) : (
                          <Megaphone className="w-3 h-3" />
                        )}
                        <span>{badgeLabel}</span>
                      </span>
                      {wasJustOpenedUnread && (
                        <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                          New
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 shrink-0">
                      {formatNoticeTime(notice.starts_at, notice.savedAt)}
                    </span>
                  </div>

                  <h3 className="text-sm font-bold text-zinc-900 dark:text-white leading-snug break-words">
                    {notice.title}
                  </h3>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed break-words">
                    {notice.body}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleOpen}
        aria-label={
          unreadCount > 0
            ? `Notifications (${unreadCount} unread)`
            : 'Notifications'
        }
        title="Notifications"
        className={
          buttonClassName ||
          'relative w-11 h-11 rounded-2xl text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-900 transition-colors active:scale-[0.96] motion-reduce:transition-none flex items-center justify-center cursor-pointer'
        }
      >
        <Bell className="w-5 h-5 stroke-[2.1]" />
        {unreadCount > 0 && (
          <span
            className={`absolute top-1.5 right-1.5 min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono font-black leading-none flex items-center justify-center border-2 border-white dark:border-zinc-950 ${badgeBg}`}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {modalContent && typeof document !== 'undefined'
        ? createPortal(modalContent, document.body)
        : modalContent}
    </>
  );
};
