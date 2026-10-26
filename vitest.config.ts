import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const alias = {
  '@shared': path.join(root, 'src/shared'),
  '@engine': path.join(root, 'src/engine'),
  '@renderer': path.join(root, 'src/renderer'),
};

export default defineConfig({
  test: {
    globals: false,
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          testTimeout: 15_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 240_000,
          hookTimeout: 300_000,
          globalSetup: ['./tests/integration/global-setup.ts'],
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 300_000,
          hookTimeout: 300_000,
          globalSetup: ['./tests/e2e/global-setup.ts'],
          fileParallelism: false,
        },
      },
      {
        resolve: { alias },
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'ui',
          environment: 'jsdom',
          include: ['tests/ui/**/*.test.tsx'],
          setupFiles: ['./tests/ui/setup.ts'],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
