import React from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './lib/theme';
import App from './App.tsx';
import './index.css';
import { blackBox } from './lib/blackBox';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { PrintSheetHost } from './components/common/PrintSheetHost';
import { initSwUpdateManager } from './lib/swUpdateManager';

// Install Black Box error recording before first render
blackBox.install();

// Register Service Worker only in production to prevent caching Vite dev dependencies
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  if (import.meta.env.PROD) {
    initSwUpdateManager();
  } else {
    // In dev mode, unregister any existing service worker and purge caches to prevent stale react chunk collisions
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        for (const reg of registrations) {
          reg.unregister().catch(() => {});
        }
      })
      .catch(() => {});
    if ('caches' in window) {
      caches
        .keys()
        .then((keys) => {
          keys.forEach((key) => {
            caches.delete(key).catch(() => {});
          });
        })
        .catch(() => {});
    }
  }
}

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={true}>
      <App />
      <PrintSheetHost />
    </ThemeProvider>
  </ErrorBoundary>
);
