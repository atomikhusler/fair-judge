import { Organization } from '../supabaseTypes';
import { supabase, isSupabaseConfigured, getStoredSessionToken } from '../supabase';
import { APP_VERSION } from '../../config/version';
import {
  BackupManifest,
  BackupPayload,
  EncryptedSafetySnapshot,
  ParsedBackupResult,
  RawBackupFile,
  RestoreMode,
  RestoreSummary,
} from './format';
import { collectOrganizationData, extractWhitelistedOrgSettings } from './collect';
import { encryptPayload, decryptPayload } from './crypto';
import {
  CURRENT_BACKUP_SCHEMA,
  MIN_SUPPORTED_SCHEMA,
  computePayloadChecksum,
  migrateBackupFile,
  pickWhitelistedSettings,
  validateBackupSchemaBounds,
} from './migrations';
import { getCacheDB } from '../db/indexedDB';

const SAFETY_SNAPSHOT_KEY = 'fj_backup_safety_snapshot';

function getSafetySnapshotStorageKey(orgId: string): string {
  return `${SAFETY_SNAPSHOT_KEY}_${orgId.trim().toUpperCase()}`;
}

function scrubLegacyLocalSnapshot(key: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {}
}

export async function createBackupFromPayload(
  org: Organization,
  rawData: BackupPayload,
  pin?: string
): Promise<{ filename: string; blob: Blob; jsonText: string; manifest: BackupManifest }> {
  const { cleanSettings } = pickWhitelistedSettings(
    rawData.settings || extractWhitelistedOrgSettings(org)
  );

  const data: BackupPayload = {
    events: Array.isArray(rawData.events) ? rawData.events : [],
    judges: Array.isArray(rawData.judges) ? rawData.judges : [],
    participants: Array.isArray(rawData.participants) ? rawData.participants : [],
    scores: Array.isArray(rawData.scores) ? rawData.scores : [],
    settings: cleanSettings,
  };

  const checksum = await computePayloadChecksum(data);
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
    schema_version: CURRENT_BACKUP_SCHEMA,
    min_reader_schema: MIN_SUPPORTED_SCHEMA,
    format_version: '2.0.0',
    app_version: APP_VERSION,
    org_id: org.org_id,
    org_name: cleanSettings.name || org.name,
    exported_at: new Date().toISOString(),
    counts: {
      events: data.events.length,
      judges: data.judges.length,
      participants: data.participants.length,
      scores: data.scores.length,
      settings: Object.keys(cleanSettings).length,
    },
    checksum,
    encrypted: isEncrypted,
    ...(salt ? { salt } : {}),
    ...(iv ? { iv } : {}),
  };

  const fileData: RawBackupFile = {
    manifest,
    payload: payloadOut,
  };

  const jsonText = JSON.stringify(fileData, null, 2);
  const blob = new Blob([jsonText], { type: 'application/json' });
  const dateStr = new Date().toISOString().slice(0, 10);
  const cleanOrgCode = org.org_id.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const filename = `fairjudge-backup-${cleanOrgCode}-${dateStr}.json`;

  return {
    filename,
    blob,
    jsonText,
    manifest,
  };
}

export async function createBackup(
  org: Organization,
  pin?: string
): Promise<{ filename: string; blob: Blob; jsonText: string; manifest: BackupManifest }> {
  const data = await collectOrganizationData(org);
  return createBackupFromPayload(org, data, pin);
}

