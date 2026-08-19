/**
 * Element bounds.
 *
 * There are **three** different rectangles you can ask an element for, and
 * conflating them is the root cause of most dirty-rectangle bugs in Phase 5.
 * Naming them apart now, before there is a dirty-rect renderer to get wrong, is
 * cheaper than debugging ghost pixels later.
 *
 *   getGeometryBounds  the un-rotated {x, y, width, height} box. What the user
 *                      thinks the shape "is". Used for resize handles.
 *
 *   getRotatedBounds   the axis-aligned box containing the *rotated* shape.
 *                      Larger than the geometry box for any angle ≠ 0. This is
 *                      what the spatial index must store (Phase 4).
 *
 *   getRenderBounds    the rotated box, padded by everything that draws outside
 *                      the path: half the stroke width, Rough.js's jitter, and
 *                      one pixel of antialiasing. This is what the dirty-rect
 *                      tracker must use (Phase 5).
 *
 * Under-pad the last one by a single pixel and you leave a faint ghost line
 * behind a moving shape. It is the bug everyone hits, and it is invisible until
 * you look closely at a light background.
 */

import {
  type Bounds,
  boundsFromRect,
  expandBounds,
  rotatePoint,
  unionAllBounds,
} from '../util/geometry';
import { type Element, isPointBased } from './element.types';

/** The un-rotated box, in scene space. */
export function getGeometryBounds(el: Element): Bounds {
  return boundsFromRect(el.x, el.y, el.width, el.height);
}

export function getElementCenter(el: Element): { x: number; y: number } {
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
}

/**
 * Axis-aligned box containing the rotated shape.
 *
 * Computed by rotating the four corners and taking min/max. For a long thin
 * rectangle at 45° this is dramatically larger than the geometry box — a
 * 300×10 rectangle rotated 45° has an AABB of roughly 220×220, about five times
 * the pixel area of the shape itself.
 *
 * That is correct and conservative, and it is a real cost in Phase 5: a handful
 * of rotated elements can dirty most of the screen. The alternatives are to
 * clip to a rotated path (much slower in canvas) or to split into several
 * tighter rectangles. The right v1 answer is to accept it and let the
 * full-repaint escape hatch catch the pathological case — but *knowing* that is
 * the trade rather than being surprised by it is the point of this comment.
 */
export function getRotatedBounds(el: Element): Bounds {
  const geometry = getGeometryBounds(el);
  if (el.angle === 0) return geometry;

  const c = getElementCenter(el);
  const corners = [
    { x: geometry.minX, y: geometry.minY },
    { x: geometry.maxX, y: geometry.minY },
    { x: geometry.maxX, y: geometry.maxY },
    { x: geometry.minX, y: geometry.maxY },
  ].map((p) => rotatePoint(p, c, el.angle));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of corners) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * How far outside its path an element actually paints, in scene units.
 *
 *   strokeWidth / 2   a stroke straddles the path, half on each side
 *   roughness * 2     Rough.js displaces points outward by roughly this much
 *   1                 antialiasing bleeds about a pixel
 *
 * Freehand strokes get extra: perfect-freehand builds an outline whose width
 * scales with the stroke width, so the outline itself can sit a full stroke
 * width outside the recorded points.
 */
export function getRenderPadding(el: Element): number {
  /* Text is not drawn by Rough.js and is not stroked, so neither the jitter nor
     the stroke-width terms apply. What it does need is headroom for glyphs that
     paint outside the line box: an accented capital reaches above the font's
     declared ascent, and a descender on the last line reaches below its descent.
     `TextMetrics.actualBoundingBox*` would give the exact answer per string, and
     asking for it here would put a measurement back inside the cull — which is
     precisely what this phase went to some trouble to avoid.

     A fraction of the font size is generous enough for Latin, cheap, and errs
     outward. Over-padding a dirty rectangle costs a few wasted pixels; under-
     padding it leaves a permanent ghost of a descender on the canvas. */
  if (el.type === 'text') return el.fontSize * 0.25 + 1;

  const stroke = el.strokeWidth / 2;
  const jitter = el.roughness * 2;
  const freehand = el.type === 'freedraw' ? el.strokeWidth : 0;
  return stroke + jitter + freehand + 1;
}

