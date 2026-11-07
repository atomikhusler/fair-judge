import React, { useState, useRef } from 'react';
import { ChevronLeft, QrCode, KeyRound, ArrowRight, ShieldCheck, Camera, Upload } from 'lucide-react';
import { SupabaseJudge, SupabaseEvent } from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';
import { extractJudgeCredentials, parseQrCodeFromImageFile } from '../../lib/qrCodeParser';

interface JudgeAuthProps {
  onJudgeLogin: (orgId: string, judge: SupabaseJudge, assignedEvents: SupabaseEvent[]) => void;
  onBack: () => void;
}

export function JudgeAuth({ onJudgeLogin, onBack }: JudgeAuthProps) {
  const [pin, setPin] = useState('');
  const [orgCode, setOrgCode] = useState('');
  const [judgeId, setJudgeId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanPin = pin.trim();

    if (!cleanPin || cleanPin.length !== 4) {
      setErrorMessage('Please enter your 4-digit security PIN.');
      return;
    }

    setIsLoading(true);
    setErrorMessage('');

    try {
      const result = await dbService.verifyJudgeCredentials(orgCode.trim(), judgeId.trim() || cleanPin, cleanPin);
      if (!result) {
        setErrorMessage('Invalid PIN or Judge identifier. Please check with your competition organiser.');
        setIsLoading(false);
        return;
      }

      onJudgeLogin(result.judge.org_id || orgCode, result.judge, result.assignedEvents || []);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Authentication error. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileScan = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsLoading(true);
    setErrorMessage('');

    try {
      const qrPayload = await parseQrCodeFromImageFile(file);
      const parsed = extractJudgeCredentials(qrPayload);
      if (!parsed) {
        throw new Error('QR code format unrecognized. Please use the Fair Judge pass.');
      }

      const result = await dbService.verifyJudgeCredentials(
        parsed.orgId,
        parsed.judgeId || parsed.pin,
        parsed.pin
      );

      if (!result) {
        throw new Error('Judge credentials from QR pass could not be verified.');
      }

      onJudgeLogin(parsed.orgId, result.judge, result.assignedEvents || []);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Could not read QR code. Please enter your 4-digit PIN manually.');
    } finally {
      setIsLoading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="w-full max-w-md mx-auto flex flex-col items-center">
      {/* Top Header Row with Glassmorphic Back Button */}
      <div className="w-full flex items-center justify-between mb-6">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to Gateway"
          className="w-10 h-10 rounded-full bg-zinc-900/60 hover:bg-zinc-800 border border-zinc-800 flex items-center justify-center text-zinc-400 hover:text-white backdrop-blur-md active:scale-95 transition-all cursor-pointer shadow-sm"
        >
          <ChevronLeft className="w-5 h-5 stroke-[2.2]" />
        </button>

        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-900/40 border border-zinc-800/80 text-[11px] font-mono font-medium text-amber-400">
          <ShieldCheck className="w-3.5 h-3.5" />
          <span>Jury Terminal</span>
        </div>
      </div>

      {/* Main Glass Card */}
      <div className="w-full rounded-3xl bg-zinc-900/80 dark:bg-zinc-950/80 border border-zinc-800/80 backdrop-blur-xl p-6 sm:p-8 shadow-2xl relative">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mx-auto mb-3 shadow-sm">
            <KeyRound className="w-6 h-6 stroke-[2.2]" />
          </div>
          <h2 className="text-xl font-black text-white tracking-tight">Judge Terminal Login</h2>
          <p className="text-xs text-zinc-400 mt-1">Enter your 4-digit security PIN or scan your jury pass</p>
        </div>

        {errorMessage && (
          <div className="mb-5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-medium text-center animate-fade-in">
            {errorMessage}
          </div>
        )}

        {/* QR Code Pass Quick Scan Button */}
        <div className="mb-6">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileScan}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading}
            className="w-full h-13 rounded-2xl bg-zinc-900/90 hover:bg-zinc-850 border border-zinc-700/80 text-zinc-200 font-bold text-xs flex items-center justify-center gap-2.5 active:scale-[0.97] transition-all cursor-pointer shadow-sm group"
          >
            <QrCode className="w-4 h-4 text-amber-400 group-hover:scale-110 transition-transform" />
            <span>Scan Jury QR Pass (Photo / Camera)</span>
          </button>
        </div>

        <div className="relative flex items-center justify-center my-5">
          <div className="border-t border-zinc-800 w-full" />
          <span className="bg-zinc-950 px-3 text-[10px] font-mono uppercase text-zinc-500 absolute font-bold tracking-wider">
            OR ENTER 4-DIGIT PIN
          </span>
        </div>

        <form onSubmit={handlePinSubmit} className="space-y-4">
          <div>
            <label className="block text-[11px] font-mono font-bold text-zinc-400 uppercase tracking-wider mb-1.5">
              4-Digit Security PIN
            </label>
            <input
              type="password"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              value={pin}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 4);
                setPin(val);
              }}
              placeholder="••••"
              autoComplete="one-time-code"
              className="w-full h-14 text-center text-2xl font-mono tracking-widest px-4 rounded-xl bg-zinc-900/90 border border-zinc-800 text-amber-400 placeholder-zinc-700 font-extrabold focus:outline-hidden focus:border-amber-500/60 focus:ring-2 focus:ring-amber-500/20 transition-all"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading || pin.length !== 4}
            className="w-full h-12 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-extrabold text-sm shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2 active:scale-[0.97] transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed mt-3"
          >
            {isLoading ? (
              <div className="w-5 h-5 rounded-full border-2 border-black/30 border-t-black animate-spin" />
            ) : (
              <>
                <span>Access Jury Roster</span>
                <ArrowRight className="w-4 h-4 stroke-[2.5]" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
