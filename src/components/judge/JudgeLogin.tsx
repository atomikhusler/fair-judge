import React, { useState, useRef, useEffect } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { 
  Gavel, 
  Camera, 
  Image as ImageIcon, 
  X, 
  AlertCircle, 
  KeyRound, 
  ArrowRight, 
  Loader2, 
  ChevronLeft 
} from 'lucide-react';
import { dbService } from '../../lib/supabase';
import { SupabaseJudge, SupabaseEvent } from '../../lib/supabaseTypes';
import { parseQrCodeFromImageFile, extractJudgeCredentials } from '../../lib/qrCodeParser';

interface JudgeLoginProps {
  onJudgeLogin: (orgId: string, judge: SupabaseJudge, assignedEvents: SupabaseEvent[]) => void;
  onBack?: () => void;
}

export function JudgeLogin({ onJudgeLogin, onBack }: JudgeLoginProps) {
  // Credentials State (Strict Triad: Org ID, Judge ID, 4-Digit PIN)
  const [judgeOrgId, setJudgeOrgId] = useState('');
  const [judgeId, setJudgeId] = useState('');
  const [judgePin, setJudgePin] = useState('');
  const [judgeError, setJudgeError] = useState('');
  const [isVerifyingJudge, setIsVerifyingJudge] = useState(false);

  // Camera QR Scanner State
  const [cameraActive, setCameraActive] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const isStartingRef = useRef(false);
  const shouldStopRef = useRef(false);
  const qrRegionId = 'fairjudge-html5-qrcode-region-judge';

  // Gallery Fallback State
  const [isProcessingGalleryQR, setIsProcessingGalleryQR] = useState(false);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);

  // Stop camera stream safely
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

  useEffect(() => {
    return () => {
      void stopScanner();
    };
  }, []);

  // Submit and verify credentials
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

  // Start live Camera Scanner
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
            const extracted = extractJudgeCredentials(decodedText);
            if (extracted) {
              setJudgeOrgId(extracted.orgId);
              setJudgeId(extracted.judgeId);
              setJudgePin(extracted.pin);
              void stopScanner();
              setTimeout(() => {
                handleJudgeSubmit(undefined, extracted);
              }, 80);
            } else if (decodedText.startsWith('FJ-')) {
              setJudgeOrgId(decodedText.trim().toUpperCase());
              void stopScanner();
            } else {
              void stopScanner();
              setJudgeError('Invalid QR code format. Please check with the competition organiser.');
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
        console.warn('Camera QR scan error:', err);
        setCameraError('Camera access unavailable or permission denied. Upload from gallery below.');
        setCameraActive(false);
      }
    }, 120);
  };

  // Gallery QR Image Upload Handler (Directive 1)
  const handleGalleryUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingGalleryQR(true);
    setCameraError(null);
    setJudgeError('');

    try {
      // 1. Zero-Cost Scanner Engine (BarcodeDetector -> jsQR fallback)
      const rawText = await parseQrCodeFromImageFile(file);

      // 2. Extract JSON/Base64 credentials
      const extracted = extractJudgeCredentials(rawText);

      if (extracted) {
        setJudgeOrgId(extracted.orgId);
        setJudgeId(extracted.judgeId);
        setJudgePin(extracted.pin);

        // 3. Automated handoff: seamless login
        await handleJudgeSubmit(undefined, extracted);
      } else if (rawText.startsWith('FJ-')) {
        setJudgeOrgId(rawText.trim().toUpperCase());
      } else {
        setJudgeError('QR code recognized, but credentials payload was invalid.');
      }
    } catch (err: any) {
      console.warn('Gallery QR parsing failed:', err);
      setJudgeError(err.message || 'Could not detect a valid QR code in this image.');
    } finally {
      setIsProcessingGalleryQR(false);
      if (e.target) e.target.value = '';
    }
  };

  return (
    <div className="w-full max-h-full overflow-y-auto no-scrollbar bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800/80 rounded-3xl p-5 md:p-6 shadow-xl relative animate-in fade-in zoom-in-95 duration-200">
      {/* Hidden file input for gallery upload */}
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleGalleryUpload}
      />

      {/* Header with optional Back Button */}
      <div className="flex items-center justify-between pb-3 border-b border-stone-200 dark:border-zinc-800/80 mb-4">
        <div className="flex items-center space-x-2">
          <div className="p-1.5 rounded-lg bg-orange-500/10 text-orange-500">
            <Gavel className="w-4 h-4" />
          </div>
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-900 dark:text-white">
            Judge Portal Access
          </span>
        </div>
        {onBack && (
          <button
            type="button"
            onClick={() => {
              void stopScanner();
              setJudgeError('');
              onBack();
            }}
            className="flex items-center space-x-1 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white transition-colors cursor-pointer"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            <span>Back</span>
          </button>
        )}
      </div>

      {/* QR Scanner Controls: Scan with Camera + Upload from Gallery Fallback */}
      <div className="mb-4 space-y-2">
        {!cameraActive ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              onClick={startScanner}
              className="min-h-[46px] rounded-2xl bg-orange-500 hover:bg-orange-600 text-white font-bold text-xs uppercase tracking-wider shadow-md shadow-orange-500/25 active:scale-[0.99] flex items-center justify-center space-x-2 cursor-pointer transition-all border border-orange-400/20"
            >
              <Camera className="w-4 h-4 text-white" />
              <span>Scan QR Code</span>
            </button>

            <button
              type="button"
              disabled={isProcessingGalleryQR}
              onClick={() => galleryInputRef.current?.click()}
              className="min-h-[46px] rounded-2xl bg-stone-100 hover:bg-stone-200 dark:bg-zinc-900 dark:hover:bg-zinc-850 text-zinc-800 dark:text-zinc-200 font-bold text-xs uppercase tracking-wider border border-stone-300 dark:border-zinc-800 active:scale-[0.99] flex items-center justify-center space-x-2 cursor-pointer transition-all disabled:opacity-60"
            >
              {isProcessingGalleryQR ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-orange-500" />
                  <span>Scanning Photo...</span>
                </>
              ) : (
                <>
                  <ImageIcon className="w-4 h-4 text-orange-500" />
                  <span>Upload QR from Gallery</span>
                </>
              )}
            </button>
          </div>
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

            <div className="flex items-center gap-2 mt-3 w-full">
              <button
                type="button"
                onClick={stopScanner}
                className="flex-1 py-1.5 bg-stone-200 dark:bg-zinc-800 hover:bg-stone-300 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 text-[11px] font-semibold rounded-xl transition-colors cursor-pointer text-center"
              >
                Cancel Camera
              </button>
              <button
                type="button"
                onClick={() => {
                  void stopScanner();
                  galleryInputRef.current?.click();
                }}
                className="flex-1 py-1.5 bg-orange-500/10 hover:bg-orange-500/20 text-orange-600 dark:text-orange-400 border border-orange-500/20 text-[11px] font-semibold rounded-xl transition-colors cursor-pointer flex items-center justify-center gap-1.5"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                <span>Use Gallery Photo</span>
              </button>
            </div>
          </div>
        )}

        {cameraError && (
          <div className="mt-2 p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs text-amber-600 dark:text-amber-400 flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p>{cameraError}</p>
              <button
                type="button"
                onClick={() => galleryInputRef.current?.click()}
                className="mt-1 font-bold text-orange-600 dark:text-orange-400 underline cursor-pointer text-[11px]"
              >
                Upload QR from Gallery instead &rarr;
              </button>
            </div>
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
          <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-500 dark:text-red-400 flex items-center space-x-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{judgeError}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={isVerifyingJudge}
          className="w-full min-h-[48px] bg-orange-500 hover:bg-orange-600 text-white font-bold text-xs uppercase tracking-wider rounded-2xl transition-all shadow-md shadow-orange-500/25 active:scale-[0.99] flex items-center justify-center space-x-2 cursor-pointer mt-2 disabled:opacity-60"
        >
          {isVerifyingJudge ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Verifying Ledger Access...</span>
            </>
          ) : (
            <>
              <span>Authenticate Judge Session</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </>
          )}
        </button>
      </form>
    </div>
  );
}
export default JudgeLogin;
