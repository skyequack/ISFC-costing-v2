import { defineConfig } from '@playwright/test';

// Visual baselines arrive in Phase 5 (docs/TESTING.md §5). Viewport is pinned now.
export default defineConfig({
  testDir: 'e2e',
  use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
});
