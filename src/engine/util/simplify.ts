/**
 * Polyline simplification — Ramer–Douglas–Peucker.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * A three-second freehand stroke on a 120 Hz trackpad produces 350–700 points.
 * Almost all of them are redundant: a human hand cannot place points that
 * finely, and the extra ones cost you three times over — in the JSON you save,
 * in the outline perfect-freehand has to build every redraw, and in the
 * distance-to-segment loop that hit-tests the stroke in Phase 4.
 *
 * RDP keeps the points that carry the shape and discards the ones that sit on a
 * line between their neighbours. On a typical stroke it removes 75–90% of the
 * points with no visible difference.
 *
 * ── The algorithm ───────────────────────────────────────────────────────────
 *
 * Divide and conquer. Take the segment from the first point to the last, find
 * the point furthest from that line, and:
 *
 *   - if that distance is below the tolerance, every point between them is
 *     within tolerance of the line, so discard them all
 *   - otherwise that point is essential — keep it, and recurse on the two
 *     halves it creates
 *
 * O(n log n) on typical input, O(n²) in the worst case (a shape where the
 * furthest point is always adjacent to an endpoint). With n in the hundreds
 * that is irrelevant, and it runs once on `pointerup` rather than per frame.
 *
 * ── When to run it ──────────────────────────────────────────────────────────
 *
 * On commit, never during the drag. Simplifying live would make the line behind
 * the cursor visibly rewrite itself as you draw, and it would throw away
 * information the *next* moment might have needed.
 */

import type { Point } from './geometry';

/**
 * Perpendicular distance from `p` to the segment `a`–`b`.
 *
 * Note "segment", not "infinite line": the projection parameter `t` is clamped
 * to [0, 1], so a point beyond an endpoint measures to that endpoint rather
 * than to a line stretching off to infinity. Skipping the clamp is the classic
 * bug here — it discards points near a sharp corner, because they look close to
 * the *extension* of the previous segment.
 *
 * Exported because Phase 4's hit-testing of lines and freehand strokes needs
 * exactly this function.
 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;

  // Degenerate segment: a and b are the same point.
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Simplify a polyline, keeping the first and last points.
 *
 * @param tolerance maximum deviation, in **scene units**. Scene rather than
 *   screen so that a stroke simplified at 400% zoom is not silently coarser
 *   than one drawn at 100% — the stored geometry should not depend on how you
 *   happened to be looking at it.
 */
export function simplifyPoints(points: readonly Point[], tolerance: number): Point[] {
  if (points.length <= 2 || tolerance <= 0) return [...points];

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  // Explicit stack rather than recursion: a pathological stroke could otherwise
  // recurse once per point, and blowing the call stack on a long scribble is a
  // silly way to lose someone's drawing.
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const [first, last] = frame;
    if (last <= first + 1) continue;

    const a = points[first]!;
    const b = points[last]!;

    let maxDistance = -1;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(points[i]!, a, b);
      if (d > maxDistance) {
        maxDistance = d;
        maxIndex = i;
      }
    }

    if (maxDistance > tolerance && maxIndex !== -1) {
      keep[maxIndex] = 1;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i] === 1) out.push(points[i]!);
  return out;
}

/**
 * Simplify points and their parallel pressure array together.
 *
 * The two arrays must stay index-aligned — drop a point without dropping its
 * pressure and every subsequent sample is attributed to the wrong position, so
 * the stroke's thickness detaches from its shape. Subtle, and very hard to
 * spot as a bug rather than "the ink looks a bit odd".
 */
export function simplifyStroke(
  points: readonly Point[],
  pressures: readonly number[],
  tolerance: number,
): { points: Point[]; pressures: number[] } {
  if (points.length <= 2 || tolerance <= 0) {
    return { points: [...points], pressures: [...pressures] };
  }

  const simplified = simplifyPoints(points, tolerance);

  // Walk both lists in lockstep. `simplified` is a subsequence of `points` in
  // the same order, so a single forward cursor is enough — no lookup needed.
  const outPressures: number[] = [];
  let cursor = 0;
  for (const p of simplified) {
    while (cursor < points.length && points[cursor] !== p) cursor++;
    outPressures.push(pressures[cursor] ?? 0.5);
    cursor++;
  }

  return { points: simplified, pressures: outPressures };
}
