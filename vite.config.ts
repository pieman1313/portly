import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves this repo at /portly/
export default defineConfig({
  base: process.env.VITE_BASE ?? '/portly/',
  plugins: [
    react({
      // React Compiler: memoises components and hooks at build time, so a
      // Dexie liveQuery emitting a new snapshot re-renders only the cards
      // whose inputs actually changed rather than every subtree below it.
      // React 19 ships the `react/compiler-runtime` the output imports from,
      // so there is no extra runtime package to install.
      babel: { plugins: [['babel-plugin-react-compiler', { target: '19' }]] },
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Portly — portfolio & dividend tracker',
        short_name: 'Portly',
        description: 'Import IBKR activity statements, track holdings, dividends and forward income. Your data never leaves your device.',
        theme_color: '#0b0f16',
        background_color: '#0b0f16',
        display: 'standalone',
        orientation: 'portrait-primary',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Separate art: Android crops maskable icons to a circle/squircle, so
          // this one is full-bleed with the glyph inside the central safe zone.
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Market data is fetched cross-origin and must never be served from a
        // stale precache — the app has its own freshness/provenance handling.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [],
      },
    }),
  ],
  test: {
    setupFiles: ['./src/test/setup.ts'],
    // The default 5s is a laptop's budget. A UI test here mounts the whole app,
    // waits on a lazily imported route chunk, fake-indexeddb and a Dexie
    // liveQuery, and one of them does that for all five tabs in a single test —
    // and the CI runner measured about twice this machine's wall clock. A deploy
    // is gated on this suite, so the timeout has to have headroom over the
    // slowest runner rather than over the fastest.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
    // Only the UI tests pay for a DOM; the 400+ pure tests stay on node.
    environmentMatchGlobs: [['src/**/*.test.tsx', 'jsdom']],
  },
} as any)
