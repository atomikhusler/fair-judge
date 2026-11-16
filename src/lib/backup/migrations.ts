import {
  BackupManifest,
  BackupPayload,
  BackupSettings,
  ParsedBackupResult,
  WHITELISTED_SETTING_KEYS,
  WhitelistedSettingKey,
} from './format';

export const CURRENT_BACKUP_SCHEMA = 2;
export const MIN_SUPPORTED_SCHEMA = 1;

const KNOWN_FILE_KEYS = new Set(['manifest', 'payload']);
const KNOWN_MANIFEST_KEYS = new Set([
  'app',
  'schema_version',
  'min_reader_schema',
  'format_version',
  'app_version',
  'org_id',
  'org_name',
  'exported_at',
  'counts',
  'checksum',
  'encrypted',
  'salt',
  'iv',
]);
const KNOWN_PAYLOAD_KEYS = new Set(['events', 'judges', 'participants', 'scores', 'settings']);
const WHITELISTED_SETTING_SET = new Set<string>(WHITELISTED_SETTING_KEYS);

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? 'null' : canonicalStringify(item)));
    return `[${items.join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const key of sortedKeys) {
    const v = obj[key];
    if (v === undefined) continue;
    entries.push(`${JSON.stringify(key)}:${canonicalStringify(v)}`);
  }
  return `{${entries.join(',')}}`;
}

export async function computePayloadChecksum(payload: BackupPayload): Promise<string> {
  const canonical = canonicalStringify(payload);
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function pickWhitelistedSettings(
  rawSettings: Record<string, any> | undefined | null
): { cleanSettings: BackupSettings; unknownSettingKeys: string[] } {
  const cleanSettings: BackupSettings = {};
  const unknownSettingKeys: string[] = [];

  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    return { cleanSettings, unknownSettingKeys };
  }

  for (const key of Object.keys(rawSettings)) {
    if (WHITELISTED_SETTING_SET.has(key)) {
      const val = rawSettings[key];
      if (val !== undefined) {
        (cleanSettings as any)[key as WhitelistedSettingKey] = val;
      }
    } else {
      unknownSettingKeys.push(`settings.${key}`);
    }
  }

  return { cleanSettings, unknownSettingKeys };
}

export function resolveBackupSchemaVersion(rawManifest: Record<string, any>): number {
  if (rawManifest.schema_version !== undefined && rawManifest.schema_version !== null) {
    const num = Number(rawManifest.schema_version);
    if (!Number.isInteger(num)) {
      throw new Error('This backup version is too old or unsupported.');
    }
    return num;
  }

  const fmt = String(rawManifest.format_version || '').trim();
  if (fmt === '1.0.0' || fmt.startsWith('1.')) return 1;
  if (fmt === '2.0.0' || fmt.startsWith('2.')) return 2;

  const major = Number(fmt.split('.')[0]);
  if (Number.isInteger(major) && major > 0) {
    return major;
  }

  throw new Error('This backup version is too old or unsupported.');
}

function migrateV1ToV2(
  rawManifest: Record<string, any>,
  rawPayload: Record<string, any>
): { manifest: BackupManifest; payload: BackupPayload } {
  const events = Array.isArray(rawPayload.events) ? rawPayload.events : [];
  const judges = Array.isArray(rawPayload.judges) ? rawPayload.judges : [];
  const participants = Array.isArray(rawPayload.participants) ? rawPayload.participants : [];
  const scores = Array.isArray(rawPayload.scores) ? rawPayload.scores : [];

  const payload: BackupPayload = {
    events,
    judges,
    participants,
    scores,
  };

  const manifest: BackupManifest = {
    app: 'Fair Judge',
    schema_version: CURRENT_BACKUP_SCHEMA,
    min_reader_schema: MIN_SUPPORTED_SCHEMA,
    format_version: '2.0.0',
    app_version: String(rawManifest.app_version || '1.0.0'),
    org_id: String(rawManifest.org_id || ''),
    org_name: String(rawManifest.org_name || 'Organization'),
    exported_at: String(rawManifest.exported_at || new Date().toISOString()),
    counts: {
      events: events.length,
      judges: judges.length,
      participants: participants.length,
      scores: scores.length,
      settings: 0,
    },
    checksum: typeof rawManifest.checksum === 'string' ? rawManifest.checksum : undefined,
    encrypted: Boolean(rawManifest.encrypted),
    ...(rawManifest.salt ? { salt: String(rawManifest.salt) } : {}),
    ...(rawManifest.iv ? { iv: String(rawManifest.iv) } : {}),
  };

  return { manifest, payload };
}

export function validateBackupSchemaBounds(rawManifest: Record<string, any>): number {
  const schemaVersion = resolveBackupSchemaVersion(rawManifest);

  if (schemaVersion > CURRENT_BACKUP_SCHEMA) {
    throw new Error('This backup was made by a newer version. Update the app first.');
  }

  if (rawManifest.min_reader_schema !== undefined && rawManifest.min_reader_schema !== null) {
    const minReader = Number(rawManifest.min_reader_schema);
    if (Number.isFinite(minReader) && minReader > CURRENT_BACKUP_SCHEMA) {
      throw new Error('This backup was made by a newer version. Update the app first.');
    }
  }

  if (schemaVersion < MIN_SUPPORTED_SCHEMA) {
    throw new Error('This backup version is too old or unsupported.');
  }

  return schemaVersion;
}

export async function migrateBackupFile(
  rawFile: Record<string, any>,
  decryptedPayload: Record<string, any>
): Promise<ParsedBackupResult> {
  if (!rawFile || typeof rawFile !== 'object' || !rawFile.manifest || typeof rawFile.manifest !== 'object') {
    throw new Error('Invalid backup manifest.');
  }
  if (rawFile.manifest.app !== 'Fair Judge') {
    throw new Error('Unrecognized backup format. File must be created by Fair Judge.');
  }
  if (!decryptedPayload || typeof decryptedPayload !== 'object' || Array.isArray(decryptedPayload)) {
    throw new Error('File is damaged or edited.');
  }

  const rawManifest = rawFile.manifest as Record<string, any>;
  const originalSchemaVersion = validateBackupSchemaBounds(rawManifest);

  // Checksum validation: mandatory on v2+, also verified if present on v1
  const rawChecksum = typeof rawManifest.checksum === 'string' ? rawManifest.checksum.trim().toLowerCase() : '';
  if (originalSchemaVersion >= 2) {
    if (!rawChecksum) {
      throw new Error('File is damaged or edited.');
    }
    const actualChecksum = await computePayloadChecksum(decryptedPayload as BackupPayload);
    if (actualChecksum !== rawChecksum) {
      throw new Error('File is damaged or edited.');
    }
  } else if (rawChecksum) {
    const actualChecksum = await computePayloadChecksum(decryptedPayload as BackupPayload);
    if (actualChecksum !== rawChecksum) {
      throw new Error('File is damaged or edited.');
    }
  }

  // Collect unknown fields at file, manifest, payload, and settings levels (stripped, never sent to DB)
  const ignoredFields: string[] = [];
  for (const key of Object.keys(rawFile)) {
    if (!KNOWN_FILE_KEYS.has(key)) {
      ignoredFields.push(`file.${key}`);
    }
  }
  for (const key of Object.keys(rawManifest)) {
    if (!KNOWN_MANIFEST_KEYS.has(key)) {
      ignoredFields.push(`manifest.${key}`);
    }
  }
  for (const key of Object.keys(decryptedPayload)) {
    if (!KNOWN_PAYLOAD_KEYS.has(key)) {
      ignoredFields.push(`payload.${key}`);
    }
  }

  if (originalSchemaVersion === 1) {
    const { manifest, payload } = migrateV1ToV2(rawManifest, decryptedPayload);
    if ('settings' in decryptedPayload && decryptedPayload.settings !== undefined) {
      ignoredFields.push('payload.settings');
    }
    return {
      manifest,
      payload,
      originalSchemaVersion: 1,
      migratedFromSchema: 1,
      settingsInBackup: false,
      ignoredFields,
    };
  }

  // Schema v2 normalization
  const events = Array.isArray(decryptedPayload.events) ? decryptedPayload.events : [];
  const judges = Array.isArray(decryptedPayload.judges) ? decryptedPayload.judges : [];
  const participants = Array.isArray(decryptedPayload.participants) ? decryptedPayload.participants : [];
  const scores = Array.isArray(decryptedPayload.scores) ? decryptedPayload.scores : [];

  const hasRawSettings =
    decryptedPayload.settings !== undefined &&
    decryptedPayload.settings !== null &&
    typeof decryptedPayload.settings === 'object' &&
    !Array.isArray(decryptedPayload.settings);

  let cleanSettings: BackupSettings | undefined;
  let settingsInBackup = false;

  if (hasRawSettings) {
    const { cleanSettings: picked, unknownSettingKeys } = pickWhitelistedSettings(decryptedPayload.settings);
    ignoredFields.push(...unknownSettingKeys);
    cleanSettings = picked;
    settingsInBackup = true;
  } else if (decryptedPayload.settings !== undefined) {
    ignoredFields.push('payload.settings');
  }

  const cleanPayload: BackupPayload = {
    events,
    judges,
    participants,
    scores,
    ...(settingsInBackup && cleanSettings ? { settings: cleanSettings } : {}),
  };

  const manifest: BackupManifest = {
    app: 'Fair Judge',
    schema_version: CURRENT_BACKUP_SCHEMA,
    min_reader_schema: Number(rawManifest.min_reader_schema || MIN_SUPPORTED_SCHEMA),
    format_version: '2.0.0',
    app_version: String(rawManifest.app_version || '16.3.0'),
    org_id: String(rawManifest.org_id || ''),
    org_name: String(rawManifest.org_name || 'Organization'),
    exported_at: String(rawManifest.exported_at || new Date().toISOString()),
    counts: {
      events: events.length,
      judges: judges.length,
      participants: participants.length,
      scores: scores.length,
      settings: cleanSettings ? Object.keys(cleanSettings).length : 0,
    },
    checksum: rawChecksum,
    encrypted: Boolean(rawManifest.encrypted),
    ...(rawManifest.salt ? { salt: String(rawManifest.salt) } : {}),
    ...(rawManifest.iv ? { iv: String(rawManifest.iv) } : {}),
  };

  return {
    manifest,
    payload: cleanPayload,
    originalSchemaVersion: CURRENT_BACKUP_SCHEMA,
    settingsInBackup,
    ignoredFields,
  };
}
