import React from 'react';
import { PublicLeaderboard } from './PublicLeaderboard';

export interface ProjectorViewProps {
  orgId: string;
  initialEventId?: string | null;
  onExit: () => void;
}

/**
 * ProjectorView component: Enterprise broadcast projection terminal for live competitions.
 * Ultra-high contrast, zero-glassmorphism, safe-area padded presentation view.
 */
export function ProjectorView(props: ProjectorViewProps) {
  return (
    <div className="w-full min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-950 dark:text-white p-safe select-none">
      <PublicLeaderboard {...props} />
    </div>
  );
}

export { PublicLeaderboard };
export default ProjectorView;
