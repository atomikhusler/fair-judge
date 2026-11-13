import { getAdminClient, resetAdminClient } from './adminClient';
import { isSupabaseConfigured } from '../lib/supabase';

export interface AdminOverview {
  total_orgs: number;
  pending_orgs: number;
  verified_orgs: number;
  rejected_orgs: number;
  suspended_orgs: number;
  deleted_orgs: number;
  total_events: number;
  active_events: number;
  total_judges: number;
  total_participants: number;
  total_scores: number;
  scores_7d: number;
  lockouts_24h: number;
  new_reports: number;
  open_reports: number;
  db_bytes: number;
  enforce_verification: boolean;
}

export type AdminOrgFilter = 'all' | 'pending' | 'verified' | 'rejected' | 'suspended' | 'deleted';

export interface AdminOrg {
  id: string;
  org_id: string;
  name: string;
  email?: string | null;
  verification_status: 'pending' | 'verified' | 'rejected';
  rejection_reason?: string | null;
  verified_at?: string | null;
  suspended: boolean;
  suspended_reason?: string | null;
  deleted_at?: string | null;
  created_at: string;
  events_count: number;
  active_events_count: number;
  judges_count: number;
  participants_count: number;
  scores_count: number;
  must_change?: boolean;
  locked_until?: string | null;
}

export interface AdminSecurityEvent {
  id: number;
  kind: string;
  org_id: string | null;
  org_name?: string | null;
  detail: Record<string, any>;
  created_at: string;
  still_locked_until?: string | null;
}

export interface AdminAuditEntry {
  id: number;
  admin_id: string;
  action: string;
  target_org_id: string | null;
  detail: Record<string, any>;
  created_at: string;
}

export interface AdminAnnouncement {
  id: string;
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'urgent';
  audience: 'all' | 'organisers' | 'judges' | 'org';
  target_org_id?: string | null;
  starts_at: string;
  ends_at?: string | null;
  active: boolean;
  created_at: string;
}

export interface AdminReportSummary {
  id: string;
  created_at: string;
  org_id: string | null;
  role: string;
  app_version?: string | null;
  summary: string;
  status: 'new' | 'acknowledged' | 'resolved';
  admin_note?: string | null;
  resolved_at?: string | null;
}

export interface AdminReportFull extends AdminReportSummary {
  report: Record<string, any>;
}

async function callAdminRpc<T>(fnName: string, params?: Record<string, any>): Promise<T> {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured.');
  }
  const client = getAdminClient();
  const { data, error } = await client.rpc(fnName, params);
  if (error) {
    throw new Error(error.message || `RPC ${fnName} failed.`);
  }
  return data as T;
}

