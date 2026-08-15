/**
 * Narrow-phase hit testing: is this point actually on this shape?
 *
 * ── Where this sits ─────────────────────────────────────────────────────────
 *
 * Hit detection is two phases, and conflating them is why naive editors get
 * slow (ARCHITECTURE §5.5):
 *
 *   broad phase   quadtree, rectangles only, cheap, deliberately over-inclusive.
 *                 Turns 50,000 candidates into about five. Lives in `Scene`.
 *   narrow phase  exact geometry, expensive, run on those five. This file.
 *
 * The split matters because the two have opposite cost profiles. A rectangle
 * overlap test is four comparisons; a point-in-polygon test on a 400-point
 * freehand stroke is not. Running the expensive one 50,000 times is the version
 * that drops frames, and it is what this arrangement exists to avoid.
 *
 * ── Rotation is handled once, generically ───────────────────────────────────
 *
 * Every function below assumes the shape is axis-aligned. `toLocal` moves the
 * *query point* into the element's un-rotated frame first, so a rotated diamond
 * is tested by exactly the same code as an unrotated one.
 *
 * **Never write rotated-shape intersection maths. Rotate the point instead.**
 * One six-line function replaces a rotated variant of every test in this file,
 * and — more importantly — replaces the bugs in them.
 *
 * ── Filled and unfilled are different shapes ────────────────────────────────
 *
 * A hollow rectangle is not a rectangle for the purposes of clicking; it is four
 * line segments. Clicking its middle must miss, because there is nothing there
 * and something behind it should get the click instead. Every test below
 * branches on `isFilled`, and getting that wrong produces the specific
 * frustration of not being able to select a shape underneath an "empty" one.
 *
 * ── The threshold ───────────────────────────────────────────────────────────
 *
 * Callers pass a tolerance in **scene units**, computed as `k / zoom`, so a thin
 * line stays equally easy to click at every zoom level. Passing a constant here
 * would make lines nearly unclickable when zoomed out and give a fat invisible
 * halo when zoomed in.
 */

import { type Bounds, type Point, boundsIntersect, rotatePoint } from '../util/geometry';
import { distanceToSegment } from '../util/simplify';
import { assertNever, type Element, isFilled } from './element.types';
import { getElementCenter, getGeometryBounds, getRotatedBounds } from './bounds';

/**
 * Move `p` into the element's local, un-rotated frame.
 *
 * The workhorse. Rotating by `-angle` about the element's centre puts the point
 * where it would be if the shape had never been rotated, after which every test
 * below can pretend `angle` is zero.
 */
export function toLocal(p: Point, el: Element): Point {
  if (el.angle === 0) return p;
  return rotatePoint(p, getElementCenter(el), -el.angle);
}

/**
 * Is `point` on `el`, within `threshold` scene units?
 *
 * `threshold` widens the shape's *edges* — it is a tolerance for the human, not
 * a property of the geometry.
 */
export function hitTestElement(el: Element, point: Point, threshold: number): boolean {
  const p = toLocal(point, el);

  switch (el.type) {
    case 'rectangle':
      return hitRectangle(el, p, threshold);
    case 'diamond':
      return hitDiamond(el, p, threshold);
    case 'ellipse':
      return hitEllipse(el, p, threshold);
    case 'line':
    case 'arrow':
    case 'freedraw':
      return hitPolyline(el, p, threshold);
    default:
      return assertNever(el, 'hitTestElement');
  }
}

/* ── per-type tests, all assuming angle === 0 ──────────────────────────────── */

function hitRectangle(el: Element, p: Point, threshold: number): boolean {
  const b = getGeometryBounds(el);

  if (isFilled(el)) return insideBounds(b, p, threshold);

  // Hollow: the shape *is* its four edges. Inside the middle is a miss.
  return (
    insideBounds(b, p, threshold) &&
    !insideBounds(b, p, -threshold) // not deep in the interior
  );
}

function hitDiamond(el: Element, p: Point, threshold: number): boolean {
  const b = getGeometryBounds(el);
  const midX = (b.minX + b.maxX) / 2;
  const midY = (b.minY + b.maxY) / 2;

  // The four vertices, in order. Rough.js draws exactly this quadrilateral.
  const vertices: Point[] = [
    { x: midX, y: b.minY },
    { x: b.maxX, y: midY },
    { x: midX, y: b.maxY },
    { x: b.minX, y: midY },
  ];

  const nearEdge = distanceToPolygonEdge(vertices, p) <= threshold;
  if (!isFilled(el)) return nearEdge;
  return nearEdge || pointInPolygon(vertices, p);
}

