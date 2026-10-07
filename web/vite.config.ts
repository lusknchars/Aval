import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// The console calls the Veto demo server through /veto, so the browser never
// needs CORS and the engine's RPC config stays on the server side.
const VETO = process.env.VETO_URL ?? 'http://127.0.0.1:5173'
const SVM = process.env.SVM_URL ?? 'http://127.0.0.1:8899'
const LAB = process.env.LAB_URL ?? 'http://127.0.0.1:8070'
const proxy = {
  '/veto': { target: VETO, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/veto/, '') },
  '/svm': { target: SVM, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/svm/, '') },
  '/lab': { target: LAB, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/lab/, '') },
}

// Bind to 127.0.0.1: plain "localhost" lands on IPv6 only, which some
// browsers and extensions can't reach.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5191, proxy },
  preview: { host: '127.0.0.1', port: 4173, proxy },
  build: {
    rollupOptions: {
      input: { site: resolve(import.meta.dirname, 'index.html'), console: resolve(import.meta.dirname, 'app/index.html') },
    },
  },
})
