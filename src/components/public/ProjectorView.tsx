import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Monitor, RefreshCw, ArrowLeft, AlertCircle } from 'lucide-react';
import {
  projectorService,
  ProjectorSnapshot,
  getStoredViewToken,
  clearApprovedPairing,
  getStoredPendingPairing,
  clearPendingPairing,
} from '../../lib/projectorService';
import { PublicLeaderboard } from './PublicLeaderboard';

export interface ProjectorViewProps {
  onExit: () => void;
}

export function ProjectorView({ onExit }: ProjectorViewProps) {
  // Approved display state
  const [viewToken, setViewToken] = useState<string | null>(() => getStoredViewToken());
  const [snapshot, setSnapshot] = useState<ProjectorSnapshot | null>(null);
  const [isBlank, setIsBlank] = useState<boolean>(false);
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState<boolean>(() => Boolean(getStoredViewToken()));
  const [isReconnecting, setIsReconnecting] = useState<boolean>(false);

  // Pairing screen state
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [deviceSecret, setDeviceSecret] = useState<string | null>(null);
  const [pairingExpiresAt, setPairingExpiresAt] = useState<string | null>(null);
  const [pairingStatus, setPairingStatus] = useState<'loading' | 'pending' | 'expired' | 'error'>('loading');
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(600);

  // Cursor auto-hide after 3s of inactivity during display
  const [isCursorHidden, setIsCursorHidden] = useState<boolean>(false);

  const lastVersionRef = useRef<string | null>(null);
  const isFetchingSnapshotRef = useRef<boolean>(false);
  const wakeLockRef = useRef<any>(null);
  const cursorTimerRef = useRef<number | null>(null);

  const returnToPairing = useCallback(() => {
    clearApprovedPairing();
    setViewToken(null);
    setSnapshot(null);
    setIsBlank(false);
    setIsLoadingSnapshot(false);
    setIsReconnecting(false);
    lastVersionRef.current = null;
  }, []);

  const requestNewPairingCode = useCallback(async (forceFresh = false) => {
    if (!forceFresh) {
      const existing = getStoredPendingPairing();
      if (existing) {
        setPairingCode(existing.code);
        setDeviceSecret(existing.deviceSecret);
        setPairingExpiresAt(existing.expiresAt);
        setPairingStatus('pending');
        setPairingError(null);
        return;
      }
    } else {
      clearPendingPairing();
    }

    setPairingStatus('loading');
    setPairingError(null);
    const res = await projectorService.requestCode();
    if (res.ok && res.code && res.deviceSecret && res.expiresAt) {
      setPairingCode(res.code);
      setDeviceSecret(res.deviceSecret);
      setPairingExpiresAt(res.expiresAt);
      setPairingStatus('pending');
      setPairingError(null);
    } else {
      setPairingStatus('error');
      setPairingError(res.message || 'Unable to generate pairing code.');
    }
  }, []);

  // Initialize pairing when no view_token exists
  useEffect(() => {
    if (viewToken) return;
    void requestNewPairingCode(false);
  }, [viewToken, requestNewPairingCode]);

  // Countdown & 3s claim polling while pairing is pending
  useEffect(() => {
    if (viewToken || pairingStatus !== 'pending' || !deviceSecret || !pairingExpiresAt) {
      return;
    }

    const expMs = new Date(pairingExpiresAt).getTime();
    const updateCountdown = () => {
      const secs = Math.max(0, Math.ceil((expMs - Date.now()) / 1000));
      setRemainingSeconds(secs);
      if (secs <= 0) {
        clearPendingPairing();
        setPairingStatus('expired');
        return false;
      }
      return true;
    };

    if (!updateCountdown()) return;

    const countdownInterval = window.setInterval(() => {
      if (!updateCountdown()) {
        window.clearInterval(countdownInterval);
      }
    }, 1000);

    let cancelled = false;
    const pollClaim = async () => {
      if (cancelled || Date.now() >= expMs) return;
      const res = await projectorService.claim(deviceSecret);
      if (cancelled) return;

      if (res.status === 'approved' && res.viewToken) {
        setViewToken(res.viewToken);
        setIsLoadingSnapshot(true);
        setPairingCode(null);
        setDeviceSecret(null);
        setPairingExpiresAt(null);
      } else if (res.status === 'expired') {
        setPairingStatus('expired');
      }
    };

    const claimInterval = window.setInterval(() => {
      void pollClaim();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(countdownInterval);
      window.clearInterval(claimInterval);
    };
  }, [viewToken, pairingStatus, deviceSecret, pairingExpiresAt]);

  // Fetch full snapshot helper
  const fetchSnapshot = useCallback(
    async (token: string) => {
      if (isFetchingSnapshotRef.current) return;
      isFetchingSnapshotRef.current = true;
      try {
        const res = await projectorService.snapshot(token);
        if (res.ok && res.snapshot) {
          setSnapshot(res.snapshot);
          setIsBlank(Boolean(res.snapshot.isBlank));
          setIsReconnecting(false);
          setIsLoadingSnapshot(false);
        } else if (res.error === 'expired_or_revoked') {
          returnToPairing();
        } else {
          setIsReconnecting(true);
          setIsLoadingSnapshot(false);
        }
      } finally {
        isFetchingSnapshotRef.current = false;
      }
    },
    [returnToPairing]
  );

  // Paired display loop: initial snapshot + 5s fingerprint polling (paused when hidden)
  useEffect(() => {
    if (!viewToken) return;

    let cancelled = false;
    let pollTimer: number | null = null;

    const checkFingerprintAndSync = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;

      const fp = await projectorService.fingerprint(viewToken);
      if (cancelled) return;

      if (!fp.ok) {
        if (fp.error === 'expired_or_revoked') {
          returnToPairing();
        } else {
          setIsReconnecting(true);
        }
        return;
      }

      setIsReconnecting(false);
      if (fp.isBlank !== undefined) {
        setIsBlank(Boolean(fp.isBlank));
      }
      if (fp.version && fp.version !== lastVersionRef.current) {
        lastVersionRef.current = fp.version;
        await fetchSnapshot(viewToken);
      }
    };

    const startPolling = () => {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      pollTimer = window.setInterval(() => {
        void checkFingerprintAndSync();
      }, 5000);
    };

    const stopPolling = () => {
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    // Initial load: fetch snapshot and initial fingerprint
    void (async () => {
      const fp = await projectorService.fingerprint(viewToken);
      if (cancelled) return;
      if (!fp.ok && fp.error === 'expired_or_revoked') {
        returnToPairing();
        return;
      }
      if (fp.ok) {
        if (fp.isBlank !== undefined) {
          setIsBlank(Boolean(fp.isBlank));
        }
        if (fp.version) {
          lastVersionRef.current = fp.version;
        }
      }
      await fetchSnapshot(viewToken);
      if (!cancelled && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
        startPolling();
      }
    })();

    const handleVisibilityChange = () => {
      if (typeof document === 'undefined') return;
      if (document.visibilityState === 'visible') {
        void checkFingerprintAndSync();
        startPolling();
      } else {
        stopPolling();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [viewToken, fetchSnapshot, returnToPairing]);

  // Screen Wake Lock while display is active; re-acquire on visibilitychange
  useEffect(() => {
    if (!viewToken || !snapshot) return;
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;

    let released = false;
    const acquireWakeLock = async () => {
      if (released) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      try {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      } catch {
        // Fail silently if unsupported or denied
      }
    };

    void acquireWakeLock();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', onVisibility);
      try {
        if (wakeLockRef.current) {
          void wakeLockRef.current.release();
          wakeLockRef.current = null;
        }
      } catch {}
    };
  }, [viewToken, snapshot]);

  // Hide mouse cursor after 3 seconds of no movement in display mode
  useEffect(() => {
    if (!viewToken || !snapshot) {
      setIsCursorHidden(false);
      return;
    }

    const resetCursorTimer = () => {
      setIsCursorHidden(false);
      if (cursorTimerRef.current) window.clearTimeout(cursorTimerRef.current);
      cursorTimerRef.current = window.setTimeout(() => {
        setIsCursorHidden(true);
      }, 3000);
    };

    resetCursorTimer();
    window.addEventListener('mousemove', resetCursorTimer, { passive: true });
    window.addEventListener('mousedown', resetCursorTimer, { passive: true });

    return () => {
      if (cursorTimerRef.current) window.clearTimeout(cursorTimerRef.current);
      window.removeEventListener('mousemove', resetCursorTimer);
      window.removeEventListener('mousedown', resetCursorTimer);
    };
  }, [viewToken, snapshot]);

  // Format MM:SS countdown for pairing code
  const formattedCountdown = `${Math.floor(remainingSeconds / 60)}:${String(
    remainingSeconds % 60
  ).padStart(2, '0')}`;

  // 1. Display Mode (once view_token is approved and snapshot loaded)
  if (viewToken && snapshot) {
    return (
      <div className={`w-full min-h-screen select-none ${isCursorHidden ? 'cursor-none' : ''}`}>
        <PublicLeaderboard
          snapshot={snapshot}
          isReconnecting={isReconnecting}
          onExit={onExit}
        />
        {isBlank && (
          <div
            className="fixed inset-0 z-[120] bg-black"
            aria-label="Projector screen blanked"
          />
        )}
      </div>
    );
  }

  // 2. Loading initial snapshot after approval
  if (viewToken && isLoadingSnapshot) {
    return (
      <div className="min-h-screen w-full bg-stone-50 dark:bg-black text-zinc-950 dark:text-white flex flex-col items-center justify-center p-6 select-none">
        <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500 mb-4">
          <Monitor className="w-8 h-8 stroke-[2]" />
        </div>
        <p className="font-mono text-[clamp(0.9rem,1.2vw,1.35rem)] font-bold">
          Loading paired display...
        </p>
      </div>
    );
  }

  // 3. Network retry screen while view_token is valid but offline before first snapshot
  if (viewToken && !snapshot) {
    return (
      <div className="min-h-screen w-full bg-stone-50 dark:bg-black text-zinc-950 dark:text-white flex flex-col items-center justify-center p-6 text-center select-none">
        <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-amber-500 mb-4">
          <Monitor className="w-8 h-8 stroke-[2]" />
        </div>
        <h2 className="text-[clamp(1.25rem,2vw,2.2rem)] font-black tracking-tight">
          Reconnecting to stage
        </h2>
        <p className="text-[clamp(0.85rem,1.1vw,1.2rem)] text-zinc-500 dark:text-zinc-400 mt-2 max-w-md">
          Waiting for network connection to load standings.
        </p>
        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={() => void fetchSnapshot(viewToken)}
            className="min-h-[44px] px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
          >
            Retry now
          </button>
          <button
            type="button"
            onClick={returnToPairing}
            className="min-h-[44px] px-5 rounded-xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 font-bold text-sm cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
          >
            Pair again
          </button>
        </div>
      </div>
    );
  }

  // 4. Pairing Screen (No approved view_token)
  return (
    <div className="min-h-screen w-full bg-stone-50 dark:bg-black text-zinc-950 dark:text-white flex flex-col justify-between p-6 sm:p-10 select-none">
      <div className="w-full max-w-4xl mx-auto flex items-center justify-between">
        <button
          type="button"
          onClick={onExit}
          className="min-h-[44px] px-4 rounded-xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:text-zinc-950 dark:hover:text-white font-bold text-xs inline-flex items-center gap-2 cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back</span>
        </button>
        <span className="font-mono text-xs font-bold uppercase tracking-widest text-zinc-500">
          Projector Pairing
        </span>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center text-center max-w-2xl mx-auto w-full py-8">
        {/* Static Icon */}
        <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500 mb-6">
          <Monitor className="w-8 h-8 sm:w-10 sm:h-10 stroke-[2]" />
        </div>

        {pairingStatus === 'loading' && (
          <div className="space-y-3">
            <div className="font-mono text-[clamp(2.5rem,7vw,6rem)] font-black tracking-[0.2em] text-zinc-400">
              ------
            </div>
            <p className="text-[clamp(0.95rem,1.4vw,1.5rem)] text-zinc-500 dark:text-zinc-400 font-medium">
              Open FairJudge on your phone, go to Projector, enter this code.
            </p>
          </div>
        )}

        {pairingStatus === 'pending' && pairingCode && (
          <div className="space-y-5 w-full">
            <div
              aria-label="Projector pairing code"
              className="inline-block px-8 py-5 rounded-3xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 shadow-sm"
            >
              <div className="font-mono text-[clamp(3.2rem,9vw,7.5rem)] font-black tracking-[0.18em] leading-none tabular-nums text-zinc-950 dark:text-white pl-[0.18em]">
                {pairingCode}
              </div>
            </div>

            <p className="text-[clamp(1rem,1.5vw,1.65rem)] text-zinc-700 dark:text-zinc-300 font-semibold leading-snug">
              Open FairJudge on your phone, go to Projector, enter this code.
            </p>

            <div className="flex items-center justify-center gap-4 pt-2">
              <span className="font-mono text-[clamp(0.75rem,1vw,1rem)] text-zinc-500 tabular-nums">
                Expires in {formattedCountdown}
              </span>
              <button
                type="button"
                onClick={() => void requestNewPairingCode(true)}
                className="min-h-[44px] px-4 rounded-xl bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200 hover:border-emerald-500/50 font-bold text-xs inline-flex items-center gap-2 cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>New code</span>
              </button>
            </div>
          </div>
        )}

        {pairingStatus === 'expired' && (
          <div className="space-y-5">
            <div className="font-mono text-[clamp(1.75rem,4vw,3.5rem)] font-black tracking-tight text-amber-500">
              Code Expired
            </div>
            <p className="text-[clamp(0.95rem,1.3vw,1.4rem)] text-zinc-600 dark:text-zinc-400">
              Open FairJudge on your phone, go to Projector, enter this code.
            </p>
            <button
              type="button"
              onClick={() => void requestNewPairingCode(true)}
              className="min-h-[48px] px-6 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm inline-flex items-center gap-2 cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
            >
              <RefreshCw className="w-4 h-4" />
              <span>New code</span>
            </button>
          </div>
        )}

        {pairingStatus === 'error' && (
          <div className="space-y-4 max-w-md">
            <div className="inline-flex items-center gap-2 text-amber-500 font-bold text-sm">
              <AlertCircle className="w-4 h-4" />
              <span>{pairingError || 'Could not generate pairing code.'}</span>
            </div>
            <div>
              <button
                type="button"
                onClick={() => void requestNewPairingCode(true)}
                className="min-h-[48px] px-6 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm inline-flex items-center gap-2 cursor-pointer transition-opacity duration-150 motion-reduce:transition-none"
              >
                <RefreshCw className="w-4 h-4" />
                <span>New code</span>
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="w-full max-w-4xl mx-auto text-center">
        <span className="font-mono text-[11px] text-zinc-500">
          Fair Judge • Secured Read-Only Display
        </span>
      </div>
    </div>
  );
}

export { PublicLeaderboard };
export default ProjectorView;
