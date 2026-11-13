import React from 'react';
import { AdminOrg } from '../adminService';
import { ListRow, StatusChip } from '../ui';
import {
  formatRelativeTime,
  getOrgActivityTimestamp,
  getOrgInitials,
  getOrgStatus,
} from './orgUtils';

interface OrgRowProps {
  org: AdminOrg;
  isSelected?: boolean;
  isHighlighted?: boolean;
  animateIndex?: number;
  onSelect: (org: AdminOrg) => void;
}

export function OrgRow({
  org,
  isSelected = false,
  isHighlighted = false,
  animateIndex,
  onSelect,
}: OrgRowProps) {
  const status = getOrgStatus(org);
  const initials = getOrgInitials(org.name);
  const relTime = formatRelativeTime(getOrgActivityTimestamp(org));

  return (
    <ListRow
      animateIndex={animateIndex}
      highlighted={isHighlighted}
      onClick={() => onSelect(org)}
      className={
        isSelected
          ? 'md:bg-violet-600/8 dark:md:bg-violet-500/12'
          : ''
      }
      leading={
        <div
          aria-hidden="true"
          className="w-10 h-10 rounded-full bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 text-[13px] font-semibold flex items-center justify-center shrink-0"
        >
          {initials}
        </div>
      }
      title={org.name}
      subtitle={
        <span className="inline-flex items-center gap-1.5 min-w-0">
          <span className="font-mono text-zinc-700 dark:text-zinc-300">{org.org_id}</span>
          <span aria-hidden="true">·</span>
          <span>{relTime}</span>
        </span>
      }
      trailing={<StatusChip tone={status.tone} label={status.label} />}
      chevron
    />
  );
}
