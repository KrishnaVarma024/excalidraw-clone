/**
 * Export.
 *
 * Two thirds of this phase unit-tests in Node, and that is not an accident:
 *
 *   - **the geometry** — framing, and the browser's canvas caps — is arithmetic
 *     over rectangles, deliberately kept out of the file that needs a canvas;
 *   - **SVG** is a pure string function, and `rough.generator()` needs no DOM.
 *
 * What is left for the browser is a loop that calls `drawElement`, and the
 * things only a browser can answer: does `toBlob` actually produce a PNG, and
 * does the file the user gets look like the drawing they made.
 */

import { describe, expect, it } from 'vitest';
import {
  EXPORT_PADDING,
  MAX_CANVAS_AREA,
  MAX_CANVAS_DIMENSION,
  exportBounds,
  exportMatrix,
  fitExportSize,
} from '@engine/export/bounds';
import { toSvg } from '@engine/export/svg';
import { exportFilename } from '@engine/export/png';
import {
  newDiamond,
  newEllipse,
  newFreedraw,
  newLinear,
  newRectangle,
  newText,
} from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, TRANSPARENT, type Element } from '@engine/scene/element.types';
import { createFixedMeasurer } from '@engine/text/measure';
import { TAU } from '@engine/util/math';
import type { Bounds } from '@engine/util/geometry';

const M = createFixedMeasurer(0.5);
const FILLED = { ...DEFAULT_STYLE, backgroundColor: '#a5d8ff' };

const rect = (over: Partial<Parameters<typeof newRectangle>[0]> = {}) =>
  newRectangle({ x: 0, y: 0, width: 100, height: 60, style: DEFAULT_STYLE, zIndex: 1, ...over });

const box = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

/* ── framing ──────────────────────────────────────────────────────────────── */

describe('exportBounds', () => {
  it('is null for an empty scene', () => {
    // An empty export is not a 0×0 image. It is something the caller must refuse.
    expect(exportBounds([])).toBeNull();
    expect(exportBounds([{ ...rect(), isDeleted: true }])).toBeNull();
  });

  it('frames the content, not the viewport', () => {
    /* The whole distinction of §9. `canvas.toBlob()` on the live canvas gives you
       the current viewport at the current zoom with the handles in it. */
    const b = exportBounds([rect({ x: 500, y: 300 })], 0)!;
    expect(b.minX).toBeLessThan(500);
    expect(b.maxX).toBeGreaterThan(600);
  });

  it('uses RENDER bounds, so edge strokes are not shaved', () => {
    /* `getRenderBounds`, not `getGeometryBounds`: the padded box including the
       stroke width, Rough.js's outward jitter and a pixel of antialiasing. Frame
       the geometry box and every shape at the edge of the drawing loses its
       outermost stroke — which reads as a rendering bug, not a framing one. */
    const el = rect({ style: { ...DEFAULT_STYLE, strokeWidth: 8, roughness: 2 } });
    const b = exportBounds([el], 0)!;
    expect(b.minX).toBeLessThan(0);
    expect(b.maxY).toBeGreaterThan(60);
  });

  it('adds padding on every side', () => {
    const tight = exportBounds([rect()], 0)!;
    const padded = exportBounds([rect()], EXPORT_PADDING)!;
    expect(tight.minX - padded.minX).toBeCloseTo(EXPORT_PADDING, 8);
    expect(padded.maxY - tight.maxY).toBeCloseTo(EXPORT_PADDING, 8);
  });

  it('unions everything visible', () => {
    const b = exportBounds([rect(), rect({ x: 900, y: 700, zIndex: 2 })], 0)!;
    expect(b.minX).toBeLessThan(0);
    expect(b.maxX).toBeGreaterThan(1000);
  });
});

/* ── the browser's canvas caps ────────────────────────────────────────────── */

