/**
 * Granular Haptics Engine for Fair Judge
 * Supports configurable strength: 'off' | 'low' (default) | 'medium' | 'strong'
 * Persisted in localStorage with real-time custom event broadcasting.
 */

export type HapticStrength = 'off' | 'low' | 'medium' | 'strong';

const HAPTIC_STORAGE_KEY = 'fairjudge_haptic_strength';

export function getHapticStrength(): HapticStrength {
  if (typeof window === 'undefined') return 'low';
  try {
    const stored = localStorage.getItem(HAPTIC_STORAGE_KEY);
    if (stored === 'off' || stored === 'low' || stored === 'medium' || stored === 'strong') {
      return stored;
    }
  } catch {}
  return 'low';
}

export function setHapticStrength(strength: HapticStrength): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(HAPTIC_STORAGE_KEY, strength);
    window.dispatchEvent(new CustomEvent('fairjudge_haptic_change', { detail: strength }));
  } catch {}
}

export function triggerHaptic(type: 'tick' | 'submit' | 'tap' = 'tick'): void {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  const strength = getHapticStrength();
  if (strength === 'off') return;

  const multipliers: Record<HapticStrength, number> = {
    off: 0,
    low: 0.6,
    medium: 1.0,
    strong: 1.6,
  };
  const m = multipliers[strength];

  try {
    if (type === 'tick' || type === 'tap') {
      navigator.vibrate([Math.round(35 * m)]);
    } else if (type === 'submit') {
      navigator.vibrate([
        Math.round(30 * m),
        Math.round(40 * m),
        Math.round(60 * m),
      ]);
    }
  } catch {}
}
