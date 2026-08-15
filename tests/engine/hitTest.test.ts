/**
 * Narrow-phase hit testing.
 *
 * The interesting cases here are not "does clicking the middle of a rectangle
 * hit it". They are the three that produce real bug reports:
 *
 *   - a hollow shape must NOT be hit through its middle, or you can never
 *     select the thing behind it;
 *   - a rotated shape must be hit where it *looks* like it is, not where its
 *     un-rotated box is;
 *   - the tolerance must be in scene units derived from zoom, or thin lines are
 *     unclickable when zoomed out.
 */

import { describe, expect, it } from 'vitest';
import { hitTestBox, hitTestElement, toLocal } from '@engine/scene/hitTest';
import {
  newDiamond,
  newEllipse,
  newFreedraw,
  newLinear,
  newRectangle,
} from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, TRANSPARENT, type Element } from '@engine/scene/element.types';
import { TAU } from '@engine/util/math';
import type { Bounds, Point } from '@engine/util/geometry';

const FILLED = { ...DEFAULT_STYLE, backgroundColor: '#ffc9c9' };
const HOLLOW = { ...DEFAULT_STYLE, backgroundColor: TRANSPARENT, strokeWidth: 1 };

const at = (x: number, y: number): Point => ({ x, y });

function rect(filled: boolean, angle = 0) {
  return newRectangle({
    x: 0,
    y: 0,
    width: 100,
    height: 60,
    style: filled ? FILLED : HOLLOW,
    zIndex: 1,
    angle,
  });
}

describe('rectangles', () => {
  it('hits anywhere inside when filled', () => {
    const el = rect(true);
    expect(hitTestElement(el, at(50, 30), 1)).toBe(true);
    expect(hitTestElement(el, at(1, 1), 1)).toBe(true);
  });

  it('misses the middle when hollow', () => {
    // The behaviour that lets you click a shape sitting *behind* an unfilled
    // one. Get this wrong and the canvas feels like it has invisible walls.
    const el = rect(false);
    expect(hitTestElement(el, at(50, 30), 2)).toBe(false);
  });

  it('hits the edge when hollow', () => {
    const el = rect(false);
    expect(hitTestElement(el, at(0, 30), 2)).toBe(true); // left edge
    expect(hitTestElement(el, at(50, 60), 2)).toBe(true); // bottom edge
    expect(hitTestElement(el, at(100, 0), 2)).toBe(true); // corner
  });

  it('misses outside, filled or not', () => {
    for (const el of [rect(true), rect(false)]) {
      expect(hitTestElement(el, at(-20, 30), 2)).toBe(false);
      expect(hitTestElement(el, at(50, 200), 2)).toBe(false);
    }
  });

  it('treats a shape thinner than the tolerance as solid', () => {
    // A 3-unit-tall rectangle with a 5-unit tolerance has no "interior" left
    // once both edges are widened. Reporting a miss in the middle of a shape
    // you can plainly see would be worse than the small inconsistency.
    const thin = newRectangle({ x: 0, y: 0, width: 100, height: 3, style: HOLLOW, zIndex: 1 });
    expect(hitTestElement(thin, at(50, 1.5), 5)).toBe(true);
  });
});

describe('rotation', () => {
  it('moves the query point into the local frame instead of rotating the shape', () => {
    const el = rect(true, TAU / 4); // 90°
    const centre = { x: 50, y: 30 };

    // A point at the centre is unaffected by rotation about the centre.
    expect(toLocal(centre, el)).toEqual(centre);

    // A point offset along +x maps to an offset along the rotated axis.
    const moved = toLocal({ x: 100, y: 30 }, el);
    expect(moved.x).toBeCloseTo(50, 6);
    expect(moved.y).toBeCloseTo(-20, 6);
  });

  it('hits a rotated rectangle where it is drawn, not where its box was', () => {
    // 100×60 rotated 90° about its centre (50, 30) occupies roughly
    // x ∈ [20, 80], y ∈ [-20, 80]. So (50, 75) is inside the rotated shape and
    // (95, 30) — comfortably inside the UNROTATED box — is outside it.
    const el = rect(true, TAU / 4);

    expect(hitTestElement(el, at(50, 75), 1)).toBe(true);
    expect(hitTestElement(el, at(95, 30), 1)).toBe(false);
  });

  it('agrees with the unrotated case at angle 0', () => {
    const a = rect(true, 0);
    const b = rect(true, TAU); // a full turn is the same shape
    for (const p of [at(50, 30), at(-5, -5), at(99, 59)]) {
      expect(hitTestElement(b, p, 1)).toBe(hitTestElement(a, p, 1));
    }
  });
});

describe('ellipses', () => {
  const ellipse = (filled: boolean) =>
    newEllipse({ x: 0, y: 0, width: 100, height: 100, style: filled ? FILLED : HOLLOW, zIndex: 1 });

  it('hits inside the curve when filled and misses the corner of its box', () => {
    // The whole reason an ellipse is not tested as a rectangle: the corners of
    // its bounding box are empty space.
    const el = ellipse(true);
    expect(hitTestElement(el, at(50, 50), 1)).toBe(true);
    expect(hitTestElement(el, at(2, 2), 1)).toBe(false);
  });

  it('hits only the outline when hollow', () => {
    const el = ellipse(false);
    expect(hitTestElement(el, at(50, 50), 2)).toBe(false); // dead centre
    expect(hitTestElement(el, at(100, 50), 2)).toBe(true); // rightmost point
    expect(hitTestElement(el, at(50, 0), 2)).toBe(true); // topmost point
  });

  it('stays clickable when flattened to a line', () => {
    // width or height of zero divides by zero in the normalised-radius maths.
    // A degenerate ellipse is still drawn, so it must still be selectable.
    const flat = newEllipse({ x: 0, y: 50, width: 100, height: 0, style: HOLLOW, zIndex: 1 });
    expect(hitTestElement(flat, at(50, 50), 2)).toBe(true);
    expect(hitTestElement(flat, at(50, 90), 2)).toBe(false);
  });
});

