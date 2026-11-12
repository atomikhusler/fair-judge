import { Organization } from '../supabaseTypes';
import { supabase, isSupabaseConfigured } from '../supabase';
import { APP_VERSION } from '../../config/version';
import { BackupManifest, BackupPayload, RawBackupFile, RestoreMode, RestoreSummary } from './format';
import { collectOrganizationData } from './collect';
import { encryptPayload, decryptPayload } from './crypto';
import { getIndexedDBCache, setIndexedDBCache } from '../db/indexedDB';

const SAFETY_SNAPSHOT_KEY = 'fj_backup_safety_snapshot';

export async function createBackup(
  org: Organization,
  pin?: string
): Promise<{ filename: string; blob: Blob; manifest: BackupManifest }> {
  const data = await collectOrganizationData(org.org_id);
  const isEncrypted = Boolean(pin && pin.trim().length > 0);

  let payloadOut: BackupPayload | string = data;
  let salt: string | undefined;
  let iv: string | undefined;

  if (isEncrypted && pin) {
    const rawJson = JSON.stringify(data);
    const enc = await encryptPayload(rawJson, pin.trim());
    payloadOut = enc.ciphertext;
    salt = enc.salt;
    iv = enc.iv;
  }

  const manifest: BackupManifest = {
    app: 'Fair Judge',
    format_version: '1.0.0',
    app_version: APP_VERSION,
    org_id: org.org_id,
    org_name: org.name,
    exported_at: new Date().toISOString(),
    counts: {
      events: data.events.length,
      judges: data.judges.length,
      participants: data.participants.length,
      scores: data.scores.length,
    },
    encrypted: isEncrypted,
    salt,
    iv,
  };

  const fileData: RawBackupFile = {
    manifest,
    payload: payloadOut,
  };

  const jsonStr = JSON.stringify(fileData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const dateStr = new Date().toISOString().slice(0, 10);
  const cleanOrgCode = org.org_id.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const filename = `fairjudge-backup-${cleanOrgCode}-${dateStr}.json`;

  return {
    filename,
    blob,
    manifest,
  };
}

export async function parseBackupFile(
  fileText: string,
  pin?: string
): Promise<{ manifest: BackupManifest; payload: BackupPayload }> {
  let parsed: RawBackupFile;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error('Invalid JSON backup file format.');
  }

  if (parsed.manifest?.app !== 'Fair Judge') {
    throw new Error('Unrecognized backup format. File must be created by Fair Judge.');
  }

  const { manifest, payload } = parsed;

  if (manifest.encrypted) {
    if (!pin) {
      throw new Error('ENCRYPTED_BACKUP: This backup is encrypted. Please enter your 4-digit PIN.');
    }
    if (!manifest.salt || !manifest.iv || typeof payload !== 'string') {
      throw new Error('Corrupted encrypted backup file structure.');
    }
    const decryptedJson = await decryptPayload(payload, pin.trim(), manifest.salt, manifest.iv);
    const decryptedPayload = JSON.parse(decryptedJson) as BackupPayload;
    return { manifest, payload: decryptedPayload };
  }

  return {
    manifest,
    payload: payload as BackupPayload,
  };
}

export async function previewRestore(
  orgId: string,
  payload: BackupPayload,
  mode: RestoreMode
): Promise<RestoreSummary> {
  if (!isSupabaseConfigured() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    throw new Error('Restore simulation requires an internet connection.');
  }

  const { data, error } = await supabase.rpc('org_restore', {
    p_org_id: orgId,
    p_mode: mode,
    p_payload: payload,
    p_dry_run: true,
  });

  if (error) {
    throw new Error(`Dry run failed: ${error.message}`);
  }

  const res = data as any;
  if (!res || !res.ok) {
    throw new Error(`Dry run rejected: ${res?.error || 'Unknown error'}`);
  }

  return res.summary as RestoreSummary;
}

export async function applyRestore(
  orgId: string,
  payload: BackupPayload,
  mode: RestoreMode
): Promise<RestoreSummary> {
  if (!isSupabaseConfigured() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    throw new Error('Restoration requires an internet connection.');
  }

  const { data, error } = await supabase.rpc('org_restore', {
    p_org_id: orgId,
    p_mode: mode,
    p_payload: payload,
    p_dry_run: false,
  });

  if (error) {
    throw new Error(`Restore failed: ${error.message}`);
  }

  const res = data as any;
  if (!res || !res.ok) {
    throw new Error(`Restore failed: ${res?.error || 'Unknown error'}`);
  }

  return res.summary as RestoreSummary;
}

export async function createSafetySnapshot(org: Organization): Promise<void> {
  try {
    const current = await collectOrganizationData(org.org_id);
    await setIndexedDBCache(
      `${SAFETY_SNAPSHOT_KEY}_${org.org_id}`,
      {
        timestamp: new Date().toISOString(),
        data: current,
      },
      true
    );
  } catch (err) {
    console.warn('Safety snapshot creation notice:', err);
  }
}

export async function hasSafetySnapshot(orgId: string): Promise<boolean> {
  try {
    const snap = await getIndexedDBCache<any>(`${SAFETY_SNAPSHOT_KEY}_${orgId}`, null);
    return Boolean(snap && snap.data);
  } catch {
    return false;
  }
}

export async function restoreSafetySnapshot(orgId: string): Promise<RestoreSummary> {
  const snap = await getIndexedDBCache<any>(`${SAFETY_SNAPSHOT_KEY}_${orgId}`, null);
  if (!snap || !snap.data) {
    throw new Error('No safety snapshot found to undo.');
  }
  return await applyRestore(orgId, snap.data, 'replace');
}

export * from './format';
export * from './collect';
export * from './crypto';
