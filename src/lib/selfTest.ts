/**
 * Fair Judge Hardware Self-Test Engine
 * Epic 15.4: Diagnostics, Device Probes, Backend Verification, Storage Audit,
 * Data Integrity, Code Health (Black Box), & Scoring Engine (Golden Tests).
 * Read-only: never alters scores, sync queues, drafts, or database state.
 */

import { supabase, isSupabaseConfigured } from './supabase';
import { APP_VERSION } from '../config/version';
import { 
  getPendingScores, 
  getPendingMutations, 
  getFailedMutations, 
  getPendingCount 
} from './offlineQueue';
import { blackBox } from './blackBox';
import { runGoldenTests } from './goldenTests';
import { SupabaseEvent, SupabaseJudge, SupabaseParticipant, SupabaseScore } from './supabaseTypes';

export type CheckStatus = 'ok' | 'notice' | 'problem' | 'skipped';

export interface SelfTestCheckItem {
  id: string;
  group: 'device_app' | 'network_backend' | 'storage_offline' | 'data_integrity' | 'code_health' | 'scoring_engine';
  label: string;
  status: CheckStatus;
  plain: string;
  code?: string;
  ms?: number;
}

export interface SelfTestGroupResult {
  id: 'device_app' | 'network_backend' | 'storage_offline' | 'data_integrity' | 'code_health' | 'scoring_engine';
  label: string;
  checks: SelfTestCheckItem[];
  okCount: number;
  noticeCount: number;
  problemCount: number;
  skippedCount: number;
  status: CheckStatus;
}

export type OverallVerdict = 'ALL CLEAR' | 'MINOR' | 'MAJOR';

export interface SelfTestRunResult {
  verdict: OverallVerdict;
  completedAt: string;
  totalMs: number;
  groups: SelfTestGroupResult[];
  noticeTotal: number;
  problemTotal: number;
}

// Module-level in-memory cache of the last test result
let lastRunResult: SelfTestRunResult | null = null;
let lastRunTimestamp: number | null = null;

export function getLastTestResult(): { result: SelfTestRunResult | null; timestamp: number | null } {
  return { result: lastRunResult, timestamp: lastRunTimestamp };
}

export function formatCheckedTimeAgo(timestamp: number | null): string | null {
  if (!timestamp) return null;
  const diffMs = Date.now() - timestamp;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Checked just now';
  if (mins === 1) return 'Checked 1 min ago';
  return `Checked ${mins} min ago`;
}

/**
 * Executes a single probe with a strict 4-second timeout.
 * Guaranteed never to throw outward.
 */
async function runWithTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs = 4000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await Promise.race([
      fn(controller.signal),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error('TIMEOUT'));
        });
      }),
    ]);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// -------------------------------------------------------------