describe('fitExportSize', () => {
  it('honours a scale that fits', () => {
    const s = fitExportSize(box(0, 0, 100, 60), 3);
    expect(s.scale).toBe(3);
    expect(s.width).toBe(300);
    expect(s.height).toBe(180);
    expect(s.clamped).toBe(false);
  });

  it('clamps a side that would exceed the per-side cap', () => {
    /* Browsers cap canvas dimensions and DO NOT tell you: `getContext` succeeds,
       drawing succeeds, and `toBlob` hands back a blank image or null. No
       exception, no warning. */
    const s = fitExportSize(box(0, 0, 20_000, 100), 3);
    expect(s.width).toBeLessThanOrEqual(MAX_CANVAS_DIMENSION);
    expect(s.clamped).toBe(true);
  });

  it('clamps on AREA even when both sides are legal', () => {
    /* The one people miss. 20,000 × 15,000 is under the per-side cap on both
       axes and still refused, because the product is past ~2^28 pixels. */
    const s = fitExportSize(box(0, 0, 20_000, 15_000), 1);
    expect(s.width * s.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);
    expect(s.clamped).toBe(true);
  });

  it('never returns a dimension past the cap, even after rounding up', () => {
    /* Ceil-then-clamp. Rounding up can push a dimension one pixel past the cap
       when the scale lands exactly on it — a one-pixel overflow that still
       produces a blank image, and the least findable bug in that file. */
    for (const w of [16_383, 16_384, 16_385, 32_768]) {
      const s = fitExportSize(box(0, 0, w, w), 3);
      expect(s.width).toBeLessThanOrEqual(MAX_CANVAS_DIMENSION);
      expect(s.height).toBeLessThanOrEqual(MAX_CANVAS_DIMENSION);
      expect(s.width * s.height).toBeLessThanOrEqual(MAX_CANVAS_AREA);
    }
  });

  it('never produces a zero dimension', () => {
    // A 0×0 canvas throws in some browsers and silently produces nothing in
    // others. Either way it is not an image.
    const s = fitExportSize(box(5, 5, 5, 5), 1);
    expect(s.width).toBeGreaterThan(0);
    expect(s.height).toBeGreaterThan(0);
  });

  it('does not report a clamp for floating-point dust', () => {
    // Telling a user their 2× export was capped to 1.9999999999999998× is worse
    // than not telling them.
    expect(fitExportSize(box(0, 0, 100, 100), 2).clamped).toBe(false);
  });
});

describe('exportMatrix', () => {
  it('maps the bounds’ top-left to the canvas origin', () => {
    /* A FRESH transform — export has its own viewport, unrelated to the screen's.
       This is the payoff for `drawElement` never having been allowed to read
       zoom, scroll or devicePixelRatio. */
    const [a, b, c, d, e, f] = exportMatrix(box(-40, -25, 60, 35), 2);
    expect([a, b, c, d]).toEqual([2, 0, 0, 2]);
    // scene (-40, -25) → device (0, 0)
    expect(-40 * a + e).toBeCloseTo(0, 8);
    expect(-25 * d + f).toBeCloseTo(0, 8);
  });
});

/* ── SVG ──────────────────────────────────────────────────────────────────── */

