import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['../../tests/integration/**/*.test.ts'],
    // Real DB round trips plus a deliberate burst; the default 5s is tight.
    testTimeout: 30_000,
    // These tests share one database — running files in parallel would let
    // them clobber each other's seats.
    fileParallelism: false,
  },
})
