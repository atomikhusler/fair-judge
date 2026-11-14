import React, { useState } from 'react';
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
  initialView?: AuthView;
}

export function AuthScreen({ onOrganiserLogin, onJudgeLogin, onOpenAdmin, initialView = 'gateway' }: AuthScreenProps) {
  const [authView, setAuthView] = useState<AuthView>(initialView);

  return (
    <div className="min-h-[100dvh] w-full flex flex-col justify-between bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100 p-4 md:p-6 relative overflow-x-hidden transition-colors duration-500 selection:bg-emerald-500 selection:text-black">
      {/* Top Bar with Theme Toggle in normal flow */}
      <div className="w-full max-w-md mx-auto flex justify-end pt-[max(env(safe-area-inset-top),0.5rem)] pb-3">
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
