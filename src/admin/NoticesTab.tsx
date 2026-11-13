import React, { useState, useEffect, useCallback } from 'react';
import {
  Megaphone,
  AlertTriangle,
  Info,
  CheckCircle2,
  Pencil,
  PowerOff,
  Loader2,
  Send,
  X,
} from 'lucide-react';
import { adminService, AdminAnnouncement } from './adminService';
import { Skel } from '../components/common/Skeletons';
import { showToast } from '../components/common/ToastProvider';
import { triggerHaptic } from '../lib/haptics';

interface NoticesTabProps {
  refreshNonce: number;
  onDataChanged: () => Promise<void>;
}

type Severity = AdminAnnouncement['severity'];
type Audience = AdminAnnouncement['audience'];
type ExpiryPreset = 'none' | '2h' | '24h' | '7d' | 'custom';

interface NoticeTemplate {
  label: string;
  title: string;
  body: string;
  severity: Severity;
  audience: Audience;
}

const NOTICE_TEMPLATES: NoticeTemplate[] = [
  {
    label: 'Maintenance',
    title: 'Scheduled Cloud Maintenance',
    body: 'Offline scoring stays active. Cloud sync may pause briefly during maintenance.',
    severity: 'warning',
    audience: 'all',
  },
  {
    label: 'App Update',
    title: 'New Fair Judge Update Available',
    body: 'Reload the app between rounds to get the latest stability and scoring improvements.',
    severity: 'info',
    audience: 'all',
  },
  {
    label: 'Urgent Alert',
    title: 'Action Required Before Live Round',
    body: 'Please ensure all judge devices are online and synced before closing the event.',
    severity: 'urgent',
    audience: 'organisers',
  },
];

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

function toLocalDateTimeInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isNoticeCurrentlyLive(item: AdminAnnouncement): boolean {
  if (!item.active) return false;
  if (!item.ends_at) return true;
  return new Date(item.ends_at).getTime() > Date.now();
}

