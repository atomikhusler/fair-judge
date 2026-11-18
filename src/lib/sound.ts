/**
 * Procedural Web Audio Sound Engine for Fair Judge (EPIC 16.3.3)
 * - Zero external audio assets (100% offline-safe, zero bundle bloat)
 * - Scoped localStorage persistence matching src/lib/haptics.ts
 * - Safe against browser autoplay restrictions (no burst replay on late unlock)
 */

export type SoundLevel = 'off' | 'soft' | 'crisp';
export type ActiveSoundLevel = 'soft' | 'crisp';
export type SoundEvent =
  | 'boot'
  | 'signin'
  | 'shutdown'
  | 'tap'
  | 'tick'
  | 'success'
  | 'warning'
  | 'alert'
  | 'notify';

const SOUND_STORAGE_KEY = 'fairjudge_sound_level';
const SOUND_LAST_ACTIVE_KEY = 'fairjudge_sound_last_active';
const ACTIVE_SESSION_STORAGE_KEY = 'fairjudge_active_session';

export const SOUND_CHANGE_EVENT = 'fairjudge_sound_change';

export function isProjectorRouteActive(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.hash.startsWith('#/projector')) return true;
  const params = new URLSearchParams(window.location.search);
  return params.get('view') === 'projector';
}

function isAdminRouteActive(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.hash.startsWith('#/admin');
}

function getScopedSoundStorageKey(): string {
  if (typeof window === 'undefined') return SOUND_STORAGE_KEY;
  if (isAdminRouteActive()) {
    return `${SOUND_STORAGE_KEY}_admin`;
  }
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (!raw) return SOUND_STORAGE_KEY;
    const session = JSON.parse(raw);
    const role = session?.role;
    const orgId =
      typeof session?.org?.org_id === 'string' ? session.org.org_id.toUpperCase() : '';
    if (role === 'judge') {
      const judgeId = session?.judge?.id || 'default';
      return `${SOUND_STORAGE_KEY}_judge_${orgId || 'org'}_${judgeId}`;
    }
    if (role === 'organiser') {
      return `${SOUND_STORAGE_KEY}_organiser_${orgId || 'default'}`;
    }
  } catch {}
  return SOUND_STORAGE_KEY;
}

function getScopedLastActiveKey(): string {
  return `${getScopedSoundStorageKey()}_last`;
}

export function getSoundLevel(): SoundLevel {
  if (typeof window === 'undefined') return 'soft';
  try {
    const stored = localStorage.getItem(getScopedSoundStorageKey());
    if (stored === 'off' || stored === 'soft' || stored === 'crisp') {
      return stored;
    }
  } catch {}
  return 'soft';
}

export function getLastActiveSoundLevel(): ActiveSoundLevel {
  if (typeof window === 'undefined') return 'soft';
  try {
    const stored =
      localStorage.getItem(getScopedLastActiveKey()) ||
      localStorage.getItem(SOUND_LAST_ACTIVE_KEY);
    if (stored === 'soft' || stored === 'crisp') {
      return stored;
    }
  } catch {}
  return 'soft';
}

export function isSoundMuted(): boolean {
  return getSoundLevel() === 'off';
}

export function setSoundLevel(level: SoundLevel): void {
  if (typeof window === 'undefined') return;
  if (level === 'off') {
    pendingLaunchChime = false;
  }
  try {
    localStorage.setItem(getScopedSoundStorageKey(), level);
    if (level === 'soft' || level === 'crisp') {
      localStorage.setItem(getScopedLastActiveKey(), level);
      localStorage.setItem(SOUND_LAST_ACTIVE_KEY, level);
    }
    window.dispatchEvent(new CustomEvent(SOUND_CHANGE_EVENT, { detail: level }));
  } catch {}
}

export function toggleSoundMute(): SoundLevel {
  const current = getSoundLevel();
  const next: SoundLevel = current === 'off' ? getLastActiveSoundLevel() : 'off';
  setSoundLevel(next);
  return next;
}