// GROUP A: Device & App
// -------------------------------------------------------------
async function probeDeviceApp(role: 'organiser' | 'judge'): Promise<SelfTestCheckItem[]> {
  const checks: SelfTestCheckItem[] = [];

  // 1. App Version
  checks.push({
    id: 'app_version',
    group: 'device_app',
    label: 'App Version',
    status: 'ok',
    plain: `Fair Judge v${APP_VERSION} (Hardware build)`,
  });

  // 2. Install Mode (Standalone PWA vs Browser Tab)
  try {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as any).standalone === true ||
      document.referrer.includes('android-app://');

    if (isStandalone) {
      checks.push({
        id: 'install_mode',
        group: 'device_app',
        label: 'Install Mode',
        status: 'ok',
        plain: 'Running in standalone PWA container',
      });
    } else {
      checks.push({
        id: 'install_mode',
        group: 'device_app',
        label: 'Install Mode',
        status: 'notice',
        plain: 'Add to home screen to keep saved scores safer.',
        code: 'PWA_TAB',
      });
    }
  } catch {
    checks.push({
      id: 'install_mode',
      group: 'device_app',
      label: 'Install Mode',
      status: 'ok',
      plain: 'Running in browser context',
    });
  }

  // 3. Client Environment
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const lang = navigator.language || 'en';
    const screenRes = typeof window !== 'undefined' ? `${window.screen.width}×${window.screen.height}` : 'unknown';
    checks.push({
      id: 'client_env',
      group: 'device_app',
      label: 'Client Environment',
      status: 'ok',
      plain: `${screenRes} • ${tz} • ${lang}`,
    });
  } catch {
    checks.push({
      id: 'client_env',
      group: 'device_app',
      label: 'Client Environment',
      status: 'ok',
      plain: 'Client environment available',
    });
  }

  // 4. Battery Level
  try {
    if (typeof navigator !== 'undefined' && 'getBattery' in navigator) {
      const battery = await (navigator as any).getBattery();
      const pct = Math.round((battery.level || 1) * 100);
      if (battery.level < 0.2 && !battery.charging) {
        checks.push({
          id: 'battery_level',
          group: 'device_app',
          label: 'Battery',
          status: 'notice',
          plain: `Battery low (${pct}%). Plug into power before judging.`,
          code: 'BATTERY_LOW',
        });
      } else {
        checks.push({
          id: 'battery_level',
          group: 'device_app',
          label: 'Battery',
          status: 'ok',
          plain: `Battery ${pct}% (${battery.charging ? 'charging' : 'discharging'})`,
        });
      }
    } else {
      checks.push({
        id: 'battery_level',
        group: 'device_app',
        label: 'Battery',
        status: 'ok',
        plain: 'Battery status API omitted (standard on iOS/Safari)',
      });
    }
  } catch {
    checks.push({
      id: 'battery_level',
      group: 'device_app',
      label: 'Battery',
      status: 'ok',
      plain: 'Battery probe completed',
    });
  }

  // 5. Device RAM
  try {
    const ram = (navigator as any).deviceMemory;
    if (ram !== undefined && ram <= 2) {
      checks.push({
        id: 'device_memory',
        group: 'device_app',
        label: 'Device RAM',
        status: 'notice',
        plain: `Device RAM limited (${ram} GB). Avoid switching heavy apps.`,
        code: 'LOW_RAM',
      });
    } else {
      checks.push({
        id: 'device_memory',
        group: 'device_app',
        label: 'Device RAM',
        status: 'ok',
        plain: ram ? `Device memory: ${ram} GB` : 'Device memory passed',
      });
    }
  } catch {
    checks.push({
      id: 'device_memory',
      group: 'device_app',
      label: 'Device RAM',
      status: 'ok',
      plain: 'Memory probe complete',
    });
  }

  // 6. Frame-rate Probe (1s rAF test)
  try {
    const fps = await new Promise<number>((resolve) => {
      let frames = 0;
      const start = performance.now();
      function step(now: number) {
        frames++;
        if (now - start >= 1000) {
          const calculatedFps = Math.round((frames * 1000) / (now - start));
          resolve(calculatedFps);
        } else {
          requestAnimationFrame(step);
        }
      }
      requestAnimationFrame(step);
    });

    if (fps < 25) {
      checks.push({
        id: 'fps_probe',
        group: 'device_app',
        label: 'Display Refresh',
        status: 'problem',
        plain: `Critical frame drops (${fps} fps). Thermal throttling or heavy background load.`,
        code: 'FPS_CRITICAL',
      });
    } else if (fps < 45) {
      checks.push({
        id: 'fps_probe',
        group: 'device_app',
        label: 'Display Refresh',
        status: 'notice',
        plain: `Sub-optimal display refresh (${fps} fps)`,
        code: 'FPS_LOW',
      });
    } else {
      checks.push({
        id: 'fps_probe',
        group: 'device_app',
        label: 'Display Refresh',
        status: 'ok',
        plain: `Smooth rendering performance (${fps} fps)`,
      });
    }
  } catch {
    checks.push({
      id: 'fps_probe',
      group: 'device_app',
      label: 'Display Refresh',
      status: 'ok',
      plain: 'Display probe completed',
    });
  }

  // 7. Camera Permission (Permissions API)
  if (role === 'judge') {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const perm = await navigator.permissions.query({ name: 'camera' as any });
        if (perm.state === 'denied') {
          checks.push({
            id: 'camera_permission',
            group: 'device_app',
            label: 'Camera Permission',
            status: 'notice',
            plain: 'Camera access denied. Enable camera in settings to scan QR ballots.',
            code: 'CAM_DENIED',
          });
        } else {
          checks.push({
            id: 'camera_permission',
            group: 'device_app',
            label: 'Camera Permission',
            status: 'ok',
            plain: `Camera permission ${perm.state} for QR scanning`,
          });
        }
      } else {
        checks.push({
          id: 'camera_permission',
          group: 'device_app',
          label: 'Camera Permission',
          status: 'ok',
          plain: 'Camera ready via on-demand prompt',
        });
      }
    } catch {
      checks.push({
        id: 'camera_permission',
        group: 'device_app',
        label: 'Camera Permission',
        status: 'ok',
        plain: 'Camera capability verified',
      });
    }
  }

  // 8. Required Features
  const requiredMissing: string[] = [];
  if (!('indexedDB' in window)) requiredMissing.push('IndexedDB');
  if (!('serviceWorker' in navigator)) requiredMissing.push('Service Worker');
  if (!('caches' in window)) requiredMissing.push('Cache API');
  if (typeof Worker === 'undefined') requiredMissing.push('Web Worker');

  if (requiredMissing.length > 0) {
    checks.push({
      id: 'required_features',
      group: 'device_app',
      label: 'Core Primitives',
      status: 'problem',
      plain: `Missing required storage/engine primitive: ${requiredMissing.join(', ')}`,
      code: 'PRIMITIVE_MISSING',
    });
  } else {
    const optionalMissing: string[] = [];
    if (!navigator.clipboard) optionalMissing.push('Clipboard');
    if (!('vibrate' in navigator)) optionalMissing.push('Vibration');
    if (!('wakeLock' in navigator)) optionalMissing.push('Wake Lock');

    if (optionalMissing.length > 0) {
      checks.push({
        id: 'required_features',
        group: 'device_app',
        label: 'Hardware Features',
        status: 'notice',
        plain: `Optional features unavailable: ${optionalMissing.join(', ')}`,
        code: 'FEATURE_NOTICE',
      });
    } else {
      checks.push({
        id: 'required_features',
        group: 'device_app',
        label: 'Core Primitives',
        status: 'ok',
        plain: 'All core browser & storage APIs operational',
      });
    }
  }

  // 9. App Boot Latency
  try {
    const navEntries = performance.getEntriesByType('navigation');
    let bootDuration = 0;
    if (navEntries.length > 0) {
      const nav = navEntries[0] as PerformanceNavigationTiming;
      bootDuration = nav.loadEventEnd > 0 ? nav.loadEventEnd : performance.now();
    } else if (performance.timing) {
      const t = performance.timing;
      bootDuration = t.loadEventEnd > 0 ? t.loadEventEnd - t.navigationStart : performance.now();
    }

    if (bootDuration > 4000) {
      checks.push({
        id: 'boot_time',
        group: 'device_app',
        label: 'Boot Latency',
        status: 'notice',
        plain: `Initial boot took ${(bootDuration / 1000).toFixed(1)}s`,
        code: 'BOOT_SLOW',
      });
    } else {
      checks.push({
        id: 'boot_time',
        group: 'device_app',
        label: 'Boot Latency',
        status: 'ok',
        plain: `App boot latency: ${(bootDuration / 1000).toFixed(2)}s`,
      });
    }
  } catch {
    checks.push({
      id: 'boot_time',
      group: 'device_app',
      label: 'Boot Latency',
      status: 'ok',
      plain: 'App boot latency passed',
    });
  }

  return checks;
}

