import React from 'react';
import { PublicLeaderboard } from './PublicLeaderboard';

export interface ProjectorViewProps {
  orgId: string;
  initialEventId?: string | null;
  onExit: () => void;
}

/**
 * ProjectorView component: Enterprise broadcast projection terminal for live competitions.
 * Re-exports and wraps the high-fidelity PublicLeaderboard engine.
 */
export function ProjectorView(props: ProjectorViewProps) {
  return <PublicLeaderboard {...props} />;
}

export { PublicLeaderboard };
export default ProjectorView;