describe('diamonds', () => {
  const diamond = (filled: boolean) =>
    newDiamond({ x: 0, y: 0, width: 100, height: 100, style: filled ? FILLED : HOLLOW, zIndex: 1 });

  it('misses the corners of its bounding box', () => {
    const el = diamond(true);
    expect(hitTestElement(el, at(50, 50), 1)).toBe(true);
    expect(hitTestElement(el, at(3, 3), 1)).toBe(false);
  });

  it('hits a vertex lying exactly on the ray-casting scanline', () => {
    // The classic point-in-polygon trap: a horizontal ray through a vertex is
    // counted twice or not at all by a naive implementation, and a diamond has
    // two vertices on its horizontal axis. The point (0, 50) is the left vertex.
    const el = diamond(true);
    expect(hitTestElement(el, at(0, 50), 1)).toBe(true);
    expect(hitTestElement(el, at(50, 50), 1)).toBe(true);
  });

  it('hits only the edges when hollow', () => {
    const el = diamond(false);
    expect(hitTestElement(el, at(50, 50), 2)).toBe(false);
    expect(hitTestElement(el, at(25, 25), 2)).toBe(true); // on the top-left edge
  });
});

describe('lines, arrows and freehand', () => {
  const line = (w: number, h: number, strokeWidth = 2) =>
    newLinear({
      x: 10,
      y: 10,
      width: w,
      height: h,
      style: { ...HOLLOW, strokeWidth },
      zIndex: 1,
      type: 'line',
      points: [
        { x: 0, y: 0 },
        { x: w, y: h },
      ],
    });

  it('hits near the segment and misses away from it', () => {
    const el = line(100, 0);
    expect(hitTestElement(el, at(60, 10), 1)).toBe(true);
    expect(hitTestElement(el, at(60, 30), 1)).toBe(false);
  });

  it('does not hit past the ends', () => {
    // `distanceToSegment` clamps to the segment rather than measuring to the
    // infinite line. Without the clamp, a short line is clickable from a mile
    // away along its own direction.
    const el = line(100, 0);
    expect(hitTestElement(el, at(200, 10), 1)).toBe(false);
  });

  it('widens the tolerance by half the stroke width', () => {
    // A 20-unit-thick line is visually 10 units either side of its path, so a
    // click 8 units off must land even with a tolerance of 1.
    const thin = line(100, 0, 1);
    const thick = line(100, 0, 20);
    expect(hitTestElement(thin, at(50, 18), 1)).toBe(false);
    expect(hitTestElement(thick, at(50, 18), 1)).toBe(true);
  });

  it('follows every segment of a freehand stroke', () => {
    const stroke = newFreedraw({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      style: { ...HOLLOW, strokeWidth: 2 },
      zIndex: 1,
      points: [
        { x: 0, y: 0 },
        { x: 50, y: 100 },
        { x: 100, y: 0 },
      ],
      pressures: [0.5, 0.5, 0.5],
      simulatePressure: false,
    });

    expect(hitTestElement(stroke, at(25, 50), 2)).toBe(true); // on the down stroke
    expect(hitTestElement(stroke, at(75, 50), 2)).toBe(true); // on the up stroke
    expect(hitTestElement(stroke, at(50, 20), 2)).toBe(false); // in the V, on nothing
  });
});

describe('the tolerance is in scene units', () => {
  it('is what makes a line equally clickable at every zoom', () => {
    // The caller computes `px / zoom`. Simulating two zoom levels: at 10% zoom a
    // 10px slop is 100 scene units, and at 1000% it is 1. The same off-by-30
    // click hits in the first and misses in the second — which is correct, and
    // is what "constant on screen" means.
    const el = newLinear({
      x: 0,
      y: 0,
      width: 200,
      height: 0,
      style: { ...HOLLOW, strokeWidth: 1 },
      zIndex: 1,
      type: 'line',
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
      ],
    });

    expect(hitTestElement(el, at(100, 30), 10 / 0.1)).toBe(true);
    expect(hitTestElement(el, at(100, 30), 10 / 10)).toBe(false);
  });
});

describe('box selection', () => {
  const box = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
    minX,
    minY,
    maxX,
    maxY,
  });

  it('selects on intersection, not containment', () => {
    // Dragging a marquee that clips a corner selects the shape. Requiring full
    // containment would mean "select everything over here" needs a marquee
    // bigger than the screen, which on an infinite canvas is a real problem.
    const el: Element = rect(true);
    expect(hitTestBox(el, box(-10, -10, 10, 10))).toBe(true);
    expect(hitTestBox(el, box(200, 200, 300, 300))).toBe(false);
  });

  it('uses rotated bounds, so a rotated shape is caught where it looks', () => {
    const el = rect(true, TAU / 4); // occupies roughly x ∈ [20,80], y ∈ [-20,80]
    expect(hitTestBox(el, box(40, -15, 60, -5))).toBe(true);
    // Inside the un-rotated box but outside the rotated one.
    expect(hitTestBox(el, box(90, 25, 99, 35))).toBe(false);
  });
});
