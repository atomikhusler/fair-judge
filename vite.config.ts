import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => {
  return {
    plugins: [
      react(),
      tailwindcss(),
      // Only include VitePWA plugin during production build to prevent dev SW HMR WebSocket errors
      ...(command === 'build'
        ? [
            VitePWA({
              registerType: 'autoUpdate',
              injectRegister: false,
              manifest: false,
              workbox: {
                skipWaiting: true,
                clientsClaim: true,
                globPatterns: ['**/*.{js,css,html,json,png,svg,woff,woff2}'],
                globIgnores: ['**/sw-sync.js', '**/EPIC-*.txt'],
                importScripts: ['/sw-sync.js'],
                navigateFallbackDenylist: [/^\/api\//, /^\/supabase-proxy\//],
                maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
              },
            }),
          ]
        : []),
    ],
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
        react: path.resolve(import.meta.dirname, 'node_modules/react'),
        'react-dom': path.resolve(import.meta.dirname, 'node_modules/react-dom'),
      },
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react-dom/server',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'lucide-react',
        'xlsx',
        '@supabase/supabase-js',
        'idb',
        'qrcode.react',
        'html5-qrcode',
        'zxcvbn',
      ],
    },
    server: {
      proxy: process.env.VITE_SUPABASE_URL
        ? {
            '/supabase-proxy': {
              target: process.env.VITE_SUPABASE_URL,
              changeOrigin: true,
              rewrite: (path: string) => path.replace(/^\/supabase-proxy/, ''),
              secure: false,
            },
          }
        : undefined,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
