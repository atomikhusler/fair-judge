/**
 * Canonical database table names shared across cache, realtime sync, and UI listeners.
 */
export const DB_TABLES = {
  EVENTS: 'events',
  PARTICIPANTS: 'participants',
  JUDGES: 'judges',
  SCORES: 'scores',
  ORGANIZATIONS: 'organizations',
  PUBLIC_SETTINGS: 'public_settings',
  ALL: 'all',
} as const;

export type DbTableName = (typeof DB_TABLES)[keyof typeof DB_TABLES];

export function normalizeDbTableName(raw: string | undefined | null): DbTableName {
  if (!raw) return DB_TABLES.ALL;
  let normalized = String(raw).trim().toLowerCase();
  if (normalized.startsWith('fairjudge_supabase_')) {
    normalized = normalized.slice('fairjudge_supabase_'.length);
  }
  if (normalized === 'orgs' || normalized === 'organization' || normalized === 'organizations') {
    return DB_TABLES.ORGANIZATIONS;
  }
  if (normalized === 'events' || normalized.startsWith('events_')) {
    return DB_TABLES.EVENTS;
  }
  if (normalized === 'participants' || normalized.startsWith('participants_')) {
    return DB_TABLES.PARTICIPANTS;
  }
  if (normalized === 'judges' || normalized.startsWith('judges_')) {
    return DB_TABLES.JUDGES;
  }
  if (normalized === 'scores' || normalized.startsWith('scores_')) {
    return DB_TABLES.SCORES;
  }
  if (normalized === 'public_settings' || normalized === 'public_link_settings') {
    return DB_TABLES.PUBLIC_SETTINGS;
  }
  return DB_TABLES.ALL;
}

export function matchesDbTable(
  received: string | undefined | null,
  ...targets: DbTableName[]
): boolean {
  const canonical = normalizeDbTableName(received);
  if (canonical === DB_TABLES.ALL) return true;
  return targets.includes(canonical);
}
