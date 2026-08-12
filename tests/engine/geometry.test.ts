import { describe, expect, it } from 'vitest';
import {
  type Bounds,
  boundsArea,
  boundsCenter,
  boundsContains,
  boundsContainsPoint,
  boundsFromRect,
  boundsHeight,
  boundsIntersect,
  boundsWidth,
  expandBounds,
  rotatePoint,
  snapBoundsOutward,
  unionAllBounds,
  unionBounds,
} from '@engine/util/geometry';
import { approxEq } from '@engine/util/math';

const b = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

describe('boundsFromRect', () => {
  it('handles a normal rectangle', () => {
    expect(boundsFromRect(10, 20, 30, 40)).toEqual(b(10, 20, 40, 60));
  });

  it('normalises negative width and height', () => {
    // This is the up-and-left drag case. Every shape tool produces it, and
    // normalising here means nothing downstream ever has to think about it.
    expect(boundsFromRect(40, 60, -30, -40)).toEqual(b(10, 20, 40, 60));
  });

  it('accepts a zero-sized rect — a point is valid bounds', () => {
    expect(boundsFromRect(5, 5, 0, 0)).toEqual(b(5, 5, 5, 5));
  });
});

describe('measurements', () => {
  it('computes width, height, area and centre', () => {
    const r = b(0, 0, 10, 20);
    expect(boundsWidth(r)).toBe(10);
    expect(boundsHeight(r)).toBe(20);
    expect(boundsArea(r)).toBe(200);
    expect(boundsCenter(r)).toEqual({ x: 5, y: 10 });
  });

  it('reports zero area for a degenerate rect', () => {
    expect(boundsArea(b(3, 3, 3, 9))).toBe(0);
  });
});

describe('boundsIntersect', () => {
  it('detects overlap', () => {
    expect(boundsIntersect(b(0, 0, 10, 10), b(5, 5, 15, 15))).toBe(true);
  });

  it('rejects disjoint boxes on each axis independently', () => {
    expect(boundsIntersect(b(0, 0, 10, 10), b(20, 0, 30, 10))).toBe(false);
    expect(boundsIntersect(b(0, 0, 10, 10), b(0, 20, 10, 30))).toBe(false);
  });

  it('treats edge contact as intersecting', () => {
    // Conservative on purpose. A false positive costs one narrow-phase test;
    // a false negative is an element you cannot click.
    expect(boundsIntersect(b(0, 0, 10, 10), b(10, 10, 20, 20))).toBe(true);
  });

  it('is symmetric', () => {
    const x = b(0, 0, 10, 10);
    const y = b(5, 5, 30, 30);
    expect(boundsIntersect(x, y)).toBe(boundsIntersect(y, x));
  });
});

describe('boundsContains', () => {
  it('detects full containment', () => {
    expect(boundsContains(b(0, 0, 100, 100), b(10, 10, 20, 20))).toBe(true);
  });

  it('rejects partial overlap — the quadtree straddling case', () => {
    // An item that only partially fits must stay in the parent node rather
    // than being pushed into a child. See ARCHITECTURE §5.2.
    expect(boundsContains(b(0, 0, 100, 100), b(90, 90, 110, 110))).toBe(false);
  });

  it('counts a box as containing itself', () => {
    const x = b(1, 2, 3, 4);
    expect(boundsContains(x, x)).toBe(true);
  });
});

describe('boundsContainsPoint', () => {
  it('includes the boundary', () => {
    const r = b(0, 0, 10, 10);
    expect(boundsContainsPoint(r, { x: 5, y: 5 })).toBe(true);
    expect(boundsContainsPoint(r, { x: 0, y: 0 })).toBe(true);
    expect(boundsContainsPoint(r, { x: 10, y: 10 })).toBe(true);
    expect(boundsContainsPoint(r, { x: 10.001, y: 5 })).toBe(false);
  });
});

