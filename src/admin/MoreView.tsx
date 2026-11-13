import React, { useState, useEffect, useCallback } from 'react';
import {
  Megaphone,
  ShieldAlert,
  History,
  RefreshCw,
  ArrowLeft,
  Lock,
  Sun,
  Moon,
  AlertTriangle,
} from 'lucide-react';
import {
  ScreenHeader,
  GroupedList,
  ListRow,
  EmptyState,
  Skel,
  showAdminToast,
} from './ui';
import { AdminMoreSection } from './useAdminRoute';
import { adminService, AdminAuditEntry } from './adminService';
import { NoticesList } from './notices/NoticesList';
import { AlertsTab } from './AlertsTab';
import { useTheme } from '../lib/theme';

interface MoreViewProps {
  section: AdminMoreSection | null;
  adminEmail: string;
  lockoutsCount: number;
  isOnline: boolean;
  isRefreshing: boolean;
  refreshNonce: number;
  onNavigateSection: (section: AdminMoreSection) => void;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onDataChanged: () => Promise<void>;
  onBackToApp: () => void;
  onLock: () => void;
}

const ACTION_LABELS: Record<string, string> = {
  set_verification: 'Verification updated',
  suspend_org: 'Organiser suspended',
  unsuspend_org: 'Organiser reactivated',
  reset_org_password: 'Password reset issued',
  soft_delete_org: 'Moved to bin',
  restore_org: 'Restored from bin',
  purge_deleted: 'Bin purged',
  unlock_org: 'Login throttle unlocked',
  set_enforcement: 'Enforcement updated',
  create_announcement: 'Notice posted',
  update_announcement: 'Notice updated',
  end_announcement: 'Notice ended',
  set_report_status: 'Support report updated',
};

function formatDetail(entry: AdminAuditEntry): string {
  const d = entry.detail || {};
  if (entry.action === 'set_verification') {
    const base = `Status: ${d.status || 'updated'}`;
    return d.reason ? `${base} · ${d.reason}` : base;
  }
  if (entry.action === 'suspend_org' && d.reason) {
    return `Reason: ${d.reason}`;
  }
  if (entry.action === 'set_enforcement') {
    return d.enforce_verification ? 'Rule turned ON' : 'Rule turned OFF';
  }
  if (entry.action === 'purge_deleted') {
    return `Purged ${d.purged_count ?? 0} account(s)`;
  }
  if (entry.action === 'create_announcement' || entry.action === 'update_announcement') {
    return d.title ? `"${d.title}" · ${d.audience || 'all'}` : 'Notice saved';
  }
  if (entry.action === 'set_report_status') {
    return `Marked ${d.status || 'updated'}`;
  }
  if (entry.action === 'reset_org_password') {
    return 'Temporary password issued';
  }
  return '';
}

function formatDayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function ActivityLogSubpage({
  isOnline,
  refreshNonce,
  onBack,
}: {
  isOnline: boolean;
  refreshNonce: number;
  onBack: () => void;
}) {
  const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadAudit = useCallback(async () => {
    if (!isOnline) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const data = await adminService.listAudit(60);
      setEntries(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err?.message || 'Could not load activity log.');
    } finally {
      setIsLoading(false);
    }
  }, [isOnline]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit, refreshNonce]);

  const grouped = entries.reduce<Array<{ day: string; items: AdminAuditEntry[] }>>((acc, entry) => {
    const day = formatDayLabel(entry.created_at);
    const existing = acc.find((g) => g.day === day);
    if (existing) {
      existing.items.push(entry);
    } else {
      acc.push({ day, items: [entry] });
    }
    return acc;
  }, []);

  return (
    <div className="min-h-full">
      <ScreenHeader
        compactOnly
        title="Activity log"
        onBack={onBack}
        backLabel="More"
      />
      <div className="p-4 md:px-0 space-y-4">
        {error && (
          <EmptyState
            icon={<AlertTriangle className="w-5 h-5 text-red-500" />}
            message={error}
            actionLabel="Retry"
            onAction={() => void loadAudit()}
            actionDisabled={!isOnline}
          />
        )}

        {isLoading && entries.length === 0 && !error && (
          <GroupedList>
            {Array.from({ length: 4 }).map((_, idx) => (
              <ListRow
                key={idx}
                title={<Skel w="55%" h={15} />}
                subtitle={<Skel w="70%" h={12} />}
                trailing={<Skel w={44} h={12} />}
              />
            ))}
          </GroupedList>
        )}

        {!isLoading && !error && entries.length === 0 && (
          <EmptyState
            icon={<History className="w-5 h-5" />}
            message="No admin actions recorded yet."
          />
        )}

        {grouped.map((group) => (
          <GroupedList key={group.day} title={group.day}>
            {group.items.map((entry, idx) => {
              const label = ACTION_LABELS[entry.action] || entry.action;
              const detailText = formatDetail(entry);
              return (
                <ListRow
                  key={entry.id}
                  animateIndex={idx}
                  title={
                    entry.target_org_id ? `${label} · ${entry.target_org_id}` : label
                  }
                  subtitle={detailText || undefined}
                  trailing={
                    <span className="admin-caption text-zinc-500 dark:text-zinc-400">
                      {formatTime(entry.created_at)}
                    </span>
                  }
                />
              );
            })}
          </GroupedList>
        ))}
      </div>
    </div>
  );
}