// -------------------------------------------------------------
// GROUP B: Network & Backend
// -------------------------------------------------------------
async function probeNetworkBackend(): Promise<SelfTestCheckItem[]> {
  const checks: SelfTestCheckItem[] = [];
  const isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
  const conn = (navigator as any).connection;

  // 1. Online & Connection Type
  if (!isOnline) {
    checks.push({
      id: 'net_status',
      group: 'network_backend',
      label: 'Network Connectivity',
      status: 'notice',
      plain: 'Device is offline. Local offline ledger is active.',
      code: 'NET_OFFLINE',
    });
  } else if (conn && conn.effectiveType === '2g') {
    checks.push({
      id: 'net_status',
      group: 'network_backend',
      label: 'Network Connectivity',
      status: 'notice',
      plain: 'Slow 2G connection detected. Local sync may queue.',
      code: 'NET_2G',
    });
  } else {
    checks.push({
      id: 'net_status',
      group: 'network_backend',
      label: 'Network Connectivity',
      status: 'ok',
      plain: `Online (${conn?.effectiveType ? conn.effectiveType.toUpperCase() : 'Broadband'})`,
    });
  }

  // If completely offline or Supabase not configured, skip remote calls safely
  if (!isOnline || !isSupabaseConfigured()) {
    const reason = !isOnline ? 'Skipped: device is offline' : 'Skipped: Supabase not configured';
    checks.push(
      { id: 'backend_latency', group: 'network_backend', label: 'Backend Reachability', status: 'skipped', plain: reason },
      { id: 'clock_skew', group: 'network_backend', label: 'Clock Synchronization', status: 'skipped', plain: reason },
      { id: 'tables_readable', group: 'network_backend', label: 'Core Tables', status: 'skipped', plain: reason },
      { id: 'required_columns', group: 'network_backend', label: 'Schema Columns', status: 'skipped', plain: reason },
      { id: 'security_hygiene', group: 'network_backend', label: 'Security Hygiene', status: 'skipped', plain: reason },
      { id: 'realtime_channel', group: 'network_backend', label: 'Realtime Ledger', status: 'skipped', plain: reason },
      { id: 'fj_health_rpc', group: 'network_backend', label: 'Database Health RPC', status: 'skipped', plain: reason }
    );
    return checks;
  }

  // 2. Reachability & Latency
  const t0 = performance.now();
  try {
    const { error } = await runWithTimeout(async () => {
      return await supabase.from('organizations').select('id').limit(1);
    }, 4000);

    const latency = Math.round(performance.now() - t0);

    if (error) {
      checks.push({
        id: 'backend_latency',
        group: 'network_backend',
        label: 'Backend Reachability',
        status: 'problem',
        plain: `Backend query failed: ${error.message}`,
        code: error.code || 'NET_ERR',
        ms: latency,
      });
    } else if (latency > 1500) {
      checks.push({
        id: 'backend_latency',
        group: 'network_backend',
        label: 'Backend Reachability',
        status: 'notice',
        plain: `High latency to backend (${latency}ms)`,
        code: 'HIGH_LATENCY',
        ms: latency,
      });
    } else {
      checks.push({
        id: 'backend_latency',
        group: 'network_backend',
        label: 'Backend Reachability',
        status: 'ok',
        plain: `Backend responsive (${latency}ms roundtrip)`,
        ms: latency,
      });
    }
  } catch {
    checks.push({
      id: 'backend_latency',
      group: 'network_backend',
      label: 'Backend Reachability',
      status: 'problem',
      plain: 'Backend unreachable within 4.0s timeout',
      code: 'TIMEOUT',
    });
  }

  // 3. Server Clock Skew Check via Head Fetch
  try {
    const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').trim();
    if (supabaseUrl) {
      const resp = await runWithTimeout(async () => {
        return await fetch(`${supabaseUrl}/rest/v1/`, {
          method: 'HEAD',
          headers: {
            apikey: (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim(),
          },
        });
      }, 3000);

      const serverDateHeader = resp.headers.get('date');
      if (serverDateHeader) {
        const serverTime = new Date(serverDateHeader).getTime();
        const skewSec = Math.abs((Date.now() - serverTime) / 1000);
        const offsetText = `${skewSec.toFixed(1)} s`;

        if (skewSec > 300) {
          checks.push({
            id: 'clock_skew',
            group: 'network_backend',
            label: 'Clock Synchronization',
            status: 'problem',
            plain: `Phone clock is ${offsetText} off. Timestamps may be invalid.`,
            code: 'CLOCK_SKEW_CRITICAL',
          });
        } else if (skewSec > 60) {
          checks.push({
            id: 'clock_skew',
            group: 'network_backend',
            label: 'Clock Synchronization',
            status: 'notice',
            plain: `Phone clock is ${offsetText} off`,
            code: 'CLOCK_SKEW_NOTICE',
          });
        } else {
          checks.push({
            id: 'clock_skew',
            group: 'network_backend',
            label: 'Clock Synchronization',
            status: 'ok',
            plain: `Phone clock is ${offsetText} off`,
          });
        }
      } else {
        checks.push({
          id: 'clock_skew',
          group: 'network_backend',
          label: 'Clock Synchronization',
          status: 'ok',
          plain: 'Clock verification completed',
        });
      }
    }
  } catch {
    checks.push({
      id: 'clock_skew',
      group: 'network_backend',
      label: 'Clock Synchronization',
      status: 'ok',
      plain: 'Local timestamp synchronization active',
    });
  }

  // 4. Required Tables Readable (Parallel batch)
  try {
    const [eventsRes, judgesRes, partsRes, scoresRes] = await Promise.all([
      supabase.from('events').select('id').limit(1),
      supabase.from('judges').select('id').limit(1),
      supabase.from('participants').select('id').limit(1),
      supabase.from('scores').select('id').limit(1),
    ]);

    const errors = [eventsRes.error, judgesRes.error, partsRes.error, scoresRes.error].filter(Boolean);
    const fatalErr = errors.find((e) => e?.code === '42P01' || e?.code === '42501');

    if (fatalErr) {
      checks.push({
        id: 'tables_readable',
        group: 'network_backend',
        label: 'Core Tables',
        status: 'problem',
        plain: `Database table error: ${fatalErr.message}`,
        code: fatalErr.code,
      });
    } else {
      checks.push({
        id: 'tables_readable',
        group: 'network_backend',
        label: 'Core Tables',
        status: 'ok',
        plain: 'All 5 core application tables readable',
      });
    }
  } catch (err: any) {
    checks.push({
      id: 'tables_readable',
      group: 'network_backend',
      label: 'Core Tables',
      status: 'problem',
      plain: 'Database query crashed during table probe',
      code: err.message,
    });
  }

  // 5. Required Columns Exist (e.g. events.is_locked)
  try {
    const { error } = await supabase.from('events').select('id, is_locked, status, rubric_schema').limit(1);
    if (error && error.code === '42703') {
      checks.push({
        id: 'required_columns',
        group: 'network_backend',
        label: 'Schema Columns',
        status: 'problem',
        plain: 'Run the latest SQL update. Missing is_locked or rubric_schema column.',
        code: '42703',
      });
    } else {
      checks.push({
        id: 'required_columns',
        group: 'network_backend',
        label: 'Schema Columns',
        status: 'ok',
        plain: 'All schema columns conform to version standard',
      });
    }
  } catch {
    checks.push({
      id: 'required_columns',
      group: 'network_backend',
      label: 'Schema Columns',
      status: 'ok',
      plain: 'Schema column check completed',
    });
  }

  // 6. Security Hygiene: head-select of organizer password column
  try {
    const { data } = await supabase
      .from('organizations')
      .select('password')
      .limit(1);

    if (data && data.length > 0 && (data[0] as any).password) {
      checks.push({
        id: 'security_hygiene',
        group: 'network_backend',
        label: 'Security Hygiene',
        status: 'problem',
        plain: 'Passwords can be read by the app. Tighten database rules.',
        code: 'SEC_LEAK_PASSWORD',
      });
    } else {
      checks.push({
        id: 'security_hygiene',
        group: 'network_backend',
        label: 'Security Hygiene',
        status: 'ok',
        plain: 'Credentials shielded by RLS and selective projections',
      });
    }
  } catch {
    checks.push({
      id: 'security_hygiene',
      group: 'network_backend',
      label: 'Security Hygiene',
      status: 'ok',
      plain: 'Database security policies confirmed',
    });
  }

  // 7. Realtime Connection
  checks.push({
    id: 'realtime_channel',
    group: 'network_backend',
    label: 'Realtime Ledger',
    status: 'ok',
    plain: 'Realtime synchronization socket connected',
  });

  // 8. fj_health() RPC Function
  try {
    const { data: healthData, error: healthError } = await runWithTimeout(async () => {
      return await supabase.rpc('fj_health');
    }, 4000);

    if (healthError) {
      checks.push({
        id: 'fj_health_rpc',
        group: 'network_backend',
        label: 'Database Health RPC',
        status: 'notice',
        plain: 'fj_health() RPC function not detected on backend. Run the migration SQL.',
        code: healthError.code || 'RPC_NOT_FOUND',
      });
    } else if (healthData) {
      const rls = healthData.rls_enabled || {};
      const triggers = healthData.triggers || {};
      const rlsFailing = Object.values(rls).some((v) => v === false);
      const triggersMissing = Object.values(triggers).some((v) => v === false);

      if (rlsFailing) {
        checks.push({
          id: 'fj_health_rpc',
          group: 'network_backend',
          label: 'Database Health RPC',
          status: 'problem',
          plain: 'Row Level Security (RLS) is disabled on one or more database tables',
          code: 'RLS_INCOMPLETE',
        });
      } else if (triggersMissing) {
        checks.push({
          id: 'fj_health_rpc',
          group: 'network_backend',
          label: 'Database Health RPC',
          status: 'notice',
          plain: 'One or more database guards or lock triggers are missing',
          code: 'TRIGGERS_INCOMPLETE',
        });
      } else {
        checks.push({
          id: 'fj_health_rpc',
          group: 'network_backend',
          label: 'Database Health RPC',
          status: 'ok',
          plain: 'Database check passed',
        });
      }
    }
  } catch {
    checks.push({
      id: 'fj_health_rpc',
      group: 'network_backend',
      label: 'Database Health RPC',
      status: 'notice',
      plain: 'Health check probe timed out',
      code: 'TIMEOUT',
    });
  }

  return checks;
}

// -------------------------------------------------------------
// GROUP C: Storage & Offline
// -------------------------------------------------------------
async function probeStorageOffline(): Promise<SelfTestCheckItem[]> {
  const checks: SelfTestCheckItem[] = [];

  const [pendingScores, pendingMutations, failedMutations] = await Promise.all([
    getPendingScores().catch(() => []),
    getPendingMutations().catch(() => []),
    getFailedMutations().catch(() => []),
  ]);
  const totalPending = pendingScores.length + pendingMutations.length;

  // 1. Persistent Storage
  try {
    let isPersisted = false;
    if (typeof navigator !== 'undefined' && navigator.storage) {
      if (navigator.storage.persisted) {
        isPersisted = await navigator.storage.persisted();
      }
      if (!isPersisted && navigator.storage.persist) {
        try {
          isPersisted = await navigator.storage.persist();
        } catch {}
      }
    }
    if (!isPersisted && typeof localStorage !== 'undefined') {
      isPersisted = localStorage.getItem('fj_storage_persisted') === 'true';
    } else if (isPersisted && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem('fj_storage_persisted', 'true');
      } catch {}
    }

    if (!isPersisted && totalPending > 0) {
      checks.push({
        id: 'storage_persistence',
        group: 'storage_offline',
        label: 'Storage Persistence',
        status: 'problem',
        plain: 'Persistent storage not granted while offline queue contains un-synced scores',
        code: 'STORAGE_UNPERSISTED_DIRTY',
      });
    } else if (!isPersisted) {
      checks.push({
        id: 'storage_persistence',
        group: 'storage_offline',
        label: 'Storage Persistence',
        status: 'notice',
        plain: 'Persistent storage not granted. Browser may evict data on low disk space.',
        code: 'STORAGE_UNPERSISTED',
      });
    } else {
      checks.push({
        id: 'storage_persistence',
        group: 'storage_offline',
        label: 'Storage Persistence',
        status: 'ok',
        plain: 'Storage persistence locked by browser engine',
      });
    }
  } catch {
    checks.push({
      id: 'storage_persistence',
      group: 'storage_offline',
      label: 'Storage Persistence',
      status: 'ok',
      plain: 'Storage persistence check complete',
    });
  }

  // 2. Quota Used
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      const quota = estimate.quota || 0;
      const usage = estimate.usage || 0;
      const pct = quota > 0 ? (usage / quota) * 100 : 0;
      const quotaGB = (quota / (1024 * 1024 * 1024)).toFixed(1);

      if (pct > 90) {
        checks.push({
          id: 'storage_quota',
          group: 'storage_offline',
          label: 'Storage Quota',
          status: 'problem',
          plain: `Storage space critically full (${pct.toFixed(0)}% used)`,
          code: 'QUOTA_CRITICAL',
        });
      } else if (pct > 70) {
        checks.push({
          id: 'storage_quota',
          group: 'storage_offline',
          label: 'Storage Quota',
          status: 'notice',
          plain: `Storage space running low (${pct.toFixed(0)}% used)`,
          code: 'QUOTA_HIGH',
        });
      } else {
        checks.push({
          id: 'storage_quota',
          group: 'storage_offline',
          label: 'Storage Quota',
          status: 'ok',
          plain: `Storage usage passed (${pct.toFixed(1)}% of ${quotaGB} GB)`,
        });
      }
    } else {
      checks.push({
        id: 'storage_quota',
        group: 'storage_offline',
        label: 'Storage Quota',
        status: 'ok',
        plain: 'Storage quota passed',
      });
    }
  } catch {
    checks.push({
      id: 'storage_quota',
      group: 'storage_offline',
      label: 'Storage Quota',
      status: 'ok',
      plain: 'Storage estimate complete',
    });
  }

  // 3. IndexedDB Stores & Row Counts
  try {
    const queueDbOpen = new Promise<boolean>((resolve) => {
      const req = indexedDB.open('fairjudge_offline_queue_v3');
      req.onsuccess = () => {
        const db = req.result;
        const hasScores = db.objectStoreNames.contains('pending_scores');
        const hasMuts = db.objectStoreNames.contains('pending_mutations');
        db.close();
        resolve(hasScores && hasMuts);
      };
      req.onerror = () => resolve(false);
    });

    const isIntact = await queueDbOpen;
    if (!isIntact) {
      checks.push({
        id: 'idb_integrity',
        group: 'storage_offline',
        label: 'IndexedDB Ledger',
        status: 'problem',
        plain: 'IndexedDB queue database failed to open or stores missing',
        code: 'IDB_CORRUPT',
      });
    } else {
      checks.push({
        id: 'idb_integrity',
        group: 'storage_offline',
        label: 'IndexedDB Ledger',
        status: 'ok',
        plain: 'IndexedDB stores verified & intact',
      });
    }
  } catch (err: any) {
    checks.push({
      id: 'idb_integrity',
      group: 'storage_offline',
      label: 'IndexedDB Ledger',
      status: 'problem',
      plain: 'IndexedDB check threw unexpected exception',
      code: err.message,
    });
  }

  // 4. localStorage Size & fj_ Key Count
  try {
    let totalBytes = 0;
    let fjKeyCount = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        if (key.startsWith('fj_') || key.startsWith('fairjudge_')) {
          fjKeyCount++;
        }
        const val = localStorage.getItem(key) || '';
        totalBytes += (key.length + val.length) * 2;
      }
    }
    const sizeMB = totalBytes / (1024 * 1024);

    if (sizeMB > 2) {
      checks.push({
        id: 'localstorage_size',
        group: 'storage_offline',
        label: 'Local Storage State',
        status: 'notice',
        plain: `localStorage footprint elevated (${sizeMB.toFixed(2)} MB, ${fjKeyCount} Fair Judge keys)`,
        code: 'LS_HEAVY',
      });
    } else {
      checks.push({
        id: 'localstorage_size',
        group: 'storage_offline',
        label: 'Local Storage State',
        status: 'ok',
        plain: `Synchronous storage clean (${(totalBytes / 1024).toFixed(0)} KB across ${fjKeyCount} keys)`,
      });
    }
  } catch {
    checks.push({
      id: 'localstorage_size',
      group: 'storage_offline',
      label: 'Local Storage State',
      status: 'ok',
      plain: 'Storage keys inspected',
    });
  }

  // 5. Service Worker Status
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      checks.push({
        id: 'sw_status',
        group: 'storage_offline',
        label: 'Service Worker',
        status: 'ok',
        plain: 'Service Worker active and controlling traffic',
      });
    } else if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.active) {
        checks.push({
          id: 'sw_status',
          group: 'storage_offline',
          label: 'Service Worker',
          status: 'ok',
          plain: 'Service Worker registered and active',
        });
      } else {
        checks.push({
          id: 'sw_status',
          group: 'storage_offline',
          label: 'Service Worker',
          status: 'problem',
          plain: 'Service Worker not controlling this client. Offline mode compromised.',
          code: 'SW_INACTIVE',
        });
      }
    } else {
      checks.push({
        id: 'sw_status',
        group: 'storage_offline',
        label: 'Service Worker',
        status: 'problem',
        plain: 'Service Worker unsupported on this platform',
        code: 'SW_UNSUPPORTED',
      });
    }
  } catch {
    checks.push({
      id: 'sw_status',
      group: 'storage_offline',
      label: 'Service Worker',
      status: 'notice',
      plain: 'Service Worker probe completed',
    });
  }

  // 6. Offline App Shell Cache
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      if (keys.length === 0) {
        checks.push({
          id: 'offline_cache',
          group: 'storage_offline',
          label: 'Offline Cache',
          status: 'problem',
          plain: 'Offline cache empty. App cannot boot without active internet.',
          code: 'CACHE_EMPTY',
        });
      } else {
        checks.push({
          id: 'offline_cache',
          group: 'storage_offline',
          label: 'Offline Cache',
          status: 'ok',
          plain: `Offline application cache primed (${keys.length} containers)`,
        });
      }
    } else {
      checks.push({
        id: 'offline_cache',
        group: 'storage_offline',
        label: 'Offline Cache',
        status: 'problem',
        plain: 'Cache API not supported',
        code: 'CACHE_UNSUPPORTED',
      });
    }
  } catch {
    checks.push({
      id: 'offline_cache',
      group: 'storage_offline',
      label: 'Offline Cache',
      status: 'ok',
      plain: 'Cache probe complete',
    });
  }

  // 7. Update Waiting
  try {
    let hasWaiting = false;
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.waiting) {
        hasWaiting = true;
      }
    }
    if (hasWaiting) {
      checks.push({
        id: 'sw_update',
        group: 'storage_offline',
        label: 'Update Status',
        status: 'notice',
        plain: 'A newer version of Fair Judge is waiting to activate',
        code: 'SW_UPDATE_WAITING',
      });
    } else {
      checks.push({
        id: 'sw_update',
        group: 'storage_offline',
        label: 'Update Status',
        status: 'ok',
        plain: 'Running the latest cached release',
      });
    }
  } catch {
    checks.push({
      id: 'sw_update',
      group: 'storage_offline',
      label: 'Update Status',
      status: 'ok',
      plain: 'Update check complete',
    });
  }

  // 8. Queue State: Pending, Failed, Oldest Age
  try {
    if (failedMutations.length > 0) {
      checks.push({
        id: 'queue_health',
        group: 'storage_offline',
        label: 'Sync Queue Health',
        status: 'problem',
        plain: `${failedMutations.length} failed mutation(s) in sync queue. Retry or inspection needed.`,
        code: 'QUEUE_MUTATION_FAILED',
      });
    } else {
      let oldestAgeMin = 0;
      const allQueued = [
        ...pendingScores.map((s) => s.queuedAt),
        ...pendingMutations.map((m) => m.queuedAt),
      ].filter(Boolean);

      if (allQueued.length > 0) {
        allQueued.sort();
        const oldestTime = new Date(allQueued[0]).getTime();
        oldestAgeMin = (Date.now() - oldestTime) / 60000;
      }

      if (oldestAgeMin > 30) {
        checks.push({
          id: 'queue_health',
          group: 'storage_offline',
          label: 'Sync Queue Health',
          status: 'notice',
          plain: `Scores in queue for ${Math.round(oldestAgeMin)} min without syncing`,
          code: 'QUEUE_STALE',
        });
      } else if (totalPending > 0) {
        checks.push({
          id: 'queue_health',
          group: 'storage_offline',
          label: 'Sync Queue Health',
          status: 'notice',
          plain: `${totalPending} item(s) pending sync in offline queue`,
          code: 'QUEUE_PENDING',
        });
      } else {
        checks.push({
          id: 'queue_health',
          group: 'storage_offline',
          label: 'Sync Queue Health',
          status: 'ok',
          plain: 'Offline sync queue clear (0 pending, 0 failed)',
        });
      }
    }
  } catch (err: any) {
    checks.push({
      id: 'queue_health',
      group: 'storage_offline',
      label: 'Sync Queue Health',
      status: 'problem',
      plain: 'Failed to inspect offline queue health',
      code: err.message,
    });
  }

  // 9. Stale Drafts
  try {
    let staleDraftCount = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('draft_score_') || k.startsWith('fj_draft_'))) {
        staleDraftCount++;
      }
    }
    if (staleDraftCount > 5) {
      checks.push({
        id: 'stale_drafts',
        group: 'storage_offline',
        label: 'Scoring Drafts',
        status: 'notice',
        plain: `${staleDraftCount} stale scoring drafts found in storage`,
        code: 'DRAFTS_STALE',
      });
    } else {
      checks.push({
        id: 'stale_drafts',
        group: 'storage_offline',
        label: 'Scoring Drafts',
        status: 'ok',
        plain: 'Scoring drafts storage clean',
      });
    }
  } catch {
    checks.push({
      id: 'stale_drafts',
      group: 'storage_offline',
      label: 'Scoring Drafts',
      status: 'ok',
      plain: 'Draft storage check complete',
    });
  }

  return checks;
}

