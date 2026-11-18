import {
  checkVersionJsonForUpdate,
  getLatestRemoteBuildId,
  getRunningBuildId,
  setSwWaitingReady,
} from '../config/version';
import {
  flushOfflineQueueToSupabase,
  getPendingCount,
  subscribeToQueueChanges,
} from './offlineQueue';

const CHECK_THROTTLE_MS = 20_000;
const PERIODIC_CHECK_MS = 30 * 60 * 1000;
const RELOADED_BUILD_KEY = 'fj_sw_reloaded_build_id';

// ========================================================
// DIRTY-FORM STATE REGISTRY
// ========================================================
const dirtyForms = new Set<string>();
const dirtyListeners = new Set<() => void>();

export function setFormDirty(formId: string, dirty: boolean): void {
  const had = dirtyForms.has(formId);
  if (dirty && !had) {
    dirtyForms.add(formId);
    dirtyListeners.forEach((cb) => {
      try {
        cb();
      } catch {}
    });
  } else if (!dirty && had) {
    dirtyForms.delete(formId);
    dirtyListeners.forEach((cb) => {
      try {
        cb();
      } catch {}
    });
  }
}

export function hasUnsavedFormChanges(): boolean {
  return dirtyForms.size > 0;
}

// ========================================================
// SERVICE WORKER UPDATE MANAGER (PRODUCTION ONLY)
// ========================================================
let initialized = false;
let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;
let currentRegistration: ServiceWorkerRegistration | null = null;
let lastCheckTimestamp = 0;
let activeCheckPromise: Promise<void> | null = null;
let hasUserInteracted = false;
let pendingReloadAfterActivation = false;
let reloadLockInMemory = false;
let latestRemoteBuildId: string | null = null;
const skipWaitingSentWorkers = new WeakSet<ServiceWorker>();
const wiredRegistrations = new WeakSet<ServiceWorkerRegistration>();
const wiredInstallingWorkers = new WeakSet<ServiceWorker>();

function isSwSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    Boolean(import.meta.env?.PROD)
  );
}

function getReloadTargetBuildId(): string {
  const running = getRunningBuildId();
  const remote = latestRemoteBuildId || getLatestRemoteBuildId();
  if (remote && remote !== running) {
    return remote;
  }
  return `sw_after_${running}`;
}

function hasReloadedForBuild(buildId: string): boolean {
  if (reloadLockInMemory) return true;
  if (!buildId || typeof window === 'undefined') return false;
  try {
    return window.sessionStorage.getItem(RELOADED_BUILD_KEY) === buildId;
  } catch {
    return false;
  }
}

function performGuardedReload(buildId: string): boolean {
  if (typeof window === 'undefined') return false;
  const running = getRunningBuildId();
  if (latestRemoteBuildId && latestRemoteBuildId === running && buildId === running) {
    return false;
  }
  if (hasReloadedForBuild(buildId)) {
    return false;
  }
  reloadLockInMemory = true;
  try {
    window.sessionStorage.setItem(RELOADED_BUILD_KEY, buildId);
  } catch {}
  window.location.reload();
  return true;
}

function wireInstallingWorker(reg: ServiceWorkerRegistration, worker: ServiceWorker | null): void {
  if (!worker || wiredInstallingWorkers.has(worker)) return;
  wiredInstallingWorkers.add(worker);
  worker.addEventListener('statechange', () => {
    if (worker.state === 'installed' && navigator.serviceWorker.controller) {
      setSwWaitingReady(Boolean(reg.waiting || worker));
      void evaluateActivationOrHold(reg);
    }
  });
}

function wireRegistration(reg: ServiceWorkerRegistration): ServiceWorkerRegistration {
  currentRegistration = reg;
  if (!wiredRegistrations.has(reg)) {
    wiredRegistrations.add(reg);
    reg.addEventListener('updatefound', () => {
      wireInstallingWorker(reg, reg.installing);
    });
  }
  if (reg.installing) {
    wireInstallingWorker(reg, reg.installing);
  }
  if (reg.waiting) {
    setSwWaitingReady(true);
  }
  return reg;
}