export function MoreView({
  section,
  adminEmail,
  lockoutsCount,
  isOnline,
  isRefreshing,
  refreshNonce,
  onNavigateSection,
  onBack,
  onRefresh,
  onDataChanged,
  onBackToApp,
  onLock,
}: MoreViewProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  if (section === 'notices') {
    return (
      <div className="min-h-full">
        <ScreenHeader compactOnly title="Notices" onBack={onBack} backLabel="More" />
        <div className="p-4 md:px-0">
          <NoticesList
            refreshNonce={refreshNonce}
            isOnline={isOnline}
            onDataChanged={onDataChanged}
          />
        </div>
      </div>
    );
  }

  if (section === 'alerts') {
    return (
      <div className="min-h-full">
        <ScreenHeader compactOnly title="Alerts" onBack={onBack} backLabel="More" />
        <div className="p-4 md:px-0">
          <AlertsTab
            refreshNonce={refreshNonce}
            isOnline={isOnline}
            onDataChanged={onDataChanged}
          />
        </div>
      </div>
    );
  }

  if (section === 'activity') {
    return (
      <ActivityLogSubpage
        isOnline={isOnline}
        refreshNonce={refreshNonce}
        onBack={onBack}
      />
    );
  }

  return (
    <div className="min-h-full">
      <ScreenHeader title="More" subtitle={adminEmail} />

      <div className="px-4 md:px-0 pb-6 space-y-6">
        <GroupedList title="Tools">
          <ListRow
            animateIndex={0}
            leading={<Megaphone className="w-5 h-5" />}
            title="Notices"
            subtitle="Broadcast banners and updates"
            chevron
            onClick={() => onNavigateSection('notices')}
          />
          <ListRow
            animateIndex={1}
            leading={<ShieldAlert className="w-5 h-5" />}
            title="Alerts"
            subtitle="Locked accounts and login throttles"
            trailing={
              lockoutsCount > 0 ? (
                <span className="inline-flex items-center justify-center min-w-[24px] h-6 px-2 rounded-full bg-red-500/15 text-red-600 dark:text-red-400 admin-caption font-semibold tabular-nums">
                  {lockoutsCount}
                </span>
              ) : undefined
            }
            chevron
            onClick={() => onNavigateSection('alerts')}
          />
          <ListRow
            animateIndex={2}
            leading={<History className="w-5 h-5" />}
            title="Activity log"
            subtitle="Recent admin actions"
            chevron
            onClick={() => onNavigateSection('activity')}
          />
        </GroupedList>

        <GroupedList title="Console">
          <ListRow
            animateIndex={3}
            leading={<RefreshCw className="w-5 h-5" />}
            title="Refresh now"
            subtitle={isRefreshing ? 'Refreshing data...' : 'Sync latest platform data'}
            disabled={!isOnline || isRefreshing}
            onClick={() => {
              void onRefresh().then(() => {
                showAdminToast('Platform data refreshed.', { tone: 'success' });
              });
            }}
          />
          <ListRow
            animateIndex={4}
            leading={isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            title="Appearance"
            trailing={isDark ? 'Dark' : 'Light'}
            onClick={() => setTheme(isDark ? 'light' : 'dark')}
          />
        </GroupedList>

        <GroupedList title="Session">
          <ListRow
            animateIndex={5}
            leading={<ArrowLeft className="w-5 h-5" />}
            title="Back to app"
            subtitle="Keep admin session active on this device"
            onClick={onBackToApp}
          />
          <ListRow
            animateIndex={6}
            danger
            leading={<Lock className="w-5 h-5" />}
            title="Lock"
            subtitle="Sign out of admin console"
            onClick={onLock}
          />
        </GroupedList>
      </div>
    </div>
  );
}
