/**
 * Procedural Web Audio Sound Engine for Fair Judge (EPIC 16.8.7 Acoustic Chimes)
 * - Zero external audio assets (100% offline-safe, zero bundle bloat)
 * - Sine-partial bell & wood-block synthesis with low-pass warmth and room delay
 * - Scoped localStorage persistence matching src/lib/haptics.ts
 * - Safe against browser autoplay restrictions (no burst replay on late unlock)
 */

export type SoundLevel = 'off' | 'soft' | 'crisp';
export type ActiveSoundLevel = 'soft' | 'crisp';
export type SoundEvent =
  | 'boot'
  | 'launch'
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
  const hash = window.location.hash || '';
  return (
    hash === '#/projector-app' ||
    hash.startsWith('#/projector-app?') ||
    hash.startsWith('#/projector-app/')
  );
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
// Singleton Web Audio Graph (Dry Bus + 28ms/41ms Feedback Room Reverb)
// ---------------------------------------------------------------------------

let audioCtx: AudioContext | null = null;
let dryBus: GainNode | null = null;
let roomInput: GainNode | null = null;
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

    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(1, ctx.currentTime);
    masterGain.connect(compressor);
    compressor.connect(ctx.destination);

    const dry = ctx.createGain();
    dry.gain.setValueAtTime(1, ctx.currentTime);
    dry.connect(masterGain);

    // Short acoustic room: cross-coupled 28 ms and 41 ms delays, feedback 0.3, wet mix 0.18
    const roomIn = ctx.createGain();
    roomIn.gain.setValueAtTime(1, ctx.currentTime);

    const delayA = ctx.createDelay(0.2);
    delayA.delayTime.setValueAtTime(0.028, ctx.currentTime);

    const delayB = ctx.createDelay(0.2);
    delayB.delayTime.setValueAtTime(0.041, ctx.currentTime);

    const fbA = ctx.createGain();
    fbA.gain.setValueAtTime(0.3, ctx.currentTime);

    const fbB = ctx.createGain();
    fbB.gain.setValueAtTime(0.3, ctx.currentTime);

    const roomTapSum = ctx.createGain();
    roomTapSum.gain.setValueAtTime(0.5, ctx.currentTime);

    const wetMix = ctx.createGain();
    wetMix.gain.setValueAtTime(0.18, ctx.currentTime);

    roomIn.connect(delayA);
    roomIn.connect(delayB);

    delayA.connect(fbA);
    fbA.connect(delayB);
    delayB.connect(fbB);
    fbB.connect(delayA);

    delayA.connect(roomTapSum);
    delayB.connect(roomTapSum);
    roomTapSum.connect(wetMix);
    wetMix.connect(masterGain);

    audioCtx = ctx;
    dryBus = dry;
    roomInput = roomIn;
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
    if (!dryBus || !roomInput) return;
    launchChimePlayed = true;
    const scale = getSoundLevel() === 'crisp' ? 0.72 : 0.38;
    try {
      schedulePattern(targetCtx, SOUND_PATTERNS.launch, scale);
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

// ---------------------------------------------------------------------------
// Acoustic Partial Synthesis
// ---------------------------------------------------------------------------

interface PartialSpec {
  ratio: number;
  level: number;
  decayScale: number;
}

const BELL_PARTIALS: readonly PartialSpec[] = [
  { ratio: 1.0, level: 1.0, decayScale: 1.0 },
  { ratio: 2.0, level: 0.3, decayScale: 0.62 },
  { ratio: 2.76, level: 0.18, decayScale: 0.4 },
  { ratio: 5.4, level: 0.07, decayScale: 0.2 },
];

const WOOD_PARTIALS: readonly PartialSpec[] = [
  { ratio: 1.0, level: 1.0, decayScale: 1.0 },
  { ratio: 3.9, level: 0.25, decayScale: 0.65 },
];

interface NoteStep {
  freq: number;
  delay: number;
  decay: number;
  gain: number;
}

interface SoundPattern {
  voice: 'bell' | 'wood';
  lowpassHz: number;
  attackSec: number;
  notes: readonly NoteStep[];
}

function schedulePattern(ctx: AudioContext, pattern: SoundPattern, scale: number): void {
  if (!dryBus || !roomInput) return;

  const voiceFilter = ctx.createBiquadFilter();
  voiceFilter.type = 'lowpass';
  voiceFilter.frequency.setValueAtTime(pattern.lowpassHz, ctx.currentTime);
  voiceFilter.Q.setValueAtTime(0.707, ctx.currentTime);

  voiceFilter.connect(dryBus);
  voiceFilter.connect(roomInput);

  const partials = pattern.voice === 'wood' ? WOOD_PARTIALS : BELL_PARTIALS;
  const maxFreq = ctx.sampleRate * 0.48;
  const baseTime = ctx.currentTime;

  for (const note of pattern.notes) {
    const startAt = baseTime + note.delay;
    for (const partial of partials) {
      const freq = note.freq * partial.ratio;
      if (freq <= 0 || freq > maxFreq) continue;

      const partialDecay = Math.max(0.025, note.decay * partial.decayScale);
      const attack = Math.min(pattern.attackSec, partialDecay * 0.2);
      const peakGain = Math.max(0.0005, note.gain * partial.level * scale);
      const endAt = startAt + partialDecay;

      const osc = ctx.createOscillator();
      const env = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startAt);

      env.gain.setValueAtTime(0.0001, startAt);
      env.gain.linearRampToValueAtTime(peakGain, startAt + attack);
      env.gain.exponentialRampToValueAtTime(0.0001, endAt);
      env.gain.linearRampToValueAtTime(0, endAt + 0.015);

      osc.connect(env);
      env.connect(voiceFilter);

      osc.start(startAt);
      osc.stop(endAt + 0.02);
    }
  }
}

