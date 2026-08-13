/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
      '@react': fileURLToPath(new URL('./src/react', import.meta.url)),
    },
  },

  test: {
    // The engine is deliberately DOM-free, so the default Node environment is
    // correct AND fast. If a test ever needs `jsdom`, that is a signal that
    // browser-only code has leaked out of src/react/ — treat it as a smell,
    // not as a reason to change this line.
    environment: 'node',
    include: ['tests/**/*.test.ts'],

    /* Benchmarks are a separate command (`npm run bench`), deliberately NOT part
       of `npm run verify`. They take seconds rather than milliseconds, and their
       output is a property of the machine as much as of the code — gating CI on
       a stopwatch is how you get a red build because a runner was busy.

       What CI does gate on is the deterministic counter asserted in
       tests/engine/culling.test.ts: same evidence about complexity, no clock
       involved. Benchmarks answer "how big is the constant", which is a question
       for a human reading a PR, not for a build. */
    benchmark: {
      include: ['tests/bench/**/*.bench.ts'],
    },

    coverage: {
      provider: 'v8',
      include: ['src/engine/**/*.ts'],
      reporter: ['text', 'html'],
    },
  },
});
