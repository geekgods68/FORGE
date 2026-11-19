import { defineConfig } from 'vitest/config';

// Loopback only. Do not add `host: true` / `--host` without an explicit decision
// recorded in docs/HEADSET_ACCESS.md. No proxies, no remote assets, no telemetry.
export default defineConfig({
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { sourcemap: true, chunkSizeWarningLimit: 6000 },
  test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
});
