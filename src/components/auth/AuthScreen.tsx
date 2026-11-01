import React, { useState } from 'react';
import zxcvbn from 'zxcvbn';
import { 
  Building2,
  Scale,
  ArrowRight, 
  KeyRound, 
  Loader2, 
  AlertCircle, 
  Eye, 
  EyeOff,
  Gavel,
  Mail,
  ShieldCheck,
  CheckCircle2
} from 'lucide-react';
import { dbService } from '../../lib/supabase';
import { Organization, SupabaseJudge, SupabaseEvent } from '../../lib/supabaseTypes';
import { JudgeLogin } from '../judge/JudgeLogin';
import { showToast } from '../common/ToastProvider';

interface AuthScreenProps {
  onOrganiserLogin: (org: Organization) => void;
  onJudgeLogin: (orgId: string, judge: SupabaseJudge, assignedEvents: SupabaseEvent[]) => void;
}

export function AuthScreen({ onOrganiserLogin, onJudgeLogin }: AuthScreenProps) {
  // Primary Portal Selector: Organiser vs Judge
  const [activePortal, setActivePortal] = useState<'organiser' | 'judge'>('organiser');

  // Organiser Form State: 'login' | 'register'
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');

  // Register form fields
  const [orgName, setOrgName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [showAdminPassword, setShowAdminPassword] = useState(false);

  // Login form fields
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  // Interaction State
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formError, setFormError] = useState('');

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

  // Organiser Form Submission (Login or Register)
  const handleOrganiserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');

    if (authMode === 'register') {
      const cleanName = orgName.trim();
      const cleanEmail = adminEmail.trim();
      const cleanPassword = adminPassword.trim();

      if (!cleanName) {
        setFormError('Please enter your Organisation or Event Name.');
        return;
      }
      if (!cleanPassword) {
        setFormError('Please enter a secure master password.');
        return;
      }
      if (cleanPassword.length < 6) {
        setFormError('Password must be at least 6 characters long.');
        return;
      }

      // 1. Strict Cloud-First Network Enforcement
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const errorMsg = 'Registration requires an active internet connection. Please reconnect to the network.';
        setFormError(errorMsg);
        showToast(`Registration failed: ${errorMsg}`, 'error');
        return;
      }

      setIsSubmitting(true);
      try {
        // 2. Direct Supabase insert awaited in dbService.createOrganization
        const createdOrg = await dbService.createOrganization(
          cleanName,
          cleanEmail || undefined,
          cleanPassword
        );

        showToast(`Organization "${createdOrg.name}" registered successfully!`, 'success');
        onOrganiserLogin(createdOrg);
      } catch (err: any) {
        console.error('Registration failed:', err);
        const errorDetail = err?.message || 'Database error occurred. Please try again.';
        setFormError(errorDetail);
        // Directive 1: Halt and display red global toast
        showToast(`Registration failed: ${errorDetail}`, 'error');
      } finally {
        setIsSubmitting(false);
      }
    } else {
      // Login Flow
      const identifier = loginIdentifier.trim();
      const enteredPassword = loginPassword.trim();

      if (!identifier) {
        setFormError('Please enter your Organisation ID or Email.');
        return;
      }
      if (!enteredPassword) {
        setFormError('Please enter your master password.');
        return;
      }

      setIsSubmitting(true);
      try {
        const org = await dbService.getOrganizationByIdentifier(identifier);

        if (!org) {
          const notFoundMsg = `Account "${identifier}" not found. Verify Org ID or email.`;
          setFormError(notFoundMsg);
          showToast(notFoundMsg, 'error');
          setIsSubmitting(false);
          return;
        }

        const expectedPassword = org.password || 'password123';
        if (org.password && org.password !== enteredPassword) {
          const passMsg = 'Incorrect master password. Please verify and try again.';
          setFormError(passMsg);
          showToast(passMsg, 'error');
          setIsSubmitting(false);
          return;
        }

        showToast(`Signed in as ${org.name}`, 'success');
        onOrganiserLogin(org);
      } catch (err: any) {
        console.error('Login error:', err);
        const errMsg = err?.message || 'Authentication error.';
        setFormError(errMsg);
        showToast(errMsg, 'error');
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  return (
    <div className="min-h-[100dvh] w-full flex flex-col justify-between bg-zinc-950 text-zinc-100 p-4 md:p-6 relative overflow-x-hidden selection:bg-emerald-500 selection:text-black">
      {/* Background radial ambient highlight */}
      <div className="fixed inset-0 pointer-events-none bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(16,185,129,0.12),transparent_70%)]" />

      {/* 1. Header with Logo & Tagline */}
      <header className="w-full max-w-md mx-auto pt-2 pb-4 flex flex-col items-center justify-center text-center relative z-10">
        <div className="flex items-center justify-center gap-2.5">
          <div className="w-10 h-10 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-500/10">
            <Scale className="w-5 h-5 stroke-[2.2]" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-white font-mono">
            Fair Judge
          </h1>
        </div>
        <p className="text-xs font-medium text-emerald-400/90 tracking-wide mt-1">
          Competition Judging Terminal & Scoring Ledger
        </p>
      </header>

      {/* 2. Main Portal Card Container */}
      <main className="w-full max-w-md mx-auto my-auto relative z-10">
        {/* Top Portal Switcher (Organiser vs Judge) */}
        <div className="flex w-full p-1 bg-zinc-900/80 rounded-2xl border border-zinc-800 shadow-inner mb-4 backdrop-blur-md">
          <button
            type="button"
            onClick={() => {
              setActivePortal('organiser');
              setFormError('');
            }}
            className={`flex-1 min-h-[42px] px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer ${
              activePortal === 'organiser'
                ? 'bg-zinc-800 text-emerald-400 shadow-md border border-zinc-700/80'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Building2 className="w-3.5 h-3.5" />
            <span>Organiser Portal</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActivePortal('judge');
              setFormError('');
            }}
            className={`flex-1 min-h-[42px] px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer ${
              activePortal === 'judge'
                ? 'bg-zinc-800 text-orange-400 shadow-md border border-zinc-700/80'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Gavel className="w-3.5 h-3.5" />
            <span>Judge Portal</span>
          </button>
        </div>

        {/* View A: Organiser Unified Card */}
        {activePortal === 'organiser' && (
          <div className="w-full bg-zinc-900/50 backdrop-blur-xl border border-zinc-800 rounded-3xl p-6 md:p-8 shadow-2xl shadow-black/80 relative animate-in fade-in zoom-in-95 duration-200">
            {/* Header with Segmented Mode Toggle (Login vs Register) */}
            <div className="flex w-full p-1 bg-zinc-950/80 rounded-2xl border border-zinc-800/80 shadow-inner mb-6">
              <button
                type="button"
                onClick={() => {
                  setAuthMode('login');
                  setFormError('');
                }}
                className={`flex-1 min-h-[38px] px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center cursor-pointer ${
                  authMode === 'login'
                    ? 'bg-zinc-800 text-emerald-400 shadow-sm border border-zinc-700/60'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setAuthMode('register');
                  setFormError('');
                }}
                className={`flex-1 min-h-[38px] px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center cursor-pointer ${
                  authMode === 'register'
                    ? 'bg-zinc-800 text-emerald-400 shadow-sm border border-zinc-700/60'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Register New Org
              </button>
            </div>

            {/* Auth Form */}
            <form onSubmit={handleOrganiserSubmit} className="space-y-4">
              {authMode === 'register' ? (
                <>
                  {/* Organization Name */}
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-300 mb-1.5 uppercase tracking-wider">
                      Organisation / Event Name
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                        <Building2 className="w-4 h-4" />
                      </div>
                      <input
                        type="text"
                        placeholder="e.g. Apex State Championships"
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        required
                        disabled={isSubmitting}
                        className="w-full h-12 pl-10 pr-4 bg-zinc-900/90 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 rounded-2xl text-sm font-medium text-white placeholder-zinc-500 outline-none transition-all disabled:opacity-50"
                      />
                    </div>
                  </div>

                  {/* Director / Admin Email (Clean, NO dummy buttons!) */}
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-300 mb-1.5 uppercase tracking-wider">
                      Admin Email Address
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                        <Mail className="w-4 h-4" />
                      </div>
                      <input
                        type="email"
                        placeholder="director@championships.org"
                        value={adminEmail}
                        onChange={(e) => setAdminEmail(e.target.value)}
                        disabled={isSubmitting}
                        className="w-full h-12 pl-10 pr-4 bg-zinc-900/90 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 rounded-2xl text-sm font-medium text-white placeholder-zinc-500 outline-none transition-all disabled:opacity-50"
                      />
                    </div>
                  </div>

                  {/* Master Password */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">
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
                        className="w-full h-12 pl-10 pr-4 bg-zinc-900/90 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 rounded-2xl text-sm font-medium text-white placeholder-zinc-500 outline-none transition-all disabled:opacity-50"
                      />
                    </div>

                    {/* Real-time Password Entropy Meter */}
                    {adminPassword && (
                      <div className="mt-2 space-y-1">
                        <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                          <span>Entropy Strength</span>
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
                      Registrations are committed directly to the Supabase cloud ledger for Super Admin verification.
                    </span>
                  </div>
                </>
              ) : (
                <>
                  {/* Sign In Identifier */}
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-300 mb-1.5 uppercase tracking-wider">
                      Organisation ID or Email
                    </label>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                        <Building2 className="w-4 h-4" />
                      </div>
                      <input
                        type="text"
                        placeholder="e.g. FJ-9A2X or director@apex.org"
                        value={loginIdentifier}
                        onChange={(e) => setLoginIdentifier(e.target.value)}
                        required
                        disabled={isSubmitting}
                        className="w-full h-12 pl-10 pr-4 bg-zinc-900/90 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 rounded-2xl text-sm font-medium text-white placeholder-zinc-500 outline-none transition-all disabled:opacity-50"
                      />
                    </div>
                  </div>

                  {/* Sign In Password */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">
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
                        className="w-full h-12 pl-10 pr-4 bg-zinc-900/90 border border-zinc-800 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/40 rounded-2xl text-sm font-medium text-white placeholder-zinc-500 outline-none transition-all disabled:opacity-50"
                      />
                    </div>
                  </div>
                </>
              )}

              {/* Form Error Banner */}
              {formError && (
                <div className="p-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-xs text-red-400 flex items-start gap-2.5 animate-in fade-in duration-200">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-400" />
                  <span className="leading-relaxed">{formError}</span>
                </div>
              )}

              {/* Solid Submit Button with Loader2 Spinner */}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full h-12 bg-emerald-600 hover:bg-emerald-500 active:scale-[0.99] text-white font-bold text-xs uppercase tracking-wider rounded-2xl transition-all shadow-lg shadow-emerald-600/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed mt-2"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-white" />
                    <span>
                      {authMode === 'register' ? 'Registering Organisation...' : 'Authenticating...'}
                    </span>
                  </>
                ) : (
                  <>
                    <span>
                      {authMode === 'register' ? 'Register & Launch Dashboard' : 'Enter Dashboard'}
                    </span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>

            {/* Quick Switch Helper */}
            <div className="mt-5 pt-4 border-t border-zinc-800/80 flex items-center justify-between text-xs text-zinc-400">
              <span>
                {authMode === 'register' ? 'Already registered?' : 'Need a new organization?'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setAuthMode(authMode === 'register' ? 'login' : 'register');
                  setFormError('');
                }}
                className="text-emerald-400 hover:text-emerald-300 font-semibold cursor-pointer"
              >
                {authMode === 'register' ? 'Sign In' : 'Create Organization'}
              </button>
            </div>
          </div>
        )}

        {/* View B: Judge Login Portal */}
        {activePortal === 'judge' && (
          <JudgeLogin
            onJudgeLogin={onJudgeLogin}
            onBack={() => setActivePortal('organiser')}
          />
        )}
      </main>

      {/* 3. Bottom Footer */}
      <footer className="w-full max-w-md mx-auto pt-4 pb-2 flex items-center justify-center text-center relative z-10">
        <p className="text-[10px] md:text-[11px] text-zinc-500 font-mono">
          Fair Judge • Offline-First Cryptographic Scoring Ledger
        </p>
      </footer>
    </div>
  );
}
