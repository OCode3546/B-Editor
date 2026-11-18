/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'

function tauriCsp(): string {
  const conf = JSON.parse(readFileSync(new URL('./src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
  return conf.app.security.csp
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { buffer: 'buffer/' },
  },
  // Tauri expects a fixed dev port and needs its own logs visible.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    allowedHosts: ['host.docker.internal'],
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // `vite preview` serves the production build with the desktop app's CSP (from tauri.conf.json),
  // so the e2e suite can catch CSP breakage without launching the native window.
  preview: {
    port: 4173,
    strictPort: true,
    headers: { 'Content-Security-Policy': tauriCsp() },
  },
  optimizeDeps: {
    exclude: ['capstone-wasm'],
    include: ['wabt', 'buffer', 'iconv-lite'],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