describe('unionBounds / unionAllBounds', () => {
  it('produces the smallest enclosing box', () => {
    expect(unionBounds(b(0, 0, 10, 10), b(20, 5, 30, 40))).toEqual(b(0, 0, 30, 40));
  });

  it('is idempotent', () => {
    const x = b(1, 2, 3, 4);
    expect(unionBounds(x, x)).toEqual(x);
  });

  it('returns null for an empty list rather than an inverted rectangle', () => {
    // Sentinel bounds like {minX: +Infinity, ...} are a classic source of
    // NaN propagation into the transform. `null` forces the caller to decide.
    expect(unionAllBounds([])).toBeNull();
  });

  it('folds a list', () => {
    expect(unionAllBounds([b(0, 0, 1, 1), b(5, 5, 6, 6), b(-2, 3, -1, 4)])).toEqual(
      b(-2, 0, 6, 6),
    );
  });
});

describe('expandBounds', () => {
  it('grows on all four sides', () => {
    expect(expandBounds(b(10, 10, 20, 20), 5)).toEqual(b(5, 5, 25, 25));
  });

  it('shrinks with a negative pad', () => {
    expect(expandBounds(b(10, 10, 20, 20), -2)).toEqual(b(12, 12, 18, 18));
  });
});

describe('snapBoundsOutward', () => {
  it('floors the minimum and ceils the maximum', () => {
    expect(snapBoundsOutward(b(2.3, 2.7, 9.1, 9.9))).toEqual(b(2, 2, 10, 10));
  });

  it('never shrinks the box — the seam-bug guarantee', () => {
    const r = b(2.3, 2.7, 9.1, 9.9);
    const s = snapBoundsOutward(r);
    expect(s.minX).toBeLessThanOrEqual(r.minX);
    expect(s.minY).toBeLessThanOrEqual(r.minY);
    expect(s.maxX).toBeGreaterThanOrEqual(r.maxX);
    expect(s.maxY).toBeGreaterThanOrEqual(r.maxY);
  });

  it('leaves already-integral bounds untouched', () => {
    expect(snapBoundsOutward(b(2, 2, 10, 10))).toEqual(b(2, 2, 10, 10));
  });
});

describe('rotatePoint', () => {
  const origin = { x: 0, y: 0 };

  it('returns the identical object for a zero angle (fast path)', () => {
    const p = { x: 3, y: 4 };
    expect(rotatePoint(p, origin, 0)).toBe(p);
  });

  it('rotates 90° clockwise in screen space (y grows downward)', () => {
    const r = rotatePoint({ x: 1, y: 0 }, origin, Math.PI / 2);
    expect(approxEq(r.x, 0)).toBe(true);
    expect(approxEq(r.y, 1)).toBe(true);
  });

  it('rotates about an arbitrary origin', () => {
    const r = rotatePoint({ x: 11, y: 10 }, { x: 10, y: 10 }, Math.PI);
    expect(approxEq(r.x, 9)).toBe(true);
    expect(approxEq(r.y, 10)).toBe(true);
  });

  it('preserves distance from the origin', () => {
    const p = { x: 3, y: 4 };
    for (const a of [0.1, 1, 2.5, -0.7, 6]) {
      const r = rotatePoint(p, origin, a);
      expect(approxEq(Math.hypot(r.x, r.y), 5, 1e-12)).toBe(true);
    }
  });

  it('inverts exactly — the hit-test round-trip that Phase 4 depends on', () => {
    // Hit-testing a rotated element rotates the *query point* by -angle into
    // the element's local frame. If that round-trip is not tight, clicks near
    // an edge land on the wrong side. ARCHITECTURE §5.5.
    const p = { x: 137.5, y: -42.25 };
    const o = { x: 10, y: 20 };
    for (const a of [0.3, 1.1, 2.9, -1.7, 5.5]) {
      const back = rotatePoint(rotatePoint(p, o, a), o, -a);
      expect(approxEq(back.x, p.x, 1e-9)).toBe(true);
      expect(approxEq(back.y, p.y, 1e-9)).toBe(true);
    }
  });
});
