import React, { useState, useCallback } from 'react';
import {
  Monitor,
  ArrowLeft,
  Lock,
  Building2,
  Loader2,
  AlertCircle,
  Calendar,
  ChevronRight,
  Clock,
  ShieldCheck,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  projectorAppService,
  ProjectorEventSummary,
  ProjectorLoginResult,
} from '../../lib/projector/projectorAppService';
import { StoredProjectorSession } from '../../lib/projector/projectorTokenStore';
import { ActiveOrgSession } from '../../lib/authService';
import { SessionLimitSheet } from '../auth/SessionLimitSheet';

interface ProjectorLoginScreenProps {
  notice?: string | null;
  onDismissNotice?: () => void;
  onAuthenticated: (session: StoredProjectorSession) => void;
  onExit: () => void;
}

export function ProjectorLoginScreen({
  notice,
  onDismissNotice,
  onAuthenticated,
  onExit,
}: ProjectorLoginScreenProps) {
  const [step, setStep] = useState<'credentials' | 'pick_event'>('credentials');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [orgSummary, setOrgSummary] = useState<{ orgId: string; name: string } | null>(null);
  const [events, setEvents] = useState<ProjectorEventSummary[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string>('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [limitSessions, setLimitSessions] = useState<ActiveOrgSession[] | null>(null);
  const [busyEvictId, setBusyEvictId] = useState<string | null>(null);
  const [limitError, setLimitError] = useState<string | undefined>(undefined);

  const completeLogin = useCallback(
    (res: ProjectorLoginResult) => {
      if (!res.ok || !res.projectorToken || !res.org || !res.event || !res.expiresAt) {
        setError(res.message || 'Could not start projector session.');
        return;
      }
      // Clear password from memory immediately once the projector-only token is issued
      setPassword('');
      setLimitSessions(null);
      setBusyEvictId(null);
      setLimitError(undefined);

      onAuthenticated({
        token: res.projectorToken,
        orgId: res.org.orgId,
        orgName: res.org.name,
        eventId: res.event.id,
        eventName: res.event.name,
        eventCategory: res.event.category,
        expiresAt: res.expiresAt,
        cursorVersion: 0,
      });
    },
    [onAuthenticated]
  );

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    onDismissNotice?.();

    const cleanId = identifier.trim();
    if (!cleanId || !password) {
      setError('Enter your Organisation ID (or email) and password.');
      return;
    }

    setLoading(true);
    try {
      const res = await projectorAppService.login({
        identifier: cleanId,
        password,
      });

      if (!res.ok) {
        setError(res.message || 'Invalid organisation ID or password.');
        return;
      }

      if (res.needsEventSelection) {
        const list = res.events || [];
        setOrgSummary(res.org || { orgId: cleanId, name: cleanId });
        setEvents(list);
        setSelectedEventId(list[0]?.id || '');
        setStep('pick_event');
        return;
      }

      completeLogin(res);
    } finally {
      setLoading(false);
    }
  };

  const handleStartWithEvent = async (revokeSessionId?: string) => {
    if (!selectedEventId) {
      setError('Select an event to display on the projector.');
      return;
    }

    setError(null);
    if (revokeSessionId) {
      setBusyEvictId(revokeSessionId);
      setLimitError(undefined);
    } else {
      setLoading(true);
    }

    try {
      const res = await projectorAppService.login({
        identifier: identifier.trim(),
        password,
        eventId: selectedEventId,
        revokeSessionId: revokeSessionId || null,
      });

      if (res.sessionLimitReached) {
        setLimitSessions(res.sessions || []);
        setLimitError(revokeSessionId ? res.message : undefined);
        return;
      }

      if (!res.ok) {
        if (revokeSessionId) {
          setLimitError(res.message || 'Could not log out that device.');
        } else {
          setError(res.message || 'Unable to start projector session.');
        }
        return;
      }

      completeLogin(res);
    } finally {
      setLoading(false);
      setBusyEvictId(null);
    }
  };

  const handleBackToCredentials = () => {
    setStep('credentials');
    setEvents([]);
    setSelectedEventId('');
    setOrgSummary(null);
    setError(null);
    setLimitSessions(null);
  };

  return (
    <div className="min-h-[100dvh] w-full bg-stone-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 flex flex-col justify-between p-4 md:p-6">
      <div className="w-full max-w-lg mx-auto flex items-center justify-between pt-[max(env(safe-area-inset-top),0.5rem)] pb-4">
        <button
          type="button"
          onClick={onExit}
          className="inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-xl bg-white dark:bg-zinc-900 border border-stone-200 dark:border-zinc-800 text-xs font-bold text-zinc-700 dark:text-zinc-200 hover:bg-stone-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to start</span>
        </button>

        <div className="inline-flex items-center gap-1.5 text-[11px] font-mono font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
          <Monitor className="w-3.5 h-3.5" />
          <span>Projector App</span>
        </div>
      </div>

      <div className="w-full max-w-lg mx-auto flex-1 flex flex-col justify-center py-4">
        <div className="rounded-3xl bg-white dark:bg-zinc-900/90 border border-stone-200 dark:border-zinc-800 shadow-xl p-6 sm:p-8 space-y-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0">
              <Monitor className="w-6 h-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-zinc-900 dark:text-white">
                {step === 'credentials' ? 'Sign in to Projector' : 'Choose an Event'}
              </h1>
              <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-400 mt-1">
                {step === 'credentials'
                  ? 'Issues a read-only single-event projector token. Works on any PC.'
                  : `${orgSummary?.name || orgSummary?.orgId} — select one event to project.`}
              </p>
            </div>
          </div>

          {notice && (
            <div
              role="status"
              className="p-3.5 rounded-2xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/60 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2.5"
            >
              <Clock className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{notice}</span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="p-3.5 rounded-2xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/60 text-xs text-rose-700 dark:text-rose-300 flex items-start gap-2.5"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {step === 'credentials' ? (
            <form onSubmit={handleCredentialsSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="projector-org-id"
                  className="block text-xs font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400"
                >
                  Organisation ID or Email
                </label>
                <div className="relative">
                  <Building2 className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="projector-org-id"
                    type="text"
                    autoComplete="username"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    placeholder="e.g. ORG-1042 or admin@school.edu"
                    disabled={loading}
                    className="w-full min-h-[48px] pl-10 pr-4 rounded-xl bg-stone-50 dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="projector-org-password"
                  className="block text-xs font-bold uppercase tracking-wider text-zinc-600 dark:text-zinc-400"
                >
                  Organiser Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    id="projector-org-password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter organiser password"
                    disabled={loading}
                    className="w-full min-h-[48px] pl-10 pr-12 rounded-xl bg-stone-50 dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 text-sm text-zinc-900 dark:text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:border-emerald-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 min-w-[36px] min-h-[36px] rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full min-h-[48px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Verifying organisation...</span>
                  </>
                ) : (
                  <>
                    <span>Continue to Event Picker</span>
                    <ChevronRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>
          ) : (
            <div className="space-y-4">
              {events.length === 0 ? (
                <div className="p-5 rounded-2xl bg-stone-50 dark:bg-zinc-950 border border-stone-200 dark:border-zinc-800 text-center space-y-2">
                  <Calendar className="w-7 h-7 text-zinc-400 mx-auto" />
                  <p className="text-sm font-bold text-zinc-900 dark:text-white">
                    No active or upcoming events found
                  </p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    Create or reopen an event in the Organiser app first. Ended and archived events cannot start a new projector session.
                  </p>
                </div>
              ) : (
                <div className="space-y-2 max-h-[320px] overflow-y-auto pr-1">
                  {events.map((ev) => {
                    const isSelected = selectedEventId === ev.id;
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => setSelectedEventId(ev.id)}
                        className={`w-full text-left p-4 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 ${
                          isSelected
                            ? 'bg-emerald-500/10 border-emerald-500 text-zinc-900 dark:text-white'
                            : 'bg-stone-50 dark:bg-zinc-950 border-stone-200 dark:border-zinc-800 text-zinc-800 dark:text-zinc-200 hover:border-zinc-400 dark:hover:border-zinc-600'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="font-bold text-sm truncate">{ev.name}</div>
                          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">
                            {ev.category || 'Competition Event'}
                            {ev.date ? ` · ${ev.date}` : ''}
                          </div>
                        </div>
                        <span
                          className={`text-[11px] font-bold uppercase px-2.5 py-1 rounded-lg shrink-0 ${
                            ev.status === 'active'
                              ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                              : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                          }`}
                        >
                          {ev.status}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={handleBackToCredentials}
                  disabled={loading}
                  className="sm:w-auto min-h-[48px] px-4 rounded-xl bg-stone-100 dark:bg-zinc-800 hover:bg-stone-200 dark:hover:bg-zinc-700 text-zinc-800 dark:text-zinc-100 text-xs font-bold transition-colors cursor-pointer disabled:opacity-50"
                >
                  Change account
                </button>
                <button
                  type="button"
                  onClick={() => void handleStartWithEvent()}
                  disabled={loading || events.length === 0 || !selectedEventId}
                  className="flex-1 min-h-[48px] px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-bold transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Starting projector...</span>
                    </>
                  ) : (
                    <>
                      <Monitor className="w-4 h-4" />
                      <span>Start Projector Session</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-stone-200 dark:border-zinc-800 flex items-start gap-2.5 text-[11px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
            <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
            <span>
              Your organiser password is never stored on this PC. Only one active projector runs per organisation, uses 1 of 3 active session slots, and expires after 8 hours or when the event ends.
            </span>
          </div>
        </div>
      </div>

      <div className="text-center text-[11px] text-zinc-500 dark:text-zinc-500 pb-2">
        Fair Judge Projector App · Read-only single-event display
      </div>

      {limitSessions && (
        <SessionLimitSheet
          sessions={limitSessions}
          busySessionId={busyEvictId}
          errorMessage={limitError}
          onEvictSession={(sessionId) => void handleStartWithEvent(sessionId)}
          onCancel={() => {
            setLimitSessions(null);
            setLimitError(undefined);
          }}
        />
      )}
    </div>
  );
}
