// Fair Judge PWA Service Worker (Cache-First Shell & Offline Resilience)
const CACHE_NAME = 'fairjudge-shell-v2';

const STATIC_PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/pwa-192x192.png',
  '/pwa-512x512.png',
  '/pwa-maskable-512x512.png',
  '/assets/1793118251574.png',
  '/fonts/Geist-Variable-latin.woff2',
];

// Install Event: Pre-cache static shell assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_PRECACHE_ASSETS).catch((err) => {
        console.warn('Some precache assets could not be cached immediately:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate Event: Clean up stale caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event: Network-First for navigation/HTML shell, Cache-First for immutable assets
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Bypass Google APIs, Firebase, Supabase, internal APIs, and Vite dev server paths/modules
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('firebase') ||
    url.hostname.includes('identitytoolkit') ||
    url.hostname.includes('googleapis.com') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/@') ||
    url.pathname.startsWith('/node_modules/') ||
    url.pathname.includes('hot-update') ||
    url.searchParams.has('v')
  ) {
    return;
  }

  // Handle SPA Navigation and index.html requests: Network-First falling back to cached shell
  if (event.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match('/index.html') || caches.match('/');
        })
    );
    return;
  }

  // Handle Static UI Assets (JS, CSS, Images, Fonts, Icons)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const isScriptOrStyle = /\.(js|mjs|css)$/i.test(url.pathname);
      if (cachedResponse) {
        const cachedContentType = cachedResponse.headers.get('content-type') || '';
        const isInvalidMime = isScriptOrStyle && cachedContentType.includes('text/html');
        if (!isInvalidMime) {
          // Fetch fresh copy in background (Stale-While-Revalidate)
          fetch(event.request)
            .then((networkResponse) => {
              const netType = networkResponse?.headers?.get('content-type') || '';
              if (
                networkResponse &&
                networkResponse.status === 200 &&
                !(isScriptOrStyle && netType.includes('text/html'))
              ) {
                caches.open(CACHE_NAME).then((cache) => {
                  cache.put(event.request, networkResponse.clone());
                });
              }
            })
            .catch(() => {});
          return cachedResponse;
        }
      }

      // Not in cache (or invalid cached HTML fallback): fetch from network and store valid copy
      return fetch(event.request).then((networkResponse) => {
        const netType = networkResponse?.headers?.get('content-type') || '';
        if (
          !networkResponse ||
          networkResponse.status !== 200 ||
          networkResponse.type !== 'basic' ||
          (isScriptOrStyle && netType.includes('text/html'))
        ) {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      });
    })
  );
});

// Native BackgroundSync API Listener:
// When the OS detects network restoration, wake up and signal clients to flush offline mutations
self.addEventListener('sync', (event) => {
  if (event.tag === 'fairjudge-offline-sync' || event.tag === 'sync-mutations') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => {
          client.postMessage({ type: 'TRIGGER_BACKGROUND_SYNC' });
        });
      })
    );
  }
});
