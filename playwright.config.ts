import { defineConfig, devices } from '@playwright/test'

// Single flow, single browser: this suite exists to prove the golden path
// connects end to end through real HTTP and real pages, not to cover every
// browser. Unit/integration tests already cover the branches in isolation.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Reuses whichever dev servers are already running locally (this repo's
  // normal `npm run dev:api` / `npm run dev:web`), and starts fresh ones —
  // required, not optional, in CI where nothing is running yet.
  webServer: [
    {
      command: 'npm run dev:api',
      url: 'http://localhost:4000/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'npm run dev:web',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
})
