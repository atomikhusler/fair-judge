import { AdminOrg, AdminOrgFilter } from '../adminService';
import { StatusTone } from '../ui';

export type OrgUiFilter = 'pending' | 'active' | 'bin';

export function mapUiFilterToRpc(filter: OrgUiFilter): AdminOrgFilter {
  if (filter === 'pending') return 'pending';
  if (filter === 'bin') return 'deleted';
  // 'all' returns all non-deleted orgs (verified, pending, rejected, suspended)
  return 'all';
}

export function mapRpcFilterToUi(filter?: AdminOrgFilter): OrgUiFilter {
  if (filter === 'pending') return 'pending';
  if (filter === 'deleted') return 'bin';
  return 'active';
}

export function getOrgStatus(org: AdminOrg): {
  label: string;
  tone: StatusTone;
  reason?: string | null;
} {
  if (org.deleted_at) {
    return { label: 'In bin', tone: 'neutral', reason: null };
  }
  if (org.suspended) {
    return {
      label: 'Suspended',
      tone: 'problem',
      reason: org.suspended_reason || null,
    };
  }
  if (org.verification_status === 'verified') {
    return { label: 'Verified', tone: 'ok', reason: null };
  }
  if (org.verification_status === 'rejected') {
    return {
      label: 'Rejected',
      tone: 'problem',
      reason: org.rejection_reason || null,
    };
  }
  return { label: 'Pending', tone: 'waiting', reason: null };
}

export function getOrgInitials(name: string): string {
  const clean = (name || '').trim();
  if (!clean) return 'O';
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0].slice(0, 2).toUpperCase();
  }
  return `${words[0][0] || ''}${words[1][0] || ''}`.toUpperCase();
}

export function formatRelativeTime(iso?: string | null): string {
  if (!iso) return '—';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '—';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function formatFullDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function getOrgActivityTimestamp(org: AdminOrg): string {
  return org.deleted_at || org.verified_at || org.created_at;
}