// ---------------------------------------------------------------------------
// Singleton Web Audio Graph
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let unlockAttached = false;
let lastTickAt = 0;
let pendingLaunchChime = false;
let launchChimePlayed = false;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioCtx) return audioCtx;

  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;

  try {
    const ctx = new Ctx();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.setValueAtTime(-16, ctx.currentTime);
    compressor.knee.setValueAtTime(18, ctx.currentTime);
    compressor.ratio.setValueAtTime(6, ctx.currentTime);
    compressor.attack.setValueAtTime(0.003, ctx.currentTime);
    compressor.release.setValueAtTime(0.15, ctx.currentTime);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1, ctx.currentTime);

    gain.connect(compressor);
    compressor.connect(ctx.destination);

    audioCtx = ctx;
    masterGain = gain;
    return ctx;
  } catch {
    return null;
  }
}

export function unlockSoundEngine(): void {
  if (typeof window === 'undefined' || unlockAttached) return;
  if (isProjectorRouteActive()) {
    pendingLaunchChime = false;
    return;
  }
  unlockAttached = true;

  const detachListeners = () => {
    window.removeEventListener('pointerdown', tryUnlock, true);
    window.removeEventListener('keydown', tryUnlock, true);
  };

  const playPendingLaunchIfReady = (targetCtx: AudioContext, shouldPlay: boolean) => {
    if (!shouldPlay || launchChimePlayed) return;
    if (isProjectorRouteActive() || getSoundLevel() === 'off' || targetCtx.state !== 'running') {
      return;
    }
    const dest = masterGain;
    if (!dest) return;
    launchChimePlayed = true;
    const scale = getSoundLevel() === 'crisp' ? 0.72 : 0.38;
    try {
      for (const step of SOUND_PATTERNS.boot) {
        scheduleTone(targetCtx, dest, step, scale);
      }
    } catch {}
  };

  const tryUnlock = () => {
    if (isProjectorRouteActive()) {
      pendingLaunchChime = false;
      detachListeners();
      unlockAttached = false;
      return;
    }
    if (getSoundLevel() === 'off') {
      pendingLaunchChime = false;
      return;
    }
    const shouldPlayLaunch = pendingLaunchChime && !launchChimePlayed;
    pendingLaunchChime = false;

    const ctx = getAudioContext();
    if (!ctx) return;

    if (ctx.state === 'suspended') {
      ctx
        .resume()
        .then(() => {
          if (ctx.state === 'running') {
            detachListeners();
            playPendingLaunchIfReady(ctx, shouldPlayLaunch);
          }
        })
        .catch(() => {});
    } else if (ctx.state === 'running') {
      detachListeners();
      playPendingLaunchIfReady(ctx, shouldPlayLaunch);
    }
  };

  window.addEventListener('pointerdown', tryUnlock, { passive: true, capture: true });
  window.addEventListener('keydown', tryUnlock, { passive: true, capture: true });
}

if (typeof window !== 'undefined') {
  unlockSoundEngine();
}

interface ToneStep {
  freq: number;
  endFreq?: number;
  type: OscillatorType;
  delay: number;
  duration: number;
  gain: number;
}

function scheduleTone(ctx: AudioContext, dest: AudioNode, step: ToneStep, scale: number): void {
  const startAt = ctx.currentTime + step.delay;
  const stopAt = startAt + step.duration + 0.02;
  const peakGain = Math.max(0.001, step.gain * scale);

  const osc = ctx.createOscillator();
  const env = ctx.createGain();

  osc.type = step.type;
  osc.frequency.setValueAtTime(step.freq, startAt);
  if (step.endFreq && step.endFreq > 0) {
    osc.frequency.exponentialRampToValueAtTime(step.endFreq, startAt + step.duration);
  }

  env.gain.setValueAtTime(0.0001, startAt);
  env.gain.linearRampToValueAtTime(peakGain, startAt + Math.min(0.008, step.duration * 0.25));
  env.gain.exponentialRampToValueAtTime(0.0001, startAt + step.duration);

  osc.connect(env);
  env.connect(dest);

  osc.start(startAt);
  osc.stop(stopAt);
}

