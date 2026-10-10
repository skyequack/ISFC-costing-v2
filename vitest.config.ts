import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  esbuild: { jsx: 'automatic' },
  test: {
    fileParallelism: false, // tests/db share one Neon branch; commit-ing tests must not interleave with counting tests
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.ts'],
    coverage: { include: ['src/domain/**'], thresholds: { lines: 95, functions: 95, branches: 95, statements: 95 } },
  },
});
