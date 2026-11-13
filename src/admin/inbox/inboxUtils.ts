import { AdminReportSummary } from '../adminService';

export type InboxFilter = 'all' | 'new' | 'acknowledged' | 'resolved';

export type VerdictLevel = 'major' | 'minor' | 'ok' | 'neutral';

export function detectReportVerdict(
  summary: string,
  reportJson?: Record<string, any> | null
): { level: VerdictLevel; label: string; dotClass: string } {
  const rawVerdict = String(reportJson?.summary?.verdict || '').toUpperCase();
  const upperSummary = (summary || '').toUpperCase();

  if (rawVerdict === 'MAJOR' || upperSummary.includes('DIAGNOSTICS: MAJOR')) {
    return { level: 'major', label: 'Major', dotClass: 'bg-red-500' };
  }
  if (rawVerdict === 'MINOR' || upperSummary.includes('DIAGNOSTICS: MINOR')) {
    return { level: 'minor', label: 'Minor', dotClass: 'bg-orange-500' };
  }
  if (rawVerdict === 'OK' || upperSummary.includes('DIAGNOSTICS: OK')) {
    return { level: 'ok', label: 'OK', dotClass: 'bg-green-500' };
  }
  return { level: 'neutral', label: 'Note', dotClass: 'bg-zinc-400 dark:bg-zinc-500' };
}

export function formatInboxRelativeTime(iso?: string | null): string {
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
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function getStatusLabel(status: AdminReportSummary['status']): string {
  if (status === 'resolved') return 'Resolved';
  if (status === 'acknowledged') return 'Seen';
  return 'New';
}

export function extractReadableFacts(
  report: Record<string, any> | null | undefined
): Array<{ label: string; value: string }> {
  if (!report || typeof report !== 'object') return [];
  const facts: Array<{ label: string; value: string }> = [];

  if (report.summary?.verdict) {
    facts.push({ label: 'Verdict', value: String(report.summary.verdict) });
  }
  if (typeof report.summary?.problemTotal === 'number') {
    facts.push({ label: 'Problems', value: String(report.summary.problemTotal) });
  }
  if (typeof report.summary?.noticeTotal === 'number') {
    facts.push({ label: 'Notices', value: String(report.summary.noticeTotal) });
  }
  if (report.appVersion) {
    facts.push({ label: 'App version', value: `v${report.appVersion}` });
  }
  if (report.orgCode || report.orgId) {
    facts.push({ label: 'Organiser', value: String(report.orgCode || report.orgId) });
  }
  if (report.role) {
    facts.push({ label: 'Role', value: String(report.role) });
  }
  if (typeof report.online === 'boolean') {
    facts.push({ label: 'Device online', value: report.online ? 'Yes' : 'No' });
  }
  if (typeof report.queueLength === 'number') {
    facts.push({ label: 'Sync queue', value: String(report.queueLength) });
  }
  if (Array.isArray(report.recentErrors)) {
    facts.push({ label: 'Recent errors', value: String(report.recentErrors.length) });
  }

  return facts;
}
