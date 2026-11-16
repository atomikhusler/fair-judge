import React, { useEffect, useState } from 'react';
import { Loader2, PowerOff, Send, Trash2 } from 'lucide-react';
import { AdminAnnouncement, adminService } from '../adminService';
import { BottomSheet, Segmented, showAdminToast } from '../ui';
import { triggerHaptic } from '../../lib/haptics';
import { playSound } from '../../lib/sound';

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

const TEMPLATES: NoticeTemplate[] = [
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
];

function toLocalDateTimeInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface NoticeEditorProps {
  open: boolean;
  notice: AdminAnnouncement | null; // null = creating new
  isOnline: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
  defaultSeverity?: Severity;
  defaultAudience?: Audience;
  defaultTargetOrgId?: string;
}

export default function NoticeEditor({
  open,
  notice,
  isOnline,
  onClose,
  onSaved,
  defaultSeverity = 'info',
  defaultAudience = 'all',
  defaultTargetOrgId = '',
}: NoticeEditorProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<Severity>('info');
  const [audience, setAudience] = useState<Audience>('all');
  const [targetOrgId, setTargetOrgId] = useState('');
  const [expiryPreset, setExpiryPreset] = useState<ExpiryPreset>('none');
  const [customEndsAt, setCustomEndsAt] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    if (notice) {
      setTitle(notice.title);
      setBody(notice.body);
      setSeverity(notice.severity);
      setAudience(notice.audience);
      setTargetOrgId(notice.target_org_id || '');
      if (notice.ends_at) {
        setExpiryPreset('custom');
        setCustomEndsAt(toLocalDateTimeInput(notice.ends_at));
      } else {
        setExpiryPreset('none');
        setCustomEndsAt('');
      }
    } else {
      setTitle('');
      setBody('');
      setSeverity(defaultSeverity);
      setAudience(defaultAudience);
      setTargetOrgId(defaultTargetOrgId.toUpperCase());
      setExpiryPreset('none');
      setCustomEndsAt('');
    }
  }, [open, notice, defaultSeverity, defaultAudience, defaultTargetOrgId]);

  const applyTemplate = (tpl: NoticeTemplate) => {
    triggerHaptic('light');
    playSound('tap');
    setTitle(tpl.title);
    setBody(tpl.body);
    setSeverity(tpl.severity);
    setAudience(tpl.audience);
    setTargetOrgId('');
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
    if (!isOnline || isSaving || isEnding || isDeleting) return;

    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    const cleanOrg = targetOrgId.trim().toUpperCase();

    if (!cleanTitle || !cleanBody) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast('Enter both a title and message.', { tone: 'error' });
      return;
    }

    if (audience === 'org' && !cleanOrg) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast('Enter an organiser ID.', { tone: 'error' });
      return;
    }

    setIsSaving(true);
    try {
      const res = await adminService.saveAnnouncement({
        id: notice?.id ?? null,
        title: cleanTitle,
        body: cleanBody,
        severity,
        audience,
        targetOrgId: audience === 'org' ? cleanOrg : null,
        endsAt: resolveEndsAtIso(),
      });
      if (!res?.ok) throw new Error(res?.error || 'Could not save notice.');
      triggerHaptic('success');
      playSound('success');
      showAdminToast(notice ? 'Notice updated.' : 'Notice published.', { tone: 'success' });
      onClose();
      await onSaved();
    } catch (err: any) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast(err?.message || 'Failed to save notice.', { tone: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleEndNow = async () => {
    if (!notice || !isOnline || isSaving || isEnding || isDeleting) return;
    setIsEnding(true);
    try {
      const res = await adminService.endAnnouncement(notice.id);
      if (!res?.ok) throw new Error('Could not revoke notice.');
      triggerHaptic('success');
      playSound('success');
      showAdminToast('Notice revoked.', { tone: 'success' });
      onClose();
      await onSaved();
    } catch (err: any) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast(err?.message || 'Failed to revoke notice.', { tone: 'error' });
    } finally {
      setIsEnding(false);
    }
  };

  const handleDelete = async () => {
    if (!notice || !isOnline || isSaving || isEnding || isDeleting) return;
    setIsDeleting(true);
    try {
      const res = await adminService.deleteAnnouncement(notice.id);
      if (!res?.ok) throw new Error('Could not delete notice.');
      triggerHaptic('success');
      playSound('success');
      showAdminToast('Notice deleted permanently.', { tone: 'success' });
      onClose();
      await onSaved();
    } catch (err: any) {
      triggerHaptic('warning');
      playSound('warning');
      showAdminToast(err?.message || 'Failed to delete notice.', { tone: 'error' });
    } finally {
      setIsDeleting(false);
    }
  };

  const isLiveNotice = Boolean(
    notice && notice.active && (!notice.ends_at || new Date(notice.ends_at).getTime() > Date.now())
  );
  const isBusy = isSaving || isEnding || isDeleting;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      closeDisabled={isBusy}
      maxWidthClass="md:max-w-lg"
      title={notice ? 'Edit notice' : 'New notice'}
      subtitle="Shown as a dismissible banner to selected users"
    >
      <form onSubmit={handleSave} className="space-y-3.5">
        {/* 2 quick templates */}
        <div className="space-y-1.5">
          <span className="block admin-caption font-semibold text-zinc-500 dark:text-zinc-400">
            Templates
          </span>
          <div className="grid grid-cols-2 gap-2">
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.label}
                type="button"
                onClick={() => applyTemplate(tpl)}
                className="admin-press min-h-[40px] px-3 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-[13px] font-medium text-zinc-900 dark:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
              >
                {tpl.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label
            htmlFor="admin-notice-title"
            className="block admin-caption font-semibold text-zinc-500 dark:text-zinc-400 mb-1"
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
            className="w-full min-h-[44px] px-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/60"
          />
        </div>

        <div>
          <label
            htmlFor="admin-notice-message"
            className="block admin-caption font-semibold text-zinc-500 dark:text-zinc-400 mb-1"
          >
            Message
          </label>
          <textarea
            id="admin-notice-message"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={500}
            rows={2}
            placeholder="Short guidance shown inside the banner..."
            className="w-full px-3.5 py-2 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/60 resize-none"
          />
        </div>

        {/* Type */}
        <div className="space-y-1.5">
          <span className="block admin-caption font-semibold text-zinc-500 dark:text-zinc-400">
            Type
          </span>
          <Segmented
            options={[
              { value: 'info', label: 'Info' },
              { value: 'warning', label: 'Warning' },
              { value: 'urgent', label: 'Urgent' },
            ]}
            value={severity}
            onChange={(val) => setSeverity(val)}
            ariaLabel="Notice type"
          />
        </div>

        {/* Audience */}
        <div className="space-y-1.5">
          <span className="block admin-caption font-semibold text-zinc-500 dark:text-zinc-400">
            Audience
          </span>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { value: 'all', label: 'Everyone' },
                { value: 'organisers', label: 'Organisers' },
                { value: 'judges', label: 'Judges' },
                { value: 'org', label: 'One organiser' },
              ] as const
            ).map((aud) => {
              const active = audience === aud.value;
              return (
                <button
                  key={aud.value}
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    setAudience(aud.value);
                  }}
                  className={`admin-press min-h-[42px] px-3 rounded-xl text-[14px] font-semibold border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer ${
                    active
                      ? 'bg-violet-600 text-white border-violet-600'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700'
                  }`}
                >
                  {aud.label}
                </button>
              );
            })}
          </div>
        </div>

        {audience === 'org' && (
          <div>
            <label
              htmlFor="admin-notice-org-id"
              className="block admin-caption font-semibold text-zinc-500 dark:text-zinc-400 mb-1"
            >
              Organiser ID
            </label>
            <input
              id="admin-notice-org-id"
              type="text"
              value={targetOrgId}
              onChange={(e) => setTargetOrgId(e.target.value.toUpperCase())}
              placeholder="FJ-XXXX"
              className="w-full min-h-[44px] px-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 font-mono uppercase text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/60"
            />
          </div>
        )}

        {/* End time */}
        <div className="space-y-1.5">
          <span className="block admin-caption font-semibold text-zinc-500 dark:text-zinc-400">
            End time (optional)
          </span>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                { value: 'none', label: 'No end' },
                { value: '2h', label: '2h' },
                { value: '24h', label: '24h' },
                { value: '7d', label: '7d' },
                { value: 'custom', label: 'Custom' },
              ] as const
            ).map((preset) => {
              const active = expiryPreset === preset.value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => {
                    triggerHaptic('light');
                    setExpiryPreset(preset.value);
                  }}
                  className={`admin-press min-h-[40px] px-3 rounded-xl text-[13px] font-semibold border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer ${
                    active
                      ? 'bg-violet-600 text-white border-violet-600'
                      : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700'
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
              aria-label="Custom end date and time"
              className="w-full min-h-[44px] px-3.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[15px] text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500/60"
            />
          )}
        </div>

        {/* Sticky action dock so Save / Publish always stays visible */}
        <div className="sticky bottom-0 -mx-4 -mb-4 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-4 bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 flex flex-col gap-2 z-10">
          <button
            type="submit"
            disabled={isBusy || !isOnline}
            className="admin-press w-full min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-[15px] font-semibold inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span>{notice ? 'Save notice' : 'Publish notice'}</span>
          </button>

          {notice && !confirmDelete && (
            <div className={`grid gap-2 ${isLiveNotice ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {isLiveNotice && (
                <button
                  type="button"
                  disabled={isBusy || !isOnline}
                  onClick={() => {
                    playSound('tap');
                    void handleEndNow();
                  }}
                  className="admin-press w-full min-h-[42px] px-3 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 text-amber-700 dark:text-amber-400 text-[14px] font-semibold inline-flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
                >
                  {isEnding ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <PowerOff className="w-4 h-4" />
                  )}
                  <span>Revoke / End</span>
                </button>
              )}

              <button
                type="button"
                disabled={isBusy || !isOnline}
                onClick={() => {
                  triggerHaptic('light');
                  playSound('tap');
                  setConfirmDelete(true);
                }}
                className="admin-press w-full min-h-[42px] px-3 rounded-xl bg-red-600/10 hover:bg-red-600/20 border border-red-500/25 disabled:opacity-50 text-red-700 dark:text-red-400 text-[14px] font-semibold inline-flex items-center justify-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/60 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                <span>Delete</span>
              </button>
            </div>
          )}

          {notice && confirmDelete && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 space-y-2.5">
              <p className="admin-caption font-semibold text-red-700 dark:text-red-300">
                Permanently delete this notice from history and client inboxes?
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setConfirmDelete(false)}
                  className="admin-press min-h-[40px] rounded-xl bg-zinc-200/80 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 text-[13px] font-semibold cursor-pointer disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isBusy || !isOnline}
                  onClick={() => void handleDelete()}
                  className="admin-press min-h-[40px] rounded-xl bg-red-600 hover:bg-red-500 text-white text-[13px] font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {isDeleting ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  <span>{isDeleting ? 'Deleting...' : 'Confirm delete'}</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </form>
    </BottomSheet>
  );
}
