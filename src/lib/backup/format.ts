import {
  CustomParticipantField,
  SupabaseEvent,
  SupabaseJudge,
  SupabaseParticipant,
  SupabaseScore,
  TieBreakerMethod,
} from '../supabaseTypes';

export const WHITELISTED_SETTING_KEYS = [
  'name',
  'email',
  'tie_breaker_enabled',
  'tie_breaker_method',
  'custom_participant_fields',
  'blind_judging_enabled',
  'auto_advance_enabled',
  'grace_period_enabled',
  'isolated_jury_enabled',
  'projector_blind_mode',
  'projector_spotlight_mode',
  'projector_ticker_text',
  'projector_carousel_interval',
] as const;

export type WhitelistedSettingKey = (typeof WHITELISTED_SETTING_KEYS)[number];

export interface BackupSettings {
  name?: string;
  email?: string;
  tie_breaker_enabled?: boolean;
  tie_breaker_method?: TieBreakerMethod;
  custom_participant_fields?: CustomParticipantField[];
  blind_judging_enabled?: boolean;
  auto_advance_enabled?: boolean;
  grace_period_enabled?: boolean;
  isolated_jury_enabled?: boolean;
  projector_blind_mode?: boolean;
  projector_spotlight_mode?: boolean;
  projector_ticker_text?: string;
  projector_carousel_interval?: number;
}

export interface BackupCounts {
  events: number;
  judges: number;
  participants: number;
  scores: number;
  settings: number;
}

export interface BackupManifestV1 {
  app: 'Fair Judge';
  format_version: '1.0.0';
  app_version: string;
  org_id: string;
  org_name: string;
  exported_at: string;
  counts: {
    events: number;
    judges: number;
    participants: number;
    scores: number;
  };
  encrypted: boolean;
  salt?: string;
  iv?: string;
}

export interface BackupManifest {
  app: 'Fair Judge';
  schema_version: number;
  min_reader_schema: number;
  format_version: '2.0.0' | '1.0.0';
  app_version: string;
  org_id: string;
  org_name: string;
  exported_at: string;
  counts: BackupCounts;
  checksum?: string;
  encrypted: boolean;
  salt?: string;
  iv?: string;
}

export interface BackupPayload {
  events: SupabaseEvent[];
  judges: SupabaseJudge[];
  participants: SupabaseParticipant[];
  scores: SupabaseScore[];
  settings?: BackupSettings;
}

export interface RawBackupFile {
  manifest: BackupManifest | BackupManifestV1 | Record<string, any>;
  payload: BackupPayload | Record<string, any> | string;
}

export interface ParsedBackupResult {
  manifest: BackupManifest;
  payload: BackupPayload;
  originalSchemaVersion: number;
  migratedFromSchema?: number;
  settingsInBackup: boolean;
  ignoredFields: string[];
}

export interface EncryptedSafetySnapshot {
  org_id: string;
  schema_version: number;
  timestamp: string;
  encrypted: true;
  salt: string;
  iv: string;
  ciphertext: string;
  counts: BackupCounts;
}

export interface RestoreSummary {
  events_created?: number;
  events_updated?: number;
  events_restored?: number;
  events_protected?: number;
  existing_locked_replaced?: number;
  judges_created?: number;
  judges_updated?: number;
  judges_restored?: number;
  participants_created?: number;
  participants_updated?: number;
  participants_restored?: number;
  scores_created?: number;
  scores_updated?: number;
  scores_restored?: number;
  settings_in_backup?: boolean;
  settings_updated?: string[];
  sync_version?: number;
}

export type RestoreMode = 'replace' | 'add' | 'merge';
