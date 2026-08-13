import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEWPORT,
  MAX_ZOOM,
  MIN_ZOOM,
  type ViewportState,
  buildDeviceMatrix,
  clampZoom,
  fitToBounds,
  getVisibleSceneBounds,
  panByScreenDelta,
  sceneToScreen,
  sceneToScreenLength,
  sceneToScreenX,
  screenToScene,
  screenToSceneLength,
  screenToSceneX,
  viewportEquals,
  zoomAtPoint,
  zoomStep,
} from '@engine/viewport/transform';
import { approxEq, makeRandom } from '@engine/util/math';

const vp = (scrollX: number, scrollY: number, zoom: number): ViewportState => ({
  scrollX,
  scrollY,
  zoom,
});

/**
 * Seeded generator.
 *
 * Seeded, not `Math.random()`, so a failure is reproducible. A property test
 * that fails once in twenty runs and cannot be replayed is worse than no test:
 * it trains you to hit re-run.
 */
function randomViewports(count: number, seed = 0xc0ffee): ViewportState[] {
  const rnd = makeRandom(seed);
  return Array.from({ length: count }, () =>
    vp(
      (rnd() - 0.5) * 20_000,
      (rnd() - 0.5) * 20_000,
      MIN_ZOOM + rnd() * (MAX_ZOOM - MIN_ZOOM),
    ),
  );
}

describe('screen ↔ scene round-trip', () => {
  it('is exact for the identity viewport', () => {
    const p = { x: 137.5, y: -42.25 };
    expect(screenToScene(sceneToScreen(p, DEFAULT_VIEWPORT), DEFAULT_VIEWPORT)).toEqual(p);
  });

  it('round-trips over 2,000 random viewport/point pairs', () => {
    const rnd = makeRandom(1234);
    let worst = 0;

    for (const v of randomViewports(2000)) {
      const p = { x: (rnd() - 0.5) * 4000, y: (rnd() - 0.5) * 4000 };
      const back = screenToScene(sceneToScreen(p, v), v);
      worst = Math.max(worst, Math.abs(back.x - p.x), Math.abs(back.y - p.y));
    }

    // Absolute tolerance, because scene coordinates here reach ±10^4 and the
    // transform does a multiply and a divide. 1e-6 scene units is roughly a
    // millionth of a pixel — far below anything observable.
    expect(worst).toBeLessThan(1e-6);
  });

  it('agrees between the scalar and point forms', () => {
    const v = vp(-137.5, 82.25, 1.75);
    const p = { x: 12, y: 34 };
    expect(sceneToScreen(p, v).x).toBe(sceneToScreenX(p.x, v));
    expect(screenToScene(p, v).x).toBe(screenToSceneX(p.x, v));
  });
});

describe('lengths vs positions', () => {
  it('ignores scroll — a length has no origin', () => {
    const a = vp(0, 0, 2);
    const b = vp(9999, -9999, 2);
    expect(sceneToScreenLength(50, a)).toBe(sceneToScreenLength(50, b));
    expect(sceneToScreenLength(50, a)).toBe(100);
  });

  it('round-trips', () => {
    const v = vp(-3, 7, 3.25);
    expect(approxEq(screenToSceneLength(sceneToScreenLength(17, v), v), 17)).toBe(true);
  });
});

