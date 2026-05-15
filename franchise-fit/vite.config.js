import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'production' ? '/PA-UpCode/' : '/',
  /** Avoid dev 504 "Outdated Optimize Dep" when CJS deps (e.g. osmtogeojson) change. */
  optimizeDeps: {
    include: ['osmtogeojson', 'leaflet', 'react-leaflet'],
  },
  /** Proxy Nominatim to avoid CORS issues in development */
  server: {
    proxy: {
      '/api/nominatim': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nominatim/, ''),
        headers: {
          'User-Agent': 'FranchiseFit/1.0 (dev proxy; contact via github.com)',
        },
      },
    },
  },
}))
