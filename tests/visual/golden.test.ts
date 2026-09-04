/**
 * Visual regression, without a browser and without an image.
 *
 * ── The trick, and why it is available at all ───────────────────────────────
 *
 * Visual regression normally means: launch a browser, screenshot, diff pixels
 * against a stored PNG. It is the standard answer and it is genuinely painful —
 * a font hinted differently on the CI runner, a GPU that antialiases a curve one
 * grey level off, a scrollbar that appears on Linux and not on macOS, and the
 * build is red for a reason that has nothing to do with the change. Teams end up
 * with a per-pixel tolerance, and a tolerance wide enough to absorb that noise is
 * usually wide enough to absorb a real regression.
 *
 * This project can skip all of it, because of two decisions made earlier for
 * other reasons:
 *
 *   Phase 2 stored the Rough.js `seed` on the element instead of regenerating it.
 *   Phase 9 built an SVG exporter that runs with no DOM at all.
 *
 * Together those give a **deterministic textual rendering of the scene**. So the
 * golden file is the SVG itself — text, diffable, reviewable in a pull request,
 * byte-identical on every machine. No browser, no image decoder, no tolerance,
 * no flake. It runs in the same 400 ms as the rest of the unit tests.
 *
 * That is the payoff of a design property nobody asked for at the time. Worth
 * being precise about the direction, though: the determinism was not built *for*
 * this. It was built because a shape that re-rolls its jitter every frame looks
 * broken. This phase is what a good invariant tends to do — pay out somewhere
 * you were not looking.
 *
 * ── What this catches that nothing else does ────────────────────────────────
 *
 * The unit tests assert properties: "opacity below 100 emits an opacity
 * attribute", "deleted elements are skipped". Properties are the right tool for
 * things you thought of. They cannot catch a change in the *shape* of the
 * output — a stroke width that now rounds differently, a transform emitted in a
 * different order, a fill rule silently dropped on one element type. Nobody
 * writes an assertion for those, because you only know to look after they break.
 *
 * A golden file catches all of them at once, and needs no foresight: it asserts
 * that the output is what it was, and makes you look at any difference.
 *
 * ── What it does NOT catch, stated plainly ──────────────────────────────────
 *
 * The SVG and canvas renderers share the Rough.js `Drawable` (§9.4), so a change
 * in the geometry moves both. But they are still two emitters: a bug in
 * `drawElement`'s canvas-only path — a wrong `globalAlpha`, a missing
 * `setLineDash` — is invisible here. That is what the Playwright smoke test in
 * `e2e/` is for. **Two gates, two failure classes**; claiming one covers the
 * other is how a suite ends up green over a broken build.
 *
 * ── Updating ────────────────────────────────────────────────────────────────
 *
 *     UPDATE_GOLDEN=1 npm test -- tests/visual
 *
 * Then *read the diff*. A golden file regenerated without reading it is worse
 * than no golden file: it costs the same and certifies nothing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateScene } from '@engine/dev/generateScene';
import { newRectangle, newText } from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, type Element } from '@engine/scene/element.types';
import { createFixedMeasurer } from '@engine/text/measure';
import { toSvg } from '@engine/export/svg';
import { TAU } from '@engine/util/math';

const GOLDEN_DIR = fileURLToPath(new URL('./__golden__', import.meta.url));
const UPDATING = process.env['UPDATE_GOLDEN'] === '1';

if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

/**
 * One element per line.
 *
 * `toSvg` emits a single line on purpose — it is a file the user downloads, and
 * newlines are bytes that buy them nothing. A golden file has the opposite
 * reader: a human scanning a pull request. On one line, changing a single stroke
 * width rewrites the whole 24 kB line and git shows "1 file changed, 1 insertion,
 * 1 deletion" — technically true, completely useless.
 *
 * So the stored format is chosen for the reviewer, not for the product. This is
 * a pure, deterministic transform of a deterministic string, so it costs the
 * comparison nothing: splitting between `>` and `<` cannot touch text content,
 * because `<` and `>` inside text are already escaped to `&lt;` and `&gt;` by the
 * serialiser.
 *
 * **A golden file whose diff nobody can read gets regenerated instead of read**,
 * and at that point it is a slow way of asserting nothing.
 */
