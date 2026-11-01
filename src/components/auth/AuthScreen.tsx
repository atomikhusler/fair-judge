import React, { useState } from 'react';
import { Organization, SupabaseJudge, SupabaseEvent } from '../../lib/supabaseTypes';
import { Gateway } from './Gateway';
import { OrganiserAuth } from './OrganiserAuth';
import { JudgeAuth } from './JudgeAuth';

export type AuthView = 'gateway' | 'organiser' | 'judge';

interface AuthScreenProps {
  onOrganiserLogin: (org: Organization) => void;
  onJudgeLogin: (orgId: string, judge: SupabaseJudge, assignedEvents: SupabaseEvent[]) => void;
  initialView?: AuthView;
}

export function AuthScreen({ onOrganiserLogin, onJudgeLogin, initialView = 'gateway' }: AuthScreenProps) {
  // Directive 2: The app must NOT default to a login form. It must render a pure Role Selection Gateway.
  const [authView, setAuthView] = useState<AuthView>(initialView);

  return (
    <div className="min-h-[100dvh] w-full flex flex-col justify-between bg-zinc-950 text-zinc-100 p-4 md:p-6 relative overflow-x-hidden selection:bg-emerald-500 selection:text-black">
      {/* Background radial ambient highlight */}
      <div className="fixed inset-0 pointer-events-none bg-[radial-gradient(ellipse_80%_60%_at_50%_-10%,rgba(16,185,129,0.10),transparent_70%)]" />

      {/* Main Container Area */}
      <div className="w-full flex-1 flex flex-col items-center justify-center relative z-10 py-6">
        {authView === 'gateway' && (
          <Gateway onSelectRole={(role) => setAuthView(role)} />
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

      {/* Persistent Subtle AMOLED Footer */}
      <footer className="w-full max-w-md mx-auto pt-4 pb-2 flex items-center justify-center text-center relative z-10">
        <p className="text-[10px] md:text-[11px] text-zinc-600 font-mono">
          Fair Judge • Precision Offline-First Scoring Ledger
        </p>
      </footer>
    </div>
  );
}