describe('zoomAtPoint', () => {
  /**
   * The invariant this whole feature exists for: the scene point under the
   * cursor must not move. Everything else about zooming is cosmetic.
   */
  it('keeps the anchored scene point fixed, over 2,000 random cases', () => {
    const rnd = makeRandom(999);
    let worst = 0;

    for (const v of randomViewports(2000, 0xbeef)) {
      const anchor = { x: rnd() * 1920, y: rnd() * 1080 };
      const nextZoom = MIN_ZOOM + rnd() * (MAX_ZOOM - MIN_ZOOM);

      const before = screenToScene(anchor, v);
      const after = screenToScene(anchor, zoomAtPoint(v, anchor, nextZoom));

      worst = Math.max(worst, Math.abs(after.x - before.x), Math.abs(after.y - before.y));
    }

    expect(worst).toBeLessThan(1e-6);
  });

  it('holds when the anchor is outside the canvas', () => {
    // Legitimate: zooming with the cursor over the toolbar, or a pinch whose
    // centroid drifts off-canvas. There is no special case in the maths and
    // there should not be one.
    const v = vp(-200, 300, 1.5);
    const anchor = { x: -450, y: 2200 };
    const before = screenToScene(anchor, v);
    const after = screenToScene(anchor, zoomAtPoint(v, anchor, 6));
    expect(approxEq(after.x, before.x, 1e-9)).toBe(true);
    expect(approxEq(after.y, before.y, 1e-9)).toBe(true);
  });

  it('holds at the clamp boundaries', () => {
    // When the requested zoom is clamped, the anchor must still be honoured —
    // at the clamped zoom. Getting this wrong makes the canvas lurch sideways
    // when you keep pinching past the limit, which looks broken.
    const v = vp(10, 20, MAX_ZOOM);
    const anchor = { x: 640, y: 360 };
    const before = screenToScene(anchor, v);
    const next = zoomAtPoint(v, anchor, MAX_ZOOM * 10);

    expect(next.zoom).toBe(MAX_ZOOM);
    const after = screenToScene(anchor, next);
    expect(approxEq(after.x, before.x, 1e-9)).toBe(true);
  });

  it('clamps in both directions', () => {
    const v = DEFAULT_VIEWPORT;
    expect(zoomAtPoint(v, { x: 0, y: 0 }, 1e9).zoom).toBe(MAX_ZOOM);
    expect(zoomAtPoint(v, { x: 0, y: 0 }, 1e-9).zoom).toBe(MIN_ZOOM);
  });
});

describe('zoomStep', () => {
  it('is multiplicative, not additive', () => {
    // The observable consequence: the same wheel delta produces the same
    // *ratio* at every zoom level, so zooming feels uniform rather than
    // violent when zoomed out and dead when zoomed in.
    const r1 = zoomStep(1, -100) / 1;
    const r2 = zoomStep(4, -100) / 4;
    expect(approxEq(r1, r2, 1e-12)).toBe(true);
  });

  it('is reversible — +d then −d returns to the start', () => {
    const start = 2.5;
    expect(approxEq(zoomStep(zoomStep(start, -73), 73), start, 1e-12)).toBe(true);
  });

  it('respects the clamps', () => {
    expect(zoomStep(MAX_ZOOM, -100000)).toBe(MAX_ZOOM);
    expect(zoomStep(MIN_ZOOM, 100000)).toBe(MIN_ZOOM);
  });

  it('zooms in on negative delta, matching wheel conventions', () => {
    expect(zoomStep(1, -50)).toBeGreaterThan(1);
    expect(zoomStep(1, 50)).toBeLessThan(1);
  });
});

describe('panByScreenDelta', () => {
  it('divides the delta by zoom', () => {
    // Drag 10 screen px at 4× zoom → the scene moves 2.5 units, not 10.
    // Omitting this division is the bug that feels fine at 100% and wrong
    // everywhere else.
    const next = panByScreenDelta(vp(0, 0, 4), 10, 20);
    expect(next.scrollX).toBe(2.5);
    expect(next.scrollY).toBe(5);
  });

  it('leaves zoom untouched', () => {
    expect(panByScreenDelta(vp(0, 0, 3.7), 5, 5).zoom).toBe(3.7);
  });

  it('keeps the scene point under a dragged cursor pinned', () => {
    // The user-visible definition of "panning works": grab a point, move the
    // mouse, and that same point is still under the cursor.
    const v = vp(-42, 17, 2.5);
    const grabScreen = { x: 300, y: 200 };
    const grabScene = screenToScene(grabScreen, v);

    const dx = 137;
    const dy = -64;
    const moved = panByScreenDelta(v, dx, dy);
    const nowScene = screenToScene({ x: grabScreen.x + dx, y: grabScreen.y + dy }, moved);

    expect(approxEq(nowScene.x, grabScene.x, 1e-9)).toBe(true);
    expect(approxEq(nowScene.y, grabScene.y, 1e-9)).toBe(true);
  });
});