/**
 * The rectangle of pixels this element can touch. The dirty rect.
 *
 * ── Memoised, and this is the highest-leverage line in the renderer ─────────
 *
 * Phase 4a set out to explain a 264× speedup and found the arithmetic did not
 * work: 16× fewer elements examined cannot make a cull 264× faster. Measuring
 * the inner loop instead of assuming it:
 *
 *     50,000 × getRenderBounds + intersect     17.7 ms
 *     50,000 × intersect only (precomputed)     1.8 ms
 *
 * **About 90% of that cull was this function, not the comparison.** It rotates
 * four corners for anything with an angle and, for freehand, has already walked
 * a point list to get there. Phase 4a's index hid the cost by storing bounds at
 * insert time; the `scan` path and the dirty-rect pipeline still pay it, over
 * and over, for elements that have not changed.
 *
 * ── Why a WeakMap keyed on the element object ──────────────────────────────
 *
 * `Scene.mutate` never edits an element in place — it replaces the object and
 * bumps `version`. So object identity *is* the cache key, and it is a perfect
 * one: a changed element is a different object and misses the cache
 * automatically. No `id:version` string to build, no invalidation to forget, and
 * a `WeakMap` lets a dropped element take its entry with it rather than leaking.
 *
 * This is the same invariant `roughCache` relies on, spent a second time. It is
 * worth noticing how much a single enforced rule — *one mutator, always a new
 * object* — has paid for by now.
 */
const renderBoundsCache = new WeakMap<Element, Bounds>();

export function getRenderBounds(el: Element): Bounds {
  const cached = renderBoundsCache.get(el);
  if (cached !== undefined) return cached;

  const bounds = expandBounds(getRotatedBounds(el), getRenderPadding(el));
  renderBoundsCache.set(el, bounds);
  return bounds;
}

/**
 * Bounds of a point list, in the element's own local space.
 *
 * Lines and freehand strokes store points relative to `(x, y)`, so their true
 * extent is not `width`/`height` until those have been recomputed. Used when
 * committing a stroke.
 */
export function getPointsBounds(points: readonly { x: number; y: number }[]): Bounds | null {
  return unionAllBounds(
    points.map((p) => ({ minX: p.x, minY: p.y, maxX: p.x, maxY: p.y })),
  );
}

/**
 * Recompute `width`/`height` from a point-based element's points.
 *
 * After a freehand stroke or a line is drawn, `width`/`height` must describe the
 * actual extent, or bounds-based culling and hit-testing are wrong. Returns the
 * patch rather than mutating, so it goes through `Scene.mutate` like everything
 * else.
 */
export function measurePointBased(
  el: Element,
): { x: number; y: number; width: number; height: number; points: readonly { x: number; y: number }[] } | null {
  if (!isPointBased(el)) return null;

  const b = getPointsBounds(el.points);
  if (b === null) return null;

  // Re-anchor so points[0] is not required to be the top-left: shift the origin
  // to the true minimum and rebase every point against it. Without this, a
  // stroke drawn up-and-left has negative local coordinates and its bounds do
  // not match its `x`/`y`.
  const dx = b.minX;
  const dy = b.minY;

  return {
    x: el.x + dx,
    y: el.y + dy,
    width: b.maxX - b.minX,
    height: b.maxY - b.minY,
    points: dx === 0 && dy === 0 ? el.points : el.points.map((p) => ({ x: p.x - dx, y: p.y - dy })),
  };
}

/** Union of every element's render bounds. Used by "fit to content" and export. */
export function getSceneBounds(elements: readonly Element[]): Bounds | null {
  return unionAllBounds(elements.map(getRenderBounds));
}
