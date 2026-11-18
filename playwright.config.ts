import { defineConfig, devices } from '@playwright/test'

// E2E_PREVIEW=1 runs against the production build with the desktop CSP.
const preview = !!process.env.E2E_PREVIEW
const baseURL = preview ? 'http://localhost:4173' : 'http://localhost:5173'

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1400, height: 860 } } }],
  webServer: {
    command: preview ? 'npm run build && npx vite preview' : 'npm run dev',
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
})