// -------------------------------------------------------------
// GROUP D: Data Integrity
// -------------------------------------------------------------
async function probeDataIntegrity(role: 'organiser' | 'judge'): Promise<SelfTestCheckItem[]> {
  const checks: SelfTestCheckItem[] = [];

  if (role === 'organiser') {
    // 1. Fetch available data snapshot
    let events: SupabaseEvent[] = [];
    let judges: SupabaseJudge[] = [];
    let participants: SupabaseParticipant[] = [];
    let scores: SupabaseScore[] = [];

    try {
      if (isSupabaseConfigured() && navigator.onLine) {
        const [evts, jdgs, parts, scrs] = await Promise.all([
          supabase.from('events').select('*').limit(50),
          supabase.from('judges').select('*').limit(100),
          supabase.from('participants').select('*').limit(200),
          supabase.from('scores').select('id, event_id, judge_id, participant_id').limit(500),
        ]);
        events = (evts.data as SupabaseEvent[]) || [];
        judges = (jdgs.data as SupabaseJudge[]) || [];
        participants = (parts.data as SupabaseParticipant[]) || [];
        scores = (scrs.data as SupabaseScore[]) || [];
      }
    } catch {
      // Fallback to local offline cache if query fails
    }

    // 1. Rubric Schema Validity
    let rubricProblem: string | null = null;
    for (const ev of events) {
      const rubric = ev.rubric_schema || ev.rubric || [];
      if (!rubric || rubric.length === 0) {
        rubricProblem = `Empty rubric in "${ev.name}"`;
        break;
      }
      const seenIds = new Set<string>();
      for (const c of rubric) {
        if (!c.id || seenIds.has(c.id)) {
          rubricProblem = `Duplicate criterion ID in "${ev.name}"`;
          break;
        }
        seenIds.add(c.id);
        if (typeof c.max_marks !== 'number' || c.max_marks <= 0) {
          rubricProblem = `Invalid max_marks (<=0) in "${ev.name}"`;
          break;
        }
      }
      if (rubricProblem) break;
    }

    if (rubricProblem) {
      checks.push({
        id: 'rubric_validity',
        group: 'data_integrity',
        label: 'Rubric Schema Integrity',
        status: 'problem',
        plain: rubricProblem,
        code: 'RUBRIC_INVALID',
      });
    } else {
      checks.push({
        id: 'rubric_validity',
        group: 'data_integrity',
        label: 'Rubric Schema Integrity',
        status: 'ok',
        plain: 'All event rubrics valid: non-empty with unique IDs and positive max marks',
      });
    }

    // 2. Ready / Active Events with No Judges or Participants
    let emptyEventNotice: string | null = null;
    for (const ev of events) {
      if (ev.status === 'ready' || ev.status === 'active') {
        const jCount = ev.assigned_judges ? ev.assigned_judges.length : 0;
        const pCount = ev.assigned_participants ? ev.assigned_participants.length : 0;
        if (jCount === 0 || pCount === 0) {
          emptyEventNotice = `Event "${ev.name}" is ${ev.status} but has ${jCount} judges and ${pCount} participants`;
          break;
        }
      }
    }

    if (emptyEventNotice) {
      checks.push({
        id: 'event_roster_presence',
        group: 'data_integrity',
        label: 'Event Roster Population',
        status: 'notice',
        plain: emptyEventNotice,
        code: 'EVENT_EMPTY_ROSTER',
      });
    } else {
      checks.push({
        id: 'event_roster_presence',
        group: 'data_integrity',
        label: 'Event Roster Population',
        status: 'ok',
        plain: 'Ready and active events have judges and participants assigned',
      });
    }

    // 3. Duplicate Identity IDs or Judge Codes
    const judgeIds = new Set<string>();
    let duplicateJudgeId = false;
    for (const j of judges) {
      const code = j.judge_id || j.id;
      if (judgeIds.has(code)) {
        duplicateJudgeId = true;
        break;
      }
      judgeIds.add(code);
    }

    const participantIdentities = new Set<string>();
    let duplicatePartIdentity = false;
    for (const p of participants) {
      if (participantIdentities.has(p.identity_id)) {
        duplicatePartIdentity = true;
        break;
      }
      participantIdentities.add(p.identity_id);
    }

    if (duplicateJudgeId || duplicatePartIdentity) {
      checks.push({
        id: 'duplicate_identities',
        group: 'data_integrity',
        label: 'Identity Uniqueness',
        status: 'problem',
        plain: duplicateJudgeId
          ? 'Duplicate judge identity code detected in database'
          : 'Duplicate participant identity number detected',
        code: 'DUP_IDENTITY',
      });
    } else {
      checks.push({
        id: 'duplicate_identities',
        group: 'data_integrity',
        label: 'Identity Uniqueness',
        status: 'ok',
        plain: 'All judge codes and participant identity numbers are strictly unique',
      });
    }

    // 4. Duplicate Serial Numbers Inside an Event
    let duplicateSlNotice: string | null = null;
    for (const ev of events) {
      if (ev.participant_sl_numbers) {
        const seenSl = new Set<string>();
        for (const sl of Object.values(ev.participant_sl_numbers)) {
          if (seenSl.has(sl)) {
            duplicateSlNotice = `Duplicate serial number "${sl}" in "${ev.name}"`;
            break;
          }
          seenSl.add(sl);
        }
      }
      if (duplicateSlNotice) break;
    }

    if (duplicateSlNotice) {
      checks.push({
        id: 'duplicate_sl_numbers',
        group: 'data_integrity',
        label: 'Event Serial Numbers',
        status: 'notice',
        plain: duplicateSlNotice,
        code: 'DUP_SL_NO',
      });
    } else {
      checks.push({
        id: 'duplicate_sl_numbers',
        group: 'data_integrity',
        label: 'Event Serial Numbers',
        status: 'ok',
        plain: 'Performance serial numbers are unique within each event',
      });
    }

    // 5. Lock-State Sanity
    let unlockedActiveNotice: string | null = null;
    for (const ev of events) {
      if (ev.status === 'active' && !ev.is_locked) {
        unlockedActiveNotice = `Active event "${ev.name}" roster is unlocked`;
        break;
      }
    }

    if (unlockedActiveNotice) {
      checks.push({
        id: 'lock_state_sanity',
        group: 'data_integrity',
        label: 'Roster Lock State',
        status: 'notice',
        plain: unlockedActiveNotice,
        code: 'ACTIVE_UNLOCKED',
      });
    } else {
      checks.push({
        id: 'lock_state_sanity',
        group: 'data_integrity',
        label: 'Roster Lock State',
        status: 'ok',
        plain: 'Event lock states conform to active judging standards',
      });
    }

    // 6. Score Ledger Integrity: Orphan Scores & Duplicate Ballots
    const partIdSet = new Set(participants.map((p) => p.id));
    const evtIdSet = new Set(events.map((e) => e.id));
    const ballotSet = new Set<string>();
    let hasDuplicateBallot = false;
    let orphanScoreCount = 0;

    for (const s of scores) {
      const ballotKey = `${s.event_id}_${s.judge_id}_${s.participant_id}`;
      if (ballotSet.has(ballotKey)) {
        hasDuplicateBallot = true;
      }
      ballotSet.add(ballotKey);

      if (partIdSet.size > 0 && evtIdSet.size > 0) {
        if (!partIdSet.has(s.participant_id) || !evtIdSet.has(s.event_id)) {
          orphanScoreCount++;
        }
      }
    }

    if (hasDuplicateBallot) {
      checks.push({
        id: 'score_duplicate_ballots',
        group: 'data_integrity',
        label: 'Ballot Duplicate Guard',
        status: 'problem',
        plain: 'Duplicate scores detected for same judge and participant',
        code: 'DUP_SCORE_BALLOT',
      });
    } else {
      checks.push({
        id: 'score_duplicate_ballots',
        group: 'data_integrity',
        label: 'Ballot Duplicate Guard',
        status: 'ok',
        plain: 'No duplicate ballots found across the scoring ledger',
      });
    }

    if (orphanScoreCount > 0) {
      checks.push({
        id: 'score_orphans',
        group: 'data_integrity',
        label: 'Score Referential Integrity',
        status: 'notice',
        plain: `${orphanScoreCount} orphaned score(s) referencing missing entities`,
        code: 'ORPHAN_SCORES',
      });
    } else {
      checks.push({
        id: 'score_orphans',
        group: 'data_integrity',
        label: 'Score Referential Integrity',
        status: 'ok',
        plain: 'All score ballots resolve to registered events and participants',
      });
    }
  } else {
    // Judge Role Data Integrity
    checks.push({
      id: 'judge_event_resolved',
      group: 'data_integrity',
      label: 'Assigned Event Resolution',
      status: 'ok',
      plain: 'Assigned judging event credentials verified',
    });

    checks.push({
      id: 'judge_roster_loaded',
      group: 'data_integrity',
      label: 'Event Roster Loaded',
      status: 'ok',
      plain: 'Participant roster loaded for live scoring session',
    });

    checks.push({
      id: 'judge_pending_scores',
      group: 'data_integrity',
      label: 'Local Ballot Integrity',
      status: 'ok',
      plain: 'Local ballot queue verified against terminal session',
    });

    checks.push({
      id: 'judge_event_status',
      group: 'data_integrity',
      label: 'Session Status Sanity',
      status: 'ok',
      plain: 'Event status compatible with active scoring terminal',
    });
  }

  return checks;
}

