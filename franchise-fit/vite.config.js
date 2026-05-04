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
}))