const SOUND_PATTERNS: Record<SoundEvent, ToneStep[]> = {
  tick: [
    { freq: 1120, endFreq: 720, type: 'triangle', delay: 0, duration: 0.016, gain: 0.16 },
  ],
  tap: [
    { freq: 840, endFreq: 520, type: 'sine', delay: 0, duration: 0.024, gain: 0.2 },
  ],
  boot: [
    { freq: 523.25, type: 'sine', delay: 0, duration: 0.16, gain: 0.2 },
    { freq: 659.25, type: 'sine', delay: 0.06, duration: 0.18, gain: 0.22 },
  ],
  signin: [
    { freq: 659.25, type: 'sine', delay: 0, duration: 0.2, gain: 0.2 },
  ],
  shutdown: [
    { freq: 659.25, type: 'sine', delay: 0, duration: 0.12, gain: 0.18 },
    { freq: 440, endFreq: 329.63, type: 'sine', delay: 0.07, duration: 0.18, gain: 0.16 },
  ],
  success: [
    { freq: 659.25, type: 'sine', delay: 0, duration: 0.11, gain: 0.2 },
    { freq: 987.77, type: 'sine', delay: 0.07, duration: 0.18, gain: 0.22 },
  ],
  warning: [
    { freq: 392.0, type: 'triangle', delay: 0, duration: 0.1, gain: 0.22 },
    { freq: 349.23, type: 'triangle', delay: 0.11, duration: 0.14, gain: 0.22 },
  ],
  alert: [
    { freq: 880.0, type: 'sine', delay: 0, duration: 0.11, gain: 0.24 },
    { freq: 698.46, type: 'sine', delay: 0.11, duration: 0.11, gain: 0.22 },
    { freq: 880.0, type: 'triangle', delay: 0.22, duration: 0.18, gain: 0.22 },
  ],
  notify: [
    { freq: 1046.5, type: 'sine', delay: 0, duration: 0.16, gain: 0.18 },
  ],
};

export interface PlaySoundOptions {
  launch?: boolean;
}

export function playSound(event: SoundEvent, options?: PlaySoundOptions): void {
  if (isProjectorRouteActive()) {
    if (options?.launch) pendingLaunchChime = false;
    return;
  }

  const level = getSoundLevel();
  if (level === 'off') {
    if (options?.launch) pendingLaunchChime = false;
    return;
  }

  if (options?.launch) {
    if (launchChimePlayed) return;
    const launchCtx = getAudioContext();
    const launchDest = masterGain;
    if (!launchCtx || !launchDest) return;

    if (launchCtx.state === 'running') {
      pendingLaunchChime = false;
      launchChimePlayed = true;
      const scale = level === 'crisp' ? 0.72 : 0.38;
      try {
        for (const step of SOUND_PATTERNS.boot) {
          scheduleTone(launchCtx, launchDest, step, scale);
        }
      } catch {}
      return;
    }

    pendingLaunchChime = true;
    unlockSoundEngine();
    return;
  }

  const nowMs = Date.now();
  if (event === 'tick') {
    if (nowMs - lastTickAt < 35) return;
    lastTickAt = nowMs;
  }

  const ctx = getAudioContext();
  const dest = masterGain;
  if (!ctx || !dest) return;

  const scale = level === 'crisp' ? 0.72 : 0.38;
  const steps = SOUND_PATTERNS[event];

  const trigger = () => {
    // Drop stale audio if browser delayed resume past 120ms (prevents queued bursts)
    if (isProjectorRouteActive() || Date.now() - nowMs > 120 || ctx.state !== 'running') return;
    try {
      for (const step of steps) {
        scheduleTone(ctx, dest, step, scale);
      }
    } catch {}
  };

  if (ctx.state === 'running') {
    trigger();
  } else if (ctx.state === 'suspended') {
    ctx.resume().then(trigger).catch(() => {});
  }
}
