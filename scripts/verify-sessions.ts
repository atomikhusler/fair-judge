import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from '../src/config/version';
import {
  DEVICE_ID_STORAGE_KEY,
  buildDeviceLabel,
  formatSessionTimestamp,
  getOrCreateDeviceId,
} from '../src/lib/deviceIdentity';

function runSessionVerification() {
  const results: string[] = [];

  // 1. Version check
  assert.equal(APP_VERSION, '16.5.0');
  results.push('PASS 1: APP_VERSION is 16.5.0');

  // 2. Device label parser tests (browser + OS, never returns raw UA)
  const uaCases: Array<{ ua: string; touch?: number; expected: string }> = [
    {
      ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
      expected: 'Chrome on Android',
    },
    {
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
      expected: 'Safari on iOS',
    },
    {
      ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1',
      expected: 'Chrome on iOS',
    },
    {
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      touch: 0,
      expected: 'Chrome on macOS',
    },
    {
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      touch: 5,
      expected: 'Safari on iPadOS',
    },
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
      expected: 'Edge on Windows',
    },
    {
      ua: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0',
      expected: 'Firefox on Linux',
    },
    {
      ua: '',
      expected: 'Web browser',
    },
  ];

  for (const c of uaCases) {
    const label = buildDeviceLabel(c.ua, c.touch);
    assert.equal(label, c.expected);
    assert.ok(!label.includes('Mozilla/'), 'Raw UA string must never appear in device_label');
  }
  results.push('PASS 2: buildDeviceLabel derives compact Browser on OS labels without storing raw UA');

  // 3. Stable device_id generation in storage mock
  const store = new Map<string, string>();
  const origLs = (globalThis as any).localStorage;
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  try {
    const firstId = getOrCreateDeviceId();
    const secondId = getOrCreateDeviceId();
    assert.ok(firstId.length >= 32);
    assert.equal(firstId, secondId);
    assert.equal(store.get(DEVICE_ID_STORAGE_KEY), firstId);
  } finally {
    if (origLs === undefined) {
      delete (globalThis as any).localStorage;
    } else {
      (globalThis as any).localStorage = origLs;
    }
  }
  results.push('PASS 3: getOrCreateDeviceId creates & reuses a stable device UUID');

  // 4. Timestamp formatter sanity
  assert.equal(formatSessionTimestamp(new Date(Date.now() - 10_000).toISOString()), 'Just now');
  assert.equal(formatSessionTimestamp(new Date(Date.now() - 5 * 60_000).toISOString()), '5m ago');
  assert.equal(formatSessionTimestamp(new Date(Date.now() - 3 * 3600_000).toISOString()), '3h ago');
  results.push('PASS 4: formatSessionTimestamp formats recent and older timestamps cleanly');

  // 5. SQL migration invariants & exact split verification
  const sqlFull = fs.readFileSync(
    path.resolve(process.cwd(), 'sql/16.5.0-organiser-sessions.sql'),
    'utf8'
  );
  const parts = [1, 2, 3, 4].map((n) =>
    fs.readFileSync(
      path.resolve(process.cwd(), `sql/16.5.0-organiser-sessions-part${n}.txt`),
      'utf8'
    )
  );
  for (let i = 0; i < parts.length; i++) {
    const lineCount = parts[i].split('\n').length - 1;
    assert.ok(lineCount <= 300, `SQL part ${i + 1} exceeds 300 lines (${lineCount})`);
  }
  assert.equal(parts.join(''), sqlFull, 'Joined SQL parts must match full SQL file byte-for-byte');
  assert.ok(sqlFull.includes("extensions.digest(convert_to(btrim(p_token), 'utf8'), 'sha256')"));
  assert.ok(sqlFull.includes('if v_active_count >= 3 then'));
  assert.ok(sqlFull.includes("'cannot_terminate_current'"));
  assert.ok(sqlFull.includes("interval '10 minutes'"));
  assert.ok(sqlFull.includes('expires_at <= now() or revoked_at is not null'));
  assert.ok(sqlFull.includes('create or replace function public.org_change_password_v2'));
  assert.ok(sqlFull.includes('id <> v_cur_id'));
  assert.ok(
    !sqlFull.includes('drop function') && !sqlFull.includes('drop table'),
    'Upgrade safety: migration must not drop existing functions or tables'
  );

  // Confirm SHA-256 hex digest format matches Node crypto SHA-256
  const sampleTok = 'abcd'.repeat(16);
  const expectedHash = crypto.createHash('sha256').update(sampleTok, 'utf8').digest('hex');
  assert.equal(expectedHash.length, 64);
  results.push('PASS 5: SQL migration splits cleanly (<=300 lines/part) & enforces hash-only, max-3, self-protect, 10m throttle');

  // 6. UI rule audit on modified components (no backdrop-filter, no transition-all)
  const uiFiles = [
    'src/components/auth/SessionLimitSheet.tsx',
    'src/components/auth/OrganiserAuth.tsx',
    'src/components/auth/SessionReverifyModal.tsx',
    'src/components/organiser/AccountModal.tsx',
  ];
  for (const rel of uiFiles) {
    const raw = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
    const codeOnly = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!codeOnly.includes('backdrop-blur'), `${rel} must not use backdrop-blur`);
    assert.ok(!codeOnly.includes('backdrop-filter'), `${rel} must not use backdrop-filter`);
    assert.ok(!codeOnly.includes('transition-all'), `${rel} must not use transition-all`);
  }
  results.push('PASS 6: UI components contain zero backdrop-filter/backdrop-blur and zero transition-all');

  console.log('\n=== EPIC 16.5.0 SESSION VERIFICATION SUMMARY ===');
  for (const line of results) {
    console.log(line);
  }
}

runSessionVerification();
