import React from 'react';

/**
 * Robust Lazy Loader with Automatic Retry & Chunk Invalidation (Phase 15.7)
 * Handles transient network dropouts, dev server restarts, and PWA cache updates.
 */
export function lazyWithRetry<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  chunkKey: string = 'chunk',
  retries: number = 2,
  intervalMs: number = 400
): React.LazyExoticComponent<T> {
  return React.lazy(() => {
    const reloadKey = `fj_reload_${chunkKey}`;

    return new Promise<{ default: T }>((resolve, reject) => {
      const execute = (remainingAttempts: number) => {
        factory()
          .then((mod) => {
            try {
              sessionStorage.removeItem(reloadKey);
            } catch {}
            resolve(mod);
          })
          .catch(async (error) => {
            if (remainingAttempts > 0) {
              setTimeout(() => execute(remainingAttempts - 1), intervalMs);
            } else {
              const isChunkError =
                error?.message?.includes('Failed to fetch dynamically imported module') ||
                error?.message?.includes('Loading chunk') ||
                error?.message?.includes('dynamically imported module') ||
                error?.name === 'TypeError';

              if (isChunkError && typeof window !== 'undefined') {
                const hasReloaded = sessionStorage.getItem(reloadKey);
                if (!hasReloaded) {
                  sessionStorage.setItem(reloadKey, 'true');
                  try {
                    if ('caches' in window) {
                      const names = await caches.keys();
                      await Promise.race([
                        Promise.all(names.map((name) => caches.delete(name))),
                        new Promise<void>((r) => setTimeout(r, 300)),
                      ]);
                    }
                  } catch {}
                  window.location.reload();
                  return;
                }
              }
              reject(error);
            }
          });
      };
      execute(retries);
    });
  });
}
