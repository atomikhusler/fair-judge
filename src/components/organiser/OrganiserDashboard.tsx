import React, { useState } from 'react';
import { 
  Menu, 
  CircleUser, 
  Scale, 
  Radio, 
  CalendarDays, 
  Users, 
  BarChart3 
} from 'lucide-react';
import { Organization } from '../../lib/supabaseTypes';
import { SettingsDrawer } from './SettingsDrawer';
import { AccountModal } from './AccountModal';
import { LiveTab } from './tabs/LiveTab';
import { EventsTab } from './tabs/EventsTab';
import { PeopleTab } from './tabs/PeopleTab';
import { InsightsTab } from './tabs/InsightsTab';
import { PullToRefresh } from '../common/PullToRefresh';

export type OrganiserNavTab = 'live' | 'events' | 'people' | 'insights';

interface OrganiserDashboardProps {
  organization: Organization;
  onLogout: () => void;
  onOpenPublicView: (eventId?: string) => void;
  onSwitchToJudgeView?: () => void;
}

export function OrganiserDashboard({
  organization: initialOrg,
  onLogout,
  onOpenPublicView,
  onSwitchToJudgeView,
}: OrganiserDashboardProps) {
  const [organization, setOrganization] = useState<Organization>(initialOrg);
  const [activeTab, setActiveTab] = useState<OrganiserNavTab>('live');

  // Modals & Drawers state
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isAccountModalOpen, setIsAccountModalOpen] = useState(false);

  // Tab definitions
  const navTabs: Array<{ id: OrganiserNavTab; label: string; icon: React.ElementType }> = [
    { id: 'live', label: 'Live', icon: Radio },
    { id: 'events', label: 'Events', icon: CalendarDays },
    { id: 'people', label: 'People', icon: Users },
    { id: 'insights', label: 'Insights', icon: BarChart3 },
  ];

  return (
    <div className="min-h-[100dvh] w-full bg-stone-50 dark:bg-black text-zinc-900 dark:text-zinc-100 flex flex-col justify-between overflow-y-auto transition-colors duration-200 relative select-none">
      
      {/* ======================================================== */}
      {/* 1. THE TOP HEADER (Framer-Grade Premium Navigation)     */}
      {/* ======================================================== */}
      <header className="h-[10dvh] min-h-[72px] max-h-[90px] shrink-0 bg-white dark:bg-zinc-950 border-b border-stone-200 dark:border-zinc-800/80 flex items-center justify-between px-4 transition-colors z-30">
        
        {/* Left: Hamburger Menu Icon */}
        <button
          type="button"
          onClick={() => setIsDrawerOpen(true)}
          className="w-12 h-12 rounded-2xl text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-900 transition-all duration-200 active:scale-[0.96] flex items-center justify-center cursor-pointer"
          aria-label="Open Navigation Drawer"
        >
          <Menu className="w-5 h-5 stroke-[2.2]" />
        </button>

        {/* Center: Branding & Organisation Name */}
        <div className="flex flex-col items-center justify-center text-center px-2">
          {/* Top Line: App Logo + Fair Judge */}
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-500 shadow-sm shadow-emerald-500/20">
              <Scale className="w-4 h-4 stroke-[2.5]" />
            </div>
            <span className="text-lg font-black tracking-tight text-zinc-900 dark:text-white">
              Fair Judge
            </span>
          </div>

          {/* Bottom Line: Actual Organisation Name */}
          <span className="text-xs font-bold text-zinc-700 dark:text-zinc-300 tracking-wide uppercase mt-1 truncate max-w-[200px] sm:max-w-xs md:max-w-sm">
            {organization.name}
          </span>
        </div>

        {/* Right: Premium Account Icon */}
        <button
          type="button"
          onClick={() => setIsAccountModalOpen(true)}
          className="w-12 h-12 rounded-2xl text-zinc-700 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white hover:bg-stone-100 dark:hover:bg-zinc-900 transition-all duration-200 active:scale-[0.96] flex items-center justify-center cursor-pointer"
          aria-label="Open Account Settings"
        >
          <CircleUser className="w-5 h-5 stroke-[2.2]" />
        </button>
      </header>

      {/* ======================================================== */}
      {/* 2. THE HAMBURGER MENU (Premium Settings Drawer)         */}
      {/* ======================================================== */}
      <SettingsDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        organization={organization}
        onUpdateOrganization={(updated) => setOrganization(updated)}
        onOpenPublicView={onOpenPublicView}
      />

      {/* ======================================================== */}
      {/* 3. THE ACCOUNT MODAL (Identity & Security)              */}
      {/* ======================================================== */}
      {isAccountModalOpen && (
        <AccountModal
          isOpen={isAccountModalOpen}
          onClose={() => setIsAccountModalOpen(false)}
          organization={organization}
          onUpdateOrganization={(updated) => setOrganization(updated)}
          onLogout={onLogout}
        />
      )}

      {/* ======================================================== */}
      {/* MAIN VIEW CONTENT AREA (Simple 4-Tab Shell Placeholders) */}
      {/* ======================================================== */}
      {/* ======================================================== */}
      {/* MAIN VIEW CONTENT AREA                                   */}
      {/* ======================================================== */}
      <main className="flex-1 flex flex-col overflow-hidden max-w-4xl w-full mx-auto relative animate-fade-in">
        
        {/* Tab 1: Live Control Room */}
        {activeTab === 'live' && (
          <LiveTab
            organization={organization}
            onOpenPublicView={onOpenPublicView}
          />
        )}

        {/* Tab 2: Events Engine & Management View */}
        {activeTab === 'events' && (
          <EventsTab
            organization={organization}
            onOpenPublicView={onOpenPublicView}
            onNavigateToLiveControl={() => setActiveTab('live')}
          />
        )}

        {/* Tab 3: People View */}
        {activeTab === 'people' && (
          <PeopleTab organization={organization} />
        )}

        {/* Tab 4: Insights View */}
        {activeTab === 'insights' && (
          <InsightsTab organization={organization} />
        )}

      </main>

      {/* ======================================================== */}
      {/* 4. THE 4-TAB BOTTOM NAVIGATION SHELL (Framer-Grade)     */}
      {/* ======================================================== */}
      <nav className="fixed bottom-0 w-full h-[8dvh] min-h-[64px] pb-safe bg-white/80 dark:bg-zinc-950/80 backdrop-blur-xl border-t border-stone-200 dark:border-zinc-800/80 flex items-center justify-around px-2 sm:px-6 select-none z-40">
        {navTabs.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 min-h-[44px] flex flex-col items-center justify-center py-1 px-2 rounded-xl transition-all duration-300 ease-out hover:-translate-y-0.5 active:scale-[0.97] active:translate-y-0 cursor-pointer ${
                isActive
                  ? 'text-emerald-600 dark:text-emerald-400 font-bold'
                  : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'
              }`}
            >
              <div
                className={`p-1 rounded-xl transition-all duration-200 ${
                  isActive ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : ''
                }`}
              >
                <Icon className="w-5 h-5 stroke-[2.2]" />
              </div>
              <span className="text-[10px] tracking-tight mt-0.5 font-medium">
                {tab.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
