import React, { useState, useEffect, useCallback } from 'react';
import { 
  getPendingCount, 
  subscribeToQueueChanges, 
  flushOfflineQueueToSupabase 
} from '../../lib/offlineQueue';
import { eventBus, SyncStatusPayload } from '../../lib/eventBus';
import { Cloud, CloudOff, RefreshCw, CheckCircle2, ChevronRight, X } from 'lucide-react';

interface OfflineTelemetryProps {
  className?: string;
  compact?: boolean;
}

export function OfflineTelemetry({ className = '', compact = false }: OfflineTelemetryProps) {
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [syncState, setSyncState] = useState<'synced' | 'syncing' | 'offline'>('synced');
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [isManualSyncing, setIsManualSyncing] = useState(false);

  // Refresh counts and sync state
  const refreshStatus = useCallback(async () => {
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    setIsOnline(online);
    const count = await getPendingCount();
    setPendingCount(count);

    if (!online || count > 0) {
      setSyncState('offline');
    } else {
      setSyncState('synced');
    }
  }, []);

  useEffect(() => {
    refreshStatus();

    const handleOnline = () => {
      setIsOnline(true);
      setSyncState('syncing');
      flushOfflineQueueToSupabase().finally(() => {
        refreshStatus();
      });
    };

    const handleOffline = () => {
      setIsOnline(false);
      setSyncState('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const unsubQueue = subscribeToQueueChanges(() => {
      refreshStatus();
    });

    const unsubBus = eventBus.on('sync_status', (payload: SyncStatusPayload) => {
      if (payload.status === 'syncing') {
        setSyncState('syncing');
      } else if (payload.status === 'synced') {
        setSyncState('synced');
        if (payload.pendingCount !== undefined) {
          setPendingCount(payload.pendingCount);
        }
      } else if (payload.status === 'offline') {
        setSyncState('offline');
        if (payload.pendingCount !== undefined) {
          setPendingCount(payload.pendingCount);
        }
      }
    });

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      unsubQueue();
      unsubBus();
    };
  }, [refreshStatus]);

  const handleManualSync = async () => {
    if (isManualSyncing) return;
    setIsManualSyncing(true);
    setSyncState('syncing');
    try {
      await flushOfflineQueueToSupabase();
    } finally {
      setIsManualSyncing(false);
      await refreshStatus();
    }
  };

  // State colors and labels
  const isSyncing = syncState === 'syncing' || isManualSyncing;
  const isOffline = !isOnline || pendingCount > 0;

  return (
    <>
      {/* Telemetry Status Pill */}
      <button
        type="button"
        onClick={() => setIsDetailsOpen(true)}
        className={`group relative flex items-center gap-1.5 px-2.5 py-1 rounded-full border transition-all duration-200 cursor-pointer select-none ${
          isSyncing
            ? 'bg-blue-500/10 border-blue-500/30 text-blue-400 hover:bg-blue-500/20'
            : isOffline
            ? 'bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20 shadow-sm shadow-amber-950/20'
            : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20'
        } ${className}`}
        title="Offline Ledger Health & Sync Telemetry"
      >
        {/* Status Dot / Spinner */}
        <span className="relative flex h-2 w-2 shrink-0">
          {isSyncing ? (
            <span className="animate-spin rounded-full h-2 w-2 border-2 border-blue-400 border-t-transparent" />
          ) : isOffline ? (
            <>
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-400" />
            </>
          ) : (
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
          )}
        </span>

        {/* Text Label */}
        <span className="text-[11px] font-bold tracking-tight uppercase whitespace-nowrap">
          {isSyncing
            ? 'Syncing...'
            : isOffline
            ? !isOnline
              ? pendingCount > 0
                ? `Offline: ${pendingCount} queued`
                : 'Offline'
              : `${pendingCount} queued`
            : compact
            ? 'Synced'
            : 'Cloud Synced'}
        </span>
      </button>

      {/* Slide-over or Modal Details Sheet */}
      {isDetailsOpen && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            className="w-full max-w-sm rounded-3xl bg-zinc-950 border border-zinc-800 p-5 shadow-2xl text-white relative animate-in zoom-in-95 duration-200"
            role="dialog"
            aria-modal="true"
          >
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2">
                <div
                  className={`w-8 h-8 rounded-xl flex items-center justify-center ${
                    isOffline ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'
                  }`}
                >
                  {isOffline ? <CloudOff className="w-4 h-4" /> : <Cloud className="w-4 h-4" />}
                </div>
                <div>
                  <h3 className="text-sm font-bold tracking-tight">Offline Sync Telemetry</h3>
                  <p className="text-[11px] text-zinc-400 font-medium">Local Ledger &amp; Cloud Bridge</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsDetailsOpen(false)}
                className="w-7 h-7 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="py-4 space-y-3">
              <div className="flex items-center justify-between p-3 rounded-2xl bg-zinc-900/70 border border-zinc-800/80">
                <span className="text-xs text-zinc-400">Network Connectivity</span>
                <span className="flex items-center gap-1.5 text-xs font-bold">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      isOnline ? 'bg-emerald-400' : 'bg-rose-400'
                    }`}
                  />
                  {isOnline ? 'Online (Wi-Fi/Cellular)' : 'Disconnected (Offline)'}
                </span>
              </div>

              <div className="flex items-center justify-between p-3 rounded-2xl bg-zinc-900/70 border border-zinc-800/80">
                <span className="text-xs text-zinc-400">Queued Mutations</span>
                <span
                  className={`text-xs font-mono font-bold ${
                    pendingCount > 0 ? 'text-amber-400' : 'text-emerald-400'
                  }`}
                >
                  {pendingCount} record{pendingCount !== 1 ? 's' : ''} in IndexedDB
                </span>
              </div>

              <div className="p-3 rounded-2xl bg-zinc-900/40 border border-zinc-800/50 text-[11px] text-zinc-400 leading-relaxed">
                {pendingCount > 0
                  ? 'All local creations and edits are securely cached in IndexedDB. They will automatically flush to Supabase the moment your connection restores.'
                  : 'All local scores, events, and participant registries are fully synchronized with the cloud database.'}
              </div>
            </div>

            <div className="pt-2 flex gap-2">
              <button
                type="button"
                disabled={!isOnline || isSyncing}
                onClick={handleManualSync}
                className="flex-1 py-2.5 px-4 rounded-xl font-bold text-xs bg-emerald-500 hover:bg-emerald-400 text-black flex items-center justify-center gap-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                {isSyncing ? 'Syncing...' : 'Force Cloud Sync'}
              </button>
              <button
                type="button"
                onClick={() => setIsDetailsOpen(false)}
                className="py-2.5 px-4 rounded-xl font-semibold text-xs bg-zinc-900 hover:bg-zinc-800 text-zinc-300 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
