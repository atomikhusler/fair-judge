import React, { useState, useEffect } from 'react';
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
  Upload
} from 'lucide-react';
import { Organization } from '../../lib/supabaseTypes';
import { dbService, supabase } from '../../lib/supabase';
import { useToast } from '../common/ToastProvider';
import { BackupSheet } from './backup/BackupSheet';
import { RestoreSheet } from './backup/RestoreSheet';

interface AccountModalProps {
  isOpen: boolean;
  onClose: () => void;
  organization: Organization;
  onUpdateOrganization: (updated: Organization) => void;
  onLogout: () => void;
}

export function AccountModal({
  isOpen,
  onClose,
  organization,
  onUpdateOrganization,
  onLogout,
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

  // Danger Zone confirmation states
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetInput, setResetInput] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const [isProcessingDanger, setIsProcessingDanger] = useState(false);

  // Backup & Restore Sheet state
  const [showBackupSheet, setShowBackupSheet] = useState(false);
  const [showRestoreSheet, setShowRestoreSheet] = useState(false);

  const verificationStatus = organization.verification_status || 'pending';

  // Keep internal edit form synchronized with organization prop
  useEffect(() => {
    setEditName(organization.name);
    setEditEmail(organization.email || '');
  }, [organization]);

  // Modal Scroll Lock: lock background scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      const original = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = original;
      };
    }
  }, [isOpen]);

  if (!isOpen) return null;


  const handleCopyOrgId = () => {
    navigator.clipboard.writeText(organization.org_id);
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
      onClose();
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4">
      {/* Backdrop */}
      <div 
        onClick={onClose}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
      />

      {/* Modal Dialog */}
      <div className="relative w-full max-w-lg bg-stone-100/50 dark:bg-black text-zinc-900 dark:text-white border border-stone-200 dark:border-zinc-800 rounded-3xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-spring-sheet select-none">
        

        {/* Modal Header */}
        <div className="px-5 py-4 shrink-0 flex items-center justify-between border-b border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center justify-center">
              <User className="w-5 h-5 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center space-x-1.5">
                <h2 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                  Account &amp; Security
                </h2>
                {verificationStatus === 'verified' && (
                  <span title="Verified Organization" className="inline-flex">
                    <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                  </span>
                )}
              </div>
              <p className="text-[11px] text-zinc-500 font-mono">
                {organization.name}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="w-9 h-9 flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-white rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 transition-colors cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body: Inset Grouped Cards */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1 overscroll-contain pb-20">

          {/* ======================================================== */}
          {/* CARD 1: ORGANIZATION IDENTITY                            */}
          {/* ======================================================== */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-4">
              Organization Identity
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              
              {/* Row 1: Organization Name */}
              <div className="p-4 space-y-2">
                {!isEditingName ? (
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <div className="space-y-0.5 min-w-0 flex-1">
                      <div className="flex items-center space-x-2">
                        <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                          Organization Name
                        </span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold uppercase bg-stone-100 dark:bg-zinc-800 text-zinc-500">
                          Host Entity
                        </span>
                      </div>
                      <p className="text-sm sm:text-base font-bold text-zinc-900 dark:text-white break-words">
                        {organization.name}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setEditName(organization.name);
                        setIsEditingName(true);
                      }}
                      aria-label="Edit organisation name"
                      title="Edit organisation name"
                      className="w-8 h-8 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-stone-200 dark:border-zinc-800 flex items-center justify-center transition-all cursor-pointer shrink-0 relative before:content-[''] before:absolute before:-inset-1.5"
                    >
                      <Pencil className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                    </button>
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
                        className="min-h-[40px] px-3 bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-semibold rounded-xl transition-all cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingName || !editName.trim()}
                        className="min-h-[40px] px-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition-all shadow-sm flex items-center justify-center space-x-1.5 cursor-pointer"
                      >
                        {isSavingName ? <span>Saving...</span> : <span>Save Name</span>}
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* Row 2: Organization Email ID + Verification Status */}
              <div className="p-4 space-y-2.5">
                {!isEditingEmail ? (
                  <div className="space-y-2.5">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                            Admin / Contact Email
                          </span>

                          {/* Dynamic Verification Badge */}
                          {verificationStatus === 'verified' && (
                            <span className="inline-flex items-center space-x-1 text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                              <CheckCircle2 className="w-3 h-3 stroke-[2.5]" />
                              <span>Verified</span>
                            </span>
                          )}
                          {verificationStatus === 'pending' && (
                            <span className="inline-flex items-center space-x-1 text-[10px] px-2 py-0.5 rounded-full font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                              <Clock className="w-3 h-3 stroke-[2.5]" />
                              <span>Under Verification</span>
                            </span>
                          )}
                          {verificationStatus === 'rejected' && (
                            <span className="inline-flex items-center space-x-1 text-[10px] px-2 py-0.5 rounded-full font-bold bg-red-500/15 text-red-600 dark:text-red-400 border border-red-500/30">
                              <XCircle className="w-3 h-3 stroke-[2.5]" />
                              <span>Verification Failed</span>
                            </span>
                          )}
                        </div>

                        <div className="flex items-center space-x-1.5">
                          <p className="text-sm font-semibold font-mono text-zinc-800 dark:text-zinc-200 break-all">
                            {organization.email || <span className="text-zinc-400 italic">No email configured</span>}
                          </p>
                          {verificationStatus === 'verified' && organization.email && (
                            <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                          )}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          setEditEmail(organization.email || '');
                          setIsEditingEmail(true);
                        }}
                        aria-label={organization.email ? 'Update contact email' : 'Add contact email'}
                        title={organization.email ? 'Update contact email' : 'Add contact email'}
                        className="w-8 h-8 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 border border-stone-200 dark:border-zinc-800 flex items-center justify-center transition-all cursor-pointer shrink-0 relative before:content-[''] before:absolute before:-inset-1.5"
                      >
                        <Mail className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                      </button>
                    </div>

                    {/* Pending Verification Info Note */}
                    {verificationStatus === 'pending' && (
                      <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed flex items-start space-x-2">
                        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                        <span>
                          Your organization and email are currently under manual review by the Security Team. Unverified or invalid accounts may be removed if rejected.
                        </span>
                      </div>
                    )}

                    {/* Rejected Verification Alert with Developer Contact & Telegram */}
                    {verificationStatus === 'rejected' && (
                      <div className="p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 space-y-2.5">
                        <div className="flex items-start space-x-2 text-xs text-red-600 dark:text-red-400 font-semibold leading-relaxed">
                          <XCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
                          <span>
                            Email verification failed. Please update your email or contact the Developer / Security Team immediately before account removal:
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 pt-0.5">
                          <a
                            href="mailto:spesium.code@proton.me"
                            className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-white dark:bg-zinc-900 border border-red-500/30 text-[11px] font-mono font-bold text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                          >
                            <Mail className="w-3.5 h-3.5" />
                            <span>spesium.code@proton.me</span>
                          </a>
                          <a
                            href="https://t.me/+ljTOKLi5dQs1MTM9"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-blue-500/15 border border-blue-500/30 text-[11px] font-bold text-blue-600 dark:text-blue-400 hover:bg-blue-500/25 transition-colors"
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
                        Update Contact Email
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
                        className="min-h-[40px] px-3 bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-semibold rounded-xl transition-all cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={isSavingEmail || !editEmail.trim()}
                        className="min-h-[40px] px-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition-all shadow-sm flex items-center justify-center space-x-1.5 cursor-pointer"
                      >
                        {isSavingEmail ? <span>Saving...</span> : <span>Save Email</span>}
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* Row 3: Organization Code (Unique Org ID) */}
              <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <div className="flex items-center space-x-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                      Organization Code
                    </span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded font-mono font-bold uppercase bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                      Jury Login Key
                    </span>
                  </div>
                </div>

                <div className="flex items-center space-x-2 shrink-0 self-start sm:self-center">
                  <span className="text-sm font-mono font-bold tracking-wider text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-xl border border-emerald-500/20">
                    {organization.org_id}
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyOrgId}
                    aria-label={copiedOrgId ? 'Copied organisation code' : 'Copy organisation code'}
                    title={copiedOrgId ? 'Copied' : 'Copy Org ID'}
                    className="w-8 h-8 rounded-xl bg-stone-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white border border-stone-200 dark:border-zinc-800 flex items-center justify-center transition-all cursor-pointer relative before:content-[''] before:absolute before:-inset-1.5"
                  >
                    {copiedOrgId ? (
                      <Check className="w-3.5 h-3.5 text-emerald-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* ======================================================== */}
          {/* CARD 2: SECURITY & SESSION                               */}
          {/* ======================================================== */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Security &amp; Session
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              {/* Row 1: Master Password Reset */}
              <div className="p-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="space-y-0.5 min-w-0 flex-1">
                    <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                      Master Password Reset
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsUpdatingPassword(!isUpdatingPassword)}
                    className="self-start sm:self-center min-h-[38px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 text-xs font-semibold border border-stone-200 dark:border-zinc-800 transition-all cursor-pointer"
                  >
                    {isUpdatingPassword ? 'Cancel' : 'Change Password'}
                  </button>
                </div>

                {/* Password Update Form (Inline Expandable) */}
                {isUpdatingPassword && (
                  <form onSubmit={handleSavePassword} className="mt-3 pt-3 border-t border-stone-100 dark:border-zinc-800/60 space-y-2.5 animate-in fade-in duration-150">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                        New Master Password
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 flex items-center space-x-1 cursor-pointer"
                      >
                        {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                        <span>{showPassword ? 'Hide' : 'Show'}</span>
                      </button>
                    </div>

                    <input
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Current master password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      required
                      className="w-full min-h-[42px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500"
                    />

                    <input
                      type={showPassword ? 'text' : 'password'}
                      placeholder="New password (minimum 6 characters)"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      required
                      className="w-full min-h-[42px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500"
                    />

                    <input
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Confirm new password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      className="w-full min-h-[42px] px-3.5 bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-900 dark:text-white focus:outline-none focus:border-emerald-500"
                    />

                    <button
                      type="submit"
                      disabled={isSavingPassword || !currentPassword || !newPassword || newPassword !== confirmPassword}
                      className="w-full min-h-[42px] bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold rounded-xl transition-all active:scale-[0.98] cursor-pointer shadow-sm flex items-center justify-center space-x-1.5"
                    >
                      <Lock className="w-3.5 h-3.5" />
                      <span>{isSavingPassword ? 'Saving Password...' : 'Save New Password'}</span>
                    </button>
                  </form>
                )}
              </div>

              {/* Row 2: Sign Out */}
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onLogout();
                }}
                className="w-full p-4 flex items-center justify-between text-left hover:bg-red-50/50 dark:hover:bg-red-500/5 transition-colors cursor-pointer group"
              >
                <div className="space-y-0.5">
                  <span className="text-sm font-bold text-red-600 dark:text-red-500 block">
                    Sign Out
                  </span>
                </div>
                <LogOut className="w-4 h-4 text-red-600 dark:text-red-500 group-hover:translate-x-0.5 transition-transform" />
              </button>
            </div>
          </div>

          {/* ======================================================== */}
          {/* CARD: BACKUP & RESTORE (Epic 15.7 Stage C)                */}
          {/* ======================================================== */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-zinc-500 ml-4 mb-2 mt-6">
              Backup &amp; Restore
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-stone-200 dark:border-zinc-800 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60">
              {/* Row 1: Create Backup */}
              <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Create Backup
                  </span>
                  <span className="text-[11px] text-zinc-500 block">
                    Export competition data to an encrypted or plain JSON archive
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowBackupSheet(true)}
                  className="self-start sm:self-center min-h-[38px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 text-xs font-semibold border border-stone-200 dark:border-zinc-800 transition-all cursor-pointer flex items-center space-x-1.5 shrink-0"
                >
                  <Download className="w-3.5 h-3.5 text-zinc-500" />
                  <span>Download Backup</span>
                </button>
              </div>

              {/* Row 2: Restore Backup */}
              <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Restore Data
                  </span>
                  <span className="text-[11px] text-zinc-500 block">
                    Atomic restore with dry-run impact simulation and locked event immunity
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowRestoreSheet(true)}
                  className="self-start sm:self-center min-h-[38px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 text-xs font-semibold border border-stone-200 dark:border-zinc-800 transition-all cursor-pointer flex items-center space-x-1.5 shrink-0"
                >
                  <Upload className="w-3.5 h-3.5 text-zinc-500" />
                  <span>Restore Backup</span>
                </button>
              </div>
            </div>
          </div>

          {/* ======================================================== */}
          {/* SECTION: ABOUT & SUPPORT (Directive 3)                   */}
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

              {/* Actionable Glassmorphic Links */}
              {/* Telegram Community */}
              <a
                href="https://t.me/+ljTOKLi5dQs1MTM9"
                target="_blank"
                rel="noopener noreferrer"
                className="p-4 flex items-center justify-between hover:bg-stone-50 dark:hover:bg-zinc-900/40 transition-colors group cursor-pointer"
              >
                <div className="flex items-center space-x-3">
                  <div className="w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center group-hover:scale-105 transition-transform">
                    <MessageCircle className="w-4 h-4 text-blue-400" />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-zinc-900 dark:text-white block group-hover:text-blue-400 transition-colors">
                      Join our Telegram Community
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      Product updates, live support &amp; feedback
                    </span>
                  </div>
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-zinc-400 group-hover:text-blue-400 transition-colors" />
              </a>

              {/* Ko-fi Developer Support */}
              <a
                href="https://ko-fi.com/sahilkumarrout"
                target="_blank"
                rel="noopener noreferrer"
                className="p-4 flex items-center justify-between hover:bg-stone-50 dark:hover:bg-zinc-900/40 transition-colors group cursor-pointer"
              >
                <div className="flex items-center space-x-3">
                  <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-500 flex items-center justify-center group-hover:scale-105 transition-transform">
                    <Coffee className="w-4 h-4 text-amber-500" />
                  </div>
                  <div>
                    <span className="text-xs font-bold text-zinc-900 dark:text-white block group-hover:text-amber-400 transition-colors">
                      Support the Developer
                    </span>
                    <span className="text-[10px] text-zinc-500">
                      Fuel development via Ko-fi
                    </span>
                  </div>
                </div>
                <ExternalLink className="w-3.5 h-3.5 text-zinc-400 group-hover:text-amber-400 transition-colors" />
              </a>
            </div>
          </div>

          {/* ======================================================== */}
          {/* CARD 3: DANGER ZONE                                      */}
          {/* ======================================================== */}
          <div>
            <h4 className="text-[11px] font-bold uppercase tracking-wider text-red-600/80 dark:text-red-400/80 ml-4 mb-2 mt-6">
              Danger Zone
            </h4>
            <div className="bg-white dark:bg-zinc-950 rounded-2xl border border-red-200 dark:border-red-950 overflow-hidden shadow-sm divide-y divide-red-100 dark:divide-red-950/60">
              {/* Reset Data Row */}
              <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Reset Account Data
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowResetConfirm(true)}
                  className="self-start sm:self-center min-h-[38px] px-3.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-400 text-xs font-bold border border-red-500/20 transition-all cursor-pointer flex items-center space-x-1.5"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset Data</span>
                </button>
              </div>

              {/* Delete Account Row */}
              <div className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="space-y-0.5 min-w-0 flex-1">
                  <span className="text-sm font-semibold text-zinc-900 dark:text-white block">
                    Delete Organization
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(true)}
                  className="self-start sm:self-center min-h-[38px] px-3.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition-all cursor-pointer flex items-center space-x-1.5 shadow-sm"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Org</span>
                </button>
              </div>
            </div>
          </div>

          {/* Animated Developer Signature Footer */}
          <div className="text-[10px] uppercase tracking-widest text-zinc-600 dark:text-zinc-400 text-center pb-4 pt-6 select-none">
            Engineered with Intent <span className="animate-pulse bg-gradient-to-r from-emerald-500 to-emerald-300 bg-clip-text text-transparent font-mono font-bold mx-1">&lt;/&gt;</span> <span className="bg-gradient-to-r from-zinc-500 via-zinc-200 to-zinc-500 dark:from-zinc-400 dark:via-white dark:to-zinc-400 bg-clip-text text-transparent animate-shimmer">Sahil Kumar Rout</span>
          </div>

        </div>
      </div>

      {/* Floating Centered Confirmation Modal: Reset Data */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-zinc-950 border border-red-500/40 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-center space-x-3 text-red-600 dark:text-red-400">
              <div className="w-10 h-10 rounded-2xl bg-red-500/15 flex items-center justify-center">
                <RotateCcw className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                  Reset Account Data
                </h3>
                <p className="text-xs text-red-600 dark:text-red-400 font-mono">
                  Permanent data purge
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Permanently wipe all competition events, rosters, and scores for <strong className="text-zinc-900 dark:text-white">{organization.name}</strong>. Admin credentials remain active.
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
                className="min-h-[42px] bg-stone-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 text-xs font-bold rounded-xl active:scale-95 transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteReset}
                disabled={resetInput.trim().toUpperCase() !== 'RESET' || isProcessingDanger}
                className="min-h-[42px] bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs font-bold rounded-xl shadow-lg shadow-red-600/25 active:scale-95 transition-all cursor-pointer flex items-center justify-center space-x-1.5"
              >
                {isProcessingDanger ? <span>Wiping...</span> : <span>Confirm Reset</span>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Centered Confirmation Modal: Delete Account */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150">
          <div className="bg-white dark:bg-zinc-950 border border-red-500/50 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95">
            <div className="flex items-center space-x-3 text-red-600 dark:text-red-400">
              <div className="w-10 h-10 rounded-2xl bg-red-500/15 flex items-center justify-center">
                <Trash2 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                  Delete Organization
                </h3>
                <p className="text-xs text-red-600 dark:text-red-400 font-mono">
                  Irreversible deletion
                </p>
              </div>
            </div>

            <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
              Completely delete <strong className="text-zinc-900 dark:text-white">{organization.name}</strong> along with all events, rosters, and ballots. This cannot be undone.
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
                className="min-h-[42px] bg-stone-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 text-xs font-bold rounded-xl active:scale-95 transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleExecuteDelete}
                disabled={deleteInput.trim().toUpperCase() !== 'DELETE' || isProcessingDanger}
                className="min-h-[42px] bg-red-600 hover:bg-red-500 disabled:opacity-40 text-white text-xs font-bold rounded-xl shadow-lg shadow-red-600/25 active:scale-95 transition-all cursor-pointer flex items-center justify-center space-x-1.5"
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
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('fairjudge_session_change'));
          }
        }}
      />
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
}
