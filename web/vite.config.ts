import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Bind dev to 127.0.0.1 too: plain "localhost" lands on IPv6 only, which some
// browsers and extensions can't reach.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5191 },
  preview: { host: '127.0.0.1', port: 4173 },
})
