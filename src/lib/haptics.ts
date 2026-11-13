/**
 * Granular Haptics Engine for Fair Judge
 * Supports configurable strength: 'off' | 'low' (default) | 'medium' | 'strong'
 * Persisted in localStorage with real-time custom event broadcasting.
 */

export type HapticStrength = 'off' | 'low' | 'medium' | 'strong';

const HAPTIC_STORAGE_KEY = 'fairjudge_haptic_strength';
const ACTIVE_SESSION_STORAGE_KEY = 'fairjudge_active_session';

function getScopedHapticStorageKey(): string {
  if (typeof window === 'undefined') return HAPTIC_STORAGE_KEY;
  try {
    const raw = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
    if (!raw) return HAPTIC_STORAGE_KEY;
    const session = JSON.parse(raw);
    const role = session?.role;
    const orgId = typeof session?.org?.org_id === 'string' ? session.org.org_id.toUpperCase() : '';
    if (role === 'judge') {
      const judgeId = session?.judge?.id || 'default';
      return `${HAPTIC_STORAGE_KEY}_judge_${orgId || 'org'}_${judgeId}`;
    }
    if (role === 'organiser') {
      return `${HAPTIC_STORAGE_KEY}_organiser_${orgId || 'default'}`;
    }
  } catch {}
  return HAPTIC_STORAGE_KEY;
}

export function getHapticStrength(): HapticStrength {
  if (typeof window === 'undefined') return 'low';
  try {
    const stored = localStorage.getItem(getScopedHapticStorageKey());
    if (stored === 'off' || stored === 'low' || stored === 'medium' || stored === 'strong') {
      return stored;
    }
  } catch {}
  return 'low';
}

export function setHapticStrength(strength: HapticStrength): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(getScopedHapticStorageKey(), strength);
    window.dispatchEvent(new CustomEvent('fairjudge_haptic_change', { detail: strength }));
  } catch {}
}

export function triggerHaptic(type: 'tick' | 'submit' | 'tap' | 'success' | 'warning' | 'light' = 'tick'): void {
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
    if (type === 'tick' || type === 'tap' || type === 'light') {
      navigator.vibrate([Math.round(35 * m)]);
    } else if (type === 'submit') {
      navigator.vibrate([
        Math.round(30 * m),
        Math.round(40 * m),
        Math.round(60 * m),
      ]);
    } else if (type === 'success') {
      navigator.vibrate([
        Math.round(30 * m),
        Math.round(40 * m),
        Math.round(50 * m),
      ]);
    } else if (type === 'warning') {
      navigator.vibrate([
        Math.round(60 * m),
        Math.round(50 * m),
        Math.round(70 * m),
      ]);
    }
  } catch {}
}