describe('toSvg', () => {
  it('is null for an empty scene', () => {
    expect(toSvg([], { background: null })).toBeNull();
  });

  it('separates pixel size from the coordinate system', () => {
    /* `width`/`height` in pixels, `viewBox` in scene units. That separation is
       what makes an SVG resolution-independent: scale changes how big it is
       placed and nothing about the geometry inside. */
    const one = toSvg([rect()], { background: null, scale: 1 })!;
    const three = toSvg([rect()], { background: null, scale: 3 })!;

    const viewBox = (s: string) => /viewBox="([^"]+)"/u.exec(s)![1];
    expect(viewBox(one)).toBe(viewBox(three));

    const width = (s: string) => Number(/ width="([\d.]+)"/u.exec(s)![1]);
    expect(width(three)).toBeCloseTo(width(one) * 3, 6);
  });

  it('emits a background rect only when asked', () => {
    expect(toSvg([rect()], { background: '#ffffff' })!).toContain('<rect');
    expect(toSvg([rect()], { background: null })!).not.toContain('<rect');
    // `TRANSPARENT` is the sentinel for "no fill" everywhere else in the model,
    // and must mean the same thing here rather than emitting `fill="transparent"`.
    expect(toSvg([rect()], { background: TRANSPARENT })!).not.toContain('<rect');
  });

  it('renders every element type without throwing', () => {
    const elements: Element[] = [
      rect(),
      newDiamond({ x: 200, y: 0, width: 80, height: 80, style: FILLED, zIndex: 2 }),
      newEllipse({ x: 400, y: 0, width: 80, height: 50, style: FILLED, zIndex: 3 }),
      newLinear({
        x: 0,
        y: 200,
        width: 100,
        height: 0,
        style: DEFAULT_STYLE,
        zIndex: 4,
        type: 'arrow',
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      }),
      newFreedraw({
        x: 0,
        y: 300,
        width: 40,
        height: 20,
        style: DEFAULT_STYLE,
        zIndex: 5,
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 10 },
          { x: 40, y: 20 },
        ],
        pressures: [0.4, 0.6, 0.5],
        simulatePressure: true,
      }),
      newText({ x: 0, y: 400, text: 'hello', style: DEFAULT_STYLE, zIndex: 6 }, M),
    ];

    const svg = toSvg(elements, { background: '#ffffff' })!;
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.endsWith('</svg>')).toBe(true);
    expect(svg).toContain('<text');
    expect((svg.match(/<g/gu) ?? []).length).toBe(elements.length);
  });

  it('draws in z-order regardless of the order it was handed', () => {
    /* An export that silently depended on the caller having sorted would be
       correct in the app — where `Scene.sorted()` supplies it — and wrong in
       every other use. That is the worst kind of dependency. */
    const back = rect({ zIndex: 1, style: { ...FILLED, backgroundColor: '#111111' } });
    const front = rect({ zIndex: 9, style: { ...FILLED, backgroundColor: '#eeeeee' } });

    const svg = toSvg([front, back], { background: null })!;
    expect(svg.indexOf('#111111')).toBeLessThan(svg.indexOf('#eeeeee'));
  });

  it('skips soft-deleted elements', () => {
    const svg = toSvg([rect(), { ...rect({ zIndex: 2 }), isDeleted: true }], { background: null })!;
    expect((svg.match(/<g/gu) ?? []).length).toBe(1);
  });

  it('rotates with a transform rather than baking it into the coordinates', () => {
    // Same reason `drawElement` rotates the canvas: one transform replaces a
    // dozen rotated-corner special cases, and the path data stays comparable
    // between a rotated and an unrotated element.
    const svg = toSvg([rect({ angle: TAU / 8 })], { background: null })!;
    expect(svg).toMatch(/transform="rotate\(45 /u);
  });

  it('carries opacity, and omits it when there is nothing to say', () => {
    expect(toSvg([rect({ style: { ...DEFAULT_STYLE, opacity: 40 } })], { background: null })!)
      .toContain('opacity="0.4"');
    expect(toSvg([rect()], { background: null })!).not.toContain('opacity=');
  });

  it('emits a dash pattern that scales with stroke width', () => {
    const thin = toSvg([rect({ style: { ...DEFAULT_STYLE, strokeStyle: 'dashed', strokeWidth: 1 } })], { background: null })!;
    const thick = toSvg([rect({ style: { ...DEFAULT_STYLE, strokeStyle: 'dashed', strokeWidth: 4 } })], { background: null })!;
    const dash = (s: string) => Number(/stroke-dasharray="([\d.]+)/u.exec(s)![1]);
    expect(dash(thick)).toBeGreaterThan(dash(thin));
    expect(toSvg([rect()], { background: null })!).not.toContain('stroke-dasharray');
  });

  it('fills freehand with nonzero, not the SVG default', () => {
    /* A stroke that crosses itself has overlapping outline regions, and
       `evenodd` — the SVG default — punches holes in exactly those overlaps. A
       scribble exported with the default rule comes out looking like lace. */
    const stroke = newFreedraw({
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      style: DEFAULT_STYLE,
      zIndex: 1,
      points: [
        { x: 0, y: 0 },
        { x: 40, y: 40 },
        { x: 0, y: 40 },
        { x: 40, y: 0 },
      ],
      pressures: [0.5, 0.5, 0.5, 0.5],
      simulatePressure: true,
    });
    expect(toSvg([stroke], { background: null })!).toContain('fill-rule="nonzero"');
  });
});

