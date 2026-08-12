/**
 * 2D geometric primitives: points and axis-aligned bounding boxes.
 *
 * `Bounds` is the single most-used type in the codebase. The quadtree stores
 * them, the dirty-rect tracker merges them, the renderer clips to them, and
 * export computes one for the whole scene. It is worth getting the
 * representation right before writing any of that.
 *
 * Representation: `{ minX, minY, maxX, maxY }` rather than `{ x, y, w, h }`.
 *   - intersection and containment are four comparisons with no arithmetic
 *   - union is four min/max calls
 *   - there is no way to express a negative width, so no normalisation step
 *     and no "did I remember to normalise this?" class of bug
 * The `{x, y, w, h}` form is better for *drawing* (it is what `fillRect` wants)
 * and that conversion happens once, at the call site, in `Renderer`.
 *
 * Convention: bounds are **inclusive of both edges** and may be zero-sized
 * (a point is a valid Bounds). Empty bounds are represented by `null`, never
 * by an inverted rectangle.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Build bounds from a top-left corner and a size. Handles negative w/h. */
export function boundsFromRect(x: number, y: number, w: number, h: number): Bounds {
  return {
    minX: w >= 0 ? x : x + w,
    minY: h >= 0 ? y : y + h,
    maxX: w >= 0 ? x + w : x,
    maxY: h >= 0 ? y + h : y,
  };
}

export function boundsWidth(b: Bounds): number {
  return b.maxX - b.minX;
}

export function boundsHeight(b: Bounds): number {
  return b.maxY - b.minY;
}

export function boundsArea(b: Bounds): number {
  return boundsWidth(b) * boundsHeight(b);
}

export function boundsCenter(b: Bounds): Point {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}

/**
 * Do `a` and `b` overlap?
 *
 * Edge-touching counts as intersecting (`>=`, not `>`). That is the
 * conservative choice, and conservative is the only safe direction for both
 * users of this function: a quadtree query that returns one extra candidate
 * costs a cheap narrow-phase test, while one that *misses* a candidate is a
 * shape you cannot click. Likewise a dirty rect that is one pixel too big
 * costs a few pixels; one that is a pixel too small leaves a visible artefact.
 */
export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Does `outer` fully contain `inner`? Used by the quadtree to push items down. */
export function boundsContains(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX &&
    outer.minY <= inner.minY &&
    outer.maxX >= inner.maxX &&
    outer.maxY >= inner.maxY
  );
}

export function boundsContainsPoint(b: Bounds, p: Point): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}

/** Smallest bounds containing both inputs. */
export function unionBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Union of many bounds. Returns `null` for an empty list — see the note above. */
export function unionAllBounds(list: readonly Bounds[]): Bounds | null {
  const first = list[0];
  if (first === undefined) return null;
  let acc = first;
  for (let i = 1; i < list.length; i++) {
    // Safe: i < length. `noUncheckedIndexedAccess` cannot prove that, so we
    // assert rather than branch inside a hot loop.
    acc = unionBounds(acc, list[i]!);
  }
  return acc;
}

/** Grow bounds by `pad` on every side. Negative `pad` shrinks. */
export function expandBounds(b: Bounds, pad: number): Bounds {
  return {
    minX: b.minX - pad,
    minY: b.minY - pad,
    maxX: b.maxX + pad,
    maxY: b.maxY + pad,
  };
}

/**
 * Snap bounds outward to integer coordinates.
 *
 * Used before `clip()` and `clearRect()`. Clipping to a fractional coordinate
 * leaves a hairline of stale pixels along the edge — the "seam" bug from
 * ARCHITECTURE §6.3④. Always floor the minimum and ceil the maximum, and do it
 * *after* converting to device pixels, never before.
 */
export function snapBoundsOutward(b: Bounds): Bounds {
  return {
    minX: Math.floor(b.minX),
    minY: Math.floor(b.minY),
    maxX: Math.ceil(b.maxX),
    maxY: Math.ceil(b.maxY),
  };
}

/**
 * Rotate `p` by `angle` radians about `origin`.
 *
 * The workhorse of every rotation feature in this project. Note that
 * hit-testing a rotated shape uses this with a *negative* angle to move the
 * query point into the element's local frame, rather than rotating the shape —
 * see ARCHITECTURE §5.5.
 */
export function rotatePoint(p: Point, origin: Point, angle: number): Point {
  if (angle === 0) return p;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  return {
    x: dx * cos - dy * sin + origin.x,
    y: dx * sin + dy * cos + origin.y,
  };
}
