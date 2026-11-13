import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Megaphone, Plus } from 'lucide-react';
import { AdminAnnouncement, adminService } from '../adminService';
import { EmptyState, GroupedList, ListRow, Segmented, Skel, StatusChip } from '../ui';
import { triggerHaptic } from '../../lib/haptics';

const NoticeEditor = lazy(() => import('./NoticeEditor'));

interface NoticesListProps {
  refreshNonce: number;
  isOnline: boolean;
  onDataChanged: () => Promise<void>;
}

type NoticesTabFilter = 'active' | 'ended';

function isNoticeLive(item: AdminAnnouncement): boolean {
  if (!item.active) return false;
  if (!item.ends_at) return true;
  return new Date(item.ends_at).getTime() > Date.now();
}

function formatAudience(item: AdminAnnouncement): string {
  if (item.audience === 'org') return item.target_org_id || 'One organiser';
  if (item.audience === 'organisers') return 'Organisers';
  if (item.audience === 'judges') return 'Judges';
  return 'Everyone';
}

function formatDateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function NoticesList({ refreshNonce, isOnline, onDataChanged }: NoticesListProps) {
  const [filter, setFilter] = useState<NoticesTabFilter>('active');
  const [notices, setNotices] = useState<AdminAnnouncement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingNotice, setEditingNotice] = useState<AdminAnnouncement | null>(null);

  const loadNotices = useCallback(async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const list = await adminService.listAnnouncements();
      setNotices(Array.isArray(list) ? list : []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load notices.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNotices();
  }, [loadNotices, refreshNonce]);

  const activeNotices = notices.filter(isNoticeLive);
  const endedNotices = notices.filter((n) => !isNoticeLive(n));
  const visibleNotices = filter === 'active' ? activeNotices : endedNotices;

  const openNewNotice = () => {
    if (!isOnline) return;
    triggerHaptic('light');
    setEditingNotice(null);
    setEditorOpen(true);
  };

  const openEditNotice = (item: AdminAnnouncement) => {
    setEditingNotice(item);
    setEditorOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <Segmented
          options={[
            { value: 'active', label: 'Active', count: activeNotices.length },
            { value: 'ended', label: 'Ended', count: endedNotices.length },
          ]}
          value={filter}
          onChange={setFilter}
          ariaLabel="Notice status filter"
          className="flex-1"
        />

        <button
          type="button"
          disabled={!isOnline}
          onClick={openNewNotice}
          className="admin-press min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-[14px] font-semibold inline-flex items-center justify-center gap-2 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>New notice</span>
        </button>
      </div>

      {error && (
        <EmptyState
          icon={<AlertTriangle className="w-5 h-5 text-red-500" />}
          message={error}
          actionLabel="Retry"
          onAction={() => void loadNotices()}
          actionDisabled={!isOnline}
        />
      )}

      {isLoading && notices.length === 0 && !error && (
        <GroupedList>
          {Array.from({ length: 3 }).map((_, i) => (
            <ListRow
              key={i}
              title={<Skel w="60%" h={15} />}
              subtitle={<Skel w="80%" h={12} />}
              trailing={<Skel w={58} h={22} rounded="rounded-full" />}
            />
          ))}
        </GroupedList>
      )}

      {!isLoading && !error && visibleNotices.length === 0 && (
        <EmptyState
          icon={<Megaphone className="w-5 h-5" />}
          message={
            filter === 'active'
              ? 'No active notices right now.'
              : 'No ended notices yet.'
          }
          actionLabel={filter === 'active' ? 'New notice' : undefined}
          onAction={filter === 'active' ? openNewNotice : undefined}
          actionDisabled={!isOnline}
        />
      )}

      {!error && visibleNotices.length > 0 && (
        <GroupedList>
          {visibleNotices.map((item) => {
            const tone =
              item.severity === 'urgent'
                ? 'problem'
                : item.severity === 'warning'
                  ? 'waiting'
                  : 'neutral';
            const sevLabel =
              item.severity === 'urgent'
                ? 'Urgent'
                : item.severity === 'warning'
                  ? 'Warning'
                  : 'Info';

            const timeDetail = item.ends_at
              ? filter === 'active'
                ? `Ends ${formatDateTime(item.ends_at)}`
                : `Ended ${formatDateTime(item.ends_at)}`
              : `Posted ${formatDateTime(item.starts_at)}`;

            return (
              <ListRow
                key={item.id}
                onClick={() => openEditNotice(item)}
                title={item.title}
                subtitle={`${formatAudience(item)} · ${timeDetail}`}
                trailing={<StatusChip tone={tone} label={sevLabel} />}
                chevron
              />
            );
          })}
        </GroupedList>
      )}

      <Suspense fallback={null}>
        <NoticeEditor
          open={editorOpen}
          notice={editingNotice}
          isOnline={isOnline}
          onClose={() => setEditorOpen(false)}
          onSaved={async () => {
            await Promise.all([loadNotices(), onDataChanged()]);
          }}
        />
      </Suspense>
    </div>
  );
}
