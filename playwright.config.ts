/**
 * End-to-end configuration.
 *
 * ── Against the built app, not the dev server ───────────────────────────────
 *
 * `vite preview` serves `dist/`, which is what actually ships: minified, with
 * `import.meta.env.DEV` false, React in production mode, and every dev-only
 * warning path compiled out. Testing the dev server is testing a build nobody
 * runs — and the differences are exactly where integration bugs hide, because a
 * production React build silently swallows things development shouts about.
 *
 * The cost is a build before the tests, which `webServer.command` handles.
 *
 * ── One browser, on purpose ─────────────────────────────────────────────────
 *
 * Chromium only. A three-browser matrix triples CI time to defend against
 * cross-browser bugs this project has never had, in a codebase whose one
 * genuinely browser-specific behaviour — the canvas size cap — is documented as
 * unhandled on iOS (§9.3) rather than tested. Adding WebKit here would not catch
 * that; it would need a real iOS device.
 *
 * The honest position is: this is a smoke test for integration, not a
 * compatibility matrix, and pretending otherwise buys minutes of CI and a false
 * sense of coverage.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

/**
 * Escape hatch for environments that supply their own Chromium.
 *
 * `npx playwright install` downloads a build pinned to the installed Playwright
 * version, which is the right default and impossible in several real places: an
 * air-gapped CI runner, a Nix or Docker image with a system Chromium, a
 * corporate proxy that blocks the CDN. Playwright supports `executablePath` for
 * exactly this; this reads it from the environment so the committed config
 * carries no machine-specific path.
 *
 * Unset — the normal case, including GitHub Actions — Playwright uses its own
 * managed browser and this changes nothing.
 *
 *     PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium npx playwright test
 */
const chromiumPath = process.env['PLAYWRIGHT_CHROMIUM_PATH'];

export default defineConfig({
  testDir: './e2e',

  /* Full parallelism locally, one worker in CI. Each test writes to the same
     IndexedDB origin, so parallel workers in one browser context would trample
     each other's saved document — and the reload test would then fail
     intermittently for a reason that has nothing to do with the code. */
  fullyParallel: false,
  workers: 1,

  /* No retries. A retried e2e test that passes on the second attempt has told
     you the app is flaky and then hidden it. If one of these five is unstable,
     that is a bug in the app or in the test, and both are worth fixing rather
     than papering over. */
  retries: 0,
  forbidOnly: !!process.env['CI'],
  timeout: 30_000,

  reporter: process.env['CI'] ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
    // A fixed viewport, because half these assertions are about how many pixels
    // got painted.
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    /* The canvas cap and the DPR maths behave differently at dpr 2, and CI runs
       at 1. Pinning it means a local run and a CI run measure the same thing. */
    deviceScaleFactor: 1,
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromiumPath === undefined ? {} : { launchOptions: { executablePath: chromiumPath } }),
      },
    },
  ],

  webServer: {
    command: `npx vite build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
