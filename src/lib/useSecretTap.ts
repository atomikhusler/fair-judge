import { useRef, useCallback } from 'react';

interface UseSecretTapOptions {
  requiredTaps?: number;
  windowMs?: number;
  onTrigger: () => void;
}

/**
 * Triggers `onTrigger` when tapped `requiredTaps` times within `windowMs`.
 * Keeps zero visual hints and cleans up old timestamps automatically.
 */
export function useSecretTap({
  requiredTaps = 5,
  windowMs = 2000,
  onTrigger,
}: UseSecretTapOptions) {
  const tapsRef = useRef<number[]>([]);

  return useCallback(() => {
    const now = Date.now();
    const recent = tapsRef.current.filter((t) => now - t <= windowMs);
    recent.push(now);

    if (recent.length >= requiredTaps) {
      tapsRef.current = [];
      onTrigger();
    } else {
      tapsRef.current = recent;
    }
  }, [requiredTaps, windowMs, onTrigger]);
}
