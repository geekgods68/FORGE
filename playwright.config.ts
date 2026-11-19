import { defineConfig } from '@playwright/test';

// Desktop Chrome only (installed Google Chrome, no browser download).
// These tests do NOT prove headset or controller behaviour.
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', channel: 'chrome', viewport: { width: 1280, height: 800 } },
  webServer: { command: 'npx vite build && npx vite preview', url: 'http://127.0.0.1:4173/', reuseExistingServer: false, timeout: 120_000 },
});
