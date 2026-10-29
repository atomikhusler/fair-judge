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
              includeAssets: ['assets/1793118251574.png', 'favicon.png', 'apple-touch-icon.png'],
              manifest: {
                id: '/',
                name: 'Fair Judge - Competition Judging Terminal',
                short_name: 'FairJudge',
                description: 'Mobile-first digitized competition judging terminal and scoring ledger.',
                theme_color: '#0f172a',
                background_color: '#090d16',
                display: 'standalone',
                orientation: 'portrait',
                start_url: '/',
                scope: '/',
                icons: [
                  {
                    src: '/assets/1793118251574.png',
                    sizes: '192x192',
                    type: 'image/png',
                    purpose: 'any',
                  },
                  {
                    src: '/assets/1793118251574.png',
                    sizes: '512x512',
                    type: 'image/png',
                    purpose: 'any',
                  },
                  {
                    src: '/assets/1793118251574.png',
                    sizes: '512x512',
                    type: 'image/png',
                    purpose: 'maskable',
                  },
                ],
              },
              workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
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
      },
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'lucide-react',
        'xlsx',
        '@supabase/supabase-js',
        'idb',
        'qrcode.react',
        'html5-qrcode',
      ],
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
