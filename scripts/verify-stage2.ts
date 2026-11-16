import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { EncryptedSafetySnapshot } from '../src/lib/backup/format';
import type { Organization } from '../src/lib/supabaseTypes';

// Minimal Web Worker / browser global shim for Node tsx evaluation
if (typeof (globalThis as any).self === 'undefined') {
  (globalThis as any).self = globalThis;
}

const FIXTURES_DIR = path.resolve(process.cwd(), 'src/lib/backup/__fixtures__');

async function runTests() {
  const {
    computePayloadChecksum,
    createBackupFromPayload,
    decryptPayload,
    decryptSafetySnapshot,
    encryptPayload,
    inspectBackupSensitivity,
    parseBackupFile,
    WHITELISTED_SETTING_KEYS,
  } = await import('../src/lib/backup/index');
  const { dbService } = await import('../src/lib/supabase');

  const results: string[] = [];

  // 1. Load & parse realistic v1.0.0 fixture
  const v1Raw = fs.readFileSync(path.join(FIXTURES_DIR, 'v1-sample.json'), 'utf8');
  const v1Parsed = await parseBackupFile(v1Raw);
  assert.equal(v1Parsed.originalSchemaVersion, 1);
  assert.equal(v1Parsed.migratedFromSchema, 1);
  assert.equal(v1Parsed.manifest.schema_version, 2);
  assert.equal(v1Parsed.manifest.format_version, '2.0.0');
  assert.equal(v1Parsed.settingsInBackup, false);
  assert.equal(v1Parsed.payload.settings, undefined);
  assert.equal(v1Parsed.manifest.counts.settings, 0);
  assert.equal(v1Parsed.payload.events.length, 1);
  assert.equal(v1Parsed.payload.events[0].is_locked, true);
  assert.equal(v1Parsed.payload.judges[0].pin, '4921');
  results.push('PASS 1: v1.0.0 fixture migrates to v2 cleanly with settings untouched');

  // 2. Load & parse realistic v2.0.0 fixture + round-trip + unknown field stripping
  const v2Raw = fs.readFileSync(path.join(FIXTURES_DIR, 'v2-sample.json'), 'utf8');
  const v2Parsed = await parseBackupFile(v2Raw);
  assert.equal(v2Parsed.originalSchemaVersion, 2);
  assert.equal(v2Parsed.migratedFromSchema, undefined);
  assert.equal(v2Parsed.settingsInBackup, true);
  assert.equal(v2Parsed.manifest.counts.settings, WHITELISTED_SETTING_KEYS.length);
  for (const key of WHITELISTED_SETTING_KEYS) {
    assert.ok(key in (v2Parsed.payload.settings || {}), `Missing whitelisted setting ${key}`);
  }

  // Round-trip createBackupFromPayload -> parseBackupFile (plain)
  const fakeOrg: Organization = {
    id: '00000000-0000-4000-8000-000000000001',
    org_id: 'FJ-TEST',
    name: v2Parsed.payload.settings?.name || 'Heritage Arts Festival 2026',
    email: v2Parsed.payload.settings?.email,
    tie_breaker_enabled: v2Parsed.payload.settings?.tie_breaker_enabled,
    tie_breaker_method: v2Parsed.payload.settings?.tie_breaker_method,
    custom_participant_fields: v2Parsed.payload.settings?.custom_participant_fields,
    blind_judging_enabled: v2Parsed.payload.settings?.blind_judging_enabled,
    auto_advance_enabled: v2Parsed.payload.settings?.auto_advance_enabled,
    grace_period_enabled: v2Parsed.payload.settings?.grace_period_enabled,
    isolated_jury_enabled: v2Parsed.payload.settings?.isolated_jury_enabled,
    projector_blind_mode: v2Parsed.payload.settings?.projector_blind_mode,
    projector_spotlight_mode: v2Parsed.payload.settings?.projector_spotlight_mode,
    projector_ticker_text: v2Parsed.payload.settings?.projector_ticker_text,
    projector_carousel_interval: v2Parsed.payload.settings?.projector_carousel_interval,
    created_at: '2026-01-01T00:00:00.000Z',
  };

  const exportedPlain = await createBackupFromPayload(fakeOrg, v2Parsed.payload);
  assert.equal(exportedPlain.manifest.schema_version, 2);
  assert.equal(exportedPlain.manifest.min_reader_schema, 1);
  assert.equal(exportedPlain.manifest.encrypted, false);
  const reParsedPlain = await parseBackupFile(exportedPlain.jsonText);
  assert.deepEqual(reParsedPlain.payload.settings, v2Parsed.payload.settings);
  assert.equal(reParsedPlain.ignoredFields.length, 0);

  // Unknown fields test (with valid checksum)
  const v2WithExtras = JSON.parse(v2Raw);
  v2WithExtras.extra_top = true;
  v2WithExtras.manifest.extra_manifest = 'foo';
  v2WithExtras.payload.unknown_table = [{ id: 'x' }];
  v2WithExtras.payload.settings.password = 'should-never-reach-db';
  v2WithExtras.payload.settings.future_toggle = true;
  v2WithExtras.manifest.checksum = await computePayloadChecksum(v2WithExtras.payload);

  const strippedParsed = await parseBackupFile(JSON.stringify(v2WithExtras));
  assert.deepEqual(
    strippedParsed.ignoredFields.sort(),
    [
      'file.extra_top',
      'manifest.extra_manifest',
      'payload.unknown_table',
      'settings.future_toggle',
      'settings.password',
    ].sort()
  );
  assert.equal((strippedParsed.payload as any).unknown_table, undefined);
  assert.equal((strippedParsed.payload.settings as any).password, undefined);
  assert.equal((strippedParsed.payload.settings as any).future_toggle, undefined);
  results.push('PASS 2: v2.0.0 round-trip preserves 13 settings & strips unknown/forbidden fields');

  // 3. Too-new backup refusal (including encrypted future schema rejected before decrypt)
  const futureV99 = JSON.parse(v2Raw);
  futureV99.manifest.schema_version = 99;
  await assert.rejects(
    () => parseBackupFile(JSON.stringify(futureV99)),
    /This backup was made by a newer version\. Update the app first\./
  );

  const futureMinReader = JSON.parse(v2Raw);
  futureMinReader.manifest.schema_version = 2;
  futureMinReader.manifest.min_reader_schema = 3;
  futureMinReader.manifest.encrypted = true;
  futureMinReader.payload = 'not-decrypted-yet';
  await assert.rejects(
    () => parseBackupFile(JSON.stringify(futureMinReader)),
    /This backup was made by a newer version\. Update the app first\./
  );

  const tooOldV0 = JSON.parse(v2Raw);
  tooOldV0.manifest.schema_version = 0;
  await assert.rejects(
    () => parseBackupFile(JSON.stringify(tooOldV0)),
    /This backup version is too old or unsupported\./
  );
  results.push('PASS 3: Future schema_version / min_reader_schema and v0 rejected cleanly');

  // 4. Tampered payload & tampered checksum refusal
  const tamperedPayload = JSON.parse(v2Raw);
  tamperedPayload.payload.participants[0].name = 'Tampered Name';
  await assert.rejects(
    () => parseBackupFile(JSON.stringify(tamperedPayload)),
    /File is damaged or edited\./
  );

  const badChecksum = JSON.parse(v2Raw);
  badChecksum.manifest.checksum = '0'.repeat(64);
  await assert.rejects(
    () => parseBackupFile(JSON.stringify(badChecksum)),
    /File is damaged or edited\./
  );
  results.push('PASS 4: Tampered payload and bad checksum rejected with exact error');

  // 5. Encrypted v2 round-trip + wrong PIN refusal
  const exportedEncrypted = await createBackupFromPayload(fakeOrg, v2Parsed.payload, '9482');
  assert.equal(exportedEncrypted.manifest.encrypted, true);
  assert.equal(typeof exportedEncrypted.jsonText, 'string');

  await assert.rejects(
    () => parseBackupFile(exportedEncrypted.jsonText),
    /ENCRYPTED_BACKUP/
  );
  await assert.rejects(
    () => parseBackupFile(exportedEncrypted.jsonText, '0000'),
    /Incorrect decryption PIN or corrupted backup file\./
  );
  const decryptedV2 = await parseBackupFile(exportedEncrypted.jsonText, '9482');
  assert.deepEqual(decryptedV2.payload.settings, v2Parsed.payload.settings);
  assert.equal(decryptedV2.payload.judges[0].pin, '4921');
  results.push('PASS 5: Encrypted v2 round-trip succeeds with right PIN & rejects wrong PIN');

  // 6. Master-password encrypted safety snapshot + wrong-password refusal
  const encSnapRaw = await encryptPayload(JSON.stringify(v2Parsed.payload), 'MasterPass#2026');
  const snapshotObj: EncryptedSafetySnapshot = {
    org_id: 'FJ-TEST',
    schema_version: 2,
    timestamp: new Date().toISOString(),
    encrypted: true,
    salt: encSnapRaw.salt,
    iv: encSnapRaw.iv,
    ciphertext: encSnapRaw.ciphertext,
    counts: exportedEncrypted.manifest.counts,
  };
  await assert.rejects(
    () => decryptSafetySnapshot(snapshotObj, 'WrongPass!'),
    /Invalid master password\. Could not unlock local safety snapshot\./
  );
  const unlockedSnapshot = await decryptSafetySnapshot(snapshotObj, 'MasterPass#2026');
  assert.equal(unlockedSnapshot.events.length, 1);
  assert.equal(unlockedSnapshot.settings?.name, 'Heritage Arts Festival 2026');
  const directCheck = await decryptPayload(
    snapshotObj.ciphertext,
    'MasterPass#2026',
    snapshotObj.salt,
    snapshotObj.iv
  );
  assert.ok(directCheck.includes('Heritage Arts Festival 2026'));
  results.push('PASS 6: Encrypted safety snapshot decrypts with master password & rejects wrong password');

  // 7. Sensitivity inspection check
  const sens = inspectBackupSensitivity(v2Parsed.payload);
  assert.equal(sens.hasPins, true);
  assert.equal(sens.hasPhones, true);
  assert.equal(sens.judgePinCount, 1);
  assert.equal(sens.participantPhoneCount, 1);
  results.push('PASS 7: Plaintext sensitivity detection finds judge PINs and participant phones');

  // 8. Offline guard for Master Reset
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: false },
    configurable: true,
    writable: true,
  });
  try {
    await assert.rejects(
      () => dbService.resetOrganizationAll('FJ-TEST', 'MasterPass#2026'),
      /Reset needs internet/
    );
  } finally {
    if (origNavDesc) {
      Object.defineProperty(globalThis, 'navigator', origNavDesc);
    }
  }
  results.push('PASS 8: dbService.resetOrganizationAll refuses offline with "Reset needs internet"');

  console.log('\n=== STAGE 2 B7 VERIFICATION SUMMARY ===');
  for (const line of results) {
    console.log(line);
  }
}

runTests().catch((err) => {
  console.error('Stage 2 verification failed:', err);
  process.exit(1);
});
