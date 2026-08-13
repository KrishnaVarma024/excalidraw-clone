import { beforeEach, describe, expect, it } from 'vitest';
import { Viewport } from '@engine/viewport/Viewport';
import { MAX_ZOOM, MIN_ZOOM } from '@engine/viewport/transform';
import { approxEq } from '@engine/util/math';

describe('Viewport', () => {
  let vp: Viewport;

  beforeEach(() => {
    vp = new Viewport();
    vp.setSize(1000, 800, 2);
  });

  it('starts at the origin, 100%', () => {
    expect(vp.get()).toEqual({ scrollX: 0, scrollY: 0, zoom: 1 });
  });

  /**
   * Every mutator returns "did anything change?", and the render loop uses that
   * to decide whether to paint. A mutator that returns `true` for a no-op means
   * the canvas repaints forever at 60fps while completely idle — which is
   * exactly the battery-burning bug the idle-frame counter exists to catch.
   */
  describe('change detection', () => {
    it('reports false for no-op operations', () => {
      expect(vp.panBy(0, 0)).toBe(false);
      expect(vp.zoomTo(1)).toBe(false);
      expect(vp.reset()).toBe(false);
      expect(vp.setSize(1000, 800, 2)).toBe(false);
    });

    it('reports true for real changes', () => {
      expect(vp.panBy(1, 0)).toBe(true);
      expect(vp.zoomTo(2)).toBe(true);
      expect(vp.setSize(1000, 801, 2)).toBe(true);
      expect(vp.setSize(1000, 801, 1)).toBe(true); // DPR alone counts
    });

    it('reports false when zooming past a clamp that is already reached', () => {
      vp.zoomTo(MAX_ZOOM);
      expect(vp.zoomTo(MAX_ZOOM * 2)).toBe(false);
      vp.zoomTo(MIN_ZOOM);
      expect(vp.zoomTo(MIN_ZOOM / 2)).toBe(false);
    });
  });

  describe('zoom anchoring', () => {
    it('defaults to the canvas centre', () => {
      const centre = vp.center;
      expect(centre).toEqual({ x: 500, y: 400 });

      const before = vp.toScene(centre);
      vp.zoomByFactor(2.5);
      const after = vp.toScene(centre);

      expect(approxEq(before.x, after.x, 1e-9)).toBe(true);
      expect(approxEq(before.y, after.y, 1e-9)).toBe(true);
    });

    it('honours an explicit anchor', () => {
      const anchor = { x: 137, y: 642 };
      const before = vp.toScene(anchor);
      vp.zoomByDelta(-120, anchor);
      const after = vp.toScene(anchor);
      expect(approxEq(before.x, after.x, 1e-9)).toBe(true);
    });

    it('survives a hundred alternating zoom steps without drifting', () => {
      // Accumulated float error is the failure mode here: each step reads the
      // state written by the previous one, so any bias compounds. A drift of
      // more than a fraction of a pixel over a realistic gesture would show up
      // as the canvas slowly crawling while the user pinches back and forth.
      const anchor = { x: 321, y: 123 };
      const before = vp.toScene(anchor);

      for (let i = 0; i < 50; i++) {
        vp.zoomByDelta(-40, anchor);
        vp.zoomByDelta(40, anchor);
      }

      const after = vp.toScene(anchor);
      expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6);
      expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6);
      expect(approxEq(vp.zoom, 1, 1e-9)).toBe(true);
    });
  });

  describe('resetZoom', () => {
    it('returns to 100% while keeping the centre put', () => {
      vp.panBy(-300, 250);
      vp.zoomByFactor(4.2);

      const centreBefore = vp.toScene(vp.center);
      vp.resetZoom();

      expect(vp.zoom).toBe(1);
      const centreAfter = vp.toScene(vp.center);
      expect(approxEq(centreBefore.x, centreAfter.x, 1e-9)).toBe(true);
      expect(approxEq(centreBefore.y, centreAfter.y, 1e-9)).toBe(true);
    });
  });

  describe('deviceMatrix', () => {
    it('folds zoom and DPR into one scale term', () => {
      vp.zoomTo(3, { x: 0, y: 0 });
      const [a, b, c, d] = vp.deviceMatrix();
      expect(a).toBe(6); // zoom 3 × dpr 2
      expect(d).toBe(6);
      expect(b).toBe(0);
      expect(c).toBe(0);
    });
  });

  describe('fit', () => {
    it('brings arbitrary bounds fully into view', () => {
      vp.fit({ minX: 4000, minY: -9000, maxX: 4600, maxY: -8500 });
      const visible = vp.visibleSceneBounds();
      expect(visible.minX).toBeLessThanOrEqual(4000);
      expect(visible.maxX).toBeGreaterThanOrEqual(4600);
      expect(visible.minY).toBeLessThanOrEqual(-9000);
      expect(visible.maxY).toBeGreaterThanOrEqual(-8500);
    });
  });

  describe('pan', () => {
    it('scales the delta by 1/zoom', () => {
      vp.zoomTo(4, { x: 0, y: 0 });
      const before = vp.get().scrollX;
      vp.panBy(40, 0);
      expect(approxEq(vp.get().scrollX - before, 10, 1e-9)).toBe(true);
    });

    it('works arbitrarily far from the origin', () => {
      // An infinite canvas means someone will eventually pan a long way. The
      // transform has no special case for this; the only real limit is float64
      // precision, which is why the tolerance below is relative to magnitude.
      for (let i = 0; i < 1000; i++) vp.panBy(1000, 1000);
      expect(vp.get().scrollX).toBe(1_000_000);
      const p = vp.toScene({ x: 0, y: 0 });
      expect(approxEq(p.x, -1_000_000, 1e-6)).toBe(true);
    });
  });
});
