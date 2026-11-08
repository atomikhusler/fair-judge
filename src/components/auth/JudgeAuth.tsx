import React, { useState, useRef, useEffect } from 'react';
import { 
  Gavel, 
  ArrowRight, 
  Loader2, 
  AlertCircle, 
  ChevronLeft,
  Camera,
  Image as ImageIcon,
  X,
  KeyRound,
  Building2,
  UserCheck
} from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { dbService, supabase, isSupabaseConfigured } from '../../lib/supabase';
import { authService } from '../../lib/authService';
import { SupabaseJudge, SupabaseEvent } from '../../lib/supabaseTypes';
import { showToast } from '../common/ToastProvider';
import { sanitizeAuthError } from './authSanitizer';
import { parseQrCodeFromImageFile, extractJudgeCredentials } from '../../lib/qrCodeParser';

interface JudgeAuthProps {
  onJudgeLogin: (orgId: string, judge: SupabaseJudge, assignedEvents: SupabaseEvent[]) => void;
  onBack: () => void;
}

export function JudgeAuth({ onJudgeLogin, onBack }: JudgeAuthProps) {
  // Three distinct manual login fields
  const [orgId, setOrgId] = useState('');
  const [judgeId, setJudgeId] = useState('');
  const [pin, setPin] = useState('');

  // Status and error states
  const [isVerifying, setIsVerifying] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // QR Code Scanner State
  const [isScanning, setIsScanning] = useState(false);
  const [scannerError, setScannerError] = useState<string | null>(null);
  const [isProcessingGallery, setIsProcessingGallery] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const qrRegionId = 'judge-auth-qr-viewport';

  // Stop active camera scanner cleanly
  const stopScanner = async () => {
    setIsScanning(false);
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
    } catch {}

    try {
      scanner.clear();
    } catch {}
  };

  useEffect(() => {
    return () => {
      void stopScanner();
    };
  }, []);

  // Start live Camera Scanner
  const startCameraScanner = async () => {
    setScannerError(null);
    setErrorMessage('');
    setIsScanning(true);

    setTimeout(async () => {
      const container = document.getElementById(qrRegionId);
      if (!container) {
        setIsScanning(false);
        return;
      }

      try {
        const scanner = new Html5Qrcode(qrRegionId);
        scannerRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          async (decodedText) => {
            void stopScanner();
            await processDecodedQr(decodedText);
          },
          () => {}
        );
      } catch (err: any) {
        console.warn('Camera stream error:', err);
        setScannerError('Camera access unavailable or denied. Upload a QR screenshot instead.');
      }
    }, 150);
  };

  // Process decoded QR payload
  const processDecodedQr = async (rawText: string) => {
    setErrorMessage('');
    setIsVerifying(true);

    try {
      const creds = extractJudgeCredentials(rawText);
      if (creds && creds.pin) {
        if (creds.orgId) setOrgId(creds.orgId.toUpperCase());
        if (creds.judgeId) setJudgeId(creds.judgeId);
        setPin(creds.pin);

        // Strict read-only authentication via authService (pure SELECT, zero auto-creation)
        const verified = await authService.authenticateJudge({
          orgId: creds.orgId,
          judgeId: creds.judgeId,
          pin: creds.pin,
          eventId: creds.eventId,
        });

        showToast(`Authenticated as Judge: ${verified.judge.name}`, 'success');
        onJudgeLogin(verified.judge.org_id.toUpperCase(), verified.judge, verified.assignedEvents);
        return;
      }

      // Check if it's a simple 4-6 character PIN string
      const clean = rawText.trim().toUpperCase();
      if (clean && clean.length >= 4 && clean.length <= 8) {
        setPin(clean.slice(0, 6));
        await handleAuthenticate(undefined, clean);
        return;
      }

      throw new Error('Authentication Failed: Invalid ID or PIN. Please request a new QR code.');
    } catch (err: any) {
      console.warn('QR authentication notice:', err);
      const msg = err.message?.includes('Authentication Failed')
        ? err.message
        : 'Authentication Failed: Invalid ID or PIN. Please request a new QR code.';
      setErrorMessage(msg);
      showToast(msg, 'error');
    } finally {
      setIsVerifying(false);
    }
  };

  // Gallery QR Image Fallback
  const handleGalleryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingGallery(true);
    setErrorMessage('');

    try {
      const rawText = await parseQrCodeFromImageFile(file);
      await processDecodedQr(rawText);
    } catch (err: any) {
      console.warn('Gallery QR notice:', err);
      const sanitized = sanitizeAuthError(err);
      setErrorMessage(sanitized);
      showToast(sanitized, 'error');
    } finally {
      setIsProcessingGallery(false);
      if (e.target) e.target.value = '';
    }
  };

  // Authenticate manual inputs
  const handleAuthenticate = async (e?: React.FormEvent, overridePin?: string) => {
    if (e) e.preventDefault();
    setErrorMessage('');

    const targetOrgId = orgId.trim().toUpperCase();
    const targetJudgeId = judgeId.trim();
    const targetPin = (overridePin || pin).trim();

    if (!targetPin) {
      setErrorMessage('Please enter your 4-Digit PIN to authenticate.');
      return;
    }

    setIsVerifying(true);
    try {
      // Pure SELECT query via zero-trust authService (zero auto-creation, strict rejection)
      const verified = await authService.authenticateJudge({
        orgId: targetOrgId || undefined,
        judgeId: targetJudgeId || undefined,
        pin: targetPin,
      });

      showToast(`Welcome, Judge ${verified.judge.name}!`, 'success');
      onJudgeLogin(verified.judge.org_id.toUpperCase(), verified.judge, verified.assignedEvents);
    } catch (err: any) {
      console.warn('Judge authentication notice:', err);
      const msg = err.message?.includes('Authentication Failed')
        ? err.message
        : 'Authentication Failed: Invalid ID or PIN. Please request a new QR code.';
      setErrorMessage(msg);
      showToast(msg, 'error');
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="w-full max-w-md mx-auto bg-zinc-900/50 backdrop-blur-xl border border-zinc-800 rounded-3xl p-6 md:p-8 shadow-2xl shadow-black/80 relative animate-in fade-in zoom-in-95 duration-200">
      {/* Hidden Gallery Input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleGalleryUpload}
      />

      {/* Floating Glassmorphic Back Button */}
      <button
        type="button"
        onClick={onBack}
        aria-label="Back to role selection"
        className="w-10 h-10 rounded-full bg-zinc-900/50 border border-zinc-800 hover:bg-zinc-800 transition-colors absolute left-4 top-4 flex items-center justify-center text-zinc-400 hover:text-white cursor-pointer active:scale-[0.97] transition-transform duration-75 ease-out will-change-transform shadow-lg z-20"
      >
        <ChevronLeft className="w-5 h-5" />
      </button>

      {/* Shrinked App Logo & Persistent Centered Header Anchor */}
      <div className="flex flex-col items-center justify-center text-center mb-6 pt-1">
        <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-1.5 shadow-sm shadow-amber-500/10">
          <Gavel className="w-5 h-5" />
        </div>
        <h1 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
          Judge Terminal
        </h1>
        <span className="text-[10px] uppercase tracking-widest text-zinc-500">
          Fair Judge
        </span>
      </div>

      {/* PRIMARY BLOCK: Unified Glassmorphic QR Card (Zero Tap-Fatigue) */}
      <div className="bg-zinc-900/40 border border-zinc-800 rounded-2xl p-4 mb-5">
        <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-3 text-center">
          Instant Badge Access
        </div>
        
        <div className="grid grid-cols-2 gap-3">
          {/* Zone A: Primary Solid Amber Camera Button */}
          <button
            type="button"
            onClick={startCameraScanner}
            disabled={isScanning || isVerifying}
            className="h-11 bg-amber-500 hover:bg-amber-400 active:scale-[0.97] transition-transform duration-75 ease-out will-change-transform text-black font-bold text-xs uppercase tracking-wider rounded-xl shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            <Camera className="w-4 h-4 shrink-0" />
            <span>Scan QR</span>
          </button>

          {/* Zone B: Secondary Ghost/Outline Gallery Upload */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isProcessingGallery || isVerifying}
            className="h-11 border border-zinc-800 hover:border-zinc-700 bg-zinc-900/60 hover:bg-zinc-800/80 active:scale-[0.97] transition-transform duration-75 ease-out will-change-transform text-zinc-300 hover:text-white font-semibold text-xs uppercase tracking-wider rounded-xl flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
          >
            {isProcessingGallery ? (
              <Loader2 className="w-4 h-4 animate-spin text-amber-400" />
            ) : (
              <ImageIcon className="w-4 h-4 shrink-0 text-zinc-400" />
            )}
            <span>{isProcessingGallery ? 'Parsing...' : 'From Gallery'}</span>
          </button>
        </div>

        {/* Live Camera Scanner Viewport if Active */}
        {isScanning && (
          <div className="mt-4 p-3 rounded-xl bg-zinc-950 border border-zinc-800 animate-in fade-in zoom-in-95">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                <Camera className="w-3.5 h-3.5 text-amber-400" />
                <span>Align badge QR in viewport</span>
              </span>
              <button
                type="button"
                onClick={stopScanner}
                className="p-1 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div
              id={qrRegionId}
              className="w-full h-48 bg-black rounded-lg overflow-hidden border border-zinc-800 flex items-center justify-center text-xs text-zinc-500"
            />

            {scannerError && (
              <div className="mt-2.5 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400 flex items-center gap-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{scannerError}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* THE DIVIDER: Clean Horizontal Line with Muted OR Badge */}
      <div className="relative my-6 flex items-center justify-center">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-zinc-800" />
        </div>
        <div className="relative bg-zinc-900/90 px-3 py-0.5 rounded-full border border-zinc-800/80">
          <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
            OR
          </span>
        </div>
      </div>

      {/* SECONDARY BLOCK: Always-Visible Manual Login (Zero Extra Taps) */}
      <form onSubmit={(e) => handleAuthenticate(e)} className="space-y-4">
        {/* Field 1: Organisation ID */}
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1.5">
            Organisation ID
          </label>
          <div className="bg-zinc-950 border border-zinc-800 focus-within:border-amber-500/50 focus-within:ring-1 focus-within:ring-amber-500/20 rounded-xl px-3.5 h-11 flex items-center gap-2.5 transition-all">
            <Building2 className="w-4 h-4 text-zinc-500 shrink-0" />
            <input
              type="text"
              placeholder="e.g. FJ-ORG-9102"
              value={orgId}
              onChange={(e) => setOrgId(e.target.value.toUpperCase())}
              disabled={isVerifying}
              className="bg-transparent text-sm font-medium text-white placeholder-zinc-600 outline-none w-full uppercase"
            />
          </div>
        </div>

        {/* Field 2: Judge ID */}
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1.5">
            Judge ID
          </label>
          <div className="bg-zinc-950 border border-zinc-800 focus-within:border-amber-500/50 focus-within:ring-1 focus-within:ring-amber-500/20 rounded-xl px-3.5 h-11 flex items-center gap-2.5 transition-all">
            <UserCheck className="w-4 h-4 text-zinc-500 shrink-0" />
            <input
              type="text"
              placeholder="e.g. J-01 or Full Name"
              value={judgeId}
              onChange={(e) => setJudgeId(e.target.value)}
              disabled={isVerifying}
              className="bg-transparent text-sm font-medium text-white placeholder-zinc-600 outline-none w-full"
            />
          </div>
        </div>

        {/* Field 3: 4-Digit PIN (Directive 4: Strict 4-Digit Numeric Constraint) */}
        <div>
          <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-400 mb-1.5">
            4-Digit PIN
          </label>
          <div className="bg-zinc-950 border border-zinc-800 focus-within:border-amber-500/50 focus-within:ring-1 focus-within:ring-amber-500/20 rounded-xl px-3.5 h-11 flex items-center gap-2.5 transition-all">
            <KeyRound className="w-4 h-4 text-zinc-500 shrink-0" />
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              placeholder="••••"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
              disabled={isVerifying}
              className="bg-transparent text-sm font-mono tracking-widest font-bold text-white placeholder-zinc-600 outline-none w-full"
            />
          </div>
        </div>

        {/* Error Alert */}
        {errorMessage && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-500 flex items-start gap-2.5 animate-in fade-in duration-200">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
            <span className="leading-relaxed">{errorMessage}</span>
          </div>
        )}

        {/* Full-Width Solid Authenticate Button */}
        <button
          type="submit"
          disabled={isVerifying}
          className="w-full h-11 bg-amber-500 hover:bg-amber-400 active:scale-[0.97] transition-transform duration-75 ease-out will-change-transform text-black font-bold text-xs uppercase tracking-wider rounded-xl shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed mt-2"
        >
          {isVerifying ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin text-black" />
              <span>Authenticating Terminal...</span>
            </>
          ) : (
            <>
              <span>Authenticate</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}
