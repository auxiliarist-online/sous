import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Installable on phones, and a share target: Android lists Sous in the
    // share sheet and opens /share?title=&text=&url= (see src/share.ts).
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.svg',
        'favicon.ico',
        'apple-touch-icon-180x180.png',
      ],
      manifest: {
        name: 'Sous',
        short_name: 'Sous',
        description: 'Plan the week. Shop the deals.',
        theme_color: '#2f6b4f',
        background_color: '#faf8f4',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        share_target: {
          action: '/share',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        // The app shell answers navigations offline, except the API and the
        // static SousBot page, which must always come from the server.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/sousbot/],
      },
    }),
  ],
  server: {
    // Forward API calls to the FastAPI dev server.
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
