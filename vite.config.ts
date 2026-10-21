import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'web',
  publicDir: 'public',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 800 },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4322' },
  },
})
