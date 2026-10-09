import { defineConfig } from 'vitest/config';
import path from 'node:path';

/** Visual smoke harness: renders every screen to static HTML (public/_preview, gitignored) from the Neon dev data. */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  esbuild: { jsx: 'automatic' },
  test: { environment: 'node', include: ['tests/preview/**/*.preview.tsx'], testTimeout: 180_000, fileParallelism: false },
});