const LAUNCH_PATTERN: SoundPattern = {
  voice: 'bell',
  lowpassHz: 6500,
  attackSec: 0.005,
  notes: [
    { freq: 523.25, delay: 0, decay: 1.6, gain: 0.19 },
    { freq: 783.99, delay: 0.18, decay: 2.15, gain: 0.21 },
  ],
};

const SOUND_PATTERNS: Record<SoundEvent, SoundPattern> = {
  launch: LAUNCH_PATTERN,
  boot: LAUNCH_PATTERN,
  signin: {
    voice: 'bell',
    lowpassHz: 6500,
    attackSec: 0.005,
    notes: [{ freq: 880.0, delay: 0, decay: 1.4, gain: 0.21 }],
  },
  shutdown: {
    voice: 'bell',
    lowpassHz: 6500,
    attackSec: 0.005,
    notes: [
      { freq: 783.99, delay: 0, decay: 1.3, gain: 0.19 },
      { freq: 523.25, delay: 0.2, decay: 1.8, gain: 0.18 },
    ],
  },
  success: {
    voice: 'bell',
    lowpassHz: 6500,
    attackSec: 0.005,
    notes: [
      { freq: 659.25, delay: 0, decay: 0.9, gain: 0.18 },
      { freq: 987.77, delay: 0.12, decay: 1.2, gain: 0.2 },
    ],
  },
  notify: {
    voice: 'bell',
    lowpassHz: 6500,
    attackSec: 0.005,
    notes: [{ freq: 1318.5, delay: 0, decay: 0.9, gain: 0.17 }],
  },
  warning: {
    voice: 'bell',
    lowpassHz: 2200,
    attackSec: 0.006,
    notes: [
      { freq: 392.0, delay: 0, decay: 0.85, gain: 0.21 },
      { freq: 329.63, delay: 0.14, decay: 1.05, gain: 0.19 },
    ],
  },
  alert: {
    voice: 'bell',
    lowpassHz: 7800,
    attackSec: 0.004,
    notes: [
      { freq: 880.0, delay: 0, decay: 0.8, gain: 0.22 },
      { freq: 698.46, delay: 0.12, decay: 1.0, gain: 0.21 },
    ],
  },
  tap: {
    voice: 'wood',
    lowpassHz: 6500,
    attackSec: 0.004,
    notes: [{ freq: 1800.0, delay: 0, decay: 0.05, gain: 0.19 }],
  },
  tick: {
    voice: 'wood',
    lowpassHz: 6500,
    attackSec: 0.004,
    notes: [{ freq: 1800.0, delay: 0, decay: 0.05, gain: 0.15 }],
  },
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
    if (!launchCtx || !dryBus || !roomInput) return;

    if (launchCtx.state === 'running') {
      pendingLaunchChime = false;
      launchChimePlayed = true;
      const scale = level === 'crisp' ? 0.72 : 0.38;
      try {
        schedulePattern(launchCtx, SOUND_PATTERNS.launch, scale);
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
  if (!ctx || !dryBus || !roomInput) return;

  const scale = level === 'crisp' ? 0.72 : 0.38;
  const pattern = SOUND_PATTERNS[event];

  const trigger = () => {
    // Drop stale audio if browser delayed resume past 120ms (prevents queued bursts)
    if (isProjectorRouteActive() || Date.now() - nowMs > 120 || ctx.state !== 'running') return;
    try {
      schedulePattern(ctx, pattern, scale);
    } catch {}
  };

  if (ctx.state === 'running') {
    trigger();
  } else if (ctx.state === 'suspended') {
    ctx.resume().then(trigger).catch(() => {});
  }
}
