import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './lib/theme';
import App from './App.tsx';
import './index.css';

// Register Service Worker only in production to prevent caching Vite dev dependencies
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          reg.onupdatefound = () => {
            const installingWorker = reg.installing;
            if (installingWorker) {
              installingWorker.onstatechange = () => {
                if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  console.log('Fair Judge offline app shell ready.');
                }
              };
            }
          };
        })
        .catch((err) => {
          console.warn('Service worker registration note:', err);
        });
    });
  } else {
    // In dev mode, unregister any existing service worker and purge caches to prevent stale react chunk collisions
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const reg of registrations) {
        reg.unregister();
      }
    });
    if ('caches' in window) {
      caches.keys().then((keys) => {
        keys.forEach((key) => caches.delete(key));
      });
    }
  }
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={true}>
    <App />
  </ThemeProvider>
);