describe('buildDeviceMatrix', () => {
  it('reproduces the formula, including DPR', () => {
    const v = vp(-137.5, 82.25, 1.75);
    const dpr = 2;
    const [a, b, c, d, e, f] = buildDeviceMatrix(v, dpr);

    expect(b).toBe(0);
    expect(c).toBe(0);

    for (const [sx, sy] of [
      [0, 0],
      [42, -17],
      [1e4, 1e4],
    ] as const) {
      // setTransform maps (x, y) → (ax + cy + e, bx + dy + f)
      expect(approxEq(a * sx + c * sy + e, sceneToScreenX(sx, v) * dpr, 1e-9)).toBe(true);
      expect(approxEq(b * sx + d * sy + f, (sy + v.scrollY) * v.zoom * dpr, 1e-9)).toBe(true);
    }
  });

  it('reduces to identity for the default viewport at dpr 1', () => {
    expect(buildDeviceMatrix(DEFAULT_VIEWPORT, 1)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('scales by dpr alone when the viewport is default', () => {
    expect(buildDeviceMatrix(DEFAULT_VIEWPORT, 3)).toEqual([3, 0, 0, 3, 0, 0]);
  });
});

describe('getVisibleSceneBounds', () => {
  it('matches the corners of the canvas', () => {
    const v = vp(-100, -50, 2);
    const b = getVisibleSceneBounds(v, 800, 600);
    expect(b.minX).toBe(screenToSceneX(0, v));
    expect(b.maxX).toBe(screenToSceneX(800, v));
    expect(b.maxX - b.minX).toBe(400); // 800 css px at 2× = 400 scene units
    expect(b.maxY - b.minY).toBe(300);
  });

  it('grows as you zoom out', () => {
    const wide = getVisibleSceneBounds(vp(0, 0, 0.5), 800, 600);
    const tight = getVisibleSceneBounds(vp(0, 0, 4), 800, 600);
    expect(wide.maxX - wide.minX).toBeGreaterThan(tight.maxX - tight.minX);
  });
});

describe('fitToBounds', () => {
  const canvasW = 1000;
  const canvasH = 800;

  it('fits the target inside the canvas', () => {
    const target = { minX: -300, minY: 100, maxX: 700, maxY: 400 };
    const v = fitToBounds(target, canvasW, canvasH, 0.1);
    const visible = getVisibleSceneBounds(v, canvasW, canvasH);

    expect(visible.minX).toBeLessThanOrEqual(target.minX);
    expect(visible.maxX).toBeGreaterThanOrEqual(target.maxX);
    expect(visible.minY).toBeLessThanOrEqual(target.minY);
    expect(visible.maxY).toBeGreaterThanOrEqual(target.maxY);
  });

  it('centres the target', () => {
    const target = { minX: -300, minY: 100, maxX: 700, maxY: 400 };
    const v = fitToBounds(target, canvasW, canvasH);
    const visible = getVisibleSceneBounds(v, canvasW, canvasH);

    const targetMidX = (target.minX + target.maxX) / 2;
    const visibleMidX = (visible.minX + visible.maxX) / 2;
    expect(approxEq(targetMidX, visibleMidX, 1e-9)).toBe(true);
  });

  it('takes the more constrained axis', () => {
    // A very wide, very short target must be fitted by its width.
    const wide = { minX: 0, minY: 0, maxX: 10_000, maxY: 10 };
    const v = fitToBounds(wide, canvasW, canvasH, 0);
    expect(approxEq(v.zoom, canvasW / 10_000, 1e-9)).toBe(true);
  });

  it('survives zero-sized bounds instead of producing Infinity', () => {
    // Happens with a single point element, or an empty selection. Without the
    // epsilon guard this is a division by zero → zoom = Infinity → a NaN
    // transform → a blank canvas with no error anywhere.
    const v = fitToBounds({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, canvasW, canvasH);
    expect(Number.isFinite(v.zoom)).toBe(true);
    expect(Number.isFinite(v.scrollX)).toBe(true);
    expect(v.zoom).toBe(MAX_ZOOM);
  });
});

describe('clampZoom / viewportEquals', () => {
  it('clamps', () => {
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });

  it('compares by value, not by reference', () => {
    expect(viewportEquals(vp(1, 2, 3), vp(1, 2, 3))).toBe(true);
    expect(viewportEquals(vp(1, 2, 3), vp(1, 2, 3.0001))).toBe(false);
  });
});
