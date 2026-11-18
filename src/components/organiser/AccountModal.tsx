import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  User,
  Copy,
  Check,
  Trash2,
  RotateCcw,
  CheckCircle2,
  Lock,
  Eye,
  EyeOff,
  LogOut,
  AlertTriangle,
  Pencil,
  Clock,
  XCircle,
  Send,
  Mail,
  MessageCircle,
  Coffee,
  ExternalLink,
  Download,
  Upload,
  ChevronDown,
  ShieldAlert,
  Undo2,
  KeyRound,
  RefreshCw,
  MonitorSmartphone,
} from 'lucide-react';
import { Organization } from '../../lib/supabaseTypes';
import { dbService, getStoredSession, setStoredSession } from '../../lib/supabase';
import { authService, ActiveOrgSession } from '../../lib/authService';
import { formatSessionTimestamp } from '../../lib/deviceIdentity';
import { eventBus } from '../../lib/eventBus';
import { DB_TABLES } from '../../lib/dbTables';
import { useToast } from '../common/ToastProvider';
import { SidePanel } from '../common/SidePanel';
import { BackupSheet } from './backup/BackupSheet';
import { RestoreSheet } from './backup/RestoreSheet';
import { triggerHaptic } from '../../lib/haptics';
import { BrandBadge } from '../shared/BrandBadge';
import { syncNow } from '../../lib/syncEngine';
import {
  collectOrganizationData,
  createBackupFromPayload,
  hasSafetySnapshot,
  restoreSafetySnapshot,
  saveEncryptedSafetySnapshot,
} from '../../lib/backup';

interface AccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  organization: Organization;
  onUpdateOrganization: (updated: Organization) => void;
  onLogout: () => void;
  mustChangePassword?: boolean;
  onPasswordChanged?: () => void;
}

