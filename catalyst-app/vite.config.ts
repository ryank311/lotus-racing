import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const serverHost = process.env.CATALYST_SERVER_HOST ?? '127.0.0.1'
const proxyHost = ['0.0.0.0', '::'].includes(serverHost) ? '127.0.0.1' : serverHost
const proxyTarget = `http://${proxyHost.includes(':') ? `[${proxyHost}]` : proxyHost}:${process.env.CATALYST_SERVER_PORT ?? 3210}`

export default defineConfig(({ mode }) => ({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    // Browser development uses the same origin for login cookies, RPC, and SSE.
    proxy: mode === 'server' ? {
      '^/api/': {
        target: proxyTarget,
      },
    } : undefined,
  },
}))
