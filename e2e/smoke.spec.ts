/**
 * The gate none of the other gates provide: does the thing actually work?
 *
 * ── Why so few tests ────────────────────────────────────────────────────────
 *
 * 581 unit tests already cover the engine, and they cover it better than a
 * browser can: in milliseconds, deterministically, with no runner to flake. What
 * they structurally cannot check is everything *between* them — that `main.tsx`
 * mounts, that the canvas gets a 2D context, that React's props reach the engine,
 * that a real `pointerdown` produces a real shape, that IndexedDB survives a
 * reload. Every one of those has been broken at some point in this project while
 * the whole unit suite stayed green.
 *
 * So this file is deliberately thin. It is not where features get tested; it is
 * where *integration* gets tested, and it should stay small enough that it never
 * becomes the slow, flaky part of CI people start rerunning until it passes.
 * **The value of an e2e suite is inversely proportional to how often it lies.**
 *
 * ── Why no pixel screenshots ────────────────────────────────────────────────
 *
 * Playwright has `toHaveScreenshot`, and it is the obvious thing to reach for in
 * a drawing app. It is also the thing that makes e2e suites hated: fonts hint
 * differently on the CI runner, GPUs antialias curves a grey level apart, and the
 * only fix is a tolerance wide enough to hide the regressions you wanted to
 * catch.
 *
 * This project does not need it. `tests/visual/` compares the SVG export — text,
 * exact, no browser — which covers rendering *output* far more precisely than a
 * screenshot could. What is left for this file is the things a canvas can only
 * answer in a browser: is anything painted at all, does the pointer reach the
 * engine, does a reload restore the document.
 *
 * The assertion used instead is coarse on purpose: count non-background pixels.
 * It cannot tell a rectangle from an ellipse — that is `tests/visual/`'s job —
 * but it catches "nothing is drawing", which is the failure that matters here
 * and is exactly what a blank-canvas regression looks like.
 */

import { expect, test, type Page } from '@playwright/test';

/** Non-background pixels on the static canvas. Coarse, and deliberately so. */
async function inkPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas');
    if (canvas === null) return -1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let ink = 0;
    // Threshold rather than "not white": the grid is drawn at ~9% opacity and
    // would otherwise count as ink on every frame, making the assertion pass
    // whether or not a shape exists.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i]! < 200 && data[i + 1]! < 200 && data[i + 2]! < 200) ink++;
    }
    return ink;
  });
}

/**
 * How many elements are in the autosaved document, read straight from IndexedDB.
 *
 * Deliberately bypasses the app: it opens the database the way a different tab
 * or a recovery script would, which is the same thing `ErrorBoundary` does when
 * everything else has failed. If this returns a count, the document is durable —
 * no inference from a spinner, a label, or a debounce timer.
 *
 * The three constants are duplicated from `src/engine/persist/storage.ts`, and
 * that coupling is on purpose. An e2e test that imported them would pass even if
 * the app renamed its store and broke every existing user's saved document.
 * Hard-coding them here means the test is checking the *published* contract —
 * where the bytes live — rather than agreeing with the implementation about it.
 */
async function savedElementCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('excalidraw-clone');
        open.onerror = () => resolve(-1);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('documents')) {
            db.close();
            resolve(0);
            return;
          }
          const request = db.transaction('documents', 'readonly').objectStore('documents').get('current');
          request.onerror = () => {
            db.close();
            resolve(-1);
          };
          request.onsuccess = () => {
            const doc = request.result as { elements?: unknown[] } | undefined;
            db.close();
            resolve(doc?.elements?.length ?? 0);
          };
        };
      }),
  );
}

/**
 * Every canvas assertion goes through a poll. None may read `inkPixels` directly.
 *
 * The engine paints on the next animation frame, and `mouse.up()` resolves as
 * soon as the event is dispatched — so a synchronous read after an interaction
 * measures the canvas *before* the shape reaches it. It is a race, which means it
 * passes locally and fails on a loaded runner, in a different test each time.
 *
 * The first version of this file read directly and looked correct: five tests,
 * green in isolation, one failure per full run that moved around. **A test that
 * fails in a different place each run is measuring the machine, not the code** —
 * and the fix is never a retry, which is why `retries: 0` in the config is what
 * surfaced this at all.
 */
