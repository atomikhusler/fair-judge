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
    return new Promise<{ default: T }>((resolve, reject) => {
      const execute = (remainingAttempts: number) => {
        factory()
          .then(resolve)
          .catch((error) => {
            if (remainingAttempts > 0) {
              setTimeout(() => execute(remainingAttempts - 1), intervalMs);
            } else {
              const isChunkError =
                error?.message?.includes('Failed to fetch dynamically imported module') ||
                error?.message?.includes('Loading chunk') ||
                error?.message?.includes('dynamically imported module') ||
                error?.name === 'TypeError';

              if (isChunkError && typeof window !== 'undefined') {
                const reloadKey = `fj_reload_${chunkKey}`;
                const hasReloaded = sessionStorage.getItem(reloadKey);
                if (!hasReloaded) {
                  sessionStorage.setItem(reloadKey, 'true');
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