export function AccountModal({
  isOpen,
  onClose,
  organization,
  onUpdateOrganization,
  onLogout,
  mustChangePassword = false,
  onPasswordChanged,
}: AccountModalProps) {
  const [copiedOrgId, setCopiedOrgId] = useState(false);
  const { showToast } = useToast();

  // Organization Name Inline Edit State
  const [isEditingName, setIsEditingName] = useState(false);
  const [editName, setEditName] = useState(organization.name);
  const [isSavingName, setIsSavingName] = useState(false);

  // Organization Email Inline Edit State
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [editEmail, setEditEmail] = useState(organization.email || '');
  const [isSavingEmail, setIsSavingEmail] = useState(false);

  // Master Password Update State
  const [isUpdatingPassword, setIsUpdatingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  // Double-Confirmation Sign Out Modal State (C2)
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  // Active Sessions State (Epic 16.5.0 — loaded only when AccountModal opens)
  const [activeSessions, setActiveSessions] = useState<ActiveOrgSession[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [confirmTerminateTarget, setConfirmTerminateTarget] = useState<
    { mode: 'one'; session: ActiveOrgSession } | { mode: 'others'; count: number } | null
  >(null);
  const [isTerminatingSession, setIsTerminatingSession] = useState(false);

  // Danger Zone Shutter & Confirmation States (C8 + Stage 2 Master Reset)
  const [isDangerShutterOpen, setIsDangerShutterOpen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetInput, setResetInput] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [downloadBackupFirst, setDownloadBackupFirst] = useState(true);
  const [resetError, setResetError] = useState('');
  const [resetCountsPreview, setResetCountsPreview] = useState({
    events: 0,
    lockedEvents: 0,
    judges: 0,
    participants: 0,
    scores: 0,
  });
  const [resetWipedSummary, setResetWipedSummary] = useState<{
    events: number;
    locked_events: number;
    judges: number;
    participants: number;
    scores: number;
  } | null>(null);
  const [resetSuccess, setResetSuccess] = useState(false);
  const [canUndoSnapshot, setCanUndoSnapshot] = useState(false);
  const [showUndoResetPrompt, setShowUndoResetPrompt] = useState(false);
  const [undoResetPassword, setUndoResetPassword] = useState('');
  const [undoResetError, setUndoResetError] = useState('');
  const [isUndoingReset, setIsUndoingReset] = useState(false);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [isProcessingDanger, setIsProcessingDanger] = useState(false);

  // Backup & Restore Sheet State
  const [showBackupSheet, setShowBackupSheet] = useState(false);
  const [showRestoreSheet, setShowRestoreSheet] = useState(false);

  const verificationStatus = organization.verification_status || 'pending';

  // Keep internal edit form synchronized with organization prop
  useEffect(() => {
    setEditName(organization.name);
    setEditEmail(organization.email || '');
  }, [organization]);

  // Expand password reset automatically when temporary password is active
  useEffect(() => {
    if (isOpen && mustChangePassword) {
      setIsUpdatingPassword(true);
    }
  }, [isOpen, mustChangePassword]);

  const loadActiveSessions = useCallback(async () => {
    setIsLoadingSessions(true);
    setSessionsError(null);
    try {
      const res = await authService.listOrgSessions();
      if (!res.ok) {
        setSessionsError(res.error || 'Could not load active sessions.');
        return;
      }
      setActiveSessions(res.sessions);
    } catch (err: any) {
      setSessionsError(err?.message || 'Could not load active sessions.');
    } finally {
      setIsLoadingSessions(false);
    }
  }, []);

  // Check encrypted safety snapshot & fetch active sessions whenever modal opens; clear transient secrets on close
  useEffect(() => {
    if (isOpen) {
      hasSafetySnapshot(organization.org_id)
        .then(setCanUndoSnapshot)
        .catch(() => setCanUndoSnapshot(false));
      void loadActiveSessions();
    } else {
      setIsDangerShutterOpen(false);
      setShowLogoutConfirm(false);
      setConfirmTerminateTarget(null);
      setIsTerminatingSession(false);
      setSessionsError(null);
      setShowResetConfirm(false);
      setResetSuccess(false);
      setShowDeleteConfirm(false);
      setResetInput('');
      setResetPassword('');
      setShowResetPassword(false);
      setResetError('');
      setResetWipedSummary(null);
      setDownloadBackupFirst(true);
      setShowUndoResetPrompt(false);
      setUndoResetPassword('');
      setUndoResetError('');
      setDeleteInput('');
      setIsEditingName(false);
      setIsEditingEmail(false);
    }
  }, [isOpen, organization.org_id, loadActiveSessions]);

  const handleCloseModal = useCallback(() => {
    setIsDangerShutterOpen(false);
    setShowLogoutConfirm(false);
    setConfirmTerminateTarget(null);
    setShowResetConfirm(false);
    setResetSuccess(false);
    setResetPassword('');
    setResetError('');
    setShowUndoResetPrompt(false);
    setUndoResetPassword('');
    setUndoResetError('');
    setShowDeleteConfirm(false);
    onClose();
  }, [onClose]);

  // Delegate Escape key priority for nested confirmation dialogs while SidePanel manages close/focus/scroll-lock
  const handleEscapeBeforeClose = useCallback(() => {
    if (showDeleteConfirm) {
      setShowDeleteConfirm(false);
      setDeleteInput('');
      return true;
    }
    if (showUndoResetPrompt) {
      setShowUndoResetPrompt(false);
      setUndoResetPassword('');
      setUndoResetError('');
      return true;
    }
    if (showResetConfirm) {
      setShowResetConfirm(false);
      setResetSuccess(false);
      setResetInput('');
      setResetPassword('');
      setResetError('');
      return true;
    }
    if (showLogoutConfirm) {
      setShowLogoutConfirm(false);
      return true;
    }
    if (confirmTerminateTarget && !isTerminatingSession) {
      setConfirmTerminateTarget(null);
      return true;
    }
    return false;
  }, [
    showDeleteConfirm,
    showUndoResetPrompt,
    showResetConfirm,
    showLogoutConfirm,
    confirmTerminateTarget,
    isTerminatingSession,
  ]);

  const handleCopyOrgId = async () => {
    triggerHaptic('tick');
    try {
      await navigator.clipboard.writeText(organization.org_id);
    } catch {
      try {
        const el = document.createElement('textarea');
        el.value = organization.org_id;
        el.style.position = 'fixed';
        el.style.opacity = '0';
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      } catch {
        showToast('Could not copy Org ID.');
        return;
      }
    }
    setCopiedOrgId(true);
    showToast('Org ID copied.');
    setTimeout(() => setCopiedOrgId(false), 1500);
  };

  // 1. Save Organization Name
  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = editName.trim();
    if (!trimmed) {
      showToast('Organization name cannot be empty.');
      return;
    }
    setIsSavingName(true);
    try {
      const updated = await dbService.updateOrganization(organization.org_id, {
        name: trimmed,
      });
      onUpdateOrganization(updated);
      setIsEditingName(false);
      showToast('Organization name updated.');
    } catch (err: any) {
      showToast(`Update failed: ${err.message || 'Unknown error'}`);
    } finally {
      setIsSavingName(false);
    }
  };

  // 2. Save Organization Email (resets verification_status to 'pending' if changed)
  const handleSaveEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = editEmail.trim();
    if (trimmed && !/^\S+@\S+\.\S+$/.test(trimmed)) {
      showToast('Please enter a valid email address.');
      return;
    }
    setIsSavingEmail(true);
    try {
      const emailChanged = trimmed.toLowerCase() !== (organization.email || '').toLowerCase();
      const updated = await dbService.updateOrganization(organization.org_id, {
        email: trimmed || undefined,
        ...(emailChanged ? { verification_status: 'pending' } : {}),
      });
      onUpdateOrganization(updated);
      setIsEditingEmail(false);
      showToast(emailChanged ? 'Email updated. Sent for verification.' : 'Contact email saved.');
    } catch (err: any) {
      showToast(`Update failed: ${err.message || 'Unknown error'}`);
    } finally {
      setIsSavingEmail(false);
    }
  };

  // 3. Save Master Password
  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      showToast('Needs internet to update password.');
      return;
    }
    if (!currentPassword) {
      showToast('Current password is required.');
      return;
    }
    if (!newPassword || newPassword.length < 6) {
      showToast('Min 6 characters required.');
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast('Passwords do not match.');
      return;
    }
    setIsSavingPassword(true);
    try {
      await authService.changeOrganiserPassword(currentPassword, newPassword);
      showToast('Master password updated. Other sessions signed out.');
      onPasswordChanged?.();
      setIsUpdatingPassword(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      void loadActiveSessions();
    } catch (err: any) {
      const code = err?.code || '';
      const msg = err?.message || '';
      if (code === 'too_many_attempts' || msg.includes('too_many_attempts')) {
        showToast('Too many attempts. Try again in 15 minutes.');
      } else if (code === 'weak_password') {
        showToast('New password is too short (minimum 6 characters).');
      } else if (code === 'unauthorized') {
        showToast('Session expired. Please sign in again.');
      } else if (code === 'invalid_credentials' || msg.includes('invalid') || msg.includes('wrong')) {
        showToast('Current password is wrong.');
      } else {
        showToast(`Password update failed: ${msg || 'Error'}`);
      }
    } finally {
      setIsSavingPassword(false);
    }
  };

  // Active Sessions: Execute single or bulk session termination
  const handleConfirmTerminateSession = async () => {
    if (!confirmTerminateTarget || isTerminatingSession) return;
    setIsTerminatingSession(true);
    try {
      if (confirmTerminateTarget.mode === 'one') {
        if (confirmTerminateTarget.session.is_current) {
          showToast('This device cannot be terminated from its own session list.');
          setConfirmTerminateTarget(null);
          return;
        }
        await authService.terminateOrgSession(confirmTerminateTarget.session.id);
        showToast(`Session ended on ${confirmTerminateTarget.session.device_label || 'device'}.`);
      } else {
        const count = await authService.terminateOtherOrgSessions();
        showToast(
          count > 0
            ? `Terminated ${count} other active session${count === 1 ? '' : 's'}.`
            : 'No other active sessions found.'
        );
      }
      setConfirmTerminateTarget(null);
      await loadActiveSessions();
    } catch (err: any) {
      showToast(err?.message || 'Could not terminate session.');
    } finally {
      setIsTerminatingSession(false);
    }
  };

  // Danger Zone: Open Master Reset modal with live counts preview
  const handleOpenMasterReset = () => {
    const evts = dbService.getCachedEvents(organization.org_id);
    const judges = dbService.getCachedJudges(organization.org_id);
    const parts = dbService.getCachedParticipants(organization.org_id);
    const scores = dbService.getCachedScores(organization.org_id);

    setResetCountsPreview({
      events: evts.length,
      lockedEvents: evts.filter((e) => e.is_locked).length,
      judges: judges.length,
      participants: parts.length,
      scores: scores.length,
    });
    setResetSuccess(false);
    setResetWipedSummary(null);
    setResetInput('');
    setResetPassword('');
    setShowResetPassword(false);
    setResetError('');
    setDownloadBackupFirst(true);
    setShowUndoResetPrompt(false);
    setUndoResetPassword('');
    setUndoResetError('');
    setShowResetConfirm(true);
  };

  // Danger Zone: Execute Master Reset (requires RESET + master password + internet)
  const handleExecuteReset = async () => {
    setResetError('');
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setResetError('Reset needs internet');
      showToast('Reset needs internet', 'error');
      return;
    }
    if (resetInput.trim().toUpperCase() !== 'RESET') {
      setResetError("Type 'RESET' to confirm.");
      return;
    }
    const cleanPwd = resetPassword.trim();
    if (!cleanPwd) {
      setResetError('Master password is required.');
      return;
    }

    setIsProcessingDanger(true);
    try {
      // 1. Collect pre-reset data & persist/verify AES-GCM encrypted safety snapshot FIRST
      let preResetPayload;
      try {
        preResetPayload = await collectOrganizationData(organization);
        await saveEncryptedSafetySnapshot(organization.org_id, preResetPayload, cleanPwd);
        const savedOk = await hasSafetySnapshot(organization.org_id);
        if (!savedOk) {
          throw new Error('Encrypted safety snapshot could not be verified on this device.');
        }
      } catch (snapErr: any) {
        const snapMsg = snapErr?.message
          ? `Could not save safety snapshot: ${snapErr.message} Nothing was deleted.`
          : 'Could not save encrypted safety snapshot locally. Reset aborted — nothing was deleted.';
        setResetError(snapMsg);
        showToast(snapMsg, 'error');
        return;
      }

      // 2. Only after encrypted snapshot is verified: verify password & wipe competition data atomically on server
      const wiped = await dbService.resetOrganizationAll(organization.org_id, cleanPwd);
      setCanUndoSnapshot(true);

      // 3. Optional automatic v2.0.0 backup download
      if (downloadBackupFirst) {
        try {
          const { filename, blob } = await createBackupFromPayload(organization, preResetPayload);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } catch (dlErr) {
          console.warn('Pre-reset backup download notice:', dlErr);
        }
      }

      // 4. Full refresh across all tabs (no manual reload)
      await syncNow({ forceFull: true, reason: 'manual' });
      eventBus.emit('cache_updated', { table: DB_TABLES.ALL });

      setResetWipedSummary(wiped);
      setResetSuccess(true);
      setResetInput('');
      setResetPassword('');
      setIsDangerShutterOpen(false);
      showToast('Reset complete. All competition data has been cleared.', 'success');
    } catch (err: any) {
      const msg = String(err?.message || 'Reset failed.');
      setResetError(msg);
      showToast(msg, 'error');
    } finally {
      setIsProcessingDanger(false);
    }
  };

  // Danger Zone: Undo Master Reset using encrypted local safety snapshot
  const handleExecuteUndoReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setUndoResetError('');
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setUndoResetError('Undo requires internet connection.');
      return;
    }
    const cleanPwd = undoResetPassword.trim();
    if (!cleanPwd) {
      setUndoResetError('Master password is required.');
      return;
    }

    setIsUndoingReset(true);
    try {
      await restoreSafetySnapshot(organization.org_id, cleanPwd);
      await dbService.clearOrgWorkAndInvalidateCache(organization.org_id);
      await syncNow({ forceFull: true, reason: 'manual' });
      const freshOrgRes = await dbService.getOrganizationByOrgIdResult(organization.org_id, true);
      if (freshOrgRes.data) {
        onUpdateOrganization(freshOrgRes.data);
        const existingSession = getStoredSession();
        if (existingSession && existingSession.org?.org_id?.toUpperCase() === organization.org_id.toUpperCase()) {
          setStoredSession({
            ...existingSession,
            org: freshOrgRes.data,
          });
        }
      }
      eventBus.emit('cache_updated', { table: DB_TABLES.ALL });

      setUndoResetPassword('');
      setShowUndoResetPrompt(false);
      setShowResetConfirm(false);
      setResetSuccess(false);
      setIsDangerShutterOpen(false);
      showToast('Reset undone. All competition data and settings restored.', 'success');
    } catch (err: any) {
      const msg = String(err?.message || 'Undo failed.');
      setUndoResetError(msg);
      showToast(msg, 'error');
    } finally {
      setIsUndoingReset(false);
    }
  };

  // Danger Zone: Delete Account
  const handleExecuteDelete = async () => {
    if (deleteInput.trim().toUpperCase() !== 'DELETE') {
      showToast("Type 'DELETE' to confirm.");
      return;
    }
    setIsProcessingDanger(true);
    try {
      await dbService.deleteOrganization(organization.org_id);
      setShowDeleteConfirm(false);
      setDeleteInput('');
      handleCloseModal();
      onLogout();
    } catch (err: any) {
      if (err?.code === 'ROSTER_LOCKED' || err?.message?.includes('ROSTER_LOCKED')) {
        showToast('Unlock your events first.');
      } else {
        showToast(`Delete failed: ${err.message}`);
      }
    } finally {
      setIsProcessingDanger(false);
    }
  };

  const hasNestedOverlay = Boolean(
    showBackupSheet ||
      showRestoreSheet ||
      showDeleteConfirm ||
      showUndoResetPrompt ||
      showResetConfirm ||
      showLogoutConfirm ||
      confirmTerminateTarget
  );

  return (
    <>
      <SidePanel
        isOpen={isOpen}
        onClose={handleCloseModal}
        title="Account & Security"
        titleId="account-modal-title"
        titleBadge={
          verificationStatus === 'verified' ? (
            <span title="Verified Organization" className="inline-flex">
              <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
            </span>
          ) : undefined
        }
        subtitle={organization.name}
        icon={<User className="w-5 h-5 stroke-[2.2]" />}
        closeAriaLabel="Close account panel"
        hasActiveOverlay={hasNestedOverlay}
        disableEscapeClose={showBackupSheet || showRestoreSheet}
        onEscapeBeforeClose={handleEscapeBeforeClose}
        bodyClassName="bg-stone-100 dark:bg-black pb-16"
      >
          {/* ======================================================== */}
          {/* TOP CARD 1A: SIGN OUT                                    */}
          {/* ======================================================== */}
          <div className="mt-2 bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm p-4">
            <button
              type="button"
              onClick={() => {
                triggerHaptic('tick');
                setShowLogoutConfirm(true);
              }}
              className="w-full min-h-[44px] px-4 rounded-xl text-xs lg:text-sm font-bold transition-colors cursor-pointer flex items-center justify-center space-x-2 bg-rose-700 hover:bg-rose-800 dark:bg-rose-700/90 dark:hover:bg-rose-700 text-white shadow-sm group"
            >
              <LogOut className="w-3.5 h-3.5 text-white transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
              <span>Sign out</span>
            </button>
          </div>

          {/* ======================================================== */}
          {/* TOP CARD 1B: ACTIVE SESSIONS (MAX 3 DEVICES)             */}
          {/* ======================================================== */}
          <div>
            <div className="flex items-center justify-between px-4 mb-2 mt-6">
              <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                Active sessions
              </h4>
              {!isLoadingSessions && !sessionsError && (
                <span className="text-[11px] lg:text-sm font-mono font-semibold text-zinc-600 dark:text-zinc-400 tabular-nums">
                  {activeSessions.length} of 3
                </span>
              )}
            </div>

            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              {isLoadingSessions ? (
                <div className="p-4 space-y-3" aria-busy="true" aria-label="Loading active sessions">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1.5 flex-1">
                      <span className="fj-skel h-4 w-36 block" />
                      <span className="fj-skel h-3 w-48 block" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-1.5 flex-1">
                      <span className="fj-skel h-4 w-32 block" />
                      <span className="fj-skel h-3 w-44 block" />
                    </div>
                    <span className="fj-skel h-9 w-20 block" />
                  </div>
                </div>
              ) : sessionsError ? (
                <div className="p-4 flex items-center justify-between gap-3">
                  <p className="text-xs lg:text-sm text-zinc-700 dark:text-zinc-300 leading-relaxed">
                    {sessionsError}
                  </p>
                  <button
                    type="button"
                    onClick={() => void loadActiveSessions()}
                    className="min-h-[44px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 border border-stone-200 dark:border-zinc-800 text-xs lg:text-sm font-bold text-zinc-800 dark:text-zinc-200 transition-colors cursor-pointer shrink-0 flex items-center gap-1.5"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Retry</span>
                  </button>
                </div>
              ) : activeSessions.length === 0 ? (
                <div className="p-4 text-xs lg:text-sm text-zinc-600 dark:text-zinc-400">
                  No active sessions returned for this account.
                </div>
              ) : (
                <>
                  {activeSessions.map((sess) => {
                    const isCurrent = Boolean(sess.is_current);
                    return (
                      <div
                        key={sess.id}
                        className="p-4 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <div className="w-9 h-9 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 flex items-center justify-center shrink-0 mt-0.5">
                            <MonitorSmartphone className="w-4 h-4" />
                          </div>
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs sm:text-sm font-bold text-zinc-900 dark:text-white truncate">
                                {sess.device_label || 'Unknown device'}
                              </span>
                              {isCurrent && (
                                <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-[10px] lg:text-xs font-bold text-emerald-800 dark:text-emerald-300 whitespace-nowrap shrink-0">
                                  This device
                                </span>
                              )}
                            </div>
                            <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] lg:text-sm text-zinc-600 dark:text-zinc-400 tabular-nums">
                              <span title={new Date(sess.created_at).toLocaleString()}>
                                Signed in {formatSessionTimestamp(sess.created_at)}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span title={new Date(sess.last_seen_at).toLocaleString()}>
                                Last seen {formatSessionTimestamp(sess.last_seen_at)}
                              </span>
                            </div>
                          </div>
                        </div>

                        {!isCurrent && (
                          <button
                            type="button"
                            onClick={() => {
                              triggerHaptic('tick');
                              setConfirmTerminateTarget({ mode: 'one', session: sess });
                            }}
                            className="min-h-[44px] px-3.5 rounded-xl bg-rose-700 hover:bg-rose-800 dark:bg-rose-700/90 dark:hover:bg-rose-700 text-white text-xs lg:text-sm font-bold transition-colors cursor-pointer shrink-0 whitespace-nowrap"
                          >
                            Terminate
                          </button>
                        )}
                      </div>
                    );
                  })}

                  {activeSessions.some((s) => !s.is_current) && (
                    <div className="p-4 bg-stone-50/70 dark:bg-zinc-900/40">
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('tick');
                          const otherCount = activeSessions.filter((s) => !s.is_current).length;
                          setConfirmTerminateTarget({ mode: 'others', count: otherCount });
                        }}
                        className="w-full min-h-[44px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 border border-stone-200 dark:border-zinc-800 text-rose-700 dark:text-rose-400 text-xs lg:text-sm font-bold transition-colors cursor-pointer flex items-center justify-center gap-2"
                      >
                        <LogOut className="w-3.5 h-3.5" />
                        <span>Terminate all others</span>
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* ======================================================== */}
          {/* CARD 1C: ORGANIZATION IDENTITY                           */}
          {/* ======================================================== */}
          <div>
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400 ml-4 mb-2 mt-6">
              Organization Identity
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">

            {/* Row 1: Organization Name — pencil to the right, NO "Host Entity" (C3) */}
            <div className="p-4 space-y-2">
              {!isEditingName ? (
                <div className="space-y-1">
                  <span className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400 block">
                    Organization Name
                  </span>
                  <div className="flex items-center justify-between gap-2.5">
                    <p className="text-sm sm:text-base font-bold text-zinc-900 dark:text-white break-words min-w-0 flex-1">
                      {organization.name}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setEditName(organization.name);
                        setIsEditingName(true);
                      }}
                      aria-label="Edit organisation name"
                      title="Edit organisation name"
                      className="w-11 h-11 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-stone-200 dark:border-zinc-800 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                    >
                      <Pencil className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleSaveName} className="space-y-3 pt-1 animate-in fade-in duration-150">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] lg:text-sm font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
                      Edit Organization Name
                    </span>
                  </div>

                  <input
                    type="text"
                    autoFocus
                    required
                    placeholder="e.g. Cambridge International Festival"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-sm font-semibold text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-emerald-500"
                  />

                  <div className="grid grid-cols-2 gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setEditName(organization.name);
                        setIsEditingName(false);
                      }}
                      disabled={isSavingName}
                      className="min-h-[44px] px-3 bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs lg:text-sm font-semibold rounded-xl transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSavingName || !editName.trim()}
                      className="min-h-[44px] px-3 bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-700/90 dark:hover:bg-emerald-700 disabled:opacity-50 text-white text-xs lg:text-sm font-bold rounded-xl transition-colors shadow-sm flex items-center justify-center space-x-1.5 cursor-pointer"
                    >
                      {isSavingName ? <span>Saving...</span> : <span>Save Name</span>}
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Row 2: Email — heading "Email", verified tick only (no "Verified" text), pencil right of heading, NO tick next to email ID, NO mail button (C4) */}
            <div className="p-4 space-y-2.5">
              {!isEditingEmail ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400">
                        Email
                      </span>
                      {verificationStatus === 'verified' && (
                        <CheckCircle2
                          className="w-3.5 h-3.5 text-emerald-500 shrink-0"
                          aria-label="Verified"
                        />
                      )}
                      {verificationStatus === 'pending' && (
                        <Clock
                          className="w-3.5 h-3.5 text-amber-500 shrink-0"
                          aria-label="Under Verification"
                        />
                      )}
                      {verificationStatus === 'rejected' && (
                        <XCircle
                          className="w-3.5 h-3.5 text-red-500 shrink-0"
                          aria-label="Verification Failed"
                        />
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setEditEmail(organization.email || '');
                        setIsEditingEmail(true);
                      }}
                      aria-label={organization.email ? 'Edit email' : 'Add email'}
                      title={organization.email ? 'Edit email' : 'Add email'}
                      className="w-11 h-11 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-stone-200 dark:border-zinc-800 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                    >
                      <Pencil className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                    </button>
                  </div>

                  <p className="text-sm font-semibold font-mono text-zinc-800 dark:text-zinc-200 break-all">
                    {organization.email || (
                      <span className="text-zinc-400 italic">No email configured</span>
                    )}
                  </p>

                  {/* Pending Verification Info Note */}
                  {verificationStatus === 'pending' && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] lg:text-sm text-amber-700 dark:text-amber-300 leading-relaxed flex items-start space-x-2 mt-2">
                      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                      <span>
                        Your organization and email are currently under manual review by the Security Team. Unverified or invalid accounts may be removed if rejected.
                      </span>
                    </div>
                  )}

                  {/* Rejected Verification Alert with Developer Contact & Telegram */}
                  {verificationStatus === 'rejected' && (
                    <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 space-y-2.5 mt-2">
                      <div className="flex items-start space-x-2 text-xs lg:text-sm text-red-600 dark:text-red-400 font-semibold leading-relaxed">
                        <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
                        <span>
                          {organization.rejection_reason
                            ? `Verification rejected: ${organization.rejection_reason}`
                            : 'Email verification failed. Please update your email or contact the Developer / Security Team immediately before account removal:'}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 pt-0.5">
                        <a
                          href="mailto:spesium.code@proton.me"
                          className="inline-flex items-center space-x-1.5 min-h-[44px] px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-red-500/30 text-[11px] lg:text-sm font-mono font-bold text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <Mail className="w-3.5 h-3.5" />
                          <span>spesium.code@proton.me</span>
                        </a>
                        <a
                          href="https://t.me/+ljTOKLi5dQs1MTM9"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center space-x-1.5 min-h-[44px] px-3 py-1.5 rounded-lg bg-blue-500/15 border border-blue-500/30 text-[11px] lg:text-sm font-bold text-blue-600 dark:text-blue-400 hover:bg-blue-500/25 transition-colors"
                        >
                          <Send className="w-3.5 h-3.5" />
                          <span>Join Telegram Support</span>
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <form onSubmit={handleSaveEmail} className="space-y-3 pt-1 animate-in fade-in duration-150">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] lg:text-sm font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
                      Update Email
                    </span>
                  </div>

                  <input
                    type="email"
                    autoFocus
                    required
                    placeholder="e.g. director@fairjudge.io"
                    value={editEmail}
                    onChange={(e) => setEditEmail(e.target.value)}
                    className="w-full min-h-[44px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-sm font-semibold text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none focus:border-emerald-500"
                  />

                  <div className="grid grid-cols-2 gap-2 pt-0.5">
                    <button
                      type="button"
                      onClick={() => {
                        setEditEmail(organization.email || '');
                        setIsEditingEmail(false);
                      }}
                      disabled={isSavingEmail}
                      className="min-h-[44px] px-3 bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs lg:text-sm font-semibold rounded-xl transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSavingEmail || !editEmail.trim()}
                      className="min-h-[44px] px-3 bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-700/90 dark:hover:bg-emerald-700 disabled:opacity-50 text-white text-xs lg:text-sm font-bold rounded-xl transition-colors shadow-sm flex items-center justify-center space-x-1.5 cursor-pointer"
                    >
                      {isSavingEmail ? <span>Saving...</span> : <span>Save Email</span>}
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Row 3: Organization Code — one line, code on right, NO "Jury Login Key" (C5) */}
            <div className="p-4 flex items-center justify-between gap-2">
              <span className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400 shrink-0">
                Organization Code
              </span>

              <div className="flex items-center space-x-2 shrink-0 min-w-0">
                <span className="text-sm font-mono font-bold tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-xl border border-emerald-500/20 truncate">
                  {organization.org_id}
                </span>
                <button
                  type="button"
                  onClick={handleCopyOrgId}
                  aria-label={copiedOrgId ? 'Copied organisation code' : 'Copy organisation code'}
                  title={copiedOrgId ? 'Copied' : 'Copy Org ID'}
                  className="w-11 h-11 rounded-xl bg-stone-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white border border-stone-200 dark:border-zinc-800 flex items-center justify-center transition-colors cursor-pointer shrink-0"
                >
                  {copiedOrgId ? (
                    <Check className="w-4 h-4 text-emerald-500" />
                  ) : (
                    <Copy className="w-4 h-4 text-zinc-600 dark:text-zinc-400" />
                  )}
                </button>
              </div>
            </div>
            </div>
          </div>

          {/* ======================================================== */}
          {/* CARD 2: SECURITY — BLUE "Change password" BTN (C6)       */}
          {/* ======================================================== */}
          <div>
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400 ml-4 mb-2 mt-6">
              Password
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm p-4">
              <button
                type="button"
                onClick={() => setIsUpdatingPassword(!isUpdatingPassword)}
                className={`w-full min-h-[44px] px-4 rounded-xl text-xs lg:text-sm font-bold transition-colors cursor-pointer flex items-center justify-center space-x-2 ${
                  isUpdatingPassword
                    ? 'bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-stone-200 dark:border-zinc-800'
                    : 'bg-blue-700 hover:bg-blue-800 dark:bg-blue-700/90 dark:hover:bg-blue-700 text-white shadow-sm'
                }`}
              >
                <Lock className="w-3.5 h-3.5" />
                <span>{isUpdatingPassword ? 'Cancel' : 'Change password'}</span>
              </button>

              {/* Password Update Form (Inline Expandable) */}
              {isUpdatingPassword && (
                <form onSubmit={handleSavePassword} className="mt-3 pt-3 border-t border-stone-100 dark:border-zinc-800/60 space-y-2.5 animate-in fade-in duration-150">
                  {mustChangePassword && (
                    <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] lg:text-sm font-medium text-amber-700 dark:text-amber-300 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>Temporary password active — please set a new master password now.</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] lg:text-sm font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider">
                      New Password
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="min-h-[44px] px-2 text-[11px] lg:text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 flex items-center space-x-1 cursor-pointer"
                    >
                      {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      <span>{showPassword ? 'Hide' : 'Show'}</span>
                    </button>
                  </div>

                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Current password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    required
                    className="w-full min-h-[44px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-amber-500"
                  />

                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="New password (minimum 6 characters)"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    className="w-full min-h-[44px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-amber-500"
                  />

                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    className="w-full min-h-[44px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-amber-500"
                  />

                  <button
                    type="submit"
                    disabled={isSavingPassword || !currentPassword || !newPassword || newPassword !== confirmPassword}
                    className="w-full min-h-[44px] bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-700/90 dark:hover:bg-emerald-700 disabled:opacity-50 text-white text-xs lg:text-sm font-bold rounded-xl transition-colors active:scale-[0.98] motion-reduce:transition-none cursor-pointer shadow-sm flex items-center justify-center space-x-1.5"
                  >
                    <Lock className="w-3.5 h-3.5" />
                    <span>{isSavingPassword ? 'Saving Password...' : 'Save New Password'}</span>
                  </button>
                </form>
              )}
            </div>
          </div>

          {/* ======================================================== */}
          {/* CARD 3: BACKUP & RESTORE — SIDE BY SIDE, NO HINTS (C7)   */}
          {/* ======================================================== */}
          <div>
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400 ml-4 mb-2 mt-6">
              Backup &amp; Restore
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm p-3.5">
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowBackupSheet(true)}
                  className="min-h-[44px] px-3.5 rounded-xl bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-700/90 dark:hover:bg-emerald-700 text-white text-xs lg:text-sm font-bold transition-colors cursor-pointer flex items-center justify-center space-x-1.5 shadow-sm"
                >
                  <Download className="w-4 h-4" />
                  <span>Backup</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowRestoreSheet(true)}
                  className="min-h-[44px] px-3.5 rounded-xl bg-amber-700 hover:bg-amber-800 dark:bg-amber-700/90 dark:hover:bg-amber-700 text-white text-xs lg:text-sm font-bold transition-colors cursor-pointer flex items-center justify-center space-x-1.5 shadow-sm"
                >
                  <Upload className="w-4 h-4" />
                  <span>Restore</span>
                </button>
              </div>
            </div>
          </div>

          {/* ======================================================== */}
          {/* CARD 4: ABOUT & SUPPORT                                  */}
          {/* ======================================================== */}
          <div>
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400 ml-4 mb-2 mt-6">
              About &amp; Support
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              {/* Brand Anchor */}
              <div className="p-4 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <BrandBadge size="sm" role="organiser" motion="still" />
                  <div>
                    <span className="text-sm font-bold text-zinc-900 dark:text-white block font-sans">
                      Fair Judge
                    </span>
                    <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400 uppercase tracking-widest font-mono">
                      Audited Scoring Terminal
                    </span>
                  </div>
                </div>
              </div>

              {/* Telegram Community */}
              <a
                href="https://t.me/+ljTOKLi5dQs1MTM9"
                target="_blank"
                rel="noopener noreferrer"
                className="min-h-[44px] p-4 flex items-center justify-between hover:bg-stone-50 dark:hover:bg-zinc-900/40 transition-colors group cursor-pointer"
              >
                <div className="flex items-center space-x-3">
                  <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-500 dark:text-blue-400 flex items-center justify-center group-hover:scale-105 transition-transform motion-reduce:transition-none">
                    <MessageCircle className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs lg:text-sm font-bold text-zinc-900 dark:text-white block group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors">
                      Join our Telegram Community
                    </span>
                    <span className="text-[10px] lg:text-sm text-zinc-600 dark:text-zinc-400">
                      Product updates, live support &amp; feedback
                    </span>
                  </div>
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-zinc-400 group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors" />
              </a>

              {/* Ko-fi Developer Support */}
              <a
                href="https://ko-fi.com/sahilkumarrout"
                target="_blank"
                rel="noopener noreferrer"
                className="min-h-[44px] p-4 flex items-center justify-between hover:bg-stone-50 dark:hover:bg-zinc-900/40 transition-colors group cursor-pointer"
              >
                <div className="flex items-center space-x-3">
                  <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center group-hover:scale-105 transition-transform motion-reduce:transition-none">
                    <Coffee className="w-4 h-4" />
                  </div>
                  <div>
                    <span className="text-xs lg:text-sm font-bold text-zinc-900 dark:text-white block group-hover:text-amber-500 dark:group-hover:text-amber-400 transition-colors">
                      Support the Developer
                    </span>
                    <span className="text-[10px] lg:text-sm text-zinc-600 dark:text-zinc-400">
                      Fuel development via Ko-fi
                    </span>
                  </div>
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-zinc-400 group-hover:text-amber-500 dark:group-hover:text-amber-400 transition-colors" />
              </a>
            </div>
          </div>

          {/* ======================================================== */}
          {/* CARD 5: DANGER ZONE WITH TAP-TO-OPEN SHUTTER (C8)        */}
          {/* ======================================================== */}
          <div>
            <h4 className="text-[11px] lg:text-sm font-bold uppercase tracking-wider text-red-600/80 dark:text-red-400/80 ml-4 mb-2 mt-6">
              Danger Zone
            </h4>
            <div className="relative bg-white dark:bg-zinc-950 rounded-2xl border border-red-200 dark:border-red-950 overflow-hidden shadow-sm">
              {/* Top-Centre Shutter Handle Button */}
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('tick');
                  setIsDangerShutterOpen((prev) => !prev);
                }}
                aria-expanded={isDangerShutterOpen}
                aria-controls="danger-zone-panel"
                aria-label={isDangerShutterOpen ? 'Close Danger Zone shutter' : 'Open Danger Zone shutter'}
                className="relative z-20 w-full min-h-[44px] px-4 flex flex-col items-center justify-center gap-1 bg-stone-50 dark:bg-zinc-900 border-b border-red-100 dark:border-red-950/60 hover:bg-stone-100 dark:hover:bg-zinc-800/80 transition-colors cursor-pointer"
              >
                <span className="w-9 h-1 rounded-full bg-red-400/70 dark:bg-red-500/60" />
                <span className="inline-flex items-center gap-1 text-[10px] lg:text-xs font-mono font-bold uppercase tracking-wider text-red-600 dark:text-red-400">
                  <ShieldAlert className="w-3 h-3" />
                  <span>{isDangerShutterOpen ? 'Tap to lock Danger Zone' : 'Tap to unlock Danger Zone'}</span>
                  <ChevronDown
                    className={`w-3 h-3 transition-transform duration-200 motion-reduce:transition-none ${
                      isDangerShutterOpen ? 'rotate-180' : 'rotate-0'
                    }`}
                  />
                </span>
              </button>

              {/* Danger Zone Controls + Smooth Shutter Overlay */}
              <div className="relative overflow-hidden">
                <div
                  id="danger-zone-panel"
                  aria-hidden={!isDangerShutterOpen}
                  data-open={isDangerShutterOpen ? 'true' : 'false'}
                  className="p-4 space-y-2.5 fj-danger-panel"
                >
                  <button
                    type="button"
                    disabled={!isDangerShutterOpen}
                    tabIndex={isDangerShutterOpen ? 0 : -1}
                    onClick={handleOpenMasterReset}
                    className="w-full min-h-[44px] px-4 rounded-xl bg-red-700 hover:bg-red-800 dark:bg-red-700/90 dark:hover:bg-red-700 disabled:pointer-events-none text-white text-xs lg:text-sm font-bold transition-colors cursor-pointer flex items-center justify-center space-x-2 shadow-sm"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Reset Data</span>
                  </button>

                  {canUndoSnapshot && (
                    <button
                      type="button"
                      disabled={!isDangerShutterOpen}
                      tabIndex={isDangerShutterOpen ? 0 : -1}
                      onClick={() => {
                        setUndoResetPassword('');
                        setUndoResetError('');
                        setShowUndoResetPrompt(true);
                      }}
                      className="w-full min-h-[44px] px-4 rounded-xl bg-amber-700 hover:bg-amber-800 dark:bg-amber-700/90 dark:hover:bg-amber-700 disabled:pointer-events-none text-white text-xs lg:text-sm font-bold transition-colors cursor-pointer flex items-center justify-center space-x-2 shadow-sm"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                      <span>Undo Last Reset</span>
                    </button>
                  )}

                  <button
                    type="button"
                    disabled={!isDangerShutterOpen}
                    tabIndex={isDangerShutterOpen ? 0 : -1}
                    onClick={() => setShowDeleteConfirm(true)}
                    className="w-full min-h-[44px] px-4 rounded-xl bg-red-700 hover:bg-red-800 dark:bg-red-700/90 dark:hover:bg-red-700 disabled:pointer-events-none text-white text-xs lg:text-sm font-bold transition-colors cursor-pointer flex items-center justify-center space-x-2 shadow-sm"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Organization</span>
                  </button>
                </div>

                {/* Protected Shutter Sheet (NO backdrop-filter, smooth GPU slide up/down + reveal) */}
                <div
                  aria-hidden="true"
                  data-open={isDangerShutterOpen ? 'true' : 'false'}
                  className={`absolute inset-0 z-10 bg-stone-200/95 dark:bg-zinc-900/95 flex items-center justify-center fj-danger-shutter ${
                    isDangerShutterOpen ? 'pointer-events-none' : 'pointer-events-auto'
                  }`}
                >
                  <div className="px-3 py-1.5 rounded-xl bg-white dark:bg-zinc-950 border border-red-200 dark:border-red-900/60 shadow-sm flex items-center gap-1.5 text-[11px] lg:text-xs font-mono font-bold text-red-600 dark:text-red-400">
                    <Lock className="w-3.5 h-3.5" />
                    <span>Protected</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Static Developer Signature Footer (zero infinite animations) */}
          <div className="text-[10px] lg:text-xs uppercase tracking-widest text-zinc-600 dark:text-zinc-400 text-center pb-4 pt-6 select-none">
            Engineered with Intent{' '}
            <span className="text-emerald-600 dark:text-emerald-400 font-mono font-bold mx-1">
              &lt;/&gt;
            </span>{' '}
            <span className="text-zinc-800 dark:text-zinc-200 font-semibold">
              Sahil Kumar Rout
            </span>
          </div>
      </SidePanel>

      {isOpen &&
        (() => {
          const overlays = (
            <>
      {/* Double-Confirmation Pop-up: Sign Out (C2) */}
      {showLogoutConfirm && (
        <div
          className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center p-4 animate-in fade-in duration-150"
          role="dialog"
          aria-modal="true"
          aria-labelledby="org-signout-confirm-title"
          onClick={() => setShowLogoutConfirm(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-zinc-950 border border-red-500/30 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150"
          >
            <div className="flex items-center space-x-3 text-red-600 dark:text-red-400">
              <div className="w-10 h-10 rounded-2xl bg-red-500/15 flex items-center justify-center shrink-0">
                <LogOut className="w-5 h-5" />
              </div>
              <div>
                <h3
                  id="org-signout-confirm-title"
                  className="text-base font-bold text-zinc-900 dark:text-white leading-tight"
                >
                  Sign out?
                </h3>
                <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-400 font-mono">
                  {organization.name}
                </p>
              </div>
            </div>

            <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Sign out of this organisation account on this device? Any unsynced changes remain queued locally.
            </p>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(false)}
                className="min-h-[44px] bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs lg:text-sm font-bold rounded-xl border border-stone-200 dark:border-zinc-800 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLogoutConfirm(false);
                  handleCloseModal();
                  onLogout();
                }}
                className="min-h-[44px] bg-rose-700 hover:bg-rose-800 dark:bg-rose-700/90 dark:hover:bg-rose-700 text-white text-xs lg:text-sm font-bold rounded-xl shadow-sm transition-colors cursor-pointer flex items-center justify-center space-x-1.5"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign out</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Pop-up: Terminate Other Session(s) (Epic 16.5.0) */}
      {confirmTerminateTarget && (
        <div
          className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center p-4 animate-in fade-in duration-150 motion-reduce:animate-none"
          role="dialog"
          aria-modal="true"
          aria-labelledby="org-session-terminate-title"
          onClick={() => {
            if (!isTerminatingSession) setConfirmTerminateTarget(null);
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-zinc-950 border border-rose-500/30 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150 motion-reduce:animate-none"
          >
            <div className="flex items-center space-x-3 text-rose-700 dark:text-rose-400">
              <div className="w-10 h-10 rounded-2xl bg-rose-500/15 flex items-center justify-center shrink-0">
                <MonitorSmartphone className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h3
                  id="org-session-terminate-title"
                  className="text-base font-bold text-zinc-900 dark:text-white leading-tight"
                >
                  {confirmTerminateTarget.mode === 'one'
                    ? 'Terminate session?'
                    : 'Terminate all other sessions?'}
                </h3>
                <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-400 truncate">
                  {confirmTerminateTarget.mode === 'one'
                    ? confirmTerminateTarget.session.device_label || 'Unknown device'
                    : `${confirmTerminateTarget.count} other device${confirmTerminateTarget.count === 1 ? '' : 's'} signed in`}
                </p>
              </div>
            </div>

            <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
              {confirmTerminateTarget.mode === 'one'
                ? 'That device will be signed out automatically within about 60 seconds. This device stays signed in.'
                : 'Every other signed-in device will be signed out automatically within about 60 seconds. This device stays signed in.'}
            </p>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                disabled={isTerminatingSession}
                onClick={() => setConfirmTerminateTarget(null)}
                className="min-h-[44px] bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs lg:text-sm font-bold rounded-xl border border-stone-200 dark:border-zinc-800 transition-colors cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isTerminatingSession}
                onClick={() => void handleConfirmTerminateSession()}
                className="min-h-[44px] bg-rose-700 hover:bg-rose-800 dark:bg-rose-700/90 dark:hover:bg-rose-700 text-white text-xs lg:text-sm font-bold rounded-xl shadow-sm transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center space-x-1.5"
              >
                <LogOut className="w-4 h-4" />
                <span>
                  {isTerminatingSession
                    ? 'Terminating...'
                    : confirmTerminateTarget.mode === 'one'
                      ? 'Terminate'
                      : 'Terminate all'}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Centered Confirmation Modal: Master Reset */}
      {showResetConfirm && (
        <div
          className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center p-4 animate-in fade-in duration-150"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-confirm-title"
        >
          <div className="bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150 max-h-[90dvh] overflow-y-auto">
            {resetSuccess ? (
              <>
                <div className="flex items-center space-x-3 text-emerald-700 dark:text-emerald-400">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 flex items-center justify-center shrink-0">
                    <CheckCircle2 className="w-5 h-5" />
                  </div>
                  <div>
                    <h3
                      id="reset-confirm-title"
                      className="text-base font-bold text-zinc-900 dark:text-white leading-tight"
                    >
                      Master Reset Complete
                    </h3>
                    <p className="text-xs lg:text-sm text-emerald-700 dark:text-emerald-400 font-mono">
                      {organization.org_id}
                    </p>
                  </div>
                </div>

                <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
                  All competition data{resetWipedSummary ? ` (${resetWipedSummary.events} events, ${resetWipedSummary.judges} judges, ${resetWipedSummary.participants} participants, ${resetWipedSummary.scores} scores)` : ''} has been wiped. Your organisation account and settings remain intact, and an encrypted safety snapshot was saved on this device.
                </p>

                <div className="grid grid-cols-1 gap-2 pt-1">
                  {canUndoSnapshot && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowResetConfirm(false);
                        setUndoResetPassword('');
                        setUndoResetError('');
                        setShowUndoResetPrompt(true);
                      }}
                      className="w-full min-h-[44px] bg-amber-700 hover:bg-amber-800 dark:bg-amber-700/90 dark:hover:bg-amber-700 text-white text-xs lg:text-sm font-bold rounded-xl shadow-sm transition-colors cursor-pointer flex items-center justify-center space-x-1.5"
                    >
                      <Undo2 className="w-4 h-4" />
                      <span>Undo Reset</span>
                    </button>
                  )}

                  <button
                    type="button"
                    autoFocus
                    onClick={() => {
                      setShowResetConfirm(false);
                      setResetSuccess(false);
                      setResetInput('');
                      setResetPassword('');
                    }}
                    className="w-full min-h-[44px] bg-emerald-700 hover:bg-emerald-800 dark:bg-emerald-700/90 dark:hover:bg-emerald-700 text-white text-xs lg:text-sm font-bold rounded-xl shadow-sm transition-colors cursor-pointer"
                  >
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center space-x-3 text-red-700 dark:text-red-400">
                  <div className="w-10 h-10 rounded-2xl bg-red-500/15 flex items-center justify-center shrink-0">
                    <RotateCcw className="w-5 h-5" />
                  </div>
                  <div>
                    <h3
                      id="reset-confirm-title"
                      className="text-base font-bold text-zinc-900 dark:text-white leading-tight"
                    >
                      Master Reset
                    </h3>
                    <p className="text-xs lg:text-sm text-red-700 dark:text-red-400 font-mono">
                      Wipes all competition data
                    </p>
                  </div>
                </div>

                <div className="p-3 rounded-2xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 space-y-2">
                  <p className="text-[11px] lg:text-sm font-semibold text-zinc-800 dark:text-zinc-200 leading-relaxed">
                    Deletes everything for <strong className="text-zinc-950 dark:text-white">{organization.name}</strong>, including{' '}
                    {resetCountsPreview.lockedEvents > 0
                      ? `${resetCountsPreview.lockedEvents} locked event(s)`
                      : 'locked events'}{' '}
                    and active judge sessions. Organisation login and settings stay intact.
                  </p>
                  <div className="grid grid-cols-4 gap-1.5 text-center pt-1">
                    <div className="p-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800">
                      <span className="text-xs lg:text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                        {resetCountsPreview.events}
                      </span>
                      <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400">Events</span>
                    </div>
                    <div className="p-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800">
                      <span className="text-xs lg:text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                        {resetCountsPreview.judges}
                      </span>
                      <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400">Judges</span>
                    </div>
                    <div className="p-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800">
                      <span className="text-xs lg:text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                        {resetCountsPreview.participants}
                      </span>
                      <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400">Roster</span>
                    </div>
                    <div className="p-1.5 rounded-lg bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800">
                      <span className="text-xs lg:text-sm font-mono font-bold text-zinc-900 dark:text-white block">
                        {resetCountsPreview.scores}
                      </span>
                      <span className="text-[10px] lg:text-xs text-zinc-600 dark:text-zinc-400">Scores</span>
                    </div>
                  </div>
                </div>

                {/* Download Backup First Checkbox (Default ON) */}
                <label className="flex items-start space-x-2.5 p-2.5 rounded-xl bg-stone-50 dark:bg-zinc-900/60 border border-stone-200 dark:border-zinc-800 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={downloadBackupFirst}
                    onChange={(e) => setDownloadBackupFirst(e.target.checked)}
                    className="mt-0.5 w-4 h-4 rounded text-emerald-700 focus:ring-emerald-600 shrink-0"
                  />
                  <span className="text-[11px] lg:text-sm text-zinc-700 dark:text-zinc-300 leading-snug">
                    <strong className="text-zinc-900 dark:text-white block">Download backup file first</strong>
                    Saves a full v2.0 archive (.json) plus an encrypted Undo snapshot on this device.
                  </span>
                </label>

                <div className="space-y-1.5">
                  <label className="text-[11px] lg:text-sm font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider block">
                    Type <span className="font-mono font-black text-red-700 dark:text-red-400">RESET</span> to confirm
                  </label>
                  <input
                    type="text"
                    autoFocus
                    placeholder="RESET"
                    value={resetInput}
                    onChange={(e) => {
                      setResetInput(e.target.value);
                      setResetError('');
                    }}
                    className="w-full min-h-[44px] px-3.5 bg-stone-100 dark:bg-zinc-900 border border-red-500/40 rounded-xl font-mono text-sm text-center uppercase tracking-widest text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/50"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] lg:text-sm font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5" />
                    <span>Master Password</span>
                  </label>
                  <div className="relative">
                    <input
                      type={showResetPassword ? 'text' : 'password'}
                      placeholder="Enter master password"
                      value={resetPassword}
                      onChange={(e) => {
                        setResetPassword(e.target.value);
                        setResetError('');
                      }}
                      className="w-full min-h-[44px] pl-3.5 pr-10 bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-red-500"
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      onClick={() => setShowResetPassword((v) => !v)}
                      aria-label={showResetPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9 md:w-11 md:h-11 flex items-center justify-center text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200 cursor-pointer"
                    >
                      {showResetPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {resetError && (
                  <p role="alert" className="text-[11px] lg:text-sm text-red-700 dark:text-red-400 font-semibold">
                    {resetError}
                  </p>
                )}

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShowResetConfirm(false);
                      setResetSuccess(false);
                      setResetInput('');
                      setResetPassword('');
                      setResetError('');
                    }}
                    disabled={isProcessingDanger}
                    className="min-h-[44px] bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs lg:text-sm font-bold rounded-xl transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleExecuteReset}
                    disabled={
                      resetInput.trim().toUpperCase() !== 'RESET' ||
                      !resetPassword.trim() ||
                      isProcessingDanger
                    }
                    className="min-h-[44px] bg-red-700 hover:bg-red-800 dark:bg-red-700/90 dark:hover:bg-red-700 disabled:opacity-40 text-white text-xs lg:text-sm font-bold rounded-xl shadow-sm transition-colors cursor-pointer flex items-center justify-center space-x-1.5"
                  >
                    {isProcessingDanger ? <span>Wiping...</span> : <span>Confirm Reset</span>}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Floating Centered Confirmation Modal: Undo Reset */}
      {showUndoResetPrompt && (
        <div
          className="fixed inset-0 z-[125] bg-black/80 flex items-center justify-center p-4 animate-in fade-in duration-150"
          role="dialog"
          aria-modal="true"
          aria-labelledby="undo-reset-title"
        >
          <form
            onSubmit={handleExecuteUndoReset}
            className="bg-white dark:bg-zinc-950 border border-amber-500/40 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150"
          >
            <div className="flex items-center space-x-3 text-amber-700 dark:text-amber-400">
              <div className="w-10 h-10 rounded-2xl bg-amber-500/15 flex items-center justify-center shrink-0">
                <Undo2 className="w-5 h-5" />
              </div>
              <div>
                <h3
                  id="undo-reset-title"
                  className="text-base font-bold text-zinc-900 dark:text-white leading-tight"
                >
                  Undo Reset
                </h3>
                <p className="text-xs lg:text-sm text-amber-700 dark:text-amber-400 font-mono">
                  Restore encrypted safety snapshot
                </p>
              </div>
            </div>

            <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-300 leading-relaxed">
              Enter your master password to decrypt the local safety snapshot and restore all competition data and settings.
            </p>

            <div className="space-y-1.5">
              <label className="text-[11px] lg:text-sm font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider block">
                Master Password
              </label>
              <input
                type="password"
                autoFocus
                placeholder="Enter master password"
                value={undoResetPassword}
                onChange={(e) => {
                  setUndoResetPassword(e.target.value);
                  setUndoResetError('');
                }}
                className="w-full min-h-[44px] px-3.5 bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs lg:text-sm text-zinc-900 dark:text-white focus:outline-none focus:border-amber-600"
              />
              {undoResetError && (
                <p role="alert" className="text-[11px] lg:text-sm text-red-700 dark:text-red-400 font-semibold">
                  {undoResetError}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowUndoResetPrompt(false);
                  setUndoResetPassword('');
                  setUndoResetError('');
                }}
                disabled={isUndoingReset}
                className="min-h-[44px] bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs lg:text-sm font-bold rounded-xl transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isUndoingReset || !undoResetPassword.trim()}
                className="min-h-[44px] bg-amber-700 hover:bg-amber-800 dark:bg-amber-700/90 dark:hover:bg-amber-700 disabled:opacity-40 text-white text-xs lg:text-sm font-bold rounded-xl shadow-sm transition-colors cursor-pointer flex items-center justify-center space-x-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isUndoingReset ? 'animate-spin' : ''}`} />
                <span>{isUndoingReset ? 'Restoring...' : 'Restore Snapshot'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Floating Centered Confirmation Modal: Delete Account */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center p-4 animate-in fade-in duration-150"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-confirm-title"
        >
          <div className="bg-white dark:bg-zinc-950 border border-red-500/50 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center space-x-3 text-red-600 dark:text-red-400">
              <div className="w-10 h-10 rounded-2xl bg-red-500/15 flex items-center justify-center">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3
                  id="delete-confirm-title"
                  className="text-base font-bold text-zinc-900 dark:text-white leading-tight"
                >
                  Delete Organization
                </h3>
                <p className="text-xs lg:text-sm text-red-600 dark:text-red-400 font-mono">
                  Irreversible deletion
                </p>
              </div>
            </div>

            <p className="text-xs lg:text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Completely delete{' '}
              <strong className="text-zinc-900 dark:text-white">{organization.name}</strong> along with all events, rosters, and ballots. This cannot be undone.
            </p>

            <div className="space-y-1.5">
              <label className="text-[11px] lg:text-sm font-bold text-zinc-600 dark:text-zinc-400 uppercase tracking-wider block">
                Type <span className="font-mono font-black text-red-600 dark:text-red-400">DELETE</span> to confirm:
              </label>
              <input
                type="text"
                autoFocus
                placeholder="DELETE"
                value={deleteInput}
                onChange={(e) => setDeleteInput(e.target.value)}
                className="w-full min-h-[44px] px-3.5 bg-stone-100 dark:bg-zinc-900 border border-red-500/50 rounded-xl font-mono text-sm text-center uppercase tracking-widest text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/50"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteInput('');
                }}
                className="min-h-[44px] bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs lg:text-sm font-bold rounded-xl transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteDelete}
                disabled={deleteInput.trim().toUpperCase() !== 'DELETE' || isProcessingDanger}
                className="min-h-[44px] bg-red-700 hover:bg-red-800 dark:bg-red-700/90 dark:hover:bg-red-700 disabled:opacity-40 text-white text-xs lg:text-sm font-bold rounded-xl shadow-sm transition-colors cursor-pointer flex items-center justify-center space-x-1.5"
              >
                {isProcessingDanger ? <span>Deleting...</span> : <span>Confirm Delete</span>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backup and Restore Modals */}
      <BackupSheet
        isOpen={showBackupSheet}
        onClose={() => setShowBackupSheet(false)}
        organization={organization}
      />
      <RestoreSheet
        isOpen={showRestoreSheet}
        onClose={() => setShowRestoreSheet(false)}
        organization={organization}
        onRestoreComplete={(updatedOrg) => {
          if (updatedOrg) {
            onUpdateOrganization(updatedOrg);
          }
          hasSafetySnapshot(organization.org_id)
            .then(setCanUndoSnapshot)
            .catch(() => {});
          eventBus.emit('cache_updated', { table: DB_TABLES.ALL });
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('fairjudge_session_change'));
          }
        }}
      />
            </>
          );
          return typeof document !== 'undefined'
            ? createPortal(overlays, document.body)
            : overlays;
        })()}
    </>
  );
}
