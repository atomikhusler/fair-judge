import { SupabaseEvent, SupabaseJudge, SupabaseParticipant, SupabaseScore } from '../supabaseTypes';

export interface BackupManifest {
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
  salt?: string; // hex encoded PBKDF2 salt
  iv?: string;   // hex encoded AES-GCM IV
}

export interface BackupPayload {
  events: SupabaseEvent[];
  judges: SupabaseJudge[];
  participants: SupabaseParticipant[];
  scores: SupabaseScore[];
}

export interface RawBackupFile {
  manifest: BackupManifest;
  payload: BackupPayload | string; // Plain object or ciphertext base64
}

export interface RestoreSummary {
  events_created?: number;
  events_updated?: number;
  events_restored?: number;
  events_protected?: number;
  judges_created?: number;
  judges_updated?: number;
  judges_restored?: number;
  participants_created?: number;
  participants_updated?: number;
  participants_restored?: number;
  scores_created?: number;
  scores_updated?: number;
  scores_restored?: number;
}

export type RestoreMode = 'replace' | 'add' | 'merge';
