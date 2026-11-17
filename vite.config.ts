import { execSync } from 'child_process';
import fs from 'fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function readAppVersion(): string {
  const versionPath = path.resolve(import.meta.dirname, 'src/config/version.ts');
  const content = fs.readFileSync(versionPath, 'utf8');
  const match = content.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1].trim() : '0.0.0';
}

function resolveBuildId(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: import.meta.dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {}
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

export default defineConfig(({ command }) => {
  const appVersion = readAppVersion();
  const buildId = resolveBuildId();

  return {
    define: {
      __APP_BUILD_ID__: JSON.stringify(buildId),
    },
    plugins: [
      react(),
      tailwindcss(),
      ...(command === 'build'
        ? [
            {
              name: 'fairjudge-emit-version-json',
              buildStart() {
                const publicDir = path.resolve(import.meta.dirname, 'public');
                fs.mkdirSync(publicDir, { recursive: true });
                const payload = `${JSON.stringify({ version: appVersion, build_id: buildId }, null, 2)}\n`;
                fs.writeFileSync(path.join(publicDir, 'version.json'), payload, 'utf8');
              },
            },
            VitePWA({
              registerType: 'autoUpdate',
              injectRegister: false,
              manifest: false,
              workbox: {
                skipWaiting: false,
                clientsClaim: true,
                globPatterns: ['**/*.{js,css,html,json,png,svg,woff,woff2}'],
                globIgnores: ['**/sw-sync.js', '**/EPIC-*.txt', 'version.json', '**/version.json'],
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