export async function getSwRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!isSwSupported()) return null;
  if (currentRegistration) return currentRegistration;
  if (registrationPromise) return registrationPromise;
  try {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) {
      return wireRegistration(existing);
    }
  } catch {}
  return null;
}

function registerServiceWorkerOnce(): Promise<ServiceWorkerRegistration | null> {
  if (!isSwSupported()) return Promise.resolve(null);
  if (registrationPromise) return registrationPromise;

  const doRegister = () =>
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        const wired = wireRegistration(reg);
        if (wired.waiting) {
          void evaluateActivationOrHold(wired);
        }
        return wired;
      })
      .catch((err) => {
        console.warn('Service worker registration note:', err);
        registrationPromise = null;
        return null;
      });

  if (document.readyState === 'complete') {
    registrationPromise = doRegister();
  } else {
    registrationPromise = new Promise<ServiceWorkerRegistration | null>((resolve) => {
      window.addEventListener(
        'load',
        () => {
          void doRegister().then(resolve);
        },
        { once: true }
      );
    });
  }

  return registrationPromise;
}

function sendSkipWaiting(worker: ServiceWorker): void {
  if (skipWaitingSentWorkers.has(worker)) return;
  skipWaitingSentWorkers.add(worker);
  try {
    worker.postMessage({ type: 'SKIP_WAITING' });
  } catch {
    skipWaitingSentWorkers.delete(worker);
  }
}

async function tryReloadIfSafeAndHidden(): Promise<boolean> {
  if (!pendingReloadAfterActivation || reloadLockInMemory) return false;
  if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
    return false;
  }

  const pendingCount = await getPendingCount().catch(() => 1);
  if (pendingCount > 0 || hasUnsavedFormChanges()) {
    return false;
  }

  // Re-verify still hidden after async IndexedDB read
  if (document.visibilityState !== 'hidden') {
    return false;
  }

  if (!latestRemoteBuildId && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
    const res = await checkVersionJsonForUpdate().catch(() => null);
    if (res?.remoteBuildId) {
      latestRemoteBuildId = res.remoteBuildId;
    }
    if (document.visibilityState !== 'hidden') {
      return false;
    }
    const pendingAfter = await getPendingCount().catch(() => 1);
    if (pendingAfter > 0 || hasUnsavedFormChanges()) {
      return false;
    }
  }

  const targetBuildId = getReloadTargetBuildId();
  pendingReloadAfterActivation = false;
  return performGuardedReload(targetBuildId);
}

async function evaluateActivationOrHold(regOverride?: ServiceWorkerRegistration | null): Promise<void> {
  if (!isSwSupported()) return;
  const reg = regOverride || (await getSwRegistration());
  const waiting = reg?.waiting || null;
  if (!waiting) {
    if (pendingReloadAfterActivation) {
      await tryReloadIfSafeAndHidden();
    }
    return;
  }

  setSwWaitingReady(true);

  const pendingCount = await getPendingCount().catch(() => 1);
  if (pendingCount > 0) {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      void flushOfflineQueueToSupabase().catch(() => {});
    }
    return;
  }

  if (hasUnsavedFormChanges()) {
    return;
  }

  const isBackgrounded = typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const isColdStartBeforeInteraction = !hasUserInteracted;
  if (!isBackgrounded && !isColdStartBeforeInteraction) {
    return;
  }

  sendSkipWaiting(waiting);
}

export async function checkForAppUpdate(options?: { force?: boolean }): Promise<void> {
  if (!isSwSupported()) {
    await checkVersionJsonForUpdate().catch(() => {});
    return;
  }

  if (activeCheckPromise) {
    return activeCheckPromise;
  }

  const now = Date.now();
  if (!options?.force && now - lastCheckTimestamp < CHECK_THROTTLE_MS) {
    return;
  }
  lastCheckTimestamp = now;

  activeCheckPromise = (async () => {
    try {
      const reg = await getSwRegistration();
      if (typeof navigator === 'undefined' || navigator.onLine !== false) {
        await Promise.all([
          reg ? reg.update().catch(() => {}) : Promise.resolve(),
          checkVersionJsonForUpdate()
            .then((res) => {
              if (res?.remoteBuildId) {
                latestRemoteBuildId = res.remoteBuildId;
              }
            })
            .catch(() => {}),
        ]);
      }
      await evaluateActivationOrHold(reg);
    } finally {
      activeCheckPromise = null;
    }
  })();

  return activeCheckPromise;
}

