import React, { useState, useEffect } from 'react';

export function NetworkStatusIndicator() {
  const [networkState, setNetworkState] = useState<'offline' | 'reconnected' | 'hidden'>(() => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return 'offline';
    }
    return 'hidden';
  });

  useEffect(() => {
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const handleOffline = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setNetworkState('offline');
    };

    const handleOnline = () => {
      // Transition to glowing green for 2 seconds when device reconnects
      setNetworkState('reconnected');
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        setNetworkState('hidden');
      }, 2000);
    };

    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  // Do not render any bar when online/reconnected to avoid any visible top green bar
  if (networkState !== 'offline') {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-2 left-1/2 -translate-x-1/2 z-[9999] pointer-events-none flex flex-col items-center select-none animate-in fade-in zoom-in-95 duration-200"
    >
      <div className="py-1 px-3 rounded-full bg-amber-500/95 text-white text-[11px] font-bold shadow-lg shadow-amber-900/30 flex items-center space-x-1.5 backdrop-blur-md">
        <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
        <span>Working Offline - Changes will sync automatically</span>
      </div>
    </div>
  );
}
