import React from 'react';
import { AlertTriangle, Megaphone, X } from 'lucide-react';
import { PlatformAnnouncement } from '../../lib/announcements';
import { triggerHaptic } from '../../lib/haptics';

interface AnnouncementBannerProps {
  notices: PlatformAnnouncement[];
  onDismiss: (id: string) => void;
}

export const AnnouncementBanner: React.FC<AnnouncementBannerProps> = ({
  notices,
  onDismiss,
}) => {
  if (!notices || notices.length === 0) return null;

  return (
    <div className="w-full shrink-0 z-20" role="region" aria-label="Platform announcements">
      {notices.map((notice) => {
        const isUrgent = notice.severity === 'urgent';
        const isWarning = notice.severity === 'warning';

        const containerClass = isUrgent
          ? 'bg-red-50 dark:bg-red-950 border-b border-red-200 dark:border-red-900 text-red-900 dark:text-red-100'
          : isWarning
          ? 'bg-amber-50 dark:bg-amber-950 border-b border-amber-200 dark:border-amber-900 text-amber-900 dark:text-amber-100'
          : 'bg-stone-100 dark:bg-zinc-900 border-b border-stone-200 dark:border-zinc-800 text-zinc-900 dark:text-zinc-100';

        const iconClass = isUrgent
          ? 'text-red-600 dark:text-red-400'
          : isWarning
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-violet-600 dark:text-violet-400';

        const subTextClass = isUrgent
          ? 'text-red-800 dark:text-red-200'
          : isWarning
          ? 'text-amber-800 dark:text-amber-200'
          : 'text-zinc-600 dark:text-zinc-300';

        const closeBtnClass = isUrgent
          ? 'text-red-700/70 hover:text-red-900 hover:bg-red-100 dark:text-red-300/70 dark:hover:text-red-100 dark:hover:bg-red-900'
          : isWarning
          ? 'text-amber-700/70 hover:text-amber-900 hover:bg-amber-100 dark:text-amber-300/70 dark:hover:text-amber-100 dark:hover:bg-amber-900'
          : 'text-zinc-500 hover:text-zinc-900 hover:bg-stone-200 dark:text-zinc-400 dark:hover:text-zinc-100 dark:hover:bg-zinc-800';

        return (
          <div
            key={notice.id}
            role={isUrgent ? 'alert' : 'status'}
            className={`w-full px-3 sm:px-4 py-2 ${containerClass}`}
          >
            <div className="max-w-4xl mx-auto flex items-start justify-between gap-2.5">
              <div className="flex items-start gap-2.5 min-w-0 py-1">
                {isUrgent || isWarning ? (
                  <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${iconClass}`} />
                ) : (
                  <Megaphone className={`w-4 h-4 shrink-0 mt-0.5 ${iconClass}`} />
                )}
                <div className="min-w-0 text-xs leading-snug">
                  <span className="font-bold mr-1.5">{notice.title}:</span>
                  <span className={`break-words ${subTextClass}`}>{notice.body}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => {
                  triggerHaptic('tick');
                  onDismiss(notice.id);
                }}
                aria-label={`Dismiss announcement: ${notice.title}`}
                className={`w-11 h-11 -my-1.5 -mr-2 rounded-xl shrink-0 flex items-center justify-center cursor-pointer ${closeBtnClass}`}
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
};
