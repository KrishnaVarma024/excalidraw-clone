import { describe, expect, it } from 'vitest';
import { distanceToSegment, simplifyPoints, simplifyStroke } from '@engine/util/simplify';
import { approxEq, makeRandom } from '@engine/util/math';
import type { Point } from '@engine/util/geometry';

const p = (x: number, y: number): Point => ({ x, y });

describe('distanceToSegment', () => {
  const a = p(0, 0);
  const b = p(10, 0);

  it('measures perpendicular distance for a point beside the segment', () => {
    expect(approxEq(distanceToSegment(p(5, 3), a, b), 3)).toBe(true);
  });

  it('returns 0 for a point on the segment', () => {
    expect(approxEq(distanceToSegment(p(5, 0), a, b), 0)).toBe(true);
  });

  /**
   * The clamp is the whole difference between "segment" and "infinite line",
   * and skipping it is the classic bug. A point beyond an endpoint must measure
   * to that endpoint. Without the clamp it measures to an imaginary extension
   * of the line, which makes points near a sharp corner look redundant — so RDP
   * discards them and the corner rounds off.
   */
  it('clamps at the endpoints rather than measuring to an infinite line', () => {
    expect(approxEq(distanceToSegment(p(-3, 4), a, b), 5)).toBe(true); // to (0,0)
    expect(approxEq(distanceToSegment(p(13, 4), a, b), 5)).toBe(true); // to (10,0)
    // The unclamped answer would be 4 in both cases.
    expect(distanceToSegment(p(-3, 4), a, b)).toBeGreaterThan(4);
  });

  it('handles a degenerate zero-length segment', () => {
    expect(approxEq(distanceToSegment(p(3, 4), a, a), 5)).toBe(true);
  });
});

describe('simplifyPoints', () => {
  it('collapses a straight line to its endpoints', () => {
    const line = Array.from({ length: 50 }, (_, i) => p(i, 0));
    expect(simplifyPoints(line, 0.5)).toEqual([p(0, 0), p(49, 0)]);
  });

  it('always keeps the first and last point', () => {
    const pts = [p(0, 0), p(5, 0.1), p(10, 0)];
    const out = simplifyPoints(pts, 1);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[2]);
  });

  it('preserves a sharp corner', () => {
    // The point of the algorithm: throw away the filler, keep the shape.
    const pts = [p(0, 0), p(5, 0), p(10, 0), p(10, 5), p(10, 10)];
    const out = simplifyPoints(pts, 0.5);
    expect(out).toContainEqual(p(10, 0));
    expect(out).toHaveLength(3);
  });

  it('removes more points as tolerance rises', () => {
    const rnd = makeRandom(4242);
    const noisy = Array.from({ length: 200 }, (_, i) => p(i, (rnd() - 0.5) * 2));

    const tight = simplifyPoints(noisy, 0.1).length;
    const loose = simplifyPoints(noisy, 2).length;

    expect(loose).toBeLessThan(tight);
    expect(loose).toBeLessThan(noisy.length);
  });

  it('removes most points from a realistic stroke', () => {
    // A smooth arc sampled densely, which is what a real freehand gesture looks
    // like. The headline claim is 75-90% reduction; assert the conservative half.
    const arc = Array.from({ length: 400 }, (_, i) => {
      const t = (i / 399) * Math.PI;
      return p(Math.cos(t) * 200, Math.sin(t) * 200);
    });

    const out = simplifyPoints(arc, 0.6);
    expect(out.length).toBeLessThan(arc.length * 0.25);
    expect(out.length).toBeGreaterThan(4); // but it is still recognisably an arc
  });

  it('keeps every simplified point within tolerance of the original path', () => {
    /**
     * The correctness property, not just "it got smaller". Every discarded
     * point must lie within `tolerance` of the polyline that survives — that is
     * what makes the simplification invisible rather than merely cheap.
     */
    const rnd = makeRandom(77);
    const original = Array.from({ length: 300 }, (_, i) =>
      p(i * 2, Math.sin(i / 12) * 40 + (rnd() - 0.5)),
    );
    const tolerance = 1.5;
    const simplified = simplifyPoints(original, tolerance);

    for (const point of original) {
      let best = Infinity;
      for (let i = 0; i < simplified.length - 1; i++) {
        best = Math.min(best, distanceToSegment(point, simplified[i]!, simplified[i + 1]!));
      }
      expect(best).toBeLessThanOrEqual(tolerance + 1e-9);
    }
  });

  it('is a no-op for degenerate input', () => {
    expect(simplifyPoints([], 1)).toEqual([]);
    expect(simplifyPoints([p(1, 1)], 1)).toEqual([p(1, 1)]);
    expect(simplifyPoints([p(0, 0), p(1, 1)], 1)).toEqual([p(0, 0), p(1, 1)]);
  });

  it('returns a copy when tolerance is zero, not the same array', () => {
    const pts = [p(0, 0), p(1, 1), p(2, 2)];
    const out = simplifyPoints(pts, 0);
    expect(out).toEqual(pts);
    expect(out).not.toBe(pts);
  });

  it('survives a very long stroke without blowing the call stack', () => {
    // The reason the implementation uses an explicit stack rather than
    // recursion. A pathological input could otherwise recurse once per point.
    const rnd = makeRandom(9);
    const huge = Array.from({ length: 20_000 }, (_, i) => p(i, rnd() * 100));
    expect(() => simplifyPoints(huge, 0.5)).not.toThrow();
  });
});

describe('simplifyStroke', () => {
  /**
   * Points and pressures are parallel arrays. Drop a point without dropping its
   * pressure and every subsequent sample is attributed to the wrong position —
   * the stroke's thickness detaches from its shape. Subtle, and very hard to
   * recognise as a bug rather than "the ink looks a bit odd".
   */
  it('keeps points and pressures index-aligned', () => {
    const points = Array.from({ length: 60 }, (_, i) => p(i, 0));
    const pressures = points.map((_, i) => i / 60);

    const out = simplifyStroke(points, pressures, 0.5);

    expect(out.points).toHaveLength(out.pressures.length);
    // Endpoints survive, so their pressures must be the original endpoints'.
    expect(out.pressures[0]).toBe(pressures[0]);
    expect(out.pressures[out.pressures.length - 1]).toBe(pressures[pressures.length - 1]);
  });

  it('carries the correct pressure for each surviving point', () => {
    const points = [p(0, 0), p(5, 0), p(10, 0), p(10, 10)];
    const pressures = [0.1, 0.2, 0.3, 0.4];

    const out = simplifyStroke(points, pressures, 0.5);

    for (let i = 0; i < out.points.length; i++) {
      const originalIndex = points.findIndex(
        (op) => op.x === out.points[i]!.x && op.y === out.points[i]!.y,
      );
      expect(out.pressures[i]).toBe(pressures[originalIndex]);
    }
  });

  it('handles a pressures array shorter than points', () => {
    // Defensive: a stream that dropped a pressure sample should degrade to a
    // neutral 0.5 rather than producing `undefined` inside the stroke geometry,
    // where it becomes NaN and the shape vanishes with no error.
    const out = simplifyStroke([p(0, 0), p(10, 0), p(20, 0)], [0.9], 0.5);
    expect(out.pressures.every((v) => Number.isFinite(v))).toBe(true);
  });
});
