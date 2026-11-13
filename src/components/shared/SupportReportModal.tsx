import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  MessageSquare,
  Send,
  X,
} from 'lucide-react';
import { APP_VERSION } from '../../config/version';
import { TELEGRAM_SUPPORT_URL } from '../../config/support';
import { triggerHaptic } from '../../lib/haptics';
import { SelfTestRunResult } from '../../lib/selfTest';
import {
  BugLogBundle,
  buildFullBugLog,
  buildSupportClipboardText,
  submitSupportReport,
  trimBugLogBundle,
} from '../../lib/bugLog';
import { downloadJson } from '../../lib/downloadUtils';
import { getStoredSession } from '../../lib/supabase';
import { showToast } from '../common/ToastProvider';

interface SupportReportModalProps {
  open: boolean;
  role: 'organiser' | 'judge';
  testResult: SelfTestRunResult | null;
  onClose: () => void;
}

type ModalStep = 'compose' | 'sent' | 'telegram';

function buildInitialSummary(testResult: SelfTestRunResult | null): string {
  if (!testResult) return '';
  if (testResult.problemTotal === 0 && testResult.noticeTotal === 0) return '';

  const issues: string[] = [];
  for (const grp of testResult.groups) {
    for (const chk of grp.checks) {
      if (chk.status === 'problem' || chk.status === 'notice') {
        issues.push(`${chk.code || chk.label}: ${chk.plain}`);
      }
      if (issues.length >= 3) break;
    }
    if (issues.length >= 3) break;
  }

  const header = `Diagnostics: ${testResult.verdict} (${testResult.problemTotal} problem, ${testResult.noticeTotal} notice)`;
  return issues.length > 0 ? `${header}\n${issues.join('\n')}` : header;
}

