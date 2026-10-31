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
  Mail
} from 'lucide-react';
import { Organization } from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';

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
  const [modalToast, setModalToast] = useState<string | null>(null);

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

  const showToast = (msg: string) => {
    setModalToast(msg);
    setTimeout(() => setModalToast(null), 2500);
  };

  const handleCopyOrgId = () => {
    navigator.clipboard.writeText(organization.org_id);
    setCopiedOrgId(true);
    showToast('Org ID copied.');
    setTimeout(() => setCopiedOrgId(false), 2000);
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
      const updated = await dbService.updateOrganization(organization.org_id, {
        password: newPassword,
      });
      onUpdateOrganization(updated);
      showToast('Master password updated.');
      setIsUpdatingPassword(false);
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      showToast(`Password update failed: ${err.message || 'Error'}`);
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
      showToast(`Reset failed: ${err.message}`);
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
      showToast(`Delete failed: ${err.message}`);
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
      <div className="relative w-full max-w-lg bg-stone-100/50 dark:bg-black text-zinc-900 dark:text-white border border-stone-200 dark:border-zinc-800 rounded-3xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden animate-in fade-in zoom-in-95 duration-200 select-none">
        
        {/* Toast inside Modal */}
        {modalToast && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 w-11/12 max-w-xs pointer-events-none animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="py-2 px-3.5 rounded-full bg-zinc-900/95 dark:bg-zinc-800/95 text-white border border-zinc-700/80 shadow-xl backdrop-blur-md flex items-center justify-center space-x-2 text-xs font-medium">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="truncate">{modalToast}</span>
            </div>
          </div>
        )}

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
                      className="self-start sm:self-center min-h-[38px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 text-xs font-semibold border border-stone-200 dark:border-zinc-800 transition-all flex items-center space-x-1.5 cursor-pointer shrink-0"
                    >
                      <Pencil className="w-3.5 h-3.5 text-zinc-500" />
                      <span>Edit Name</span>
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
                        className="self-start sm:self-center min-h-[38px] px-3.5 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-800 dark:text-zinc-200 text-xs font-semibold border border-stone-200 dark:border-zinc-800 transition-all flex items-center space-x-1.5 cursor-pointer shrink-0"
                      >
                        <Pencil className="w-3.5 h-3.5 text-zinc-500" />
                        <span>{organization.email ? 'Update Email' : 'Add Email'}</span>
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
                    className="min-h-[38px] px-3 rounded-xl bg-stone-100 dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white border border-stone-200 dark:border-zinc-800 flex items-center space-x-1.5 transition-all cursor-pointer font-semibold text-xs"
                    title="Copy Org ID"
                  >
                    {copiedOrgId ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-500" />
                        <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5 text-zinc-400" />
                        <span>Copy</span>
                      </>
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
                      disabled={isSavingPassword || !newPassword || newPassword !== confirmPassword}
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
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : modalContent;
}
