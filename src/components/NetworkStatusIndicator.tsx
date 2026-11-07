import React, { useState, useEffect } from 'react';
import { WifiOff, RefreshCw } from 'lucide-react';
import { subscribeToQueueChanges, getPendingCount } from '../lib/offlineQueue';

export function NetworkStatusIndicator() {
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const unsub = subscribeToQueueChanges(() => {
      getPendingCount().then((count) => setPendingCount(count));
    });

    getPendingCount().then((count) => setPendingCount(count));

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      unsub();
    };
  }, []);

  if (isOnline && pendingCount === 0) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[9990] pointer-events-none select-none max-w-xs w-auto animate-fade-in"
    >
      {!isOnline ? (
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-400 text-xs font-semibold backdrop-blur-md shadow-lg">
          <WifiOff className="w-3.5 h-3.5" />
          <span>Offline Mode ({pendingCount} queued)</span>
        </div>
      ) : pendingCount > 0 ? (
        <div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-400 text-xs font-semibold backdrop-blur-md shadow-lg">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          <span>Syncing {pendingCount} offline change{pendingCount > 1 ? 's' : ''}...</span>
        </div>
      ) : null}
    </div>
  );
}
