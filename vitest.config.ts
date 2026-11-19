import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'packages', include: ['packages/*/src/**/*.test.ts'], environment: 'node' } },
      { test: { name: 'integration', include: ['tests/integration/**/*.test.ts'], environment: 'node' } },
      {
        extends: './apps/desktop/vite.config.ts',
        test: {
          name: 'desktop',
          root: './apps/desktop',
          include: ['src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
        },
      },
    ],
  },
});