async function expectInk(page: Page, timeout = 5_000) {
  return expect.poll(() => inkPixels(page), { timeout });
}

async function drawRectangle(page: Page, from = { x: 420, y: 300 }, to = { x: 620, y: 430 }) {
  await page.keyboard.press('r');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 8 });
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test.describe('smoke', () => {
  /* Fail the test on ANY console error, not just on a failed assertion.
     A React key warning or an unhandled promise rejection is a real defect that
     no assertion in this file is aimed at, and it is free to catch here. */
  test.beforeEach(async ({ page }) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') throw new Error(`console error: ${msg.text()}`);
    });
    page.on('pageerror', (error) => {
      throw new Error(`uncaught: ${error.message}`);
    });
  });

  test('boots, mounts both canvases, and paints the grid', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('canvas')).toHaveCount(2);
    await expect(page.getByRole('radio', { name: /rectangle/i })).toBeVisible();
  });

  test('draws a rectangle from real pointer events', async ({ page }) => {
    await page.goto('/');
    const before = await inkPixels(page);
    await drawRectangle(page);

    // A 200×130 rectangle at 2px stroke is several thousand ink pixels. The
    // margin is wide because the exact count depends on device pixel ratio and
    // on Rough.js's jitter — this asserts "something substantial appeared", not
    // "this specific shape appeared".
    await (await expectInk(page)).toBeGreaterThan(before + 500);
  });

  test('keeps the drawing across a reload', async ({ page }) => {
    await page.goto('/');
    await drawRectangle(page);
    await (await expectInk(page)).toBeGreaterThan(500);
    const before = await inkPixels(page);

    /* Wait for the bytes to actually be in IndexedDB — not for the UI to say so.

       Phase 8 debounces saves by SAVE_DEBOUNCE_MS (1200 ms) and then defers to
       requestIdleCallback, so reloading immediately races the write and fails for
       a reason that is not a bug. Two earlier versions of this wait were both
       wrong, in the same way:

         1. `toContainText(/last save [\\d.]+ ms/)` — matched instantly, because
            the overlay reads `0.0 ms (pending)` while the save is still queued.
         2. `not.toContainText('(pending)')` — also matched instantly, because the
            overlay refreshes at ~8 Hz and had not yet repainted to show the
            pending state at all.

       Both were attempts to infer a storage fact from a rendering of it, and both
       were races in opposite directions. **Assert the condition itself.** Reading
       the object store answers exactly the question the next line depends on: is
       the document durable yet? */
    await expect.poll(() => savedElementCount(page), { timeout: 10_000 }).toBeGreaterThan(0);

    await page.reload();
    await expect(page.locator('canvas')).toHaveCount(2);

    /* Polled, not read once: `toHaveCount(2)` resolves when the canvases are in
       the DOM, which is before the first animation frame has painted anything
       into them. */
    // Not exact: a reload re-runs Rough.js from the stored seed, which is
    // deterministic, but antialiasing at a fractional offset is not.
    await (await expectInk(page)).toBeGreaterThan(before * 0.8);
  });

  test('downloads an SVG containing the drawing', async ({ page }) => {
    await page.goto('/');
    await drawRectangle(page);

    /* Driven through the real button and the real download, not through a handle
       on `window`. The tempting shortcut is to expose the engine globally and
       call `exportSvg()` from `page.evaluate` — it is three lines shorter and it
       tests a code path no user takes, while leaving a permanent scripting
       backdoor in the shipped bundle to make the test convenient. The download
       path costs one extra API call and covers the button, the Blob, the object
       URL and the filename. */
    await page.getByRole('button', { name: 'Export', exact: true }).click();

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'SVG', exact: true }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/\.svg$/u);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const svg = Buffer.concat(chunks).toString('utf8');

    expect(svg).toContain('<svg');
    expect(svg).toContain('<path');
  });

  test('survives undo and redo back to the same drawing', async ({ page }) => {
    await page.goto('/');
    const empty = await inkPixels(page);
    await drawRectangle(page);
    await (await expectInk(page)).toBeGreaterThan(empty + 500);
    const drawn = await inkPixels(page);

    await page.keyboard.press('Control+z');
    await (await expectInk(page)).toBeLessThan(empty + 200);

    await page.keyboard.press('Control+Shift+z');
    await (await expectInk(page)).toBeGreaterThan(drawn * 0.8);
  });
});
