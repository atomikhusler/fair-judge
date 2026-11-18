import { useEffect, useRef } from 'react';

export interface UseTaskScreenBackGuardOptions {
  isOpen: boolean;
  onBack: () => void;
  hasNestedOverlay?: boolean;
  onCloseNested?: () => void;
}

/**
 * Shared browser/Android hardware back button guard for full-screen TaskScreen forms.
 * Pushes a synthetic history entry with the exact current URL (no hash modification)
 * so hashchange routing in App.tsx is never disturbed and closing via Save/Discard/<-
 * pops the guard entry cleanly without double history.back().
 */
export function useTaskScreenBackGuard({
  isOpen,
  onBack,
  hasNestedOverlay = false,
  onCloseNested,
}: UseTaskScreenBackGuardOptions): void {
  const onBackRef = useRef(onBack);
  const onCloseNestedRef = useRef(onCloseNested);
  const hasNestedRef = useRef(hasNestedOverlay);
  const isOpenRef = useRef(isOpen);

  isOpenRef.current = isOpen;
  hasNestedRef.current = hasNestedOverlay;
  onBackRef.current = onBack;
  onCloseNestedRef.current = onCloseNested;

  const guardIdRef = useRef<string | null>(null);
  const hasPushedEntryRef = useRef(false);
  const pushedHashRef = useRef<string>('');
  const rearmTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const pushGuardEntry = () => {
      if (hasPushedEntryRef.current) return;
      const guardId = `fj_ts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      guardIdRef.current = guardId;
      pushedHashRef.current = window.location.hash;
      const baseState =
        window.history.state && typeof window.history.state === 'object'
          ? window.history.state
          : {};
      try {
        window.history.pushState(
          { ...baseState, __fjTaskScreenGuard: guardId },
          '',
          window.location.href
        );
        hasPushedEntryRef.current = true;
      } catch {
        hasPushedEntryRef.current = false;
      }
    };

    const clearRearmTimer = () => {
      if (rearmTimerRef.current !== null) {
        window.clearTimeout(rearmTimerRef.current);
        rearmTimerRef.current = null;
      }
    };

    if (!isOpen) {
      clearRearmTimer();
      if (hasPushedEntryRef.current) {
        const expectedGuardId = guardIdRef.current;
        hasPushedEntryRef.current = false;
        guardIdRef.current = null;
        if (window.history.state?.__fjTaskScreenGuard === expectedGuardId) {
          window.history.back();
        }
      }
      return;
    }

    pushGuardEntry();

    const handlePopState = () => {
      if (!hasPushedEntryRef.current) return;

      // If hash changed, another route navigation occurred; release guard without blocking routing.
      if (window.location.hash !== pushedHashRef.current) {
        hasPushedEntryRef.current = false;
        guardIdRef.current = null;
        return;
      }

      // If our guard entry is still at the top of state, this popstate wasn't popping us.
      if (window.history.state?.__fjTaskScreenGuard === guardIdRef.current) {
        return;
      }

      hasPushedEntryRef.current = false;
      guardIdRef.current = null;

      if (hasNestedRef.current && onCloseNestedRef.current) {
        onCloseNestedRef.current();
      } else {
        onBackRef.current();
      }

      // If the screen stays open (e.g. unsaved dialog opened), re-arm the guard entry
      // so a subsequent hardware/browser Back press is also intercepted.
      clearRearmTimer();
      rearmTimerRef.current = window.setTimeout(() => {
        rearmTimerRef.current = null;
        if (isOpenRef.current && !hasPushedEntryRef.current) {
          pushGuardEntry();
        }
      }, 20);
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      clearRearmTimer();
      window.removeEventListener('popstate', handlePopState);
    };
  }, [isOpen]);

  // Clean up pushed entry if component unmounts while form is still open
  useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return;
      if (hasPushedEntryRef.current) {
        const expectedGuardId = guardIdRef.current;
        hasPushedEntryRef.current = false;
        guardIdRef.current = null;
        if (window.history.state?.__fjTaskScreenGuard === expectedGuardId) {
          window.history.back();
        }
      }
    };
  }, []);
}
