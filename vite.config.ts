import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 6000,
    sourcemap: false,
    rollupOptions: { output: { codeSplitting: false } },
  },
  server: { host: true },
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
});
