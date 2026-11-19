import { defineConfig, devices } from '@playwright/test';

/**
 * Browser smoke tests against the production build served on 127.0.0.1.
 * Uses Playwright's bundled Chromium (installed with `pnpm exec playwright install chromium`).
 * Headless Chromium renders WebGL in software; these tests verify behaviour, not GPU performance.
 */
export default defineConfig({
  testDir: 'tests/end-to-end',
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @forge/desktop build && pnpm --filter @forge/desktop preview',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
