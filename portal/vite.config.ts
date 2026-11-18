import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** The Orbit API in development (`npm run dev:api`). */
const API = 'http://localhost:4000'

export default defineConfig({
  plugins: [react()],

  // Mirrored in tsconfig.app.json `paths`. `@contract` is the REST contract the
  // API, CLI and portal share; the portal only ever imports types from it.
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@contract': path.resolve(__dirname, '../src/types/contract.ts'),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': API,
      '/webhooks': API,
    },
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': API,
      '/webhooks': API,
    },
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
