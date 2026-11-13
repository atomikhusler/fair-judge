import React, { useEffect, useState } from 'react';
import { Loader2, PowerOff, Send } from 'lucide-react';
import { AdminAnnouncement, adminService } from '../adminService';
import { BottomSheet, Segmented, showAdminToast } from '../ui';
import { triggerHaptic } from '../../lib/haptics';

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
}

export default function NoticeEditor({
  open,
  notice,
  isOnline,
  onClose,
  onSaved,
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

  useEffect(() => {
    if (!open) return;
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
      setSeverity('info');
      setAudience('all');
      setTargetOrgId('');
      setExpiryPreset('none');
      setCustomEndsAt('');
    }
  }, [open, notice]);

  const applyTemplate = (tpl: NoticeTemplate) => {
    triggerHaptic('light');
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
    if (!isOnline || isSaving || isEnding) return;

    const cleanTitle = title.trim();
    const cleanBody = body.trim();
    const cleanOrg = targetOrgId.trim().toUpperCase();

    if (!cleanTitle || !cleanBody) {
      triggerHaptic('warning');
      showAdminToast('Enter both a title and message.', { tone: 'error' });
      return;
    }

    if (audience === 'org' && !cleanOrg) {
      triggerHaptic('warning');
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
      showAdminToast(notice ? 'Notice updated.' : 'Notice published.', { tone: 'success' });
      onClose();
      await onSaved();
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Failed to save notice.', { tone: 'error' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleEndNow = async () => {
    if (!notice || !isOnline || isSaving || isEnding) return;
    setIsEnding(true);
    try {
      const res = await adminService.endAnnouncement(notice.id);
      if (!res?.ok) throw new Error('Could not end notice.');
      triggerHaptic('success');
      showAdminToast('Notice ended.', { tone: 'success' });
      onClose();
      await onSaved();
    } catch (err: any) {
      triggerHaptic('warning');
      showAdminToast(err?.message || 'Failed to end notice.', { tone: 'error' });
    } finally {
      setIsEnding(false);
    }
  };

  const isLiveNotice = Boolean(
    notice && notice.active && (!notice.ends_at || new Date(notice.ends_at).getTime() > Date.now())
  );

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      closeDisabled={isSaving || isEnding}
      maxWidthClass="md:max-w-lg"
      title={notice ? 'Edit notice' : 'New notice'}
      subtitle="Shown as a dismissible banner to selected users"
    >
      <form onSubmit={handleSave} className="space-y-4">
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
                className="admin-press min-h-[44px] px-3 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-[14px] font-medium text-zinc-900 dark:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
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
            rows={3}
            placeholder="Short guidance shown inside the banner..."
            className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-violet-500/60 resize-none"
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
                  className={`admin-press min-h-[44px] px-3 rounded-xl text-[14px] font-semibold border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer ${
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
                  className={`admin-press min-h-[44px] px-3 rounded-xl text-[13px] font-semibold border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer ${
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

        <div className="flex flex-col gap-2 pt-2">
          <button
            type="submit"
            disabled={isSaving || isEnding || !isOnline}
            className="admin-press w-full min-h-[44px] px-4 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white text-[15px] font-semibold inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            <span>{notice ? 'Save notice' : 'Publish notice'}</span>
          </button>

          {isLiveNotice && (
            <button
              type="button"
              disabled={isSaving || isEnding || !isOnline}
              onClick={() => void handleEndNow()}
              className="admin-press w-full min-h-[44px] px-4 rounded-xl bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 text-red-600 dark:text-red-400 text-[15px] font-semibold inline-flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 cursor-pointer"
            >
              {isEnding ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <PowerOff className="w-4 h-4" />
              )}
              <span>End now</span>
            </button>
          )}
        </div>
      </form>
    </BottomSheet>
  );
}
