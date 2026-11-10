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
  ShieldCheck,
  Scale
} from 'lucide-react';
import { dbService } from '../../lib/supabase';
import { authService } from '../../lib/authService';
import { Organization } from '../../lib/supabaseTypes';
import { showToast, toast } from '../common/ToastProvider';
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

  // Password entropy analysis for registration
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
        // Pre-flight check & strict INSERT via zero-trust authService
        const createdOrg = await authService.registerOrganiser(
          cleanName,
          cleanEmail || undefined,
          cleanPassword
        );

        showToast(`Organisation "${createdOrg.name}" registered successfully!`, 'success');
        onOrganiserLogin(createdOrg);
      } catch (err: any) {
        console.warn('Registration attempt notice:', err?.message || err);
        const msg = err.message?.includes('Registration Failed')
          ? err.message
          : sanitizeAuthError(err);
        setErrorMessage(msg);
        showToast(msg, 'error');
      } finally {
        setIsSubmitting(false);
      }
    } else {
      // Login mode: Strict SELECT query matching org_id/email AND password
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
        // Strict read-only login validation via authService (no auto-registration fallback)
        const org = await authService.loginOrganiser(identifier, password);

        onOrganiserLogin(org);
      } catch (err: any) {
        console.warn('Login attempt notice:', err?.message || err);
        const msg = err.message?.includes('Invalid Organization ID')
          ? err.message
          : 'Invalid Organization ID or Master Password.';
        setErrorMessage(msg);
        showToast(msg, 'error');
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <div className="w-full max-w-md mx-auto bg-zinc-900 border border-zinc-800 border-t-white/5 rounded-3xl p-6 md:p-8 shadow-2xl shadow-black/80 relative animate-in fade-in zoom-in-95 duration-200">
      {/* Floating Glassmorphic Back Button */}
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to role selection"
        className="w-10 h-10 rounded-full bg-zinc-900 border border-zinc-800 border-t-white/5 hover:bg-zinc-800 transition-colors absolute left-4 top-4 flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer active:scale-95 shadow-lg z-20"
      >
        <ChevronLeft className="w-5 h-5" />
      </button>

      {/* Persistent Shrinked App Logo & Centered Header Anchor */}
      <div className="flex flex-col items-center justify-center text-center mb-6 pt-1">
        <div className="w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center mb-1.5 shadow-sm shadow-emerald-500/10">
          <ShieldCheck className="w-5 h-5 stroke-[2.2]" />
        </div>
        <h1 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
          Organiser Portal
        </h1>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">
          Fair Judge
        </span>
      </div>

      {/* The Segmented Toggle: Premium pill container */}
      <div className="bg-zinc-900 p-1 rounded-xl flex mb-6 border border-zinc-800/80 border-t-white/5">
        <button
          type="button"
          onClick={() => {
            setAuthMode('login');
            setErrorMessage('');
          }}
          className={`flex-1 py-2 text-xs font-bold transition-all rounded-lg flex items-center justify-center cursor-pointer ${
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
          className={`flex-1 py-2 text-xs font-bold transition-all rounded-lg flex items-center justify-center cursor-pointer ${
            authMode === 'register'
              ? 'bg-zinc-800 text-emerald-400 shadow-md border border-zinc-700/60'
              : 'text-zinc-400 hover:text-white'
          }`}
        >
          Register
        </button>
      </div>

      {/* Forms with Industry-Standard Linear/Vercel Aesthetic */}
      <form onSubmit={handleSubmit} className="space-y-4">
        {authMode === 'register' ? (
          <>
            {/* Org Name */}
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1.5">
                Organisation / Event Name
              </label>
              <div className="bg-zinc-950 border border-zinc-800 focus-within:border-emerald-500/50 focus-within:ring-1 focus-within:ring-emerald-500/20 rounded-xl px-3.5 h-11 flex items-center gap-2.5 transition-all">
                <Building2 className="w-4 h-4 text-zinc-500 shrink-0" />
                <input
                  type="text"
                  placeholder="e.g. State Science Fair"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  required
                  disabled={isSubmitting}
                  className="bg-transparent text-sm font-medium text-white placeholder-zinc-600 outline-none w-full"
                />
              </div>
            </div>

            {/* Admin Email */}
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1.5">
                Admin Email Address
              </label>
              <div className="bg-zinc-950 border border-zinc-800 focus-within:border-emerald-500/50 focus-within:ring-1 focus-within:ring-emerald-500/20 rounded-xl px-3.5 h-11 flex items-center gap-2.5 transition-all">
                <Mail className="w-4 h-4 text-zinc-500 shrink-0" />
                <input
                  type="email"
                  placeholder="admin@organisation.org"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  disabled={isSubmitting}
                  className="bg-transparent text-sm font-medium text-white placeholder-zinc-600 outline-none w-full"
                />
              </div>
            </div>

            {/* Master Password */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                  Master Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowAdminPassword(!showAdminPassword)}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1 cursor-pointer transition-colors"
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
              <div className="bg-zinc-950 border border-zinc-800 focus-within:border-emerald-500/50 focus-within:ring-1 focus-within:ring-emerald-500/20 rounded-xl px-3.5 h-11 flex items-center gap-2.5 transition-all">
                <KeyRound className="w-4 h-4 text-zinc-500 shrink-0" />
                <input
                  type={showAdminPassword ? 'text' : 'password'}
                  placeholder="Minimum 6 characters"
                  value={adminPassword}
                  onChange={(e) => setAdminPassword(e.target.value)}
                  required
                  disabled={isSubmitting}
                  className="bg-transparent text-sm font-medium text-white placeholder-zinc-600 outline-none w-full"
                />
              </div>

              {/* Entropy Meter */}
              {adminPassword && (
                <div className="mt-2 space-y-1">
                  <div className="h-1 w-full bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 ${getEntropyBar().color}`}
                      style={{ width: getEntropyBar().width }}
                    />
                  </div>
                  <div className="flex justify-between items-center text-[10px] font-mono text-zinc-500">
                    <span>Security Strength</span>
                    <span className="font-semibold text-zinc-400">{getEntropyBar().label}</span>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Login Identifier */}
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1.5">
                Organisation ID or Email
              </label>
              <div className="bg-zinc-950 border border-zinc-800 focus-within:border-emerald-500/50 focus-within:ring-1 focus-within:ring-emerald-500/20 rounded-xl px-3.5 h-11 flex items-center gap-2.5 transition-all">
                <Building2 className="w-4 h-4 text-zinc-500 shrink-0" />
                <input
                  type="text"
                  placeholder="e.g. FJ-ORG-9102 or admin@event.com"
                  value={loginIdentifier}
                  onChange={(e) => setLoginIdentifier(e.target.value)}
                  required
                  disabled={isSubmitting}
                  className="bg-transparent text-sm font-medium text-white placeholder-zinc-600 outline-none w-full"
                />
              </div>
            </div>

            {/* Login Password */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
                  Master Password
                </label>
                <button
                  type="button"
                  onClick={() => setShowLoginPassword(!showLoginPassword)}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 flex items-center gap-1 cursor-pointer transition-colors"
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
              <div className="bg-zinc-950 border border-zinc-800 focus-within:border-emerald-500/50 focus-within:ring-1 focus-within:ring-emerald-500/20 rounded-xl px-3.5 h-11 flex items-center gap-2.5 transition-all">
                <KeyRound className="w-4 h-4 text-zinc-500 shrink-0" />
                <input
                  type={showLoginPassword ? 'text' : 'password'}
                  placeholder="Enter your master password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  required
                  disabled={isSubmitting}
                  className="bg-transparent text-sm font-medium text-white placeholder-zinc-600 outline-none w-full"
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
          className="w-full h-11 bg-emerald-500 hover:bg-emerald-400 active:scale-[0.99] text-black font-bold text-xs uppercase tracking-wider rounded-xl transition-all shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed mt-2"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-black" />
              <span>{authMode === 'register' ? 'Registering Organisation...' : 'Signing In...'}</span>
            </>
          ) : (
            <>
              <span>{authMode === 'register' ? 'Create Organisation' : 'Access Command Center'}</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>

        {authMode === 'register' && (
          <p className="text-[10px] text-zinc-500 text-center flex items-center justify-center gap-1.5 pt-1">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
            <span>Master credentials protect event deletion and roster actions.</span>
          </p>
        )}
      </form>
    </div>
  );
}