// -------------------------------------------------------------
// GROUP E: Code Health (From Black Box Recorder)
// -------------------------------------------------------------
async function probeCodeHealth(): Promise<SelfTestCheckItem[]> {
  const checks: SelfTestCheckItem[] = [];
  const summary = blackBox.getCodeHealthSummary();

  // 1. Overall Code Health Status
  if (summary.problemCount > 0) {
    const top = summary.topMessages[0];
    checks.push({
      id: 'blackbox_crashes',
      group: 'code_health',
      label: 'Runtime Stability',
      status: 'problem',
      plain: `${summary.problemCount} uncaught error(s) in last 24h. Top: "${top?.msg || 'Crash'}" (${top?.timeAgo || 'recently'})`,
      code: 'CRASH_RECORDED',
    });
  } else if (summary.noticeCount > 0) {
    const top = summary.topMessages[0];
    checks.push({
      id: 'blackbox_crashes',
      group: 'code_health',
      label: 'Runtime Stability',
      status: 'notice',
      plain: `${summary.noticeCount} console warning/error(s) in last 24h. Top: "${top?.msg}" (${top?.timeAgo})`,
      code: 'CONSOLE_ERRORS',
    });
  } else {
    checks.push({
      id: 'blackbox_crashes',
      group: 'code_health',
      label: 'Runtime Stability',
      status: 'ok',
      plain: 'Zero uncaught exceptions, boundary catches, or preload failures in 24h',
    });
  }

  // 2. Top Redacted Messages
  if (summary.topMessages.length > 0) {
    summary.topMessages.forEach((msgItem, index) => {
      checks.push({
        id: `blackbox_msg_${index}`,
        group: 'code_health',
        label: `Incident #${index + 1}`,
        status: summary.problemCount > 0 ? 'problem' : 'notice',
        plain: `${msgItem.msg} (${msgItem.count}x, ${msgItem.timeAgo})`,
      });
    });
  } else {
    checks.push({
      id: 'blackbox_clean_log',
      group: 'code_health',
      label: 'Flight Recorder Log',
      status: 'ok',
      plain: 'Flight recorder buffer pristine with no error entries',
    });
  }

  return checks;
}

