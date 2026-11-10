import React, { useState, useEffect } from 'react';
import { 
  Scale, 
  CircleUser, 
  Lock, 
  PauseCircle, 
  CheckCircle, 
  LogOut, 
  ChevronRight, 
  X, 
  ShieldCheck, 
  Calendar, 
  KeyRound, 
  Building2, 
  Sparkles 
} from 'lucide-react';
import { SupabaseJudge, SupabaseEvent, Organization } from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';
import { ThemeToggleButton } from '../../lib/theme';
import { PullToRefresh } from '../common/PullToRefresh';
import { flushOfflineQueueToSupabase } from '../../lib/offlineQueue';
import { showToast } from '../common/ToastProvider';

export interface JudgeLobbyProps {
  orgId: string;
  judge: SupabaseJudge;
  events: SupabaseEvent[];
  onSelectEvent: (event: SupabaseEvent) => void;
  onLogout: () => void;
  onSwitchToOrganiserView?: () => void;
}

export function JudgeLobby({
  orgId,
  judge,
  events,
  onSelectEvent,
  onLogout,
}: JudgeLobbyProps) {
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);

  useEffect(() => {
    dbService.getOrganizationByOrgId(orgId).then((org) => {
      if (org) setOrganization(org);
    });
  }, [orgId]);

  useEffect(() => {
    if (isAccountModalOpen || showLogoutConfirm) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [isAccountModalOpen, showLogoutConfirm]);

  const handleRefresh = async () => {
    try {
      await flushOfflineQueueToSupabase();
    } catch (err) {
      console.warn('Queue flush note:', err);
    }
    window.dispatchEvent(new CustomEvent('fairjudge_db_change', { detail: { table: 'all' } }));
    showToast('Event roster synchronized.');
  };

  const activeEventsCount = events.filter((e) => e.status === 'active').length;

  return (
    <div className="min-h-[100dvh] overflow-y-auto w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col items-center justify-start selection:bg-amber-500 selection:text-black transition-colors duration-200 relative">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full h-16 shrink-0 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md border-b border-stone-200 dark:border-zinc-800/80 px-4 flex items-center justify-between">
        <div className="flex items-center">
          <button
            type="button"
            onClick={handleRefresh}
            title="Refresh events"
            className="w-10 h-10 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-500 dark:text-amber-400 flex items-center justify-center shadow-xs shrink-0 active:scale-[0.97] transition-transform duration-75 cursor-pointer"
          >
            <Scale className="w-5 h-5 stroke-[2.2]" />
          </button>
        </div>

        <div className="flex flex-col items-center justify-center text-center px-2 min-w-0">
          <span className="text-base font-black tracking-tight text-zinc-900 dark:text-white truncate">
            Fair Judge
          </span>
          <span className="text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-widest truncate">
            {organization?.name || orgId}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggleButton />
          <button
            type="button"
            onClick={() => setIsAccountModalOpen(true)}
            title="Judge Account"
            className="w-9 h-9 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:text-amber-500 dark:hover:text-amber-400 transition-colors cursor-pointer"
          >
            <CircleUser className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setShowLogoutConfirm(true)}
            title="Logout"
            className="w-9 h-9 rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 flex items-center justify-center text-zinc-400 hover:text-rose-400 transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Content with PullToRefresh */}
      <PullToRefresh onRefresh={handleRefresh} className="w-full flex-1 max-w-lg mx-auto p-4 sm:p-6">
        <div className="w-full space-y-6">
          {/* Welcome Card */}
          <div className="p-5 rounded-3xl bg-white dark:bg-zinc-900/80 border border-stone-200 dark:border-zinc-800 shadow-md">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-500 dark:text-amber-400">
                  JURY CREDENTIAL ACTIVE
                </span>
                <h1 className="text-xl font-black text-zinc-900 dark:text-white mt-0.5">
                  {judge.name}
                </h1>
                <p className="text-xs text-zinc-500 font-mono mt-0.5">
                  Judge ID: {judge.judge_id || judge.id.slice(0, 8)}
                </p>
              </div>
              <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center font-mono font-bold text-sm">
                {activeEventsCount} Live
              </div>
            </div>
          </div>

          {/* Events List */}
          <div className="space-y-3">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-zinc-400">
                Assigned Competitions ({events.length})
              </h2>
            </div>

            {events.length === 0 ? (
              <div className="p-8 rounded-3xl bg-white dark:bg-zinc-900/40 border border-stone-200 dark:border-zinc-800 text-center">
                <Calendar className="w-8 h-8 text-zinc-400 mx-auto mb-2" />
                <p className="text-sm font-bold text-zinc-400">No events currently assigned</p>
                <p className="text-xs text-zinc-500 mt-1">
                  Contact your competition organizer to assign your jury seat.
                </p>
              </div>
            ) : (
              events.map((evt) => {
                const isActive = evt.status === 'active';
                const isPaused = evt.status === 'paused';
                const isConcluded = evt.status === 'ended';

                return (
                  <div
                    key={evt.id}
                    onClick={() => {
                      if (isActive) {
                        onSelectEvent(evt);
                      } else {
                        showToast(`Event "${evt.name}" is ${evt.status}. Only active events can be scored.`, 'warning');
                      }
                    }}
                    className={`p-4 rounded-2xl border transition-all cursor-pointer flex items-center justify-between ${
                      isActive
                        ? 'bg-white dark:bg-zinc-900 border-stone-200 dark:border-zinc-800 hover:border-amber-500/50 shadow-sm active:scale-[0.98]'
                        : 'bg-stone-100/50 dark:bg-zinc-900/30 border-stone-200/60 dark:border-zinc-800/40 opacity-70 cursor-not-allowed'
                    }`}
                  >
                    <div className="min-w-0 flex-1 mr-3">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            isActive
                              ? 'bg-amber-400 animate-pulse'
                              : isPaused
                              ? 'bg-yellow-500'
                              : 'bg-zinc-500'
                          }`}
                        />
                        <span className="text-[10px] font-mono uppercase font-bold text-zinc-400">
                          {evt.status}
                        </span>
                      </div>
                      <h3 className="text-base font-extrabold text-zinc-900 dark:text-white truncate mt-1">
                        {evt.name}
                      </h3>
                      <p className="text-xs text-zinc-500 truncate mt-0.5">
                        {evt.category || 'Standard Category'} • {evt.assigned_participants?.length || 0} competitors
                      </p>
                    </div>

                    <div className="shrink-0">
                      {isActive ? (
                        <div className="px-4 py-2 rounded-xl bg-amber-500 text-black font-extrabold text-xs shadow-md shadow-amber-500/20 flex items-center gap-1">
                          <span>Enter</span>
                          <ChevronRight className="w-4 h-4 stroke-[2.5]" />
                        </div>
                      ) : (
                        <div className="w-8 h-8 rounded-lg bg-stone-200 dark:bg-zinc-800 flex items-center justify-center text-zinc-500">
                          {isPaused ? <PauseCircle className="w-4 h-4" /> : <Lock className="w-4 h-4" />}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </PullToRefresh>

      {/* Account Modal */}
      {isAccountModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-sm rounded-3xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-black text-white">Judge Credential</h3>
              <button
                type="button"
                onClick={() => setIsAccountModalOpen(false)}
                className="w-8 h-8 rounded-full bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3 font-mono text-xs">
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block">Name</span>
                <span className="text-white font-bold text-sm">{judge.name}</span>
              </div>
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block">Judge ID</span>
                <span className="text-amber-400 font-bold">{judge.judge_id || judge.id}</span>
              </div>
              <div className="p-3 rounded-xl bg-zinc-950 border border-zinc-800">
                <span className="text-zinc-500 block">Organization</span>
                <span className="text-white font-bold">{organization?.name || orgId}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Logout Confirmation */}
      {showLogoutConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
          <div className="w-full max-w-sm rounded-3xl bg-zinc-900 border border-zinc-800 p-6 shadow-2xl text-center">
            <LogOut className="w-10 h-10 text-rose-400 mx-auto mb-3" />
            <h3 className="text-lg font-black text-white">Sign Out of Terminal?</h3>
            <p className="text-xs text-zinc-400 mt-1">
              You will need your 4-digit security PIN or QR pass to log in again.
            </p>
            <div className="flex gap-3 mt-6">
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 py-3 rounded-xl bg-zinc-800 text-zinc-300 font-bold text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowLogoutConfirm(false);
                  onLogout();
                }}
                className="flex-1 py-3 rounded-xl bg-rose-500 text-white font-bold text-xs"
              >
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
