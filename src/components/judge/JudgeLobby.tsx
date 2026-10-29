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

interface JudgeLobbyProps {
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
  // Organization state for header subtitle
  const [organization, setOrganization] = useState<Organization | null>(null);

  // Modal & Toast states
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Load organization details
  useEffect(() => {
    dbService.getOrganizationByOrgId(orgId).then((org) => {
      if (org) setOrganization(org);
    });
  }, [orgId]);

  // Modal Scroll Lock: lock document.body scroll when Account modal or logout confirm is open
  useEffect(() => {
    if (isAccountModalOpen || showLogoutConfirm) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [isAccountModalOpen, showLogoutConfirm]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleRefresh = async () => {
    window.dispatchEvent(new CustomEvent('fairjudge_db_change', { detail: { table: 'all' } }));
    await new Promise((r) => setTimeout(r, 600));
  };

  const activeEventsCount = events.filter((e) => e.status === 'active').length;

  return (
    <div className="min-h-[100dvh] overflow-y-auto w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col items-center justify-start selection:bg-emerald-500 selection:text-white transition-colors duration-200 relative">
      
      {/* Floating Toast Notification (pointer-events-none to prevent touch intercept) */}
      {toastMessage ? (
        <div className="fixed top-4 left-4 right-4 z-50 p-3.5 bg-zinc-900/95 text-white border border-zinc-700 rounded-2xl shadow-2xl flex items-center space-x-2.5 text-xs font-semibold backdrop-blur-md animate-fade-in pointer-events-none">
          <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      ) : null}

      {/* ======================================================== */}
      {/* PART 4: THE JUDGE LOBBY - HEADER                         */}
      {/* ======================================================== */}
      <header className="sticky top-0 z-50 w-full h-16 shrink-0 bg-stone-50/95 dark:bg-black/95 backdrop-blur-md border-b border-stone-200 dark:border-zinc-800/80 px-4 flex items-center justify-between">
        {/* Left: App Logo (Scale icon) with refresh on click */}
        <div className="flex items-center">
          <button
            type="button"
            onClick={handleRefresh}
            title="Refresh events"
            className="w-10 h-10 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shadow-sm shrink-0 transition-all active:scale-95 cursor-pointer"
          >
            <Scale className="w-5 h-5 stroke-[2.2]" />
          </button>
        </div>

        {/* Center (Stacked): Fair Judge (Bold) on top, {organization.name} (Small, uppercase, muted) underneath */}
        <div className="flex flex-col items-center justify-center text-center px-2 min-w-0">
          <span className="text-sm font-extrabold text-zinc-900 dark:text-white tracking-tight leading-none">
            Fair Judge
          </span>
          <span className="text-[10px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mt-1 truncate max-w-[190px] sm:max-w-xs">
            {organization?.name || orgId}
          </span>
        </div>

        {/* Right: The Theme toggle (Sun/Moon) placed immediately to the left of the Account icon */}
        <div className="flex items-center space-x-2">
          <ThemeToggleButton />
          <button
            onClick={() => setIsAccountModalOpen(true)}
            className="w-10 h-10 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 flex items-center justify-center transition-colors active:scale-95 cursor-pointer shadow-xs"
            title="Judge Account & Session"
            aria-label="Judge Account"
          >
            <CircleUser className="w-5 h-5 stroke-[2]" />
          </button>
        </div>
      </header>

      {/* Standalone VIP Judge Pill: Just below the header (No rogue margins or flex-1) */}
      <div className="w-full flex justify-center pt-4 pb-1 px-4 shrink-0 pointer-events-none">
        <div className="inline-flex items-center space-x-2 px-4 py-1.5 rounded-full bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 shadow-sm text-xs font-bold text-zinc-800 dark:text-zinc-200 select-none pointer-events-auto">
          <span className="text-sm leading-none">⚖️</span>
          <span>{judge.name.startsWith('Judge') ? judge.name : `Judge ${judge.name}`}</span>
        </div>
      </div>

      {/* ======================================================== */}
      {/* ASSIGNED EVENTS FEED WITH GENEROUS pb-40                 */}
      {/* ======================================================== */}
      <main className="w-full max-w-lg px-4 pt-3 pb-40 space-y-4 relative z-10">
          <div className="flex items-center justify-between px-1">
            <div>
              <h2 className="text-xs font-black text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                Assigned Events ({events.length})
              </h2>
              {activeEventsCount > 0 && (
                <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-bold mt-0.5">
                  {activeEventsCount} {activeEventsCount === 1 ? 'event is' : 'events are'} currently live
                </p>
              )}
            </div>
          </div>

          {events.length === 0 ? (
            <div className="p-8 bg-white dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 rounded-3xl text-center space-y-3 shadow-sm">
              <div className="w-12 h-12 rounded-2xl bg-stone-100 dark:bg-zinc-900 flex items-center justify-center mx-auto text-zinc-400">
                <Lock className="w-6 h-6" />
              </div>
              <h3 className="text-sm font-bold text-zinc-800 dark:text-zinc-200">
                No Events Assigned Yet
              </h3>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 max-w-xs mx-auto leading-relaxed">
                Your scoring profile is active. Please ask the event organiser to assign your terminal to an event.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {events.map((event) => {
                const isDraft = event.status === 'draft' || event.status === 'upcoming';
                const isActive = event.status === 'active';
                const isPaused = event.status === 'paused';
                const isEnded = event.status === 'ended' || event.status === 'archived';

                return (
                  <div
                    key={event.id}
                    onClick={() => {
                      if (isActive) {
                        onSelectEvent(event);
                      } else {
                        showToast(`Access Restricted: "${event.name}" is ${event.status}. Only active events can be evaluated.`);
                      }
                    }}
                    className={`w-full p-4 sm:p-5 rounded-3xl border transition-all text-left relative overflow-hidden ${
                      isActive
                        ? 'bg-white dark:bg-zinc-950 border-stone-200 dark:border-zinc-800 hover:border-emerald-500/50 hover:bg-stone-50 dark:hover:bg-zinc-900/40 cursor-pointer shadow-md active:scale-[0.98]'
                        : 'bg-white/50 dark:bg-zinc-950/40 border-stone-200/50 dark:border-zinc-900/60 cursor-not-allowed opacity-65'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-mono font-bold text-zinc-400 uppercase tracking-wider">
                        {event.category || 'General Stage'}
                      </span>
                      <div>
                        {isActive && (
                          <span className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-[10px] font-black bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 shadow-sm">
                            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                            <span>LIVE NOW</span>
                          </span>
                        )}
                        {isDraft && (
                          <span className="inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full text-[10px] font-semibold bg-stone-100 dark:bg-zinc-900 text-zinc-500 border border-stone-200 dark:border-zinc-800">
                            <Lock className="w-3 h-3 text-zinc-400" />
                            <span>Awaiting Start</span>
                          </span>
                        )}
                        {isPaused && (
                          <span className="inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                            <PauseCircle className="w-3 h-3" />
                            <span>Paused</span>
                          </span>
                        )}
                        {isEnded && (
                          <span className="inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-stone-100 dark:bg-zinc-900 text-zinc-400 border border-stone-200 dark:border-zinc-800">
                            <CheckCircle className="w-3 h-3 text-zinc-400" />
                            <span>Concluded</span>
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-base font-extrabold text-zinc-900 dark:text-white tracking-tight truncate">
                          {event.name}
                        </h3>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 flex items-center gap-1.5 font-medium">
                          <span>{event.rubric_schema?.length || event.rubric?.length || 0} Criteria</span>
                          <span>•</span>
                          <span>{event.assigned_participants?.length || 0} Competitors</span>
                        </p>
                      </div>

                      {isActive ? (
                        <div className="shrink-0">
                          <span className="inline-flex items-center space-x-1 px-3.5 py-2 rounded-xl bg-emerald-600 dark:bg-emerald-500 text-white text-xs font-bold shadow-md shadow-emerald-900/20 transition-all">
                            <span>Enter Stage</span>
                            <ChevronRight className="w-4 h-4 stroke-[2.5]" />
                          </span>
                        </div>
                      ) : (
                        <div className="p-2 text-zinc-400 shrink-0">
                          <Lock className="w-4 h-4" />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </main>

        {/* ======================================================== */}
        {/* PART 3: THE JUDGE ACCOUNT MODAL (Grouped Cards)          */}
        {/* ======================================================== */}
        {isAccountModalOpen ? (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 pointer-events-auto">
            {/* Backdrop */}
            <div 
              onClick={() => setIsAccountModalOpen(false)}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
            />

            {/* Modal Dialog */}
            <div className="relative w-full max-w-sm bg-stone-100/90 dark:bg-zinc-950 text-zinc-900 dark:text-white border border-stone-200 dark:border-zinc-800 rounded-3xl shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 select-none">
              
              {/* Modal Header */}
              <div className="px-5 py-4 shrink-0 flex items-center justify-between border-b border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/60">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 flex items-center justify-center">
                    <CircleUser className="w-5 h-5 stroke-[2.2]" />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                      Judge Terminal
                    </h3>
                    <p className="text-[11px] text-zinc-500 font-mono font-medium">
                      Active VIP Session
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => setIsAccountModalOpen(false)}
                  className="w-9 h-9 flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-white rounded-xl bg-stone-100 dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 transition-colors cursor-pointer"
                  aria-label="Close modal"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Grouped Details Card */}
              <div className="p-4 space-y-3">
                <div className="bg-white dark:bg-zinc-900/80 rounded-2xl border border-stone-200 dark:border-zinc-800/80 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60 text-xs">
                  {/* Name Row */}
                  <div className="p-3.5 flex items-center justify-between">
                    <span className="text-zinc-500 font-medium">Judge Name</span>
                    <span className="font-extrabold text-zinc-900 dark:text-white text-sm">
                      {judge.name}
                    </span>
                  </div>

                  {/* ID / PIN Row */}
                  <div className="p-3.5 flex items-center justify-between">
                    <span className="text-zinc-500 font-medium">Terminal PIN / ID</span>
                    <span className="font-mono font-bold text-blue-600 dark:text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-lg border border-blue-500/20">
                      PIN: {judge.pin || judge.judge_pin || '••••'}
                    </span>
                  </div>

                  {/* Organization Row */}
                  <div className="p-3.5 flex items-center justify-between">
                    <span className="text-zinc-500 font-medium">Organization</span>
                    <span className="font-mono font-bold text-zinc-800 dark:text-zinc-200">
                      {orgId}
                    </span>
                  </div>

                  {/* Assigned Events Count */}
                  <div className="p-3.5 flex items-center justify-between">
                    <span className="text-zinc-500 font-medium">Assigned Events</span>
                    <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                      {events.length} Events
                    </span>
                  </div>

                  {/* Display Mode Toggle */}
                  <div className="p-3.5 flex items-center justify-between">
                    <span className="text-zinc-500 font-medium">Interface Theme</span>
                    <ThemeToggleButton />
                  </div>
                </div>

                {/* Bold Red Logout Button */}
                <button
                  type="button"
                  onClick={() => {
                    setIsAccountModalOpen(false);
                    setShowLogoutConfirm(true);
                  }}
                  className="w-full p-4 rounded-2xl bg-red-500/10 hover:bg-red-500/20 text-red-600 dark:text-red-500 border border-red-500/25 flex items-center justify-between font-bold text-sm transition-all active:scale-[0.98] cursor-pointer shadow-sm group"
                >
                  <div className="flex items-center space-x-2">
                    <LogOut className="w-4 h-4 text-red-500 group-hover:-translate-x-0.5 transition-transform" />
                    <span>Sign Out of Terminal</span>
                  </div>
                  <ChevronRight className="w-4 h-4 opacity-50" />
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* ======================================================== */}
        {/* CUSTOM FRAMER-STYLE LOGOUT CONFIRMATION POPUP            */}
        {/* ======================================================== */}
        {showLogoutConfirm ? (
          <div className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-in fade-in duration-150 pointer-events-auto">
            <div className="bg-white dark:bg-zinc-950 border border-red-500/30 rounded-3xl max-w-sm w-full p-6 space-y-4 shadow-2xl animate-in zoom-in-95 select-none">
              <div className="flex items-center space-x-3 text-red-600 dark:text-red-500">
                <div className="w-11 h-11 rounded-2xl bg-red-500/15 border border-red-500/20 flex items-center justify-center">
                  <LogOut className="w-5 h-5 stroke-[2.2]" />
                </div>
                <div>
                  <h3 className="text-base font-extrabold text-zinc-900 dark:text-white leading-tight">
                    Sign Out of Terminal?
                  </h3>
                  <p className="text-xs text-red-600 dark:text-red-400 font-mono">
                    End judging session
                  </p>
                </div>
              </div>

              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed">
                Are you sure you want to exit your judging session, <strong className="text-zinc-900 dark:text-white">{judge.name}</strong>? Any unsubmitted scores will be discarded, but all previously submitted ballots remain locked in the audit ledger.
              </p>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowLogoutConfirm(false)}
                  className="min-h-[44px] bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-xs font-bold rounded-xl active:scale-95 transition-all cursor-pointer border border-stone-200 dark:border-zinc-800"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowLogoutConfirm(false);
                    onLogout();
                  }}
                  className="min-h-[44px] bg-red-600 hover:bg-red-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-red-600/25 active:scale-95 transition-all cursor-pointer flex items-center justify-center space-x-1.5"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Confirm Sign Out</span>
                </button>
              </div>
            </div>
          </div>
        ) : null}

    </div>
  );
}