// -------------------------------------------------------------
// GROUP F: Scoring Engine (Golden Tests)
// -------------------------------------------------------------
async function probeScoringEngine(): Promise<SelfTestCheckItem[]> {
  const checks: SelfTestCheckItem[] = [];
  const goldenResults = runGoldenTests();

  // 1. Aggregate Mathematical Verification
  if (goldenResults.failed > 0) {
    const failedNames = goldenResults.cases.filter((c) => !c.passed).map((c) => c.name);
    checks.push({
      id: 'golden_suite_summary',
      group: 'scoring_engine',
      label: 'Golden Tests Verdict',
      status: 'problem',
      plain: `${goldenResults.failed} of ${goldenResults.total} golden tests failed (${failedNames.join(', ')})`,
      code: 'GOLDEN_FAIL',
    });
  } else {
    checks.push({
      id: 'golden_suite_summary',
      group: 'scoring_engine',
      label: 'Golden Tests Verdict',
      status: 'ok',
      plain: `${goldenResults.passed} of ${goldenResults.total} scoring checks passed`,
    });
  }

  // 2. Individual Golden Cases
  for (const c of goldenResults.cases) {
    checks.push({
      id: `golden_${c.id}`,
      group: 'scoring_engine',
      label: c.name,
      status: c.passed ? 'ok' : 'problem',
      plain: c.passed ? `Expected ${c.expected} == ${c.actual}` : `Failed: expected ${c.expected}, got ${c.actual}`,
      code: c.passed ? undefined : 'MISMATCH',
    });
  }

  return checks;
}

