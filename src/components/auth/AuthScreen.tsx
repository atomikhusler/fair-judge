import React, { useState, useEffect, useRef } from 'react';
import zxcvbn from 'zxcvbn';
import { Html5Qrcode } from 'html5-qrcode';
import { 
  Building2,
  LayoutGrid, 
  Gavel, 
  Scale,
  ArrowRight, 
  KeyRound, 
  Loader2, 
  Camera, 
  X, 
  AlertCircle, 
  Eye, 
  EyeOff,
  ChevronLeft
} from 'lucide-react';
import { dbService } from '../../lib/supabase';
import { Organization, SupabaseJudge, SupabaseEvent } from '../../lib/supabaseTypes';

interface AuthScreenProps {
  onOrganiserLogin: (org: Organization) => void;
  onJudgeLogin: (orgId: string, judge: SupabaseJudge, assignedEvents: SupabaseEvent[]) => void;
}

export function AuthScreen({ onOrganiserLogin, onJudgeLogin }: AuthScreenProps) {
  // Navigation mode: 'split' | 'organiser' | 'judge'
  const [selectedRole, setSelectedRole] = useState<'split' | 'organiser' | 'judge'>('split');

  // Organiser form state
  const [isNewOrg, setIsNewOrg] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [loginIdentifier, setLoginIdentifier] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [organiserError, setOrganiserError] = useState('');
  const [isLoadingTransition, setIsLoadingTransition] = useState(false);

  // Judge form state (Strict Triad: Org ID, Judge ID, PIN)
  const [judgeOrgId, setJudgeOrgId] = useState('');
  const [judgeId, setJudgeId] = useState('');
  const [judgePin, setJudgePin] = useState('');
  const [judgeError, setJudgeError] = useState('');
  const [isVerifyingJudge, setIsVerifyingJudge] = useState(false);

  // Camera QR Scanner state
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isStartingRef = useRef(false);
  const shouldStopRef = useRef(false);
  const qrRegionId = 'fairjudge-html5-qrcode-region';

  // Password entropy analysis
  const passwordResult = adminPassword ? zxcvbn(adminPassword) : null;
  const passwordScore = passwordResult ? passwordResult.score : 0;

  const getEntropyBar = () => {
    if (!adminPassword) return { width: '0%', color: 'bg-zinc-800' };
    if (passwordScore <= 1) return { width: '30%', color: 'bg-red-500' };
    if (passwordScore <= 3) return { width: '60%', color: 'bg-amber-500 shadow-sm shadow-amber-500/50' };
    return { width: '100%', color: 'bg-emerald-500 shadow-sm shadow-emerald-500/50' };
  };

  // Organiser Submit
  const handleOrganiserSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setOrganiserError('');

    if (isNewOrg) {
      if (!orgName.trim()) {
        setOrganiserError('Please enter your organisation name.');
        return;
      }
      if (!adminPassword.trim()) {
        setOrganiserError('Please set a master password for your account.');
        return;
      }
      setIsLoadingTransition(true);
      try {
        const createdOrg = await dbService.createOrganization(
          orgName.trim(), 
          adminEmail.trim(),
          adminPassword.trim()
        );
        setTimeout(() => {
          setIsLoadingTransition(false);
          onOrganiserLogin(createdOrg);
        }, 500);
      } catch (err: any) {
        setIsLoadingTransition(false);
        setOrganiserError(err.message || 'Could not register organisation.');
      }
    } else {
      const identifier = loginIdentifier.trim();
      const enteredPassword = loginPassword.trim();

      if (!identifier) {
        setOrganiserError('Please enter your Organisation ID or Email.');
        return;
      }
      if (!enteredPassword) {
        setOrganiserError('Please enter your password.');
        return;
      }

      setIsLoadingTransition(true);
      try {
        const org = await dbService.getOrganizationByIdentifier(identifier);

        if (!org) {
          setIsLoadingTransition(false);
          setOrganiserError(`Account "${identifier}" not found. Enter valid Org ID or registered Email.`);
          return;
        }

        const expectedPassword = org.password || 'password123';
        if (org.password && org.password !== enteredPassword) {
          setIsLoadingTransition(false);
          setOrganiserError('Incorrect password. Please verify and try again.');
          return;
        }

        setTimeout(() => {
          setIsLoadingTransition(false);
          onOrganiserLogin(org);
        }, 500);
      } catch (err: any) {
        setIsLoadingTransition(false);
        setOrganiserError(err.message || 'Authentication error.');
      }
    }
  };

  // Judge Manual / QR Submit
  const handleJudgeSubmit = async (
    e?: React.FormEvent,
    customCreds?: { orgId: string; judgeId: string; pin: string }
  ) => {
    if (e) e.preventDefault();
    setJudgeError('');

    const targetOrg = (customCreds?.orgId || judgeOrgId).trim();
    const targetJudgeId = (customCreds?.judgeId || judgeId).trim();
    const targetPin = (customCreds?.pin || judgePin).trim();

    if (!targetOrg || !targetJudgeId || !targetPin) {
      setJudgeError('Please enter Organisation ID, Judge ID, and 4-Digit PIN.');
      return;
    }

    setIsVerifyingJudge(true);
    try {
      const verified = await dbService.verifyJudgeCredentials(
        targetOrg,
        targetJudgeId,
        targetPin
      );

      if (!verified) {
        setJudgeError('Invalid credentials. Please verify your Org ID, Judge ID, and PIN.');
        setIsVerifyingJudge(false);
        return;
      }

      await stopScanner();
      setIsVerifyingJudge(false);
      onJudgeLogin(targetOrg.toUpperCase(), verified.judge, verified.assignedEvents);
    } catch (err: any) {
      setIsVerifyingJudge(false);
      setJudgeError(err.message || 'Failed to authenticate credentials.');
    }
  };

  // Scanner lifecycle safely guarded
  const stopScanner = async () => {
    shouldStopRef.current = true;
    setCameraActive(false);

    const scanner = scannerRef.current;
    scannerRef.current = null;

    if (!scanner) return;

    try {
      let isRunning = false;
      if (typeof (scanner as any).getState === 'function') {
        const state = (scanner as any).getState();
        isRunning = state === 2 || state === 3;
      } else {
        isRunning = Boolean((scanner as any).isScanning);
      }

      if (isRunning) {
        await Promise.resolve(scanner.stop()).catch(() => {});
      }
    } catch {
      // Ignored safely
    }

    try {
      scanner.clear();
    } catch {
      // Ignored safely
    }
  };

  const startScanner = async () => {
    if (scannerRef.current || isStartingRef.current) return;

    setCameraError(null);
    setCameraActive(true);
    shouldStopRef.current = false;
    isStartingRef.current = true;

    setTimeout(async () => {
      if (shouldStopRef.current) {
        isStartingRef.current = false;
        return;
      }

      const container = document.getElementById(qrRegionId);
      if (!container) {
        isStartingRef.current = false;
        setCameraActive(false);
        return;
      }

      try {
        const scanner = new Html5Qrcode(qrRegionId);
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            qrbox: { width: 220, height: 220 },
          },
          (decodedText) => {
            try {
              const parsed = JSON.parse(decodedText);
              const oId = parsed.orgId ? parsed.orgId.toUpperCase() : judgeOrgId;
              const jId = parsed.judgeId || parsed.id || judgeId;
              const p = parsed.pin ? String(parsed.pin) : judgePin;

              if (parsed.orgId) setJudgeOrgId(oId);
              if (parsed.judgeId || parsed.id) setJudgeId(jId);
              if (parsed.pin) setJudgePin(p);

              void stopScanner();
              if (parsed.orgId && (parsed.judgeId || parsed.id) && parsed.pin) {
                setTimeout(() => {
                  handleJudgeSubmit(undefined, { orgId: oId, judgeId: jId, pin: p });
                }, 80);
              }
            } catch {
              if (decodedText.startsWith('FJ-')) {
                setJudgeOrgId(decodedText.trim().toUpperCase());
              }
              void stopScanner();
            }
          },
          () => {}
        );

        isStartingRef.current = false;
        if (shouldStopRef.current) {
          void stopScanner();
        }
      } catch (err: any) {
        isStartingRef.current = false;
        scannerRef.current = null;
        console.warn('QR scan error:', err);
        setCameraError('Camera access unavailable. Please enter credentials manually below.');
        setCameraActive(false);
      }
    }, 120);
  };

  useEffect(() => {
    return () => {
      void stopScanner();
    };
  }, []);

  // Skeleton Transition Screen
  if (isLoadingTransition) {
    return (
      <div className="h-[100dvh] w-full max-w-md md:max-w-xl mx-auto flex flex-col justify-between overflow-hidden bg-stone-50 dark:bg-black select-none text-zinc-900 dark:text-white">
        <header className="h-[15dvh] min-h-[72px] max-h-[110px] flex-shrink-0 flex flex-col justify-center items-center px-4 relative border-b border-stone-200/60 dark:border-zinc-900">
          <div className="flex items-center justify-center gap-2.5 animate-pulse">
            <div className="w-8 h-8 rounded-xl bg-stone-200 dark:bg-zinc-800" />
            <div className="h-6 w-28 bg-stone-200 dark:bg-zinc-800 rounded-lg" />
          </div>
          <div className="h-3 w-36 bg-stone-200 dark:bg-zinc-800/60 rounded mt-1.5 animate-pulse" />
        </header>

        <main className="h-[80dvh] flex-1 overflow-y-auto px-4 py-3 space-y-3 overscroll-contain flex flex-col justify-center">
          <div className="w-full space-y-3 animate-pulse">
            <div className="h-28 bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-900 rounded-3xl" />
            <div className="h-28 bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-900 rounded-3xl" />
            <div className="text-center text-xs font-mono text-zinc-500 tracking-wider pt-2">
              AUTHENTICATING SESSION...
            </div>
          </div>
        </main>

        <footer className="h-[5dvh] min-h-[28px] max-h-[36px] flex-shrink-0 flex items-center justify-center px-4 border-t border-stone-200/60 dark:border-zinc-900">
          <p className="text-[10px] md:text-[11px] text-zinc-500 dark:text-zinc-500 font-mono text-center">
            Engineered by Sahil Kumar Rout • Fair Judge v12.10.0
          </p>
        </footer>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] w-full max-w-md md:max-w-xl mx-auto flex flex-col justify-between overflow-hidden bg-stone-50 dark:bg-black select-none text-zinc-900 dark:text-zinc-100 transition-colors duration-200 relative">
      {/* Background radial highlight */}
      <div className="fixed inset-0 pointer-events-none bg-[radial-gradient(circle_at_top,rgba(16,185,129,0.07),transparent_65%)]" />

      {/* ======================================================== */}
      {/* 1. TOP HEADER (Strictly Centered Logo & Tagline)          */}
      {/* ======================================================== */}
      <header className="h-[15dvh] min-h-[72px] max-h-[110px] flex-shrink-0 flex items-center justify-center px-4 relative border-b border-stone-200/60 dark:border-zinc-900">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="flex items-center justify-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500 shadow-sm shadow-emerald-500/20">
              <Scale className="w-4 h-4 stroke-[2.2]" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">Fair Judge</h1>
          </div>
          <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400/90 tracking-wide mt-1">
            Transparency in Judgement
          </p>
        </div>
      </header>

      {/* ======================================================== */}
      {/* 2. MIDDLE ACTION AREA (80% ALLOCATION)                   */}
      {/* ======================================================== */}
      <div className="h-[80dvh] flex-1 px-4 py-3 space-y-3 overscroll-contain flex flex-col justify-center overflow-y-auto">
        {/* VIEW 1: THE TWO CORE SELECTION CARDS (MANAGEMENT VS EVALUATION) */}
        {selectedRole === 'split' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 w-full animate-in fade-in zoom-in-95 duration-200">
            {/* Card A: Management ("I am an Organiser") */}
            <button
              type="button"
              onClick={() => setSelectedRole('organiser')}
              className="group relative p-5 rounded-3xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 hover:border-emerald-500/50 hover:bg-stone-100/40 dark:hover:bg-zinc-900/40 transition-all text-left flex flex-col justify-between shadow-lg shadow-black/5 dark:shadow-none active:scale-[0.98] cursor-pointer"
            >
              <div className="flex items-center justify-between w-full mb-3">
                <div className="p-3 rounded-2xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 group-hover:scale-105 transition-transform">
                  <LayoutGrid className="w-6 h-6" />
                </div>
                <div className="p-2 rounded-xl bg-stone-100 dark:bg-zinc-900 text-zinc-400 group-hover:text-emerald-500 group-hover:bg-emerald-500/10 group-hover:translate-x-1 transition-all">
                  <ArrowRight className="w-4 h-4" />
                </div>
              </div>

              <div>
                <span className="text-[10px] font-mono tracking-widest text-emerald-500 uppercase font-bold block">
                  Management
                </span>
                <h2 className="text-lg md:text-xl font-bold text-zinc-900 dark:text-white mt-0.5 group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">
                  I am an Organiser
                </h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
                  Manage roster, rubric criteria, event controls, and live projector screens.
                </p>
              </div>
            </button>

            {/* Card B: Evaluation ("I am a Judge") */}
            <button
              type="button"
              onClick={() => setSelectedRole('judge')}
              className="group relative p-5 rounded-3xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 hover:border-orange-500/50 hover:bg-stone-100/40 dark:hover:bg-zinc-900/40 transition-all text-left flex flex-col justify-between shadow-lg shadow-black/5 dark:shadow-none active:scale-[0.98] cursor-pointer"
            >
              <div className="flex items-center justify-between w-full mb-3">
                <div className="p-3 rounded-2xl bg-orange-500/10 text-orange-500 border border-orange-500/20 group-hover:scale-105 transition-transform">
                  <Gavel className="w-6 h-6" />
                </div>
                <div className="p-2 rounded-xl bg-stone-100 dark:bg-zinc-900 text-zinc-400 group-hover:text-orange-500 group-hover:bg-orange-500/10 group-hover:translate-x-1 transition-all">
                  <ArrowRight className="w-4 h-4" />
                </div>
              </div>

              <div>
                <span className="text-[10px] font-mono tracking-widest text-orange-500 uppercase font-bold block">
                  Evaluation
                </span>
                <h2 className="text-lg md:text-xl font-bold text-zinc-900 dark:text-white mt-0.5 group-hover:text-orange-500 transition-colors">
                  I am a Judge
                </h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
                  Access assigned scoring panels via single-tap QR scan or 4-digit PIN.
                </p>
              </div>
            </button>
          </div>
        )}

        {/* VIEW 2: ORGANISER AUTH FORM */}
        {selectedRole === 'organiser' && (
          <div className="w-full max-h-full overflow-y-auto no-scrollbar bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-3xl p-5 md:p-6 shadow-xl relative animate-in fade-in zoom-in-95 duration-200">
            {/* Header with Back Button */}
            <div className="flex items-center justify-between pb-3 border-b border-stone-200 dark:border-zinc-800/80 mb-4">
              <div className="flex items-center space-x-2">
                <div className="p-1.5 rounded-lg bg-emerald-500/10 text-emerald-500">
                  <Building2 className="w-4 h-4" />
                </div>
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-900 dark:text-white">
                  Organiser Access
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  setOrganiserError('');
                  setSelectedRole('split');
                }}
                className="flex items-center space-x-1 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            </div>

            {/* Sub-Tabs: Sign In vs Register (Framer-grade segmented toggle) */}
            <div className="flex w-full p-1 bg-stone-200/70 dark:bg-zinc-900 rounded-xl border border-stone-200/60 dark:border-zinc-800 shadow-inner mb-4">
              <button
                type="button"
                onClick={() => {
                  setIsNewOrg(false);
                  setOrganiserError('');
                }}
                className={`flex-1 min-h-[38px] px-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center cursor-pointer ${
                  !isNewOrg
                    ? 'bg-white dark:bg-zinc-950 text-emerald-600 dark:text-emerald-400 shadow-sm border border-stone-200/60 dark:border-zinc-800'
                    : 'text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-white'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsNewOrg(true);
                  setOrganiserError('');
                }}
                className={`flex-1 min-h-[38px] px-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center cursor-pointer ${
                  isNewOrg
                    ? 'bg-white dark:bg-zinc-950 text-emerald-600 dark:text-emerald-400 shadow-sm border border-stone-200/60 dark:border-zinc-800'
                    : 'text-stone-500 dark:text-zinc-400 hover:text-stone-900 dark:hover:text-white'
                }`}
              >
                Register New Org
              </button>
            </div>

            <form onSubmit={handleOrganiserSubmit} className="space-y-3.5">
              {isNewOrg ? (
                <>
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 uppercase tracking-wider">
                      Organisation / Event Name
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Apex Championships"
                      value={orgName}
                      onChange={(e) => setOrgName(e.target.value)}
                      required
                      className="min-h-[48px] rounded-2xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 focus:ring-2 focus:ring-emerald-500/40 text-sm font-medium w-full px-4 text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 uppercase tracking-wider">
                      Admin Email (Magic Link)
                    </label>
                    <div className="relative">
                      <input
                        type="email"
                        placeholder="director@championships.org"
                        value={adminEmail}
                        onChange={(e) => setAdminEmail(e.target.value)}
                        className="min-h-[48px] rounded-2xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 focus:ring-2 focus:ring-emerald-500/40 text-sm font-medium w-full pl-4 pr-24 text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none"
                      />
                      <span className="absolute right-2 top-2 bottom-2 px-3 rounded-xl text-xs font-bold flex items-center bg-stone-200 dark:bg-zinc-800 text-stone-600 dark:text-zinc-300 pointer-events-none select-none">
                        Verify
                      </span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 uppercase tracking-wider">
                      Master Password
                    </label>
                    <input
                      type="password"
                      placeholder="••••••••••••"
                      value={adminPassword}
                      onChange={(e) => setAdminPassword(e.target.value)}
                      className="min-h-[48px] rounded-2xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 focus:ring-2 focus:ring-emerald-500/40 text-sm font-medium w-full px-4 text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none"
                    />
                    <div className="w-full h-1 bg-stone-200 dark:bg-zinc-900 rounded-full mt-2 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${getEntropyBar().color}`}
                        style={{ width: getEntropyBar().width }}
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 uppercase tracking-wider">
                      Organisation ID or Email
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. FJ-9A2X or director@event.org"
                      value={loginIdentifier}
                      onChange={(e) => setLoginIdentifier(e.target.value)}
                      required
                      className="min-h-[48px] rounded-2xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 focus:ring-2 focus:ring-emerald-500/40 text-sm font-medium w-full px-4 text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 uppercase tracking-wider">
                        Master Password
                      </label>
                      <button
                        type="button"
                        onClick={() => setShowLoginPassword(!showLoginPassword)}
                        className="text-[10px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300 flex items-center space-x-1"
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
                      <input
                        type={showLoginPassword ? 'text' : 'password'}
                        placeholder="••••••••••••"
                        value={loginPassword}
                        onChange={(e) => setLoginPassword(e.target.value)}
                        required
                        className="min-h-[48px] rounded-2xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 focus:ring-2 focus:ring-emerald-500/40 text-sm font-medium w-full px-4 text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none"
                      />
                    </div>
                  </div>
                </>
              )}

              {organiserError && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-500 dark:text-red-400 flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{organiserError}</span>
                </div>
              )}

              <button
                type="submit"
                className="w-full min-h-[48px] bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs uppercase tracking-wider rounded-2xl transition-all shadow-md shadow-emerald-500/20 active:scale-[0.99] flex items-center justify-center space-x-2 cursor-pointer mt-2"
              >
                <span>{isNewOrg ? 'Create & Launch Dashboard' : 'Enter Dashboard'}</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </form>
          </div>
        )}

        {/* VIEW 3: JUDGE AUTH FORM (Amber/Orange Theme) */}
        {selectedRole === 'judge' && (
          <div className="w-full max-h-full overflow-y-auto no-scrollbar bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-3xl p-5 md:p-6 shadow-xl relative animate-in fade-in zoom-in-95 duration-200">
            {/* Header with Back Button */}
            <div className="flex items-center justify-between pb-3 border-b border-stone-200 dark:border-zinc-800/80 mb-4">
              <div className="flex items-center space-x-2">
                <div className="p-1.5 rounded-lg bg-orange-500/10 text-orange-500">
                  <Gavel className="w-4 h-4" />
                </div>
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-900 dark:text-white">
                  Judge Portal Access
                </span>
              </div>
              <button
                type="button"
                onClick={() => {
                  stopScanner();
                  setJudgeError('');
                  setSelectedRole('split');
                }}
                className="flex items-center space-x-1 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
            </div>

            {/* Primary Action: QR Code Button */}
            <div className="mb-4">
              {!cameraActive ? (
                <button
                  type="button"
                  onClick={startScanner}
                  className="w-full min-h-[48px] rounded-2xl bg-orange-500 hover:bg-orange-600 text-white font-bold text-xs uppercase tracking-wider shadow-md shadow-orange-500/25 active:scale-[0.99] flex items-center justify-center space-x-2 cursor-pointer transition-all border border-orange-400/20"
                >
                  <Camera className="w-4 h-4 text-white" />
                  <span>Scan QR Code</span>
                </button>
              ) : (
                <div className="w-full bg-stone-100 dark:bg-zinc-900 rounded-2xl overflow-hidden border border-stone-200 dark:border-zinc-800 p-3 relative flex flex-col items-center">
                  <div className="flex items-center justify-between w-full px-1 pb-2">
                    <span className="text-[11px] font-mono font-bold text-zinc-600 dark:text-zinc-300 uppercase tracking-wider flex items-center space-x-2">
                      <span className="w-2 h-2 rounded-full bg-orange-500 animate-pulse" />
                      <span>Point camera at Judge Credential QR</span>
                    </span>
                    <button
                      type="button"
                      onClick={stopScanner}
                      className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-white rounded-lg transition-colors cursor-pointer"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div id={qrRegionId} className="w-full max-w-[220px] rounded-xl overflow-hidden border border-stone-300 dark:border-zinc-700 shadow-inner" />

                  <button
                    type="button"
                    onClick={stopScanner}
                    className="mt-2 px-3 py-1 bg-stone-200 dark:bg-zinc-800 hover:bg-stone-300 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 text-[11px] font-semibold rounded-lg transition-colors cursor-pointer"
                  >
                    Cancel Camera
                  </button>
                </div>
              )}

              {cameraError && (
                <div className="mt-2 p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-600 dark:text-amber-400 flex items-start space-x-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{cameraError}</span>
                </div>
              )}
            </div>

            {/* Separator */}
            <div className="flex items-center my-3.5">
              <div className="flex-1 border-t border-stone-200 dark:border-zinc-800/80" />
              <span className="px-3 text-[10px] font-mono uppercase tracking-widest text-zinc-400 dark:text-zinc-500">
                OR ENTER CREDENTIALS MANUALLY
              </span>
              <div className="flex-1 border-t border-stone-200 dark:border-zinc-800/80" />
            </div>

            {/* Inputs: Three inputs only (Org ID, Judge ID, 4-Digit PIN) */}
            <form onSubmit={(e) => handleJudgeSubmit(e)} className="space-y-3.5">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 uppercase tracking-wider">
                    Org ID
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. FJ-9A2X"
                    value={judgeOrgId}
                    onChange={(e) => setJudgeOrgId(e.target.value.toUpperCase())}
                    required
                    className="min-h-[48px] rounded-2xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 focus:ring-2 focus:ring-orange-500/40 text-sm font-medium font-mono w-full px-4 text-zinc-900 dark:text-white uppercase focus:outline-none"
                  />
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 uppercase tracking-wider">
                    Judge ID
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. J-01"
                    value={judgeId}
                    onChange={(e) => setJudgeId(e.target.value.toUpperCase())}
                    required
                    className="min-h-[48px] rounded-2xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 focus:ring-2 focus:ring-orange-500/40 text-sm font-medium font-mono w-full px-4 text-zinc-900 dark:text-white uppercase focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5 uppercase tracking-wider">
                  4-Digit Security PIN
                </label>
                <div className="relative">
                  <KeyRound className="w-4 h-4 text-zinc-400 absolute left-4 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    maxLength={4}
                    placeholder="••••"
                    value={judgePin}
                    onChange={(e) => setJudgePin(e.target.value)}
                    required
                    className="min-h-[48px] rounded-2xl bg-stone-50 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 focus:ring-2 focus:ring-orange-500/40 font-mono text-base tracking-widest text-zinc-900 dark:text-white placeholder-zinc-400 focus:outline-none text-center w-full pl-10 pr-4"
                  />
                </div>
              </div>

              {judgeError && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-500 dark:text-red-400">
                  {judgeError}
                </div>
              )}

              <button
                type="submit"
                disabled={isVerifyingJudge}
                className="w-full min-h-[48px] bg-orange-500 hover:bg-orange-600 text-white font-bold text-xs uppercase tracking-wider rounded-2xl transition-all shadow-md shadow-orange-500/25 flex items-center justify-center space-x-2 disabled:opacity-50 active:scale-[0.99] cursor-pointer mt-2"
              >
                {isVerifyingJudge ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Verifying Credentials...</span>
                  </>
                ) : (
                  <>
                    <span>Enter Scoring Panel</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* 3. BOTTOM FOOTER (5% ALLOCATION)                         */}
      {/* ======================================================== */}
      <footer className="h-[5dvh] min-h-[28px] max-h-[36px] flex-shrink-0 flex items-center justify-center px-4 border-t border-stone-200/60 dark:border-zinc-900">
        <p className="text-[10px] md:text-[11px] text-zinc-500 dark:text-zinc-500 font-mono text-center">
          Engineered by Sahil Kumar Rout • Fair Judge v12.10.0
        </p>
      </footer>
    </div>
  );
}
