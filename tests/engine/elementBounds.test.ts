import { describe, expect, it } from 'vitest';
import {
  getGeometryBounds,
  getRenderBounds,
  getRenderPadding,
  getRotatedBounds,
  getSceneBounds,
  measurePointBased,
} from '@engine/scene/bounds';
import { newFreedraw, newRectangle, normalizeDrag } from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, type ElementStyle } from '@engine/scene/element.types';
import { approxEq, degToRad } from '@engine/util/math';
import { boundsContains } from '@engine/util/geometry';

const style = (patch: Partial<ElementStyle> = {}): ElementStyle => ({
  ...DEFAULT_STYLE,
  ...patch,
});

function box(x: number, y: number, w: number, h: number, angle = 0, s = style()) {
  return newRectangle({ x, y, width: w, height: h, style: s, zIndex: 1, angle });
}

describe('getGeometryBounds', () => {
  it('is the plain un-rotated box', () => {
    expect(getGeometryBounds(box(10, 20, 30, 40))).toEqual({
      minX: 10,
      minY: 20,
      maxX: 40,
      maxY: 60,
    });
  });
});

describe('getRotatedBounds', () => {
  it('returns the geometry box unchanged at angle 0', () => {
    const el = box(10, 20, 30, 40);
    expect(getRotatedBounds(el)).toEqual(getGeometryBounds(el));
  });

  it('is unchanged by a 180° rotation', () => {
    // A rectangle rotated half a turn occupies exactly the same pixels.
    const el = box(0, 0, 40, 20, Math.PI);
    const b = getRotatedBounds(el);
    expect(approxEq(b.minX, 0, 1e-9)).toBe(true);
    expect(approxEq(b.maxX, 40, 1e-9)).toBe(true);
    expect(approxEq(b.maxY, 20, 1e-9)).toBe(true);
  });

  it('swaps width and height at 90°', () => {
    const el = box(0, 0, 40, 20, degToRad(90));
    const b = getRotatedBounds(el);
    expect(approxEq(b.maxX - b.minX, 20, 1e-9)).toBe(true);
    expect(approxEq(b.maxY - b.minY, 40, 1e-9)).toBe(true);
  });

  it('grows dramatically for a long thin shape at 45°', () => {
    /**
     * The cost that Phase 5 has to live with. A 300×10 rectangle rotated 45°
     * has an axis-aligned box of roughly 220×220 — about five times the pixel
     * area of the shape itself. That is correct and conservative, and it is why
     * the dirty-rect renderer needs a full-repaint escape hatch: a handful of
     * rotated elements can dirty most of the screen.
     */
    const el = box(0, 0, 300, 10, degToRad(45));
    const b = getRotatedBounds(el);
    const side = b.maxX - b.minX;

    expect(side).toBeGreaterThan(200);
    expect(side).toBeLessThan(230);
    // Conservative, never smaller than the shape.
    expect(side).toBeGreaterThan(300 * Math.SQRT1_2 - 1);
  });

  /**
   * Note what this does NOT assert: that the rotated box contains the geometry
   * box. That is true at small angles and false near 90°, where an 80×30 shape
   * becomes a 30×80 box that the original does not fit inside. The property
   * that actually holds at every angle is the area relation — the rotated AABB
   * is never smaller than the shape it encloses.
   *
   * I wrote the containment assertion first and the test caught me: worth
   * keeping the note, because "assert the property that is true, not the one
   * that sounds true" is the lesson.
   */
  it('is never smaller in area than the shape it encloses', () => {
    for (const deg of [0, 17, 45, 90, 133, 271, 359]) {
      const el = box(-40, 25, 80, 30, degToRad(deg));
      const r = getRotatedBounds(el);
      expect((r.maxX - r.minX) * (r.maxY - r.minY)).toBeGreaterThanOrEqual(80 * 30 - 1e-6);
    }
  });

  it('contains the geometry box only while the rotation is small', () => {
    const shallow = box(-40, 25, 80, 30, degToRad(10));
    expect(boundsContains(getRotatedBounds(shallow), getGeometryBounds(shallow))).toBe(true);

    const quarter = box(-40, 25, 80, 30, degToRad(90));
    expect(boundsContains(getRotatedBounds(quarter), getGeometryBounds(quarter))).toBe(false);
  });

  it('keeps the centre fixed under rotation', () => {
    const el = box(10, 10, 100, 40, degToRad(37));
    const b = getRotatedBounds(el);
    expect(approxEq((b.minX + b.maxX) / 2, 60, 1e-9)).toBe(true);
    expect(approxEq((b.minY + b.maxY) / 2, 30, 1e-9)).toBe(true);
  });
});

