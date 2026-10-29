import { createRoot } from 'react-dom/client';
import { ThemeProvider } from './lib/theme';
import App from './App.tsx';
import './index.css';

// Register Service Worker for offline app shell caching
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
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
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={true}>
    <App />
  </ThemeProvider>
);