export async function parseBackupFile(
  fileText: string,
  pin?: string
): Promise<ParsedBackupResult> {
  let parsed: RawBackupFile;
  try {
    parsed = JSON.parse(fileText);
  } catch {
    throw new Error('Invalid JSON backup file format.');
  }

  if (!parsed || typeof parsed !== 'object' || parsed.manifest?.app !== 'Fair Judge') {
    throw new Error('Unrecognized backup format. File must be created by Fair Judge.');
  }

  const rawManifest = parsed.manifest as Record<string, any>;
  // Reject future / unsupported schema versions before decrypting
  validateBackupSchemaBounds(rawManifest);

  let rawPayloadObj: Record<string, any>;
  if (rawManifest.encrypted) {
    if (!pin) {
      throw new Error('ENCRYPTED_BACKUP: This backup is encrypted. Please enter your security PIN.');
    }
    if (!rawManifest.salt || !rawManifest.iv || typeof parsed.payload !== 'string') {
      throw new Error('File is damaged or edited.');
    }
    const decryptedJson = await decryptPayload(
      parsed.payload,
      pin.trim(),
      String(rawManifest.salt),
      String(rawManifest.iv)
    );
    try {
      rawPayloadObj = JSON.parse(decryptedJson);
    } catch {
      throw new Error('File is damaged or edited.');
    }
  } else {
    if (!parsed.payload || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) {
      throw new Error('File is damaged or edited.');
    }
    rawPayloadObj = parsed.payload as Record<string, any>;
  }

  return migrateBackupFile(parsed as Record<string, any>, rawPayloadObj);
}

function mapRestoreRpcError(res: any, prefix: string): Error {
  const errCode = res?.error || res?.reason || '';
  const reason = res?.message || errCode || 'Unknown error';
  if (errCode === 'unauthorized') {
    return new Error('Session expired or invalid. Please sign in again.');
  }
  if (errCode === 'too_many_attempts') {
    return new Error('Too many wrong password attempts. Try again in 15 minutes.');
  }
  if (errCode === 'invalid_credentials') {
    return new Error('Invalid master password. Please verify credentials.');
  }
  if (errCode === 'backup_too_new') {
    return new Error('This backup was made by a newer version. Update the app first.');
  }
  if (errCode === 'unsupported_backup_version') {
    return new Error('This backup version is too old or unsupported.');
  }
  return new Error(`${prefix}: ${reason}`);
}

async function callOrgRestoreV2(
  orgId: string,
  password: string,
  payload: BackupPayload,
  mode: RestoreMode,
  dryRun: boolean
): Promise<RestoreSummary> {
  if (!isSupabaseConfigured() || (typeof navigator !== 'undefined' && !navigator.onLine)) {
    throw new Error(
      dryRun
        ? 'Restore simulation requires an internet connection.'
        : 'Restoration requires an internet connection.'
    );
  }

  const token = (getStoredSessionToken() || '').trim();
  if (!token) {
    throw new Error('Session token missing. Please sign in again.');
  }

  // Send only known v2 schema fields; unknown fields remain stripped
  const rpcPayload: Record<string, any> = {
    schema_version: CURRENT_BACKUP_SCHEMA,
    events: payload.events || [],
    judges: payload.judges || [],
    participants: payload.participants || [],
    scores: payload.scores || [],
  };
  if (payload.settings) {
    rpcPayload.settings = pickWhitelistedSettings(payload.settings).cleanSettings;
  }

  const { data, error } = await supabase.rpc('org_restore_v2', {
    p_token: token,
    p_org_id: orgId,
    p_password: password,
    p_mode: mode,
    p_payload: rpcPayload,
    p_dry_run: dryRun,
  });

  if (error) {
    throw new Error(`${dryRun ? 'Dry run' : 'Restore'} failed: ${error.message}`);
  }

  const res = data as any;
  if (!res || !res.ok) {
    throw mapRestoreRpcError(res, dryRun ? 'Dry run rejected' : 'Restore failed');
  }

  return (res.summary || {}) as RestoreSummary;
}

export async function previewRestore(
  orgId: string,
  password: string,
  payload: BackupPayload,
  mode: RestoreMode
): Promise<RestoreSummary> {
  return callOrgRestoreV2(orgId, password, payload, mode, true);
}

export async function applyRestore(
  orgId: string,
  password: string,
  payload: BackupPayload,
  mode: RestoreMode
): Promise<RestoreSummary> {
  return callOrgRestoreV2(orgId, password, payload, mode, false);
}