export function NoticesTab({ refreshNonce, onDataChanged }: NoticesTabProps) {
  const [notices, setNotices] = useState<AdminAnnouncement[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Composer state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<Severity>('info');
  const [audience, setAudience] = useState<Audience>('all');
  const [targetOrgId, setTargetOrgId] = useState('');
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>('none');
  const [customEndsAt, setCustomEndsAt] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Two-tap confirmation for End Now
  const [confirmEndId, setConfirmEndId] = useState<string | null>(null);
  const [endingId, setEndingId] = useState<string | null>(null);

  const loadNotices = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const list = await adminService.listAnnouncements();
      setNotices(Array.isArray(list) ? list : []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load announcements.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNotices();
  }, [loadNotices, refreshNonce]);

  const resetComposer = () => {
    setEditingId(null);
    setTitle('');
    setBody('');
    setSeverity('info');
    setAudience('all');
    setTargetOrgId('');
    setExpiryPreset('none');
    setCustomEndsAt('');
  };

  const applyTemplate = (tpl: NoticeTemplate) => {
    triggerHaptic('tick');
    setTitle(tpl.title);
    setBody(tpl.body);
    setSeverity(tpl.severity);
    setAudience(tpl.audience);
    if (tpl.audience !== 'org') setTargetOrgId('');
  };

  const startEditing = (item: AdminAnnouncement) => {
    triggerHaptic('tick');
    setEditingId(item.id);
    setTitle(item.title);
    setBody(item.body);
    setSeverity(item.severity);
    setAudience(item.audience);
    setTargetOrgId(item.target_org_id || '');
    if (item.ends_at) {
      setExpiryPreset('custom');
      setCustomEndsAt(toLocalDateTimeInput(item.ends_at));
    } else {
      setExpiryPreset('none');
      setCustomEndsAt('');
    }
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const resolveEndsAtIso = (): string | null => {
    if (expiryPreset === 'none') return null;
    if (expiryPreset === '2h') return new Date(Date.now() + 2 * 3600 * 1000).toISOString();
    if (expiryPreset === '24h') return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    if (expiryPreset === '7d') return new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    if (expiryPreset === 'custom' && customEndsAt) {
      const parsed = new Date(customEndsAt);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return null;
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    const cleanOrg = targetOrgId.trim().toUpperCase();

    if (!cleanTitle || !cleanBody) {
      triggerHaptic('warning');
      showToast('Enter both a title and message.', 'warning');
      return;
    }

    if (audience === 'org' && !cleanOrg) {
      triggerHaptic('warning');
      showToast('Enter a target Org ID for single-org announcements.', 'warning');
      return;
    }

    setIsSaving(true);
    triggerHaptic('submit');
    try {
      const res = await adminService.saveAnnouncement({
        id: editingId,
        title: cleanTitle,
        body: cleanBody,
        severity,
        audience,
        targetOrgId: audience === 'org' ? cleanOrg : null,
        endsAt: resolveEndsAtIso(),
      });
      if (!res?.ok) {
        throw new Error(res?.error || 'Could not save announcement.');
      }
      triggerHaptic('success');
      showToast(editingId ? 'Announcement updated.' : 'Announcement published.', 'success');
      resetComposer();
      await Promise.all([loadNotices(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Failed to publish announcement.', 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEndNotice = async (id: string) => {
    if (confirmEndId !== id) {
      triggerHaptic('tick');
      setConfirmEndId(id);
      return;
    }

    setEndingId(id);
    setConfirmEndId(null);
    try {
      const res = await adminService.endAnnouncement(id);
      if (!res?.ok) {
        throw new Error('Could not end announcement.');
      }
      triggerHaptic('success');
      showToast('Announcement ended.', 'success');
      if (editingId === id) resetComposer();
      await Promise.all([loadNotices(), onDataChanged()]);
    } catch (err: any) {
      triggerHaptic('warning');
      showToast(err?.message || 'Failed to end announcement.', 'error');
    } finally {
      setEndingId(null);
    }
  };

  const activeNotices = notices.filter(isNoticeCurrentlyLive);
  const endedNotices = notices.filter((n) => !isNoticeCurrentlyLive(n));

  return (
    <div className="space-y-4">
      {/* Composer */}
      <section className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-violet-500/15 text-violet-600 dark:text-violet-400 flex items-center justify-center shrink-0">
              <Megaphone className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-zinc-900 dark:text-white truncate">
                {editingId ? 'Edit Announcement' : 'Broadcast Notice'}
              </h2>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                Shown as a dismissible banner to active users.
              </p>
            </div>
          </div>

          {editingId && (
            <button
              type="button"
              onClick={() => {
                triggerHaptic('tick');
                resetComposer();
              }}
              className="min-h-[44px] px-3 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-xs font-medium text-zinc-700 dark:text-zinc-200 inline-flex items-center gap-1 cursor-pointer shrink-0"
            >
              <X className="w-3.5 h-3.5" />
              <span>Cancel Edit</span>
            </button>
          )}
        </div>

        {/* Quick Templates */}
        <div className="space-y-1.5">
          <span className="block text-[11px] font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Quick Templates
          </span>
          <div className="flex flex-wrap gap-2">
            {NOTICE_TEMPLATES.map((tpl) => (
              <button
                key={tpl.label}
                type="button"
                onClick={() => applyTemplate(tpl)}
                className="min-h-[44px] px-3 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-xs font-medium text-zinc-800 dark:text-zinc-200 cursor-pointer"
              >
                {tpl.label}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSave} className="space-y-3.5">
          <div>
            <label
              htmlFor="admin-notice-title"
              className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1"
            >
              Title
            </label>
            <input
              id="admin-notice-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={120}
              placeholder="e.g., Scheduled Maintenance"
              className="w-full min-h-[44px] px-3 rounded-xl bg-stone-50 dark:bg-black border border-stone-200 dark:border-zinc-700 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
            />
          </div>

          <div>
            <label
              htmlFor="admin-notice-body"
              className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1"
            >
              Message
            </label>
            <textarea
              id="admin-notice-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={500}
              rows={3}
              placeholder="Short, plain guidance visible in one banner line..."
              className="w-full px-3 py-2.5 rounded-xl bg-stone-50 dark:bg-black border border-stone-200 dark:border-zinc-700 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/50 resize-y"
            />
          </div>

          {/* Severity & Audience */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <span className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                Severity
              </span>
              <div className="grid grid-cols-3 gap-1.5">
                {(['info', 'warning', 'urgent'] as const).map((sev) => {
                  const active = severity === sev;
                  return (
                    <button
                      key={sev}
                      type="button"
                      onClick={() => {
                        triggerHaptic('tick');
                        setSeverity(sev);
                      }}
                      className={`min-h-[44px] rounded-xl text-xs font-semibold capitalize border cursor-pointer ${
                        active
                          ? sev === 'urgent'
                            ? 'bg-red-600 text-white border-red-600'
                            : sev === 'warning'
                            ? 'bg-amber-500 text-black border-amber-500'
                            : 'bg-violet-600 text-white border-violet-600'
                          : 'bg-stone-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-stone-200 dark:border-zinc-700 hover:bg-stone-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {sev}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <span className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                Audience
              </span>
              <div className="grid grid-cols-2 gap-1.5">
                {(
                  [
                    { key: 'all', label: 'Everyone' },
                    { key: 'organisers', label: 'Organisers' },
                    { key: 'judges', label: 'Judges' },
                    { key: 'org', label: 'Single Org' },
                  ] as const
                ).map((aud) => {
                  const active = audience === aud.key;
                  return (
                    <button
                      key={aud.key}
                      type="button"
                      onClick={() => {
                        triggerHaptic('tick');
                        setAudience(aud.key);
                      }}
                      className={`min-h-[44px] rounded-xl text-xs font-semibold border cursor-pointer ${
                        active
                          ? 'bg-violet-600 text-white border-violet-600'
                          : 'bg-stone-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-stone-200 dark:border-zinc-700 hover:bg-stone-200 dark:hover:bg-zinc-700'
                      }`}
                    >
                      {aud.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {audience === 'org' && (
            <div>
              <label
                htmlFor="admin-notice-org"
                className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1"
              >
                Target Org ID
              </label>
              <input
                id="admin-notice-org"
                type="text"
                value={targetOrgId}
                onChange={(e) => setTargetOrgId(e.target.value.toUpperCase())}
                placeholder="FJ-XXXX"
                className="w-full min-h-[44px] px-3 rounded-xl bg-stone-50 dark:bg-black border border-stone-200 dark:border-zinc-700 text-sm font-mono uppercase text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              />
            </div>
          )}

          {/* Expiry */}
          <div className="space-y-2">
            <span className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300">
              Auto-Expire
            </span>
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { key: 'none', label: 'No expiry' },
                  { key: '2h', label: '2 hours' },
                  { key: '24h', label: '24 hours' },
                  { key: '7d', label: '7 days' },
                  { key: 'custom', label: 'Custom' },
                ] as const
              ).map((preset) => {
                const active = expiryPreset === preset.key;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    onClick={() => {
                      triggerHaptic('tick');
                      setExpiryPreset(preset.key);
                    }}
                    className={`min-h-[44px] px-3 rounded-xl text-xs font-semibold border cursor-pointer ${
                      active
                        ? 'bg-violet-600 text-white border-violet-600'
                        : 'bg-stone-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-stone-200 dark:border-zinc-700 hover:bg-stone-200 dark:hover:bg-zinc-700'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>

            {expiryPreset === 'custom' && (
              <input
                type="datetime-local"
                value={customEndsAt}
                onChange={(e) => setCustomEndsAt(e.target.value)}
                aria-label="Custom expiry date and time"
                className="w-full min-h-[44px] px-3 rounded-xl bg-stone-50 dark:bg-black border border-stone-200 dark:border-zinc-700 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500/50"
              />
            )}
          </div>

          <button
            type="submit"
            disabled={isSaving}
            className="w-full min-h-[44px] rounded-xl bg-violet-600 hover:bg-violet-500 text-white font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span>
              {isSaving
                ? 'Saving…'
                : editingId
                ? 'Update Announcement'
                : 'Publish Announcement'}
            </span>
          </button>
        </form>
      </section>

      {/* Active & Ended Lists */}
      {isLoading ? (
        <div className="space-y-3">
          <Skel className="h-24 w-full rounded-2xl" />
          <Skel className="h-24 w-full rounded-2xl" />
        </div>
      ) : error ? (
        <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-5 text-center space-y-2">
          <AlertTriangle className="w-5 h-5 text-red-500 mx-auto" />
          <p className="text-sm font-semibold">{error}</p>
          <button
            type="button"
            onClick={() => void loadNotices()}
            className="min-h-[44px] px-4 rounded-xl bg-violet-600 text-white text-xs font-semibold cursor-pointer"
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          <section className="space-y-2.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 px-1">
              Active Notices ({activeNotices.length})
            </h3>

            {activeNotices.length === 0 ? (
              <div className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-5 text-center text-xs text-zinc-500 dark:text-zinc-400">
                No active announcements right now.
              </div>
            ) : (
              <div className="space-y-2.5">
                {activeNotices.map((item) => {
                  const sevColor =
                    item.severity === 'urgent'
                      ? 'text-red-600 dark:text-red-400'
                      : item.severity === 'warning'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-violet-600 dark:text-violet-400';

                  return (
                    <article
                      key={item.id}
                      className="bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-2xl p-4 space-y-2.5"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold">
                            <span className={`inline-flex items-center gap-1 uppercase ${sevColor}`}>
                              {item.severity === 'info' ? (
                                <Info className="w-3.5 h-3.5" />
                              ) : (
                                <AlertTriangle className="w-3.5 h-3.5" />
                              )}
                              <span>{item.severity}</span>
                            </span>
                            <span className="text-zinc-400">•</span>
                            <span className="text-zinc-600 dark:text-zinc-300 capitalize">
                              {item.audience === 'org'
                                ? `Org: ${item.target_org_id || '—'}`
                                : item.audience}
                            </span>
                            {item.ends_at && (
                              <>
                                <span className="text-zinc-400">•</span>
                                <span className="text-zinc-500 dark:text-zinc-400">
                                  Ends {formatDateTime(item.ends_at)}
                                </span>
                              </>
                            )}
                          </div>
                          <h4 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                            {item.title}
                          </h4>
                          <p className="text-xs text-zinc-600 dark:text-zinc-300 leading-relaxed">
                            {item.body}
                          </p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-stone-100 dark:border-zinc-800">
                        <button
                          type="button"
                          onClick={() => startEditing(item)}
                          className="min-h-[44px] px-3 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-800 dark:text-zinc-200 inline-flex items-center gap-1.5 cursor-pointer"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          <span>Edit</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => void handleEndNotice(item.id)}
                          disabled={endingId === item.id}
                          className={`min-h-[44px] px-3 rounded-xl text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                            confirmEndId === item.id
                              ? 'bg-red-600 text-white hover:bg-red-500'
                              : 'bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-red-600 dark:text-red-400'
                          }`}
                        >
                          <PowerOff className="w-3.5 h-3.5" />
                          <span>
                            {endingId === item.id
                              ? 'Ending…'
                              : confirmEndId === item.id
                              ? 'Tap again to End Now'
                              : 'End Now'}
                          </span>
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {endedNotices.length > 0 && (
            <section className="space-y-2.5 pt-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 px-1">
                Ended / Expired ({endedNotices.length})
              </h3>
              <div className="space-y-2">
                {endedNotices.map((item) => (
                  <article
                    key={item.id}
                    className="bg-stone-100 dark:bg-zinc-900/60 border border-stone-200 dark:border-zinc-800 rounded-2xl p-3.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span className="truncate">
                          Ended {formatDateTime(item.ends_at || item.starts_at)} •{' '}
                          {item.audience === 'org' ? item.target_org_id : item.audience}
                        </span>
                      </div>
                      <p className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 truncate mt-0.5">
                        {item.title}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => startEditing(item)}
                      className="min-h-[44px] px-3 rounded-xl bg-white dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 text-xs font-semibold text-zinc-700 dark:text-zinc-200 shrink-0 cursor-pointer"
                    >
                      Republish
                    </button>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
