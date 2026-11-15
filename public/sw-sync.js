// Fair Judge BackgroundSync extension loaded by Workbox SW via importScripts
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