export const adminService = {
  async signIn(email: string, password: string): Promise<{ email: string; userId: string }> {
    if (!isSupabaseConfigured()) {
      throw new Error('Database connection is not configured.');
    }
    const cleanEmail = email.trim();
    if (!cleanEmail || !password) {
      throw new Error('Enter your email and password.');
    }

    const client = getAdminClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: cleanEmail,
      password,
    });

    if (error || !data.user) {
      throw new Error(error?.message || 'Invalid admin credentials.');
    }

    const { data: isAdmin, error: checkError } = await client.rpc('is_platform_admin');
    if (checkError || !isAdmin) {
      await client.auth.signOut().catch(() => {});
      resetAdminClient();
      throw new Error('This account does not have platform admin access.');
    }

    return {
      email: data.user.email || cleanEmail,
      userId: data.user.id,
    };
  },

  async signOut(): Promise<void> {
    try {
      const client = getAdminClient();
      await client.auth.signOut();
    } catch {
      // Best-effort sign out
    } finally {
      resetAdminClient();
    }
  },

  async checkSession(): Promise<{ email: string; userId: string } | null> {
    if (!isSupabaseConfigured()) return null;
    try {
      const client = getAdminClient();
      const { data } = await client.auth.getSession();
      if (!data.session?.user) return null;

      const { data: isAdmin } = await client.rpc('is_platform_admin');
      if (!isAdmin) {
        await client.auth.signOut().catch(() => {});
        resetAdminClient();
        return null;
      }

      return {
        email: data.session.user.email || 'Admin',
        userId: data.session.user.id,
      };
    } catch {
      return null;
    }
  },

  getOverview(): Promise<AdminOverview> {
    return callAdminRpc<AdminOverview>('admin_overview');
  },

  listOrgs(filter: AdminOrgFilter = 'all', search = ''): Promise<AdminOrg[]> {
    return callAdminRpc<AdminOrg[]>('admin_list_orgs', {
      p_filter: filter,
      p_search: search,
    });
  },

  setVerification(orgId: string, status: 'pending' | 'verified' | 'rejected', reason?: string) {
    return callAdminRpc<{ ok: boolean; error?: string }>('admin_set_verification', {
      p_org_id: orgId,
      p_status: status,
      p_reason: reason || null,
    });
  },

  setSuspended(orgId: string, suspended: boolean, reason?: string) {
    return callAdminRpc<{ ok: boolean; error?: string }>('admin_set_suspended', {
      p_org_id: orgId,
      p_suspended: suspended,
      p_reason: reason || null,
    });
  },

  resetOrgPassword(orgId: string) {
    return callAdminRpc<{ ok: boolean; temp_password?: string; org_id?: string; error?: string }>(
      'admin_reset_org_password',
      { p_org_id: orgId }
    );
  },

  softDeleteOrg(orgId: string) {
    return callAdminRpc<{ ok: boolean; error?: string }>('admin_soft_delete_org', {
      p_org_id: orgId,
    });
  },

  restoreOrg(orgId: string) {
    return callAdminRpc<{ ok: boolean; error?: string }>('admin_restore_org', {
      p_org_id: orgId,
    });
  },

  purgeDeleted(olderThanDays = 30) {
    return callAdminRpc<{ ok: boolean; purged_count: number; purged_org_ids: string[] }>(
      'admin_purge_deleted',
      { p_older_than_days: olderThanDays }
    );
  },

  listSecurityEvents(limit = 50): Promise<AdminSecurityEvent[]> {
    return callAdminRpc<AdminSecurityEvent[]>('admin_list_security_events', {
      p_limit: limit,
    });
  },

  unlockOrg(orgId: string) {
    return callAdminRpc<{ ok: boolean }>('admin_unlock_org', {
      p_org_id: orgId,
    });
  },

  listAudit(limit = 50): Promise<AdminAuditEntry[]> {
    return callAdminRpc<AdminAuditEntry[]>('admin_list_audit', {
      p_limit: limit,
    });
  },

  setEnforcement(enforce: boolean) {
    return callAdminRpc<{ ok: boolean; enforce_verification: boolean }>('admin_set_enforcement', {
      p_enforce: enforce,
    });
  },

  listAnnouncements(): Promise<AdminAnnouncement[]> {
    return callAdminRpc<AdminAnnouncement[]>('admin_list_announcements');
  },

  saveAnnouncement(payload: {
    id?: string | null;
    title: string;
    body: string;
    severity: 'info' | 'warning' | 'urgent';
    audience: 'all' | 'organisers' | 'judges' | 'org';
    targetOrgId?: string | null;
    endsAt?: string | null;
  }) {
    return callAdminRpc<{ ok: boolean; announcement?: AdminAnnouncement; error?: string }>(
      'admin_save_announcement',
      {
        p_id: payload.id || null,
        p_title: payload.title,
        p_body: payload.body,
        p_severity: payload.severity,
        p_audience: payload.audience,
        p_target_org_id: payload.targetOrgId || null,
        p_ends_at: payload.endsAt || null,
      }
    );
  },

  endAnnouncement(id: string) {
    return callAdminRpc<{ ok: boolean }>('admin_end_announcement', {
      p_id: id,
    });
  },

  listReports(status: 'all' | 'new' | 'acknowledged' | 'resolved' = 'all', limit = 50): Promise<AdminReportSummary[]> {
    return callAdminRpc<AdminReportSummary[]>('admin_list_reports', {
      p_status: status,
      p_limit: limit,
    });
  },

  getReport(id: string) {
    return callAdminRpc<{ ok: boolean; report?: AdminReportFull; error?: string }>('admin_get_report', {
      p_id: id,
    });
  },

  setReportStatus(id: string, status: 'new' | 'acknowledged' | 'resolved', note?: string | null) {
    return callAdminRpc<{ ok: boolean; error?: string }>('admin_set_report_status', {
      p_id: id,
      p_status: status,
      p_note: note ?? null,
    });
  },
};
