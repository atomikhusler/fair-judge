import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
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
  Scale,
  MessageCircle,
  Coffee,
  ExternalLink,
  Download,
  Upload,
  ChevronDown,
  ShieldAlert,
} from 'lucide-react';
import { Organization } from '../../lib/supabaseTypes';
import { dbService, supabase } from '../../lib/supabase';
import { eventBus } from '../../lib/eventBus';
import { useToast } from '../common/ToastProvider';
import { BackupSheet } from './backup/BackupSheet';
import { RestoreSheet } from './backup/RestoreSheet';
import { triggerHaptic } from '../../lib/haptics';

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

  // Danger Zone Shutter & Confirmation States (C8)
  const [isDangerShutterOpen, setIsDangerShutterOpen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetInput, setResetInput] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [isProcessingDanger, setIsProcessingDanger] = useState(false);

  // Backup & Restore Sheet State
  const [showBackupSheet, setShowBackupSheet] = useState(false);
  const [showRestoreSheet, setShowRestoreSheet] = useState(false);

  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

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

  // Reset transient shutter & confirmation states whenever modal closes (C8)
  useEffect(() => {
    if (!isOpen) {
      setIsDangerShutterOpen(false);
      setShowLogoutConfirm(false);
      setShowResetConfirm(false);
      setShowDeleteConfirm(false);
      setResetInput('');
      setDeleteInput('');
      setIsEditingName(false);
      setIsEditingEmail(false);
    }
  }, [isOpen]);

  const handleCloseModal = useCallback(() => {
    setIsDangerShutterOpen(false);
    setShowLogoutConfirm(false);
    setShowResetConfirm(false);
    setShowDeleteConfirm(false);
    onClose();
  }, [onClose]);

  // Modal Scroll Lock, Focus Restoration & Escape Handling
  useEffect(() => {
    if (!isOpen) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        previousFocusRef.current?.focus();
        previousFocusRef.current = null;
      }
      return;
    }

    wasOpenRef.current = true;
    previousFocusRef.current =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => {
      closeBtnRef.current?.focus();
    }, 20);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Let BackupSheet / RestoreSheet handle their own Escape when open
      if (showBackupSheet || showRestoreSheet) return;

      e.preventDefault();
      if (showDeleteConfirm) {
        setShowDeleteConfirm(false);
        setDeleteInput('');
        return;
      }
      if (showResetConfirm) {
        setShowResetConfirm(false);
        setResetInput('');
        return;
      }
      if (showLogoutConfirm) {
        setShowLogoutConfirm(false);
        return;
      }
      handleCloseModal();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [
    isOpen,
    showBackupSheet,
    showRestoreSheet,
    showDeleteConfirm,
    showResetConfirm,
    showLogoutConfirm,
    handleCloseModal,
  ]);

  if (!isOpen) return null;

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
      const { data, error } = await supabase.rpc('org_change_password', {
        p_org_id: organization.org_id,
        p_old: currentPassword.trim(),
        p_new: newPassword.trim(),
      });
      if (error) throw error;
      const res = data as any;
      if (!res || !res.ok) {
        const errCode = res?.error || res?.reason;
        if (errCode === 'too_many_attempts') {
          showToast('Too many attempts. Try again in 15 minutes.');
          return;
        }
        if (errCode === 'weak_password') {
          showToast('New password is too short (minimum 6 characters).');
          return;
        }
        showToast('Current password is wrong.');
        return;
      }
      showToast('Master password updated.');
      onPasswordChanged?.();
      setIsUpdatingPassword(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('too_many_attempts')) {
        showToast('Too many attempts. Try again in 15 minutes.');
      } else if (msg.includes('invalid') || msg.includes('wrong')) {
        showToast('Current password is wrong.');
      } else {
        showToast(`Password update failed: ${msg || 'Error'}`);
      }
    } finally {
      setIsSavingPassword(false);
    }
  };

  // Danger Zone: Reset Data
  const handleExecuteReset = async () => {
    if (resetInput.trim().toUpperCase() !== 'RESET') {
      showToast("Type 'RESET' to confirm.");
      return;
    }
    setIsProcessingDanger(true);
    try {
      await dbService.resetOrganizationData(organization.org_id);
      setShowResetConfirm(false);
      setResetInput('');
      setIsDangerShutterOpen(false);
      showToast('All competition data wiped.');
    } catch (err: any) {
      if (err?.code === 'ROSTER_LOCKED' || err?.message?.includes('ROSTER_LOCKED')) {
        showToast('Unlock your events first.');
      } else {
        showToast(`Reset failed: ${err.message}`);
      }
    } finally {
      setIsProcessingDanger(false);
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

  const modalContent = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="account-modal-title"
    >
      {/* Solid dark scrim — no backdrop-filter (C1) */}
      <div
        onClick={handleCloseModal}
        className="fixed inset-0 bg-black/60 transition-opacity duration-200 motion-reduce:transition-none"
      />

      {/* Modal Dialog matching Settings Sheet tokens (C1) */}
      <div className="relative w-full max-w-lg bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-white border border-stone-200 dark:border-zinc-800 rounded-3xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-spring-sheet select-none">
        {/* Modal Header */}
        <div className="px-5 py-4 shrink-0 flex items-center justify-between border-b border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
          <div className="flex items-center space-x-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center justify-center shrink-0">
              <User className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center space-x-1.5">
                <h2
                  id="account-modal-title"
                  className="text-base font-bold text-zinc-900 dark:text-white leading-tight"
                >
                  Account &amp; Security
                </h2>
                {verificationStatus === 'verified' && (
                  <span title="Verified Organization" className="inline-flex">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-500 font-mono truncate">
                {organization.name}
              </p>
            </div>
          </div>

          <button
            ref={closeBtnRef}
            type="button"
            onClick={handleCloseModal}
            className="w-11 h-11 flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-white rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 transition-colors cursor-pointer shrink-0"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body: Solid Inset Grouped Cards */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1 bg-stone-100 dark:bg-black overscroll-contain pb-16">
          {/* ======================================================== */}
          {/* TOP: SIGN OUT ATTACHED TO ORGANIZATION IDENTITY (C2)     */}
          {/* ======================================================== */}
          <div className="mt-2 bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
            {/* Attached Sign Out Row at Very Top (C2) */}
            <button
              type="button"
              onClick={() => {
                triggerHaptic('tick');
                setShowLogoutConfirm(true);
              }}
              className="w-full min-h-[48px] px-4 py-3 flex items-center justify-between text-left bg-red-500/10 hover:bg-red-500/20 dark:bg-red-500/10 dark:hover:bg-red-500/20 border border-red-500/40 rounded-t-2xl transition-colors cursor-pointer group"
            >
              <span className="text-sm font-bold text-red-600 dark:text-red-400">
                Sign out
              </span>
              <LogOut className="w-4 h-4 text-red-600 dark:text-red-400 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
            </button>

            {/* Organization Identity Section Header (attached directly below Sign Out) */}
            <div className="px-4 py-2 bg-stone-50 dark:bg-zinc-900/60">
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                Organization Identity
              </h4>
            </div>

            {/* Row 1: Organization Name — pencil to the right, NO "Host Entity" (C3) */}
            <div className="p-4 space-y-2">
              {!isEditingName ? (
                <div className="space-y-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 block">
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
                      <Pencil className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleSaveName} className="space-y-3 pt-1 animate-in fade-in duration-150">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
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
                      className="min-h-[44px] px-3 bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-semibold rounded-xl transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSavingName || !editName.trim()}
                      className="min-h-[44px] px-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition-colors shadow-sm flex items-center justify-center space-x-1.5 cursor-pointer"
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
                      <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
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
                      <Pencil className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                    </button>
                  </div>

                  <p className="text-sm font-semibold font-mono text-zinc-800 dark:text-zinc-200 break-all">
                    {organization.email || (
                      <span className="text-zinc-400 italic">No email configured</span>
                    )}
                  </p>

                  {/* Pending Verification Info Note */}
                  {verificationStatus === 'pending' && (
                    <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed flex items-start space-x-2 mt-2">
                      <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                      <span>
                        Your organization and email are currently under manual review by the Security Team. Unverified or invalid accounts may be removed if rejected.
                      </span>
                    </div>
                  )}

                  {/* Rejected Verification Alert with Developer Contact & Telegram */}
                  {verificationStatus === 'rejected' && (
                    <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 space-y-2.5 mt-2">
                      <div className="flex items-start space-x-2 text-xs text-red-600 dark:text-red-400 font-semibold leading-relaxed">
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
                          className="inline-flex items-center space-x-1.5 min-h-[44px] px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-red-500/30 text-[11px] font-mono font-bold text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <Mail className="w-3.5 h-3.5" />
                          <span>spesium.code@proton.me</span>
                        </a>
                        <a
                          href="https://t.me/+ljTOKLi5dQs1MTM9"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center space-x-1.5 min-h-[44px] px-3 py-1.5 rounded-lg bg-blue-500/15 border border-blue-500/30 text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:bg-blue-500/25 transition-colors"
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
                    <span className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
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
                      className="min-h-[44px] px-3 bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-semibold rounded-xl transition-colors cursor-pointer"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSavingEmail || !editEmail.trim()}
                      className="min-h-[44px] px-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition-colors shadow-sm flex items-center justify-center space-x-1.5 cursor-pointer"
                    >
                      {isSavingEmail ? <span>Saving...</span> : <span>Save Email</span>}
                    </button>
                  </div>
                </form>
              )}
            </div>

            {/* Row 3: Organization Code — one line, code on right, NO "Jury Login Key" (C5) */}
            <div className="p-4 flex items-center justify-between gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 shrink-0">
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
                    <Copy className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* ======================================================== */}
          {/* CARD 2: SECURITY — ROSE "Change password" BTN (C6)       */}
          {/* ======================================================== */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Password
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm p-4">
              <button
                type="button"
                onClick={() => setIsUpdatingPassword(!isUpdatingPassword)}
                className={`w-full min-h-[44px] px-4 rounded-xl text-xs font-bold transition-colors cursor-pointer flex items-center justify-center space-x-2 ${
                  isUpdatingPassword
                    ? 'bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 border border-stone-200 dark:border-zinc-800'
                    : 'bg-rose-600 hover:bg-rose-500 text-white shadow-sm'
                }`}
              >
                <Lock className="w-3.5 h-3.5" />
                <span>{isUpdatingPassword ? 'Cancel' : 'Change password'}</span>
              </button>

              {/* Password Update Form (Inline Expandable) */}
              {isUpdatingPassword && (
                <form onSubmit={handleSavePassword} className="mt-3 pt-3 border-t border-stone-100 dark:border-zinc-800/60 space-y-2.5 animate-in fade-in duration-150">
                  {mustChangePassword && (
                    <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] font-medium text-amber-700 dark:text-amber-300 flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                      <span>Temporary password active — please set a new master password now.</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                      New Password
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="min-h-[44px] px-2 text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 flex items-center space-x-1 cursor-pointer"
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
                    className="w-full min-h-[44px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-amber-500"
                  />

                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="New password (minimum 6 characters)"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    className="w-full min-h-[44px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-amber-500"
                  />

                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    className="w-full min-h-[44px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-amber-500"
                  />

                  <button
                    type="submit"
                    disabled={isSavingPassword || !currentPassword || !newPassword || newPassword !== confirmPassword}
                    className="w-full min-h-[44px] bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition-colors active:scale-[0.98] motion-reduce:transition-none cursor-pointer shadow-sm flex items-center justify-center space-x-1.5"
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
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Backup &amp; Restore
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm p-3.5">
              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setShowBackupSheet(true)}
                  className="min-h-[44px] px-3.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold transition-colors cursor-pointer flex items-center justify-center space-x-1.5 shadow-sm"
                >
                  <Download className="w-4 h-4" />
                  <span>Backup</span>
                </button>

                <button
                  type="button"
                  onClick={() => setShowRestoreSheet(true)}
                  className="min-h-[44px] px-3.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs font-bold transition-colors cursor-pointer flex items-center justify-center space-x-1.5 shadow-sm"
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
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              About &amp; Support
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              {/* Brand Anchor */}
              <div className="p-4 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-500 flex items-center justify-center shadow-sm">
                    <Scale className="w-5 h-5 stroke-[2.2]" />
                  </div>
                  <div>
                    <span className="text-sm font-bold text-zinc-900 dark:text-white block font-mono">
                      Fair Judge
                    </span>
                    <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">
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
                    <span className="text-xs font-bold text-zinc-900 dark:text-white block group-hover:text-blue-500 dark:group-hover:text-blue-400 transition-colors">
                      Join our Telegram Community
                    </span>
                    <span className="text-[10px] text-zinc-500">
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
                    <span className="text-xs font-bold text-zinc-900 dark:text-white block group-hover:text-amber-500 dark:group-hover:text-amber-400 transition-colors">
                      Support the Developer
                    </span>
                    <span className="text-[10px] text-zinc-500">
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
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-red-600/80 dark:text-red-400/80 ml-4 mb-2 mt-6">
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
                <span className="inline-flex items-center gap-1 text-[10px] font-mono font-bold uppercase tracking-wider text-red-600 dark:text-red-400">
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
                    onClick={() => setShowResetConfirm(true)}
                    className="w-full min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:pointer-events-none text-white text-xs font-bold transition-colors cursor-pointer flex items-center justify-center space-x-2 shadow-sm"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Reset Data</span>
                  </button>

                  <button
                    type="button"
                    disabled={!isDangerShutterOpen}
                    tabIndex={isDangerShutterOpen ? 0 : -1}
                    onClick={() => setShowDeleteConfirm(true)}
                    className="w-full min-h-[44px] px-4 rounded-xl bg-red-600 hover:bg-red-500 disabled:pointer-events-none text-white text-xs font-bold transition-colors cursor-pointer flex items-center justify-center space-x-2 shadow-sm"
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
                  <div className="px-3 py-1.5 rounded-xl bg-white dark:bg-zinc-950 border border-red-200 dark:border-red-900/60 shadow-sm flex items-center gap-1.5 text-[11px] font-mono font-bold text-red-600 dark:text-red-400">
                    <Lock className="w-3.5 h-3.5" />
                    <span>Protected</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Static Developer Signature Footer (zero infinite animations) */}
          <div className="text-[10px] uppercase tracking-widest text-zinc-600 dark:text-zinc-400 text-center pb-4 pt-6 select-none">
            Engineered with Intent{' '}
            <span className="text-emerald-600 dark:text-emerald-400 font-mono font-bold mx-1">
              &lt;/&gt;
            </span>{' '}
            <span className="text-zinc-800 dark:text-zinc-200 font-semibold">
              Sahil Kumar Rout
            </span>
          </div>
        </div>
      </div>

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
                <p className="text-xs text-zinc-500 dark:text-zinc-400 font-mono">
                  {organization.name}
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Sign out of this organisation account on this device? Any unsynced changes remain queued locally.
            </p>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(false)}
                className="min-h-[44px] bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-bold rounded-xl border border-stone-200 dark:border-zinc-800 transition-colors cursor-pointer"
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
                className="min-h-[44px] bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-red-600/25 transition-colors cursor-pointer flex items-center justify-center space-x-1.5"
              >
                <LogOut className="w-4 h-4" />
                <span>Sign out</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Centered Confirmation Modal: Reset Data */}
      {showResetConfirm && (
        <div
          className="fixed inset-0 z-[120] bg-black/80 flex items-center justify-center p-4 animate-in fade-in duration-150"
          role="dialog"
          aria-modal="true"
          aria-labelledby="reset-confirm-title"
        >
          <div className="bg-white dark:bg-zinc-950 border border-red-500/40 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95 duration-150">
            <div className="flex items-center space-x-3 text-red-600 dark:text-red-400">
              <div className="w-10 h-10 rounded-2xl bg-red-500/15 flex items-center justify-center">
                <RotateCcw className="w-5 h-5" />
              </div>
              <div>
                <h3
                  id="reset-confirm-title"
                  className="text-base font-bold text-zinc-900 dark:text-white leading-tight"
                >
                  Reset Account Data
                </h3>
                <p className="text-xs text-red-600 dark:text-red-400 font-mono">
                  Permanent data purge
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Permanently wipe all competition events, rosters, and scores for{' '}
              <strong className="text-zinc-900 dark:text-white">{organization.name}</strong>. Admin credentials remain active.
            </p>

            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider block">
                Type <span className="font-mono font-black text-red-600 dark:text-red-400">RESET</span> to confirm:
              </label>
              <input
                type="text"
                autoFocus
                placeholder="RESET"
                value={resetInput}
                onChange={(e) => setResetInput(e.target.value)}
                className="w-full min-h-[44px] px-3.5 bg-stone-100 dark:bg-zinc-900 border border-red-500/40 rounded-xl font-mono text-sm text-center uppercase tracking-widest text-zinc-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-red-500/50"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  setShowResetConfirm(false);
                  setResetInput('');
                }}
                className="min-h-[44px] bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-bold rounded-xl transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteReset}
                disabled={resetInput.trim().toUpperCase() !== 'RESET' || isProcessingDanger}
                className="min-h-[44px] bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs font-bold rounded-xl shadow-lg shadow-red-600/25 transition-colors cursor-pointer flex items-center justify-center space-x-1.5"
              >
                {isProcessingDanger ? <span>Wiping...</span> : <span>Confirm Reset</span>}
              </button>
            </div>
          </div>
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
                <p className="text-xs text-red-600 dark:text-red-400 font-mono">
                  Irreversible deletion
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Completely delete{' '}
              <strong className="text-zinc-900 dark:text-white">{organization.name}</strong> along with all events, rosters, and ballots. This cannot be undone.
            </p>

            <div className="space-y-1.5">
              <label className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider block">
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
                className="min-h-[44px] bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-bold rounded-xl transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteDelete}
                disabled={deleteInput.trim().toUpperCase() !== 'DELETE' || isProcessingDanger}
                className="min-h-[44px] bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs font-bold rounded-xl shadow-lg shadow-red-600/25 transition-colors cursor-pointer flex items-center justify-center space-x-1.5"
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
        onRestoreComplete={() => {
          eventBus.emit('cache_updated', { table: 'all' });
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('fairjudge_session_change'));
          }
        }}
      />
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
}