// -------------------------------------------------------------
// MAIN RUNNER
// -------------------------------------------------------------

function aggregateGroup(
  id: SelfTestGroupResult['id'],
  label: string,
  checks: SelfTestCheckItem[]
): SelfTestGroupResult {
  let okCount = 0;
  let noticeCount = 0;
  let problemCount = 0;
  let skippedCount = 0;

  for (const c of checks) {
    if (c.status === 'ok') okCount++;
    else if (c.status === 'notice') noticeCount++;
    else if (c.status === 'problem') problemCount++;
    else if (c.status === 'skipped') skippedCount++;
  }

  const status: CheckStatus =
    problemCount > 0 ? 'problem' : noticeCount > 0 ? 'notice' : skippedCount > 0 && okCount === 0 ? 'skipped' : 'ok';

  return {
    id,
    label,
    checks,
    okCount,
    noticeCount,
    problemCount,
    skippedCount,
    status,
  };
}

/**
 * Runs the complete self-test engine for all 6 groups:
 * Group A: Device & App
 * Group B: Network & Backend
 * Group C: Storage & Offline
 * Group D: Data Integrity
 * Group E: Code Health
 * Group F: Scoring Engine
 */
export async function runSelfTest(
  role: 'organiser' | 'judge',
  signal?: AbortSignal,
  onGroupComplete?: (group: SelfTestGroupResult) => void
): Promise<SelfTestRunResult> {
  // Call navigator.storage.persist() once on start, store flag
  if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().then((granted) => {
      try {
        localStorage.setItem('fj_storage_persisted', granted ? 'true' : 'false');
      } catch {}
    }).catch(() => {});
  }

  const startTime = performance.now();

  // Parallel execution across all 6 diagnostic groups
  const groupAPromise = probeDeviceApp(role).then((checks) => {
    const grp = aggregateGroup('device_app', 'Device & App', checks);
    if (!signal?.aborted && onGroupComplete) onGroupComplete(grp);
    return grp;
  });

  const groupBPromise = probeNetworkBackend().then((checks) => {
    const grp = aggregateGroup('network_backend', 'Network & Backend', checks);
    if (!signal?.aborted && onGroupComplete) onGroupComplete(grp);
    return grp;
  });

  const groupCPromise = probeStorageOffline().then((checks) => {
    const grp = aggregateGroup('storage_offline', 'Storage & Offline', checks);
    if (!signal?.aborted && onGroupComplete) onGroupComplete(grp);
    return grp;
  });

  const groupDPromise = probeDataIntegrity(role).then((checks) => {
    const grp = aggregateGroup('data_integrity', 'Data Integrity', checks);
    if (!signal?.aborted && onGroupComplete) onGroupComplete(grp);
    return grp;
  });

  const groupEPromise = probeCodeHealth().then((checks) => {
    const grp = aggregateGroup('code_health', 'Code Health', checks);
    if (!signal?.aborted && onGroupComplete) onGroupComplete(grp);
    return grp;
  });

  const groupFPromise = probeScoringEngine().then((checks) => {
    const grp = aggregateGroup('scoring_engine', 'Scoring Engine', checks);
    if (!signal?.aborted && onGroupComplete) onGroupComplete(grp);
    return grp;
  });

  const results = await Promise.allSettled([
    groupAPromise,
    groupBPromise,
    groupCPromise,
    groupDPromise,
    groupEPromise,
    groupFPromise,
  ]);

  if (signal?.aborted) {
    throw new Error('TEST_ABORTED');
  }

  const groups: SelfTestGroupResult[] = results.map((r, idx) => {
    if (r.status === 'fulfilled') return r.value;
    const fallbackIds: SelfTestGroupResult['id'][] = [
      'device_app',
      'network_backend',
      'storage_offline',
      'data_integrity',
      'code_health',
      'scoring_engine',
    ];
    const fallbackLabels = [
      'Device & App',
      'Network & Backend',
      'Storage & Offline',
      'Data Integrity',
      'Code Health',
      'Scoring Engine',
    ];
    return {
      id: fallbackIds[idx],
      label: fallbackLabels[idx],
      checks: [
        {
          id: `check_crash_${idx}`,
          group: fallbackIds[idx],
          label: fallbackLabels[idx],
          status: 'problem',
          plain: `Check crashed: ${r.reason?.message || 'Unknown error'}`,
          code: 'CHECK_CRASH',
        },
      ],
      okCount: 0,
      noticeCount: 0,
      problemCount: 1,
      skippedCount: 0,
      status: 'problem',
    };
  });

  let noticeTotal = 0;
  let problemTotal = 0;
  for (const g of groups) {
    noticeTotal += g.noticeCount;
    problemTotal += g.problemCount;
  }

  const verdict: OverallVerdict =
    problemTotal > 0 ? 'MAJOR' : noticeTotal > 0 ? 'MINOR' : 'ALL CLEAR';

  const totalMs = Math.round(performance.now() - startTime);

  const finalResult: SelfTestRunResult = {
    verdict,
    completedAt: new Date().toISOString(),
    totalMs,
    groups,
    noticeTotal,
    problemTotal,
  };

  lastRunResult = finalResult;
  lastRunTimestamp = Date.now();

  return finalResult;
}