export async function saveEncryptedSafetySnapshot(
  orgId: string,
  data: BackupPayload,
  masterPassword: string
): Promise<void> {
  const cleanPwd = masterPassword.trim();
  if (!cleanPwd) {
    throw new Error('Master password is required to encrypt the safety snapshot.');
  }

  const cleanOrgId = orgId.trim().toUpperCase();
  const key = getSafetySnapshotStorageKey(cleanOrgId);
  scrubLegacyLocalSnapshot(key);

  const enc = await encryptPayload(JSON.stringify(data), cleanPwd);
  const snapshot: EncryptedSafetySnapshot = {
    org_id: cleanOrgId,
    schema_version: CURRENT_BACKUP_SCHEMA,
    timestamp: new Date().toISOString(),
    encrypted: true,
    salt: enc.salt,
    iv: enc.iv,
    ciphertext: enc.ciphertext,
    counts: {
      events: data.events.length,
      judges: data.judges.length,
      participants: data.participants.length,
      scores: data.scores.length,
      settings: data.settings ? Object.keys(data.settings).length : 0,
    },
  };

  const db = await getCacheDB();
  await db.put('cache_store', {
    key,
    data: snapshot,
    timestamp: Date.now(),
  });

  const savedEntry = await db.get('cache_store', key);
  const savedSnap = savedEntry?.data as EncryptedSafetySnapshot | undefined;
  if (
    !savedSnap ||
    savedSnap.encrypted !== true ||
    savedSnap.ciphertext !== enc.ciphertext ||
    savedSnap.salt !== enc.salt ||
    savedSnap.iv !== enc.iv
  ) {
    throw new Error('Could not verify saved safety snapshot in local storage.');
  }
}

export async function createSafetySnapshot(
  org: Organization,
  masterPassword: string
): Promise<void> {
  const current = await collectOrganizationData(org);
  await saveEncryptedSafetySnapshot(org.org_id, current, masterPassword);
}

async function readEncryptedSafetySnapshot(orgId: string): Promise<EncryptedSafetySnapshot | null> {
  const key = getSafetySnapshotStorageKey(orgId);
  scrubLegacyLocalSnapshot(key);
  try {
    const db = await getCacheDB();
    const entry = await db.get('cache_store', key);
    const snap = entry?.data as EncryptedSafetySnapshot | undefined;
    if (
      snap &&
      snap.encrypted === true &&
      typeof snap.ciphertext === 'string' &&
      typeof snap.salt === 'string' &&
      typeof snap.iv === 'string'
    ) {
      return snap;
    }
    return null;
  } catch {
    return null;
  }
}

export async function hasSafetySnapshot(orgId: string): Promise<boolean> {
  const snap = await readEncryptedSafetySnapshot(orgId);
  return Boolean(snap);
}

export async function getSafetySnapshotInfo(
  orgId: string
): Promise<{ timestamp: string; counts: EncryptedSafetySnapshot['counts'] } | null> {
  const snap = await readEncryptedSafetySnapshot(orgId);
  if (!snap) return null;
  return {
    timestamp: snap.timestamp,
    counts: snap.counts,
  };
}

export async function decryptSafetySnapshot(
  snapshot: EncryptedSafetySnapshot,
  masterPassword: string
): Promise<BackupPayload> {
  const cleanPwd = masterPassword.trim();
  if (!cleanPwd) {
    throw new Error('Master password is required.');
  }
  try {
    const json = await decryptPayload(snapshot.ciphertext, cleanPwd, snapshot.salt, snapshot.iv);
    return JSON.parse(json) as BackupPayload;
  } catch {
    throw new Error('Invalid master password. Could not unlock local safety snapshot.');
  }
}

export async function restoreSafetySnapshot(
  orgId: string,
  password: string
): Promise<RestoreSummary> {
  const snap = await readEncryptedSafetySnapshot(orgId);
  if (!snap) {
    throw new Error('No encrypted safety snapshot found to undo.');
  }
  const cleanPwd = password.trim();
  const data = await decryptSafetySnapshot(snap, cleanPwd);
  return applyRestore(orgId, cleanPwd, data, 'replace');
}

export * from './format';
export * from './collect';
export * from './crypto';
export * from './migrations';