const forDiff = (svg: string): string => `${svg.replaceAll('><', '>\n<')}\n`;

/**
 * Compare against the stored file, or write it when updating.
 *
 * A missing golden is a hard failure rather than a silent create. Auto-creating
 * on first run means a typo'd scenario name quietly writes a new file and passes
 * forever — the test exists, is green, and asserts nothing. **A test that cannot
 * fail is a liability with a maintenance cost.**
 */
function matchesGolden(name: string, actual: string): void {
  const path = join(GOLDEN_DIR, `${name}.svg`);

  const text = forDiff(actual);

  if (UPDATING) {
    writeFileSync(path, text, 'utf8');
    return;
  }

  if (!existsSync(path)) {
    throw new Error(
      `No golden file for "${name}".\n\n` +
        `  Expected: ${path}\n\n` +
        `  If this scenario is new, create it deliberately:\n` +
        `      UPDATE_GOLDEN=1 npm test -- tests/visual\n`,
    );
  }

  expect(text).toBe(readFileSync(path, 'utf8'));
}

/* ── The scenarios ──────────────────────────────────────────────────────────

   Small and hand-built rather than one big generated scene. A 1,000-element
   golden is 660 kB of unreadable path data: any change produces a diff nobody
   can read, so the only available response is to regenerate it — which defeats
   the point entirely. These are sized so a human can look at the diff and say
   "yes, the dashes should have moved", which is the only review that means
   anything.

   One file per feature, for the same reason a good unit test has one subject:
   when it fails, the FILENAME is already most of the diagnosis.

   ── The one thing that must be pinned ────────────────────────────────────────

   `newRectangle` calls `newSeed()`, and the seed is what Rough.js jitters from.
   Leave it and every run produces different path data — the golden would fail on
   the second run and there would be nothing wrong. Overridden explicitly below.

   `id` is deliberately NOT pinned: it never reaches the SVG. Pinning it anyway
   would suggest to the next reader that it matters, and the value of a fixture
   is that everything in it is load-bearing. */

const M = createFixedMeasurer(0.5);

const rect = (
  over: Partial<Parameters<typeof newRectangle>[0]> = {},
  seed = 42,
): Element => ({ ...newRectangle({ x: 0, y: 0, width: 120, height: 80, style: DEFAULT_STYLE, zIndex: 1, ...over }), seed });

describe('golden SVG', () => {
  it('shapes — every element type, from the seeded generator', () => {
    const elements = generateScene({ count: 12, seed: 7, spread: 300 }).elements;
    matchesGolden('shapes', toSvg(elements, { background: '#ffffff' })!);
  });

  it('styles — stroke widths, dash patterns and opacity', () => {
    const elements: Element[] = [];
    let z = 0;
    for (const strokeStyle of ['solid', 'dashed', 'dotted'] as const) {
      for (const strokeWidth of [1, 2, 4] as const) {
        elements.push(
          rect(
            {
              x: (z % 3) * 160,
              y: Math.floor(z / 3) * 110,
              zIndex: z,
              style: {
                ...DEFAULT_STYLE,
                strokeStyle,
                strokeWidth,
                backgroundColor: '#a5d8ff',
                opacity: 40 + z * 6,
              },
            },
            100 + z,
          ),
        );
        z++;
      }
    }
    matchesGolden('styles', toSvg(elements, { background: '#ffffff' })!);
  });

  it('rotation — the transform, and where its origin sits', () => {
    const elements = [0, 1, 2, 3].map((i) =>
      rect({ x: i * 180, y: 0, zIndex: i, angle: (i * TAU) / 12 }, 200 + i),
    );
    matchesGolden('rotation', toSvg(elements, { background: null })!);
  });

  it('text — wrapping, alignment and XML escaping', () => {
    const make = (textAlign: 'left' | 'center' | 'right', x: number, zIndex: number) =>
      newText(
        {
          x,
          y: 0,
          text: 'wrap me please <&> "quoted"\nsecond line',
          style: DEFAULT_STYLE,
          zIndex,
          textAlign,
          wrapWidth: 200,
        },
        M,
      );
    matchesGolden(
      'text',
      toSvg([make('left', 0, 0), make('center', 240, 1), make('right', 480, 2)], {
        background: '#ffffff',
      })!,
    );
  });
});