export const SupportReportModal: React.FC<SupportReportModalProps> = ({
  open,
  role,
  testResult,
  onClose,
}) => {
  const [step, setStep] = useState<ModalStep>('compose');
  const [summary, setSummary] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [preparingTelegram, setPreparingTelegram] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [fallbackReason, setFallbackReason] = useState<string | null>(null);
  const [ticketId, setTicketId] = useState<string | null>(null);

  const [bundleData, setBundleData] = useState<{
    bundle: BugLogBundle;
    filename: string;
  } | null>(null);
  const [downloadedFilename, setDownloadedFilename] = useState<string | null>(null);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [showManualCopyBox, setShowManualCopyBox] = useState(false);

  const sessionOrgId = useMemo(() => {
    const id = getStoredSession()?.org?.org_id?.trim();
    return id || null;
  }, [open]);

  // Reset modal state cleanly each time it opens
  useEffect(() => {
    if (!open) return;
    setStep('compose');
    setSummary(buildInitialSummary(testResult));
    setSubmitting(false);
    setPreparingTelegram(false);
    setErrorMsg(null);
    setFallbackReason(null);
    setTicketId(null);
    setBundleData(null);
    setDownloadedFilename(null);
    setCopiedSummary(false);
    setShowManualCopyBox(false);
  }, [open, testResult]);

  // Escape key dismissal
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting && !preparingTelegram) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, submitting, preparingTelegram, onClose]);

  if (!open) return null;

  const trimmedSummary = summary.trim();
  const clipboardText = buildSupportClipboardText({
    role,
    orgCode: bundleData?.bundle.orgCode || sessionOrgId || 'terminal',
    summary: trimmedSummary || 'Diagnostic report attached.',
    verdict: bundleData?.bundle.summary.verdict || testResult?.verdict,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmedSummary) {
      setErrorMsg('Please briefly describe what happened before sending.');
      triggerHaptic('warning');
      return;
    }

    setErrorMsg(null);
    setFallbackReason(null);
    setSubmitting(true);
    triggerHaptic('submit');

    const res = await submitSupportReport({
      role,
      summary: trimmedSummary,
    });

    setSubmitting(false);
    setBundleData({ bundle: res.bundle, filename: res.filename });

    if (res.ok) {
      triggerHaptic('success');
      setTicketId(res.id || null);
      setStep('sent');
      showToast('Report sent to developer', 'success');
      return;
    }

    if (res.reason === 'invalid_summary') {
      triggerHaptic('warning');
      setErrorMsg(res.message || 'Summary must be between 1 and 2000 characters.');
      return;
    }

    triggerHaptic('warning');
    if (res.reason === 'offline') {
      setFallbackReason('You are offline. Save the file below and send it on Telegram once connected.');
    } else if (res.reason === 'rate_limited') {
      setFallbackReason('Hourly report limit reached (max 3 per hour). You can attach your report on Telegram instead.');
    } else if (res.reason === 'not_configured') {
      setFallbackReason('Direct inbox is unavailable in this build. Send via Telegram instead.');
    } else {
      setFallbackReason(
        res.message
          ? `Could not send directly (${res.message}). Use Telegram below instead.`
          : 'Could not reach support inbox right now. Use Telegram below instead.'
      );
    }
    setStep('telegram');
  };

  const handleSwitchToTelegram = async () => {
    triggerHaptic('light');
    setErrorMsg(null);
    setFallbackReason(null);

    if (!bundleData) {
      setPreparingTelegram(true);
      try {
        const built = await buildFullBugLog(role);
        setBundleData({
          bundle: trimBugLogBundle(built.bundle),
          filename: built.filename,
        });
      } catch {
        // Ignore build error and still open instructions
      } finally {
        setPreparingTelegram(false);
      }
    }

    setStep('telegram');
  };

  const handleDownloadBundle = async () => {
    triggerHaptic('tick');
    let target = bundleData;
    if (!target) {
      setPreparingTelegram(true);
      try {
        const built = await buildFullBugLog(role);
        target = {
          bundle: trimBugLogBundle(built.bundle),
          filename: built.filename,
        };
        setBundleData(target);
      } catch {
        showToast('Could not prepare diagnostic bundle', 'error');
        setPreparingTelegram(false);
        return;
      }
      setPreparingTelegram(false);
    }

    const saved = downloadJson(target.filename, target.bundle);
    setDownloadedFilename(saved);
    triggerHaptic('success');
    showToast(`Saved: ${saved}`, 'success');
  };

  const handleCopySummary = async () => {
    triggerHaptic('tick');
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(clipboardText);
        setCopiedSummary(true);
        setShowManualCopyBox(false);
        triggerHaptic('success');
        return;
      }
    } catch {}
    setShowManualCopyBox(true);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="support-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting && !preparingTelegram) {
          onClose();
        }
      }}
    >
      <div className="w-full max-w-md bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto text-zinc-900 dark:text-zinc-100">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stone-200 dark:border-zinc-800">
          <div className="min-w-0">
            <h3
              id="support-modal-title"
              className="text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
            >
              {step === 'sent'
                ? 'Report Delivered'
                : step === 'telegram'
                ? 'Send via Telegram'
                : 'Send to Developer'}
            </h3>
            <p className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 truncate">
              v{APP_VERSION} • {role === 'organiser' ? 'Organiser' : 'Judge'}
              {sessionOrgId ? ` • ${sessionOrgId}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting || preparingTelegram}
            aria-label="Close support dialog"
            className="w-11 h-11 -mr-2 rounded-xl flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-stone-100 dark:hover:bg-zinc-800 cursor-pointer disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4">
          {step === 'compose' && (
            <form onSubmit={handleSubmit} className="space-y-3.5">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label
                    htmlFor="fj-support-summary"
                    className="text-xs font-medium text-zinc-800 dark:text-zinc-200"
                  >
                    What happened?
                  </label>
                  <span className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 tabular-nums">
                    {summary.length}/2000
                  </span>
                </div>
                <textarea
                  id="fj-support-summary"
                  value={summary}
                  onChange={(e) => {
                    setSummary(e.target.value);
                    if (errorMsg) setErrorMsg(null);
                  }}
                  maxLength={2000}
                  rows={4}
                  disabled={submitting || preparingTelegram}
                  placeholder="Briefly describe the issue, screen, or error message..."
                  className="w-full rounded-xl bg-stone-50 dark:bg-black border border-stone-300 dark:border-zinc-700 px-3 py-2.5 text-xs text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 resize-y min-h-[96px]"
                />
              </div>

              <div className="rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 px-3 py-2.5 text-[11px] text-zinc-600 dark:text-zinc-300 leading-relaxed">
                Automatically attaches your latest diagnostic check, sanitized error log, and sync queue state. Passwords and session tokens are never included.
              </div>

              {errorMsg && (
                <div
                  role="alert"
                  className="rounded-xl bg-red-50 dark:bg-red-950/60 border border-red-200 dark:border-red-900 px-3 py-2 text-xs text-red-700 dark:text-red-300 flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <div className="flex flex-col gap-2 pt-1">
                <button
                  type="submit"
                  disabled={submitting || preparingTelegram}
                  className="w-full min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <Send className="w-4 h-4" />
                  <span>{submitting ? 'Running checks & sending…' : 'Send Report'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleSwitchToTelegram}
                  disabled={submitting || preparingTelegram}
                  className="w-full min-h-[44px] rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 font-medium text-xs flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>{preparingTelegram ? 'Preparing bundle…' : 'Send via Telegram instead'}</span>
                </button>
              </div>
            </form>
          )}

          {step === 'sent' && (
            <div className="space-y-4 py-1">
              <div className="flex items-start gap-3 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 p-3.5">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                <div className="space-y-1 min-w-0">
                  <p className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    Your report is in the developer inbox.
                  </p>
                  <p className="text-[11px] text-zinc-600 dark:text-zinc-300">
                    Diagnostics and recent error logs were attached automatically.
                  </p>
                  {ticketId && (
                    <p className="text-[11px] font-mono text-emerald-700 dark:text-emerald-300 pt-0.5">
                      Ref: #{ticketId.slice(0, 8).toUpperCase()}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="w-full min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs cursor-pointer"
                >
                  Done
                </button>
                <button
                  type="button"
                  onClick={() => setStep('telegram')}
                  className="w-full min-h-[44px] rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200 font-medium text-xs flex items-center justify-center gap-2 cursor-pointer"
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>Need urgent help? Open Telegram</span>
                </button>
              </div>
            </div>
          )}

          {step === 'telegram' && (
            <div className="space-y-3.5">
              {fallbackReason && (
                <div
                  role="status"
                  className="rounded-xl bg-amber-50 dark:bg-amber-950/50 border border-amber-200 dark:border-amber-900 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{fallbackReason}</span>
                </div>
              )}

              <div className="space-y-2.5">
                {/* Step 1 */}
                <div className="rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                      1. Save diagnostic file
                    </span>
                    {downloadedFilename && (
                      <span className="text-[10px] font-mono text-emerald-600 dark:text-emerald-400">
                        Saved
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-zinc-600 dark:text-zinc-300">
                    Downloads a sanitized JSON log you can attach in the chat.
                  </p>
                  <button
                    type="button"
                    onClick={handleDownloadBundle}
                    disabled={preparingTelegram}
                    className="w-full min-h-[44px] rounded-xl bg-white dark:bg-zinc-900 border border-stone-300 dark:border-zinc-600 hover:bg-stone-50 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                  >
                    <Download className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                    <span>
                      {preparingTelegram
                        ? 'Preparing file…'
                        : downloadedFilename
                        ? 'Download File Again'
                        : 'Download Diagnostic JSON'}
                    </span>
                  </button>
                  {downloadedFilename && (
                    <p className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400 truncate">
                      {downloadedFilename}
                    </p>
                  )}
                </div>

                {/* Step 2 */}
                <div className="rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 p-3 space-y-2">
                  <span className="block text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    2. Copy short summary
                  </span>
                  <button
                    type="button"
                    onClick={handleCopySummary}
                    className="w-full min-h-[44px] rounded-xl bg-white dark:bg-zinc-900 border border-stone-300 dark:border-zinc-600 hover:bg-stone-50 dark:hover:bg-zinc-700 text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center justify-center gap-2 cursor-pointer"
                  >
                    {copiedSummary ? (
                      <>
                        <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                        <span>Summary Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                        <span>Copy Summary to Clipboard</span>
                      </>
                    )}
                  </button>
                  {showManualCopyBox && (
                    <textarea
                      readOnly
                      rows={3}
                      value={clipboardText}
                      onFocus={(e) => e.target.select()}
                      aria-label="Selectable summary text"
                      className="w-full rounded-lg bg-stone-50 dark:bg-black border border-stone-300 dark:border-zinc-700 p-2 text-[11px] font-mono text-zinc-800 dark:text-zinc-200"
                    />
                  )}
                </div>

                {/* Step 3 */}
                <div className="rounded-xl bg-stone-100 dark:bg-zinc-800 border border-stone-200 dark:border-zinc-700 p-3 space-y-2">
                  <span className="block text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                    3. Open Telegram &amp; attach the file
                  </span>
                  <a
                    href={TELEGRAM_SUPPORT_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => triggerHaptic('light')}
                    className="w-full min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center justify-center gap-2 no-underline"
                  >
                    <span>Open Telegram Support Group</span>
                    <ExternalLink className="w-4 h-4" />
                  </a>
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 pt-1">
                {!ticketId && (
                  <button
                    type="button"
                    onClick={() => setStep('compose')}
                    className="min-h-[44px] px-3 rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-xs font-medium text-zinc-700 dark:text-zinc-200 cursor-pointer"
                  >
                    Back
                  </button>
                )}
                <button
                  type="button"
                  onClick={onClose}
                  className="ml-auto min-h-[44px] px-4 rounded-xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 text-xs font-medium text-zinc-700 dark:text-zinc-200 cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