/**
 * Min-version modal manual update action:
 * Never skips the IndexedDB outbox check. Sends SKIP_WAITING if a SW is waiting,
 * then performs a once-per-build_id guarded reload.
 */
export async function applyMinVersionUpdate(): Promise<boolean> {
  const pendingCount = await getPendingCount().catch(() => 1);
  if (pendingCount > 0) {
    if (typeof navigator === 'undefined' || navigator.onLine !== false) {
      void flushOfflineQueueToSupabase().catch(() => {});
    }
    return false;
  }

  if (typeof navigator === 'undefined' || navigator.onLine !== false) {
    const res = await checkVersionJsonForUpdate().catch(() => null);
    if (res?.remoteBuildId) {
      latestRemoteBuildId = res.remoteBuildId;
    }
  }

  const reg = await getSwRegistration();
  const waiting = reg?.waiting || null;

  if (waiting && isSwSupported()) {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
        resolve();
      };
      const onControllerChange = () => done();
      navigator.serviceWorker.addEventListener('controllerchange', onControllerChange, { once: true });
      window.setTimeout(done, 1500);
      sendSkipWaiting(waiting);
    });
  }

  const targetBuildId = getReloadTargetBuildId();
  pendingReloadAfterActivation = false;
  return performGuardedReload(targetBuildId);
}

export function initSwUpdateManager(): () => void {
  if (typeof window === 'undefined' || initialized || !isSwSupported()) {
    return () => {};
  }
  initialized = true;

  const markUserInteracted = () => {
    if (hasUserInteracted) return;
    hasUserInteracted = true;
    removeInteractionListeners();
  };

  const interactionEvents = ['pointerdown', 'keydown', 'touchstart', 'input', 'change'] as const;
  const removeInteractionListeners = () => {
    interactionEvents.forEach((evt) => {
      window.removeEventListener(evt, markUserInteracted, true);
    });
  };
  interactionEvents.forEach((evt) => {
    window.addEventListener(evt, markUserInteracted, { capture: true, passive: true });
  });

  const handleControllerChange = () => {
    setSwWaitingReady(false);
    pendingReloadAfterActivation = true;
    void tryReloadIfSafeAndHidden();
  };
  navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);

  const handleVisibilityChange = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'visible') {
      void checkForAppUpdate();
    } else if (document.visibilityState === 'hidden') {
      if (pendingReloadAfterActivation) {
        void tryReloadIfSafeAndHidden();
      } else {
        void evaluateActivationOrHold();
      }
    }
  };

  const handlePageHide = () => {
    if (pendingReloadAfterActivation) {
      void tryReloadIfSafeAndHidden();
    } else {
      void evaluateActivationOrHold();
    }
  };

  const handleFocus = () => {
    void checkForAppUpdate();
  };

  const handleOnline = () => {
    void checkForAppUpdate();
  };

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('focus', handleFocus);
  window.addEventListener('online', handleOnline);

  const periodicTimer = window.setInterval(() => {
    void checkForAppUpdate();
  }, PERIODIC_CHECK_MS);

  const unsubQueue = subscribeToQueueChanges(() => {
    if (pendingReloadAfterActivation) {
      void tryReloadIfSafeAndHidden();
    } else {
      void evaluateActivationOrHold();
    }
  });

  const onDirtyChange = () => {
    if (hasUnsavedFormChanges()) return;
    if (pendingReloadAfterActivation) {
      void tryReloadIfSafeAndHidden();
    } else {
      void evaluateActivationOrHold();
    }
  };
  dirtyListeners.add(onDirtyChange);

  void registerServiceWorkerOnce().then((reg) => {
    if (reg) {
      void checkForAppUpdate({ force: true });
    }
  });

  return () => {
    removeInteractionListeners();
    navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    window.removeEventListener('pagehide', handlePageHide);
    window.removeEventListener('focus', handleFocus);
    window.removeEventListener('online', handleOnline);
    window.clearInterval(periodicTimer);
    unsubQueue();
    dirtyListeners.delete(onDirtyChange);
    initialized = false;
  };
}
