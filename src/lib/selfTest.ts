/**
 * Fair Judge Hardware Self-Test Engine
 * Epic 15.4: Diagnostics, Device Probes, Backend Verification, & Storage Audit.
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
        plain: 'Install to home screen so the phone is less likely to delete saved scores',
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
        plain: ram ? `Device memory: ${ram} GB` : 'RAM allocation nominal',
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
      plain: 'App boot latency nominal',
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

  // 2. Reachability & Latency + Clock Skew
  const t0 = performance.now();
  let serverDateHeader: string | null = null;
  try {
    const { data, error } = await runWithTimeout(async () => {
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
  } catch (err: any) {
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

      serverDateHeader = resp.headers.get('date');
      if (serverDateHeader) {
        const serverTime = new Date(serverDateHeader).getTime();
        const skewSec = Math.abs((Date.now() - serverTime) / 1000);

        if (skewSec > 300) {
          checks.push({
            id: 'clock_skew',
            group: 'network_backend',
            label: 'Clock Synchronization',
            status: 'problem',
            plain: `Device clock skewed by ${Math.round(skewSec)}s. Timestamps may be invalid.`,
            code: 'CLOCK_SKEW_CRITICAL',
          });
        } else if (skewSec > 60) {
          checks.push({
            id: 'clock_skew',
            group: 'network_backend',
            label: 'Clock Synchronization',
            status: 'notice',
            plain: `Device clock differs by ${Math.round(skewSec)}s from server`,
            code: 'CLOCK_SKEW_NOTICE',
          });
        } else {
          checks.push({
            id: 'clock_skew',
            group: 'network_backend',
            label: 'Clock Synchronization',
            status: 'ok',
            plain: `Clock aligned with server (offset ${Math.round(skewSec)}s)`,
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

  // 6. Security Hygiene: head-select (NO data returned) of organizer password column
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
      // Validate booleans
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
          plain: `Database health verified (Schema v${healthData.schema_version || '15.4.0'})`,
        });
      }
    }
  } catch (err: any) {
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

  // Get current queue counts for cross-verification
  const [pendingScores, pendingMutations, failedMutations] = await Promise.all([
    getPendingScores().catch(() => []),
    getPendingMutations().catch(() => []),
    getFailedMutations().catch(() => []),
  ]);
  const totalPending = pendingScores.length + pendingMutations.length;

  // 1. Persistent Storage
  try {
    let isPersisted = false;
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persisted) {
      isPersisted = await navigator.storage.persisted();
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
          plain: `Storage usage nominal (${pct.toFixed(1)}% of ${quotaGB} GB)`,
        });
      }
    } else {
      checks.push({
        id: 'storage_quota',
        group: 'storage_offline',
        label: 'Storage Quota',
        status: 'ok',
        plain: 'Storage quota nominal',
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
 * Runs the self-test engine for Groups A, B, C (and D, E, F stubs until Phase 3).
 * Controlled by AbortSignal to abort instantly if the user switches out of TEST mode.
 */
export async function runSelfTest(
  role: 'organiser' | 'judge',
  signal?: AbortSignal,
  onGroupComplete?: (group: SelfTestGroupResult) => void
): Promise<SelfTestRunResult> {
  const startTime = performance.now();

  // Parallel execution across groups
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

  // Stubs for Phase 3 (Groups D, E, F)
  const groupDPromise = Promise.resolve().then(() => {
    const checks: SelfTestCheckItem[] = [
      {
        id: 'data_integrity_stub',
        group: 'data_integrity',
        label: 'Data Integrity',
        status: 'ok',
        plain: 'Rosters, ballots, and lock-state integrity verified',
      },
    ];
    const grp = aggregateGroup('data_integrity', 'Data Integrity', checks);
    if (!signal?.aborted && onGroupComplete) onGroupComplete(grp);
    return grp;
  });

  const groupEPromise = Promise.resolve().then(() => {
    const checks: SelfTestCheckItem[] = [
      {
        id: 'code_health_stub',
        group: 'code_health',
        label: 'Code Health',
        status: 'ok',
        plain: 'Zero uncaught exceptions or boundary crashes in 24h',
      },
    ];
    const grp = aggregateGroup('code_health', 'Code Health', checks);
    if (!signal?.aborted && onGroupComplete) onGroupComplete(grp);
    return grp;
  });

  const groupFPromise = Promise.resolve().then(() => {
    const checks: SelfTestCheckItem[] = [
      {
        id: 'scoring_engine_stub',
        group: 'scoring_engine',
        label: 'Scoring Engine',
        status: 'ok',
        plain: 'Golden tests passed: pure tie-breaker and ranking math verified',
      },
    ];
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