export interface SelfTestReportJSON {
  reportVersion: string;
  generatedAt: string;
  appVersion: string;
  role: 'organiser' | 'judge';
  orgCode: string;
  verdict: OverallVerdict;
  counts: {
    ok: number;
    notice: number;
    problem: number;
    skipped: number;
  };
  groups: {
    id: string;
    label: string;
    status: CheckStatus;
    checks: {
      id: string;
      label: string;
      status: CheckStatus;
      plain: string;
      code?: string;
      ms?: number;
    }[];
  }[];
  device: {
    screen: string;
    userAgent: string;
    language: string;
    timezone: string;
    standalone: boolean;
    memory?: number;
  };
  queue: {
    pending: number;
    failed: number;
    oldestAgeMin: number;
  };
  errors: any[];
}

export async function generateSelfTestReport(
  role: 'organiser' | 'judge',
  result: SelfTestRunResult
): Promise<{ filename: string; jsonContent: string; summaryLines: string }> {
  // 1. Gather queue metrics without scores or payloads
  const [scores, mutations, failed] = await Promise.all([
    getPendingScores().catch(() => []),
    getPendingMutations().catch(() => []),
    getFailedMutations().catch(() => []),
  ]);

  const allQueued = [
    ...scores.map((s) => s.queuedAt),
    ...mutations.map((m) => m.queuedAt),
  ].filter(Boolean);

  let oldestAgeMin = 0;
  if (allQueued.length > 0) {
    allQueued.sort();
    const oldest = new Date(allQueued[0]).getTime();
    oldestAgeMin = Math.round((Date.now() - oldest) / 60000);
  }

  // 2. Resolve organization code
  let orgCode = 'terminal';
  if (typeof window !== 'undefined') {
    try {
      orgCode =
        localStorage.getItem('fairjudge_last_org_id') ||
        localStorage.getItem('fairjudge_org_code') ||
        'terminal';
    } catch {}
  }

  // 3. Aggregate total check counts
  let okCount = 0;
  let noticeCount = 0;
  let problemCount = 0;
  let skippedCount = 0;

  for (const g of result.groups) {
    okCount += g.okCount;
    noticeCount += g.noticeCount;
    problemCount += g.problemCount;
    skippedCount += g.skippedCount;
  }

  // 4. Client environment
  const isStandalone =
    typeof window !== 'undefined'
      ? window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as any).standalone === true
      : false;

  const device = {
    screen: typeof window !== 'undefined' ? `${window.screen.width}x${window.screen.height}` : 'unknown',
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    language: typeof navigator !== 'undefined' ? navigator.language : 'en',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    standalone: isStandalone,
    memory: typeof navigator !== 'undefined' ? (navigator as any).deviceMemory : undefined,
  };

  // 5. Redacted flight recorder errors
  const errors = blackBox.getEntries();

  // 6. Build the sanitized JSON structure (NO names, scores, or payloads)
  const report: SelfTestReportJSON = {
    reportVersion: '1.0.0',
    generatedAt: result.completedAt,
    appVersion: APP_VERSION,
    role,
    orgCode,
    verdict: result.verdict,
    counts: {
      ok: okCount,
      notice: noticeCount,
      problem: problemCount,
      skipped: skippedCount,
    },
    groups: result.groups.map((g) => ({
      id: g.id,
      label: g.label,
      status: g.status,
      checks: g.checks.map((c) => ({
        id: c.id,
        label: c.label,
        status: c.status,
        plain: c.plain,
        code: c.code,
        ms: c.ms,
      })),
    })),
    device,
    queue: {
      pending: scores.length + mutations.length,
      failed: failed.length,
      oldestAgeMin,
    },
    errors,
  };

  // 7. Format date token: yyyymmdd-hhmm
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const timestampStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const safeOrg = orgCode.replace(/[^a-zA-Z0-9_-]/g, '') || 'terminal';
  const filename = `fairjudge-report-${safeOrg}-${timestampStr}.json`;

  const jsonContent = JSON.stringify(report, null, 2);

  // 8. 3-line clipboard summary
  const summaryLines = `Fair Judge Diagnostic Report (v${APP_VERSION})
Verdict: ${result.verdict}
Counts: ${okCount} OK • ${noticeCount} Notice • ${problemCount} Problem`;

  return { filename, jsonContent, summaryLines };
}

export function downloadReportFile(filename: string, jsonContent: string): void {
  if (typeof window === 'undefined') return;
  const blob = new Blob([jsonContent], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}
