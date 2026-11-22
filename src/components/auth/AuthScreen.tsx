import React, { useState } from 'react';
import { Monitor } from 'lucide-react';
import { Organization, SupabaseJudge, SupabaseEvent } from '../../lib/supabaseTypes';
import { Gateway } from './Gateway';
import { OrganiserAuth } from './OrganiserAuth';
import { JudgeAuth } from './JudgeAuth';
import { AuthFooter } from './AuthFooter';
import { AuthBackdrop } from './AuthBackdrop';
import { ThemeToggleButton } from '../../lib/theme';

export type AuthView = 'gateway' | 'organiser' | 'judge';

interface AuthScreenProps {
  onOrganiserLogin: (org: Organization, sessionToken?: string, mustChange?: boolean) => void;
  onJudgeLogin: (
    orgId: string,
    judge: SupabaseJudge,
    assignedEvents: SupabaseEvent[],
    sessionToken?: string,
    org?: Organization
  ) => void;
  onOpenAdmin?: () => void;
  onOpenProjector?: () => void;
  initialView?: AuthView;
}

export function AuthScreen({
  onOrganiserLogin,
  onJudgeLogin,
  onOpenAdmin,
  onOpenProjector,
  initialView = 'gateway',
}: AuthScreenProps) {
  const [authView, setAuthView] = useState<AuthView>(initialView);

  return (
    <div className="min-h-[100dvh] w-full flex flex-col justify-between bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 p-4 md:p-6 relative overflow-x-hidden transition-colors duration-300 motion-reduce:transition-none selection:bg-emerald-500 selection:text-black">
      {/* Top Bar with Projector App entry (top-left) and Theme Toggle (top-right) */}
      <div className="w-full max-w-md mx-auto flex items-center justify-between pt-[max(env(safe-area-inset-top),0.5rem)] pb-3 relative z-20">
        {onOpenProjector ? (
          <button
            type="button"
            onClick={onOpenProjector}
            aria-label="Open Projector App"
            title="Open Projector App"
            data-testid="projector-app-entry"
            className="min-w-[44px] min-h-[44px] px-3 rounded-xl bg-white/90 dark:bg-zinc-900/90 border border-stone-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 hover:text-emerald-600 dark:hover:text-emerald-400 hover:border-emerald-500/40 transition-colors flex items-center justify-center gap-2 shadow-sm cursor-pointer"
          >
            <Monitor className="w-4 h-4" />
            <span className="text-xs font-bold hidden sm:inline">Projector</span>
          </button>
        ) : (
          <div />
        )}
        <ThemeToggleButton />
      </div>

      {/* Static Role Backdrop (Glow + dot grid) */}
      <AuthBackdrop role={authView === 'judge' ? 'judge' : 'organiser'} />

      {/* Main Container Area */}
      <div className="w-full flex-1 flex flex-col items-center justify-center relative z-10 py-6">
        {authView === 'gateway' && (
          <Gateway
            onSelectRole={(role) => setAuthView(role)}
            onOpenAdmin={onOpenAdmin}
          />
        )}

        {authView === 'organiser' && (
          <OrganiserAuth
            onOrganiserLogin={onOrganiserLogin}
            onBack={() => setAuthView('gateway')}
          />
        )}

        {authView === 'judge' && (
          <JudgeAuth
            onJudgeLogin={onJudgeLogin}
            onBack={() => setAuthView('gateway')}
          />
        )}
      </div>

      {/* Persistent Animated Developer Footer (Rendered across all Auth views) */}
      <AuthFooter />
    </div>
  );
}