function hitEllipse(el: Element, p: Point, threshold: number): boolean {
  const b = getGeometryBounds(el);
  const rx = (b.maxX - b.minX) / 2;
  const ry = (b.maxY - b.minY) / 2;

  // Degenerate: a zero-width or zero-height ellipse is a line segment, and the
  // normalised-radius maths below divides by zero. Falling back rather than
  // returning false keeps a flattened ellipse clickable, which is what the user
  // sees on screen.
  if (rx === 0 || ry === 0) {
    return (
      distanceToSegment(p, { x: b.minX, y: (b.minY + b.maxY) / 2 }, { x: b.maxX, y: (b.minY + b.maxY) / 2 }) <=
      threshold
    );
  }

  const dx = (p.x - (b.minX + rx)) / rx;
  const dy = (p.y - (b.minY + ry)) / ry;
  const normalised = Math.sqrt(dx * dx + dy * dy); // 1 exactly on the outline

  if (isFilled(el)) return normalised <= 1 + threshold / Math.min(rx, ry);

  /* Distance to the outline, approximated.
   *
   * `|normalised − 1| · min(rx, ry)` is the exact distance for a circle and an
   * under-estimate for an eccentric ellipse — it is generous near the flat sides
   * and tight near the pointed ends. The exact answer requires solving a quartic
   * (or iterating), which is real work to run on every pointermove.
   *
   * Erring generous is the right direction: an extra pixel of tolerance is
   * invisible, while a shape you cannot click is a bug report. Noted here rather
   * than hidden, because "this is approximate" is a thing a reviewer should be
   * told rather than have to discover. */
  return Math.abs(normalised - 1) * Math.min(rx, ry) <= threshold;
}

/**
 * Lines, arrows and freehand strokes: distance to the polyline.
 *
 * ── Why freehand is not tested against its rendered outline ─────────────────
 *
 * A freehand stroke is drawn as a filled outline polygon built by
 * perfect-freehand, so the strictly correct test is point-in-that-polygon. This
 * does not do that, for two reasons.
 *
 * The polygon does not exist until it is built, and building it means running
 * perfect-freehand — the most expensive operation in the renderer — on every
 * `pointermove`, which is 120–240 times a second. Caching it would mean a second
 * cache keyed by version, invalidated by the same rules as the drawable cache,
 * for a test whose answer differs from this one by less than the stroke's own
 * width.
 *
 * So: distance to the recorded polyline, with the threshold widened by half the
 * stroke width, which is what the outline's half-thickness is. The difference
 * shows up only at sharp corners of very thick strokes, and it errs toward being
 * easier to click.
 */
function hitPolyline(el: Element, p: Point, threshold: number): boolean {
  const points = el.type === 'freedraw' || el.type === 'line' || el.type === 'arrow' ? el.points : [];
  const tolerance = threshold + el.strokeWidth / 2;

  // Points are stored relative to (x, y) — see element.types.ts — so the query
  // point moves into that frame rather than every vertex moving out of it. One
  // subtraction instead of `points.length` additions, on the hot path.
  const local = { x: p.x - el.x, y: p.y - el.y };

  if (points.length === 0) return false;
  if (points.length === 1) {
    const only = points[0]!;
    return Math.hypot(local.x - only.x, local.y - only.y) <= tolerance;
  }

  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(local, points[i - 1]!, points[i]!) <= tolerance) return true;
  }
  return false;
}

/* ── geometry helpers ──────────────────────────────────────────────────────── */

function insideBounds(b: Bounds, p: Point, pad: number): boolean {
  return (
    p.x >= b.minX - pad && p.x <= b.maxX + pad && p.y >= b.minY - pad && p.y <= b.maxY + pad
  );
}

/**
 * Even-odd ray casting.
 *
 * Cast a ray to the right and count crossings; odd means inside. The
 * `(yi > p.y) !== (yj > p.y)` form is the standard way to make a vertex lying
 * exactly on the ray count once rather than twice or zero times — which is
 * precisely the case that makes a naive implementation report "outside" for a
 * point on a diamond's horizontal axis.
 */
function pointInPolygon(vertices: readonly Point[], p: Point): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const a = vertices[i]!;
    const b = vertices[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToPolygonEdge(vertices: readonly Point[], p: Point): number {
  let best = Infinity;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const d = distanceToSegment(p, vertices[j]!, vertices[i]!);
    if (d < best) best = d;
  }
  return best;
}

/* ── box selection ─────────────────────────────────────────────────────────── */

/**
 * Does `el` fall inside a marquee?
 *
 * Uses **intersection**, not containment: dragging a box that clips the corner
 * of a shape selects it. Requiring full containment is the other defensible
 * choice (Illustrator does it, and it is better for precise work), but it makes
 * "select everything roughly over here" require a marquee larger than the screen
 * — and on an infinite canvas that is a real problem rather than a preference.
 *
 * Tested against the rotated box rather than the render box: render bounds
 * include stroke and Rough.js padding, and selecting a shape whose *padding*
 * you touched feels wrong in a way that is hard to name but easy to notice.
 */
export function hitTestBox(el: Element, box: Bounds): boolean {
  return boundsIntersect(getRotatedBounds(el), box);
}