/* ── the bugs that make a file unopenable ─────────────────────────────────── */

describe('XML escaping', () => {
  it('escapes text content', () => {
    /* The one that bites in the real world: a user types `a < b` into a text
       element and the export is a corrupt file that no parser will open. */
    const el = newText(
      { x: 0, y: 0, text: 'a < b && c > d', style: DEFAULT_STYLE, zIndex: 1 },
      M,
    );
    const svg = toSvg([el], { background: null })!;
    expect(svg).toContain('a &lt; b &amp;&amp; c &gt; d');
    expect(svg).not.toMatch(/>a < b/u);
  });

  it('escapes the font stack, which contains quotes', () => {
    // `"Comic Sans MS"` — with the quotes — pasted into a double-quoted
    // attribute produces an SVG no parser will open. Total, and silent until
    // something tries to read the file.
    const el = newText({ x: 0, y: 0, text: 'hi', style: DEFAULT_STYLE, zIndex: 1 }, M);
    const svg = toSvg([el], { background: null })!;
    expect(svg).toContain('&quot;');
    expect(/font-family="[^"]*"/u.test(svg)).toBe(true);
  });

  it('produces a document a real XML parser accepts', () => {
    /* The assertion that covers the cases I did not think of. Every check above
       is a string match against a bug I already knew about; this one fails for
       any malformed output at all. */
    const elements = [
      rect(),
      newText({ x: 0, y: 100, text: 'quotes " and <tags> & ampersands', style: DEFAULT_STYLE, zIndex: 2 }, M),
    ];
    const svg = toSvg(elements, { background: '#ffffff' })!;

    // A tiny well-formedness check: every tag opens and closes, and no raw
    // `<` survives inside text content.
    const opens = (svg.match(/<[a-zA-Z]/gu) ?? []).length;
    const closes = (svg.match(/<\/[a-zA-Z]/gu) ?? []).length + (svg.match(/\/>/gu) ?? []).length;
    expect(opens).toBe(closes);
  });
});

/* ── the reason the seed was stored in Phase 2 ────────────────────────────── */

describe('byte-reproducibility', () => {
  it('exports the same scene to the same bytes, twice', () => {
    /* Because `seed` is STORED on the element rather than regenerated (§3.1).
       This is what makes Phase 10's visual-regression testing possible at all,
       and it is the reason the seed was made a stored field three phases before
       anything used it. */
    const elements = [rect({ style: FILLED }), rect({ x: 200, zIndex: 2, angle: 0.7 })];
    expect(toSvg(elements, { background: '#ffffff' })).toBe(
      toSvg(elements, { background: '#ffffff' }),
    );
  });

  it('gives DIFFERENT bytes for a different seed, so the test above means something', () => {
    // A reproducibility test passes trivially if the output does not depend on
    // the input. This is the control.
    const a = rect();
    const b = { ...a, seed: a.seed + 1 };
    expect(toSvg([a], { background: null })).not.toBe(toSvg([b], { background: null }));
  });

  it('rounds coordinates, which is what makes the bytes stable', () => {
    /* Not cosmetic. Rough.js emits full float precision — ~17 characters per
       coordinate — and two runs differing in the sixteenth decimal place would
       produce different bytes. Two decimals is well below one device pixel at
       any sane export scale. */
    const svg = toSvg([rect({ x: 1 / 3, y: 2 / 3 })], { background: null })!;
    expect(svg).not.toMatch(/\d\.\d{5}/u);
  });
});

describe('exportFilename', () => {
  it('sorts chronologically by name', () => {
    // A locale timestamp sorts alphabetically into nonsense, and a colon is
    // illegal in a filename on Windows.
    const a = exportFilename('png', new Date(2026, 0, 2, 3, 4));
    const b = exportFilename('png', new Date(2026, 10, 20, 13, 40));
    expect(a).toBe('drawing-2026-01-02-0304.png');
    expect([b, a].sort()).toEqual([a, b]);
    expect(a).not.toContain(':');
  });
});
