import React, { useState } from 'react';
import zxcvbn from 'zxcvbn';
import { 
  Building2, 
  KeyRound, 
  Mail, 
  ArrowRight, 
  Loader2, 
  AlertCircle, 
  Eye, 
  EyeOff, 
  ChevronLeft,
  ShieldCheck
} from 'lucide-react';
import { dbService } from '../../lib/supabase';
import { Organization } from '../../lib/supabaseTypes';
import { showToast } from '../common/ToastProvider';
import { sanitizeAuthError } from './authSanitizer';

interface OrganiserAuthProps {
  onOrganiserLogin: (org: Organization) => void;
  onBack: () => void;
}

export function OrganiserAuth({ onOrganiserLogin, onBack }: OrganiserAuthProps) {
  // Mode: 'login' | 'register'
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  // Form Fields
  const [orgName, setOrgName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [showAdminPassword, setShowAdminPassword] = useState(false);

  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  // States
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Password entropy analysis
  const passwordResult = adminPassword ? zxcvbn(adminPassword) : null;
  const passwordScore = passwordResult ? passwordResult.score : 0;

  const getEntropyBar = () => {
    if (!adminPassword) return { width: '0%', color: 'bg-zinc-800', label: '' };
    if (passwordScore <= 1) return { width: '25%', color: 'bg-red-500', label: 'Weak' };
    if (passwordScore === 2) return { width: '50%', color: 'bg-amber-500', label: 'Fair' };
    if (passwordScore === 3) return { width: '75%', color: 'bg-blue-500', label: 'Good' };
    return { width: '100%', color: 'bg-emerald-500 shadow-sm shadow-emerald-500/50', label: 'Strong' };
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage('');

    if (authMode === 'register') {
      const cleanName = orgName.trim();
      const cleanEmail = adminEmail.trim();
      const cleanPassword = adminPassword.trim();

      if (!cleanName) {
        setErrorMessage('Please enter an organisation or event name.');
        return;
      }
      if (!cleanPassword) {
        setErrorMessage('Please set a master password for your account.');
        return;
      }
      if (cleanPassword.length < 6) {
        setErrorMessage('Password must be at least 6 characters long.');
        return;
      }

      // Cloud-first network enforcement
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const netErr = 'Network Error: Unable to reach the database. Please check your connection.';
        setErrorMessage(netErr);
        showToast(netErr, 'error');
        return;
      }

      setIsSubmitting(true);
      try {
        const createdOrg = await dbService.createOrganization(
          cleanName,
          cleanEmail || undefined,
          cleanPassword
        );

        showToast(`Organisation "${createdOrg.name}" registered successfully!`, 'success');
        onOrganiserLogin(createdOrg);
      } catch (err: any) {
        console.error('Registration error intercepted:', err);
        // Directive 1: Strict Error Sanitization
        const sanitized = sanitizeAuthError(err);
        setErrorMessage(sanitized);
        showToast(sanitized, 'error');
        // Data Integrity: Do NOT push user to dashboard
      } finally {
        setIsSubmitting(false);
      }
    } else {
      // Login mode
      const identifier = loginIdentifier.trim();
      const password = loginPassword.trim();

      if (!identifier) {
        setErrorMessage('Please enter your Organisation ID or registered email.');
        return;
      }
      if (!password) {
        setErrorMessage('Please enter your master password.');
        return;
      }

      setIsSubmitting(true);
      try {
        const org = await dbService.getOrganizationByIdentifier(identifier);

        if (!org) {
          const notFound = `Account "${identifier}" not found. Verify Org ID or email.`;
          setErrorMessage(notFound);
          showToast(notFound, 'error');
          setIsSubmitting(false);
          return;
        }

        const expectedPassword = org.password || 'password123';
        if (org.password && org.password !== password) {
          const passErr = 'Incorrect password. Please verify and try again.';
          setErrorMessage(passErr);
          showToast(passErr, 'error');
          setIsSubmitting(false);
          return;
        }

        showToast(`Welcome back, ${org.name}!`, 'success');
        onOrganiserLogin(org);
      } catch (err: any) {
        console.error('Login error intercepted:', err);
        // Directive 1: Strict Error Sanitization
        const sanitized = sanitizeAuthError(err);
        setErrorMessage(sanitized);
        showToast(sanitized, 'error');
        // Data Integrity: Do NOT push user to dashboard
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <div className="w-full max-w-md mx-auto bg-zinc-900/50 backdrop-blur-xl border border-zinc-800 rounded-3xl p-6 md:p-8 shadow-2xl shadow-black/80 relative animate-in fade-in zoom-in-95 duration-200">
      {/* Top Header with Back Button */}
      <div className="flex items-center justify-between pb-4 border-b border-zinc-800/80 mb-5">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs font-semibold text-zinc-400 hover:text-white transition-colors cursor-pointer"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>Role Selection</span>
        </button>
        <span className="text-[11px] font-mono uppercase tracking-wider text-emerald-400 font-bold flex items-center gap-1.5">
          <Building2 className="w-3.5 h-3.5" />
          <span>Organiser Portal</span>
        </span>
      </div>

      {/* Directive 3: Segmented Control - Single, premium pill-shaped toggle at top */}
      <div className="bg-zinc-900 border border-zinc-800 p-1 rounded-full flex mb-6">
        <button
          type="button"
          onClick={() => {
            setAuthMode('login');
            setErrorMessage('');
          }}
          className={`flex-1 py-2 text-xs font-bold transition-all rounded-full flex items-center justify-center cursor-pointer ${
            authMode === 'login'
              ? 'bg-zinc-800 text-emerald-400 shadow-md border border-zinc-700/60'
              : 'text-zinc-400 hover:text-white'
          }`}
        >
          Sign In
        </button>
        <button
          type="button"
          onClick={() => {
            setAuthMode('register');
            setErrorMessage('');
          }}
          className={`flex-1 py-2 text-xs font-bold transition-all rounded-full flex items-center justify-center cursor-pointer ${
            authMode === 'register'
              ? 'bg-zinc-800 text-emerald-400 shadow-md border border-zinc-700/60'
              : 'text-zinc-400 hover:text-white'
          }`}
        >
          Register New Org
        </button>
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {authMode === 'register' ? (
          <>
            {/* Org Name */}
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1.5">
                Organisation / Event Name
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                  <Building2 className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  placeholder="e.g. State Science Fair"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  required
                  disabled={isSubmitting}
                  className="w-full h-11 pl-10 pr-4 bg-zinc-900/80 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 transition-all rounded-xl text-sm font-medium text-white placeholder-zinc-500 outline-none disabled:opacity-50"
                />
              </div>
            </div>

            {/* Admin Email */}
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1.5">
                Admin Email Address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                  <Mail className="w-4 h-4" />
                </div>
                <input
                  type="email"
                  placeholder="admin@organisation.org"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  disabled={isSubmitting}
                  className="w-full h-11 pl-10 pr-4 bg-zinc-900/80 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 transition-all rounded-xl text-sm font-medium text-white placeholder-zinc-500 outline-none disabled:opacity-50"
                />
              </div>
            </div>

            {/* Master Password */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                  Master Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowAdminPassword(!showAdminPassword)}
                  className="text-[10px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 cursor-pointer"
                >
                  {showAdminPassword ? (
                    <>
                      <EyeOff className="w-3 h-3" />
                      <span>Hide</span>
                    </>
                  ) : (
                    <>
                      <Eye className="w-3 h-3" />
                      <span>Show</span>
                    </>
                  )}
                </button>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                  <KeyRound className="w-4 h-4" />
                </div>
                <input
                  type={showAdminPassword ? 'text' : 'password'}
                  placeholder="Minimum 6 characters"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  required
                  disabled={isSubmitting}
                  className="w-full h-11 pl-10 pr-4 bg-zinc-900/80 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 transition-all rounded-xl text-sm font-medium text-white placeholder-zinc-500 outline-none disabled:opacity-50"
                />
              </div>

              {/* Entropy Bar */}
              {adminPassword && (
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                    <span>Entropy Level</span>
                    <span className={passwordScore >= 3 ? 'text-emerald-400 font-bold' : 'text-zinc-400'}>
                      {getEntropyBar().label}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${getEntropyBar().color}`}
                      style={{ width: getEntropyBar().width }}
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="pt-1 flex items-start gap-2 text-[11px] text-zinc-400 leading-relaxed">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <span>
                Account registration connects to the cloud ledger for official accreditation.
              </span>
            </div>
          </>
        ) : (
          <>
            {/* Login Identifier */}
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1.5">
                Organisation ID or Email
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                  <Building2 className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  placeholder="e.g. FJ-9A2X or admin@state.org"
                  value={loginIdentifier}
                  onChange={(e) => setLoginIdentifier(e.target.value)}
                  required
                  disabled={isSubmitting}
                  className="w-full h-11 pl-10 pr-4 bg-zinc-900/80 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 transition-all rounded-xl text-sm font-medium text-white placeholder-zinc-500 outline-none disabled:opacity-50"
                />
              </div>
            </div>

            {/* Login Password */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
                  Master Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowLoginPassword(!showLoginPassword)}
                  className="text-[10px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1 cursor-pointer"
                >
                  {showLoginPassword ? (
                    <>
                      <EyeOff className="w-3 h-3" />
                      <span>Hide</span>
                    </>
                  ) : (
                    <>
                      <Eye className="w-3 h-3" />
                      <span>Show</span>
                    </>
                  )}
                </button>
              </div>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                  <KeyRound className="w-4 h-4" />
                </div>
                <input
                  type={showLoginPassword ? 'text' : 'password'}
                  placeholder="••••••••••••"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  required
                  disabled={isSubmitting}
                  className="w-full h-11 pl-10 pr-4 bg-zinc-900/80 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/50 transition-all rounded-xl text-sm font-medium text-white placeholder-zinc-500 outline-none disabled:opacity-50"
                />
              </div>
            </div>
          </>
        )}

        {/* Error Alert */}
        {errorMessage && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-start gap-2.5 animate-in fade-in duration-200">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
            <span className="leading-relaxed">{errorMessage}</span>
          </div>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full h-11 bg-emerald-600 hover:bg-emerald-500 active:scale-[0.99] text-white font-bold text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg shadow-emerald-600/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed mt-2"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-white" />
              <span>
                {authMode === 'register' ? 'Registering Organisation...' : 'Signing In...'}
              </span>
            </>
          ) : (
            <>
              <span>
                {authMode === 'register' ? 'Create & Launch Dashboard' : 'Enter Dashboard'}
              </span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}
