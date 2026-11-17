/**
 * Organiser Device Identity & Compact Label Builder (Epic 16.5.0)
 * - Stores an opaque UUID in localStorage so this browser has a stable device_id.
 * - Derives a short human-readable browser + OS label without storing the raw User-Agent.
 */

export const DEVICE_ID_STORAGE_KEY = 'fairjudge_device_id';

function createDeviceUuid(): string {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function getOrCreateDeviceId(): string {
  try {
    if (typeof localStorage !== 'undefined') {
      const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY)?.trim();
      if (existing && existing.length >= 8 && existing.length <= 128) {
        return existing;
      }
      const next = createDeviceUuid();
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, next);
      return next;
    }
  } catch {
    // Storage restricted (private browsing / non-DOM test environment)
  }
  return createDeviceUuid();
}

export function buildDeviceLabel(userAgentInput?: string, maxTouchPointsInput?: number): string {
  const ua =
    typeof userAgentInput === 'string'
      ? userAgentInput
      : typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? navigator.userAgent
        : '';

  if (!ua.trim()) {
    return 'Web browser';
  }

  const maxTouch =
    typeof maxTouchPointsInput === 'number'
      ? maxTouchPointsInput
      : typeof navigator !== 'undefined' && typeof navigator.maxTouchPoints === 'number'
        ? navigator.maxTouchPoints
        : 0;

  let os = 'Unknown OS';
  if (/iPad/i.test(ua) || (/Macintosh/i.test(ua) && maxTouch > 1)) {
    os = 'iPadOS';
  } else if (/iPhone|iPod/i.test(ua)) {
    os = 'iOS';
  } else if (/Android/i.test(ua)) {
    os = 'Android';
  } else if (/Windows/i.test(ua)) {
    os = 'Windows';
  } else if (/CrOS/i.test(ua)) {
    os = 'ChromeOS';
  } else if (/Mac OS X|Macintosh/i.test(ua)) {
    os = 'macOS';
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
  }

  let browser = 'Browser';
  if (/EdgA\/|EdgiOS\/|Edg\//i.test(ua)) {
    browser = 'Edge';
  } else if (/OPR\/|Opera/i.test(ua)) {
    browser = 'Opera';
  } else if (/SamsungBrowser\//i.test(ua)) {
    browser = 'Samsung Internet';
  } else if (/FxiOS\/|Firefox\//i.test(ua)) {
    browser = 'Firefox';
  } else if (/CriOS\/|Chrome\//i.test(ua)) {
    browser = 'Chrome';
  } else if (/Safari\//i.test(ua) && !/Chrome\/|CriOS\/|Chromium\//i.test(ua)) {
    browser = 'Safari';
  }

  if (browser === 'Browser' && os === 'Unknown OS') {
    return 'Web browser';
  }
  if (os === 'Unknown OS') {
    return browser;
  }
  return `${browser} on ${os}`;
}

export function formatSessionTimestamp(iso?: string): string {
  if (!iso) return 'Unknown';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'Unknown';

  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

