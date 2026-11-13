import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { 
  Scale,
  CircleUser, 
  Lock, 
  PauseCircle, 
  CheckCircle, 
  CheckCircle2,
  LogOut, 
  ChevronRight, 
  X,
  ShieldCheck,
  Calendar,
  KeyRound,
  Building2,
  Sparkles,
  Download,
  AlertTriangle
} from 'lucide-react';
import { SupabaseJudge, SupabaseEvent, Organization } from '../../lib/supabaseTypes';
import { dbService } from '../../lib/supabase';
import { ThemeToggleButton } from '../../lib/theme';
import { PullToRefresh } from '../common/PullToRefresh';
import { flushOfflineQueueToSupabase, downloadDiagnosticLog, getPendingScores, getPendingMutations } from '../../lib/offlineQueue';
import { showToast } from '../common/ToastProvider';
import { getHapticStrength, setHapticStrength, triggerHaptic, HapticStrength } from '../../lib/haptics';
import { APP_VERSION } from '../../config/version';
import { SignatureHardware } from '../shared/SignatureHardware';
import {
  PlatformAnnouncement,
  fetchActiveAnnouncements,
  dismissNotice,
} from '../../lib/announcements';
import { AnnouncementBanner } from '../common/AnnouncementBanner';
import { OrgBlockedScreen } from '../common/OrgBlockedScreen';
import { eventBus } from '../../lib/eventBus';

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
  const [announcements, setAnnouncements] = useState<PlatformAnnouncement[]>([]);
  const [blockedMode, setBlockedMode] = useState<'suspended' | 'deleted' | null>(null);

  // Modal states
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [hapticSetting, setHapticSetting] = useState<HapticStrength>(getHapticStrength);

  // 5-Tap Intelligent Diagnostic State (EPIC 15.1)
  const [diagTapCount, setDiagTapCount] = useState(0);
  const [diagUnlocked, setDiagUnlocked] = useState(false);
  const [diagAnimating, setDiagAnimating] = useState(false);
  const [diagQueuePending, setDiagQueuePending] = useState<number | null>(null);
  const [isDownloadingLog, setIsDownloadingLog] = useState(false);
  const diagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleVersionTap = async () => {
    if (diagTimerRef.current) clearTimeout(diagTimerRef.current);
    const next = diagTapCount + 1;
    if (next >= 5) {
      setDiagTapCount(0);
      triggerHaptic('tick');
      const [scores, muts] = await Promise.all([
        getPendingScores().catch(() => []),
        getPendingMutations().catch(() => []),
      ]);
      const totalPending = scores.length + muts.length;
      setDiagQueuePending(totalPending);
      setDiagUnlocked(true);
      if (totalPending === 0) {
        setDiagAnimating(true);
        setTimeout(() => setDiagAnimating(false), 650);
      }
    } else {
      setDiagTapCount(next);
      diagTimerRef.current = setTimeout(() => {
        setDiagTapCount(0);
      }, 2500);
    }
  };

  const handleDownloadDiagnostic = async () => {
    try {
      setIsDownloadingLog(true);
      await downloadDiagnosticLog();
      showToast('Diagnostic log exported successfully', 'success');
    } catch {
      showToast('Failed to export diagnostic log', 'error');
    } finally {
      setIsDownloadingLog(false);
    }
  };

  // Load organization details & active platform announcements once
  useEffect(() => {
    dbService.getOrganizationByOrgId(orgId).then((org) => {
      if (org) setOrganization(org);
    });
    fetchActiveAnnouncements('judge', orgId).then(setAnnouncements);
  }, [orgId]);

  useEffect(() => {
    const unsub = eventBus.on('org_enforcement', ({ code }) => {
      if (code === 'DELETED') {
        setBlockedMode('deleted');
      } else if (code === 'SUSPENDED') {
        setBlockedMode('suspended');
      } else if (code === 'NOT_VERIFIED') {
        showToast('Organization verification required before live scores can sync.', 'warning', 4500);
      }
    });
    return unsub;
  }, []);

  // Modal Scroll Lock: lock document.body scroll when Account modal or logout confirm is open
  useEffect(() => {
    if (isAccountModalOpen) {
      setHapticSetting(getHapticStrength());
    }
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
    fetchActiveAnnouncements('judge', orgId).then(setAnnouncements);
    window.dispatchEvent(new CustomEvent('fairjudge_db_change', { detail: { table: 'all' } }));
    await new Promise((r) => setTimeout(r, 600));
  };

  const activeEventsCount = events.filter((e) => e.status === 'active').length;
  const isOrgDeleted = Boolean(organization?.deleted_at) || blockedMode === 'deleted';
  const isOrgSuspended = Boolean(organization?.suspended) || blockedMode === 'suspended';

  if (isOrgDeleted || isOrgSuspended) {
    return (
      <OrgBlockedScreen
        mode={isOrgDeleted ? 'deleted' : 'suspended'}
        orgName={organization?.name}
        orgId={orgId}
        reason={organization?.suspended_reason}
        onLogout={onLogout}
      />
    );
  }

  return (
    <div className="min-h-[100dvh] overflow-y-auto w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col items-center justify-start selection:bg-amber-500 selection:text-black transition-colors duration-200 relative">

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
            className="w-10 h-10 rounded-xl bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 text-amber-500 dark:text-amber-400 flex items-center justify-center shadow-sm shrink-0 active:scale-[0.97] transition-transform duration-75 ease-out will-change-transform cursor-pointer"
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
            className="w-10 h-10 rounded-xl bg-stone-100 dark:bg-zinc-900 hover:bg-stone-200 dark:hover:bg-zinc-800 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 flex items-center justify-center active:scale-[0.97] transition-transform duration-75 ease-out will-change-transform cursor-pointer shadow-xs"
            title="Judge Account & Session"
            aria-label="Judge Account"
          >
            <CircleUser className="w-5 h-5 stroke-[2]" />
          </button>
        </div>
      </header>

      <AnnouncementBanner
        notices={announcements}
        onDismiss={(id) => {
          dismissNotice(id);
          setAnnouncements((prev) => prev.filter((n) => n.id !== id));
        }}
      />

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
      <PullToRefresh onRefresh={handleRefresh} accentColor="amber" className="w-full flex-1 flex flex-col items-center">
        <main className="w-full max-w-lg px-4 pt-3 pb-40 space-y-4 relative z-10">
          <div className="flex items-center justify-between px-1">
            <div>
              <h2 className="text-xs font-black text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
                Assigned Events ({events.length})
              </h2>
              {activeEventsCount > 0 && (
                <p className="text-[11px] text-amber-500 dark:text-amber-400 font-bold mt-0.5">
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
              {events.map((event, idx) => {
                const isDraft = event.status === 'draft' || event.status === 'upcoming';
                const isActive = event.status === 'active';
                const isPaused = event.status === 'paused';
                const isEnded = event.status === 'ended' || event.status === 'archived';

                return (
                  <div
                    key={event.id}
                    style={{ animationDelay: `${Math.min(idx, 8) * 50}ms` }}
                    onClick={() => {
                      if (isActive) {
                        triggerHaptic('tap');
                        onSelectEvent(event);
                      } else {
                        showToast(`Access Restricted: "${event.name}" is ${event.status}. Only active events can be evaluated.`);
                      }
                    }}
                    className={`w-full p-4 sm:p-5 rounded-3xl border border-t-white/5 text-left relative overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200 fill-mode-both ${
                      isActive
                        ? 'bg-white dark:bg-zinc-950 border-stone-200 dark:border-zinc-800 hover:border-amber-500/50 hover:bg-stone-50 dark:hover:bg-zinc-900/40 cursor-pointer shadow-md active:scale-95 transition-transform duration-75 ease-out will-change-transform'
                        : 'bg-white/50 dark:bg-zinc-950 border-stone-200/50 dark:border-zinc-800 cursor-not-allowed opacity-65'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-mono font-bold text-zinc-400 uppercase tracking-wider">
                        {event.category || 'General Stage'}
                      </span>
                      <div>
                        {isActive && (
                          <span className="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-[10px] font-black bg-amber-500/10 text-amber-500 dark:text-amber-400 border border-amber-500/25 shadow-sm">
                            <span className="w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_6px_rgba(245,158,11,0.85)] ring-1 ring-amber-500/30" />
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
                          <span className="inline-flex items-center space-x-1 px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-black text-xs font-black shadow-md shadow-amber-500/20 active:scale-[0.97] transition-transform duration-75 ease-out will-change-transform">
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
      </PullToRefresh>

        {/* ======================================================== */}
        {/* PART 3: THE JUDGE ACCOUNT MODAL (Grouped Cards)          */}
        {/* ======================================================== */}
        {isAccountModalOpen
          ? (() => {
              const accountModalContent = (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-3 sm:p-4 pointer-events-auto">
                  {/* Backdrop */}
                  <div 
                    onClick={() => setIsAccountModalOpen(false)}
                    className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
                  />

                  {/* Modal Dialog */}
                  <div className="relative w-full max-w-sm bg-stone-100/90 dark:bg-zinc-950 text-zinc-900 dark:text-white border border-stone-200 dark:border-zinc-800 rounded-3xl shadow-2xl flex flex-col max-h-[90dvh] overflow-hidden animate-spring-sheet select-none">
                    
                    {/* Modal Header */}
                    <div className="px-5 py-4 shrink-0 flex items-center justify-between border-b border-stone-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
                      <div className="flex items-center space-x-3">
                        <div className={`w-10 h-10 rounded-xl bg-amber-500/10 text-amber-500 dark:text-amber-400 border border-amber-500/20 flex items-center justify-center ${diagAnimating ? 'animate-flip-y' : ''}`}>
                          <CircleUser className="w-5 h-5 stroke-[2.2]" />
                        </div>
                        <div>
                          <div className="flex items-center space-x-2">
                            <h3 className="text-base font-bold text-zinc-900 dark:text-white leading-tight">
                              Judge Terminal
                            </h3>
                            <button
                              type="button"
                              onClick={handleVersionTap}
                              className="text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 active:scale-95 transition-transform cursor-pointer select-none"
                              title="Tap 5 times to run system diagnostics"
                            >
                              v{APP_VERSION}
                            </button>
                          </div>
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

                    {/* Grouped Details Card (Scrollable Modal Body) */}
                    <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-3 pb-10">
                      <div className="bg-white dark:bg-zinc-900 rounded-2xl border border-stone-200 dark:border-zinc-800/80 overflow-hidden shadow-sm divide-y divide-stone-100 dark:divide-zinc-800/60 text-xs">
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
                          <span className="font-mono font-bold text-amber-500 dark:text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-lg border border-amber-500/20">
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
                          <span className="font-mono font-bold text-amber-500 dark:text-amber-400">
                            {events.length} Events
                          </span>
                        </div>

                        {/* Display Mode Toggle */}
                        <div className="p-3.5 flex items-center justify-between">
                          <span className="text-zinc-500 font-medium">Interface Theme</span>
                          <ThemeToggleButton />
                        </div>

                        {/* Haptics */}
                        <div className="p-3.5 flex items-center justify-between gap-2">
                          <span className="text-zinc-500 font-medium">Haptics</span>
                          <div className="inline-flex rounded-xl bg-stone-100 dark:bg-zinc-800 p-0.5 border border-stone-200 dark:border-zinc-700">
                            {(['off', 'low', 'medium', 'strong'] as const).map((lvl) => (
                              <button
                                key={lvl}
                                type="button"
                                onClick={() => {
                                  setHapticStrength(lvl);
                                  setHapticSetting(lvl);
                                  triggerHaptic('tick');
                                }}
                                className={`px-2 py-1 text-[10px] font-bold rounded-lg uppercase transition-colors cursor-pointer ${
                                  hapticSetting === lvl
                                    ? 'bg-amber-500 text-black shadow-sm'
                                    : 'text-zinc-500 hover:text-zinc-900 dark:hover:text-white'
                                }`}
                              >
                                {lvl}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                      {/* Signature Hardware: About + Self-Test Terminal (Epic 15.4) */}
                      <div className="pt-1 pb-1">
                        <SignatureHardware role="judge" />
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
              );
              return typeof document !== 'undefined' ? createPortal(accountModalContent, document.body) : accountModalContent;
            })()
          : null}

        {/* ======================================================== */}
        {/* CUSTOM FRAMER-STYLE LOGOUT CONFIRMATION POPUP            */}
        {/* ======================================================== */}
        {showLogoutConfirm
          ? (() => {
              const logoutModalContent = (
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
              );
              return typeof document !== 'undefined' ? createPortal(logoutModalContent, document.body) : logoutModalContent;
            })()
          : null}

    </div>
  );
}