describe('getRenderPadding / getRenderBounds', () => {
  /**
   * The bug this prevents: under-pad by a single pixel and a moving shape
   * leaves a faint ghost line behind it. Invisible until you look closely, and
   * baffling when you do.
   */
  it('grows with stroke width and roughness', () => {
    const thin = getRenderPadding(box(0, 0, 10, 10, 0, style({ strokeWidth: 1, roughness: 0 })));
    const thick = getRenderPadding(box(0, 0, 10, 10, 0, style({ strokeWidth: 8, roughness: 0 })));
    const rough = getRenderPadding(box(0, 0, 10, 10, 0, style({ strokeWidth: 1, roughness: 2 })));

    expect(thick).toBeGreaterThan(thin);
    expect(rough).toBeGreaterThan(thin);
  });

  it('is never zero — antialiasing alone bleeds a pixel', () => {
    expect(
      getRenderPadding(box(0, 0, 10, 10, 0, style({ strokeWidth: 0, roughness: 0 }))),
    ).toBeGreaterThanOrEqual(1);
  });

  it('always strictly contains the rotated bounds', () => {
    for (const deg of [0, 30, 45, 90, 200]) {
      const el = box(0, 0, 60, 20, degToRad(deg), style({ strokeWidth: 4, roughness: 2 }));
      const rotated = getRotatedBounds(el);
      const render = getRenderBounds(el);

      expect(boundsContains(render, rotated)).toBe(true);
      expect(render.minX).toBeLessThan(rotated.minX);
      expect(render.maxY).toBeGreaterThan(rotated.maxY);
    }
  });

  it('pads freehand more, because the outline sits outside the recorded points', () => {
    const s = style({ strokeWidth: 4 });
    const stroke = newFreedraw({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      style: s,
      zIndex: 1,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ],
      pressures: [0.5, 0.5],
      simulatePressure: true,
    });
    expect(getRenderPadding(stroke)).toBeGreaterThan(getRenderPadding(box(0, 0, 10, 10, 0, s)));
  });
});

describe('measurePointBased', () => {
  const s = style();

  function stroke(points: { x: number; y: number }[]) {
    return newFreedraw({
      x: 100,
      y: 100,
      width: 0,
      height: 0,
      style: s,
      zIndex: 1,
      points,
      pressures: points.map(() => 0.5),
      simulatePressure: true,
    });
  }

  it('derives width and height from the points', () => {
    const measured = measurePointBased(
      stroke([
        { x: 0, y: 0 },
        { x: 30, y: 20 },
      ]),
    )!;
    expect(measured.width).toBe(30);
    expect(measured.height).toBe(20);
  });

  it('re-anchors a stroke drawn up-and-left', () => {
    /**
     * points[0] is where the pointer went down, not necessarily the top-left.
     * Draw up and to the left and the local coordinates go negative — at which
     * point the element's bounds no longer match its x/y, so culling and
     * hit-testing are both wrong. Re-anchoring fixes it at commit time, once.
     */
    const measured = measurePointBased(
      stroke([
        { x: 0, y: 0 },
        { x: -40, y: -25 },
      ]),
    )!;

    expect(measured.x).toBe(60); // 100 + (-40)
    expect(measured.y).toBe(75); // 100 + (-25)
    expect(measured.width).toBe(40);
    expect(measured.height).toBe(25);

    // Every local coordinate is now non-negative.
    for (const p of measured.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves an already-anchored stroke untouched', () => {
    const el = stroke([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ]);
    const measured = measurePointBased(el)!;
    expect(measured.x).toBe(el.x);
    // Same array reference — nothing to rewrite, so nothing is allocated.
    expect(measured.points).toBe(el.points);
  });

  it('returns null for a non-point-based element', () => {
    expect(measurePointBased(box(0, 0, 10, 10))).toBeNull();
  });
});

describe('normalizeDrag', () => {
  it('handles a normal down-right drag', () => {
    expect(normalizeDrag({ x: 10, y: 10 }, { x: 40, y: 50 })).toEqual({
      x: 10,
      y: 10,
      width: 30,
      height: 40,
    });
  });

  it('normalises an up-and-left drag to positive size', () => {
    // Every shape tool produces this. Normalising once, where elements are
    // born, means nothing downstream ever asks "what if width is negative?"
    expect(normalizeDrag({ x: 40, y: 50 }, { x: 10, y: 10 })).toEqual({
      x: 10,
      y: 10,
      width: 30,
      height: 40,
    });
  });

  it('handles a zero-length drag', () => {
    expect(normalizeDrag({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({
      x: 5,
      y: 5,
      width: 0,
      height: 0,
    });
  });
});

describe('getSceneBounds', () => {
  it('unions every element', () => {
    const b = getSceneBounds([box(0, 0, 10, 10), box(100, 50, 10, 10)])!;
    expect(b.minX).toBeLessThanOrEqual(0);
    expect(b.maxX).toBeGreaterThanOrEqual(110);
  });

  it('returns null for an empty scene rather than an inverted rectangle', () => {
    // Zoom-to-fit on an empty canvas must be a no-op, not a division by zero
    // that produces a NaN transform and a silently blank canvas.
    expect(getSceneBounds([])).toBeNull();
  });
});
