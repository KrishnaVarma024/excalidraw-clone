/**
 * Dirty-rectangle tracking.
 *
 * ── The inversion ───────────────────────────────────────────────────────────
 *
 * Every phase up to now repainted the whole canvas on every frame that changed
 * anything. This file inverts that:
 *
 *   **The screen is already correct. Only repair what changed.**
 *
 * The consequence is that frame cost stops tracking *what is on screen* and
 * starts tracking *what moved*. Dragging one rectangle across a 50,000-element
 * drawing repaints two small rectangles — the place it left and the place it
 * arrived — regardless of how much else is visible.
 *
 * ── This class does not draw ────────────────────────────────────────────────
 *
 * It collects rectangles, merges them, and decides whether the result is worth
 * using. That is deliberately all: it is pure geometry over `Bounds`, so it
 * unit-tests without a canvas, and every interesting decision in it is a number
 * you can assert rather than a pixel you have to look at.
 *
 * ── Knowing when to give up ─────────────────────────────────────────────────
 *
 * The part that separates a working implementation from a demo is not the
 * merging. It is `plan()` returning `full` when the dirty region has grown large
 * enough that clipping and clearing N regions costs more than clearing one.
 *
 * A dirty-rect renderer that never falls back is *slower* than a full repaint
 * for any change that touches most of the screen — and "select all and nudge"
 * is exactly that change. Both thresholds below are measurable, are reported in
 * the stats overlay, and have a test each.
 */

import {
  type Bounds,
  boundsArea,
  boundsIntersect,
  expandBounds,
  unionBounds,
} from '../util/geometry';

/**
 * Merge two rectangles when the union wastes less than 40% extra area.
 *
 * ── Why a ratio and not "do they overlap" ───────────────────────────────────
 *
 * Merging only on overlap leaves you clipping and clearing twice for two rects
 * a pixel apart. Merging always collapses the whole screen into one rectangle
 * the moment anything happens in two corners.
 *
 * The ratio asks the only question that matters: *does the union cost less than
 * the two separate passes?* Each pass has a fixed overhead — `save`, `beginPath`,
 * `clip`, `clearRect`, a spatial query, `restore` — so a little wasted area is
 * cheaper than an extra pass. 1.4 says "up to 40% wasted pixels is worth one
 * fewer clip", which is the trade that overhead implies.
 *
 * It is a heuristic and it is tuned by measurement, not derivation. That is
 * normal for this decision and the number is exported so a test can move it.
 */
export const MERGE_WASTE_RATIO = 1.4;

/**
 * More dirty rectangles than this and the per-rect overhead dominates.
 *
 * Each rect is a clip + a clear + a spatial query. Two dozen of those is already
 * more state-machine churn than one full clear, whatever their combined area.
 */
export const MAX_DIRTY_RECTS = 24;

/**
 * Dirty coverage above this fraction of the viewport → full repaint.
 *
 * Past roughly 60% of the screen, the clipping machinery is pure overhead on top
 * of work you were going to do anyway. Below it, the saving is real and grows as
 * the dirty region shrinks.
 */
export const MAX_DIRTY_COVERAGE = 0.6;

/** What the renderer should do this frame. */
export type RenderPlan =
  /** Nothing changed. Skip the frame entirely. */
  | { readonly kind: 'none' }
  /** Repaint these regions only, in scene space. */
  | { readonly kind: 'partial'; readonly rects: readonly Bounds[]; readonly coverage: number }
  /** Repaint everything. Cheaper than the alternative, or forced. */
  | { readonly kind: 'full'; readonly reason: FullRepaintReason };

export type FullRepaintReason =
  /** Pan, zoom, resize, theme — everything on screen moved or changed. */
  | 'global'
  /** Too many separate regions; per-rect overhead would dominate. */
  | 'count'
  /** The dirty region covers too much of the viewport to be worth clipping. */
  | 'coverage'
  /** First frame, or after a full repaint was forced. */
  | 'initial';

export interface DirtyStats {
  /** Rectangles collected before merging. */
  readonly collected: number;
  /** Rectangles after merging — what the renderer actually clips to. */
  readonly merged: number;
  /** Fraction of the viewport the dirty region covers, 0…1. */
  readonly coverage: number;
  /** Full repaints since the last reset. High during pans, near zero when drawing. */
  readonly fullRepaints: number;
  /** Why the last full repaint happened. Null if the last frame was partial. */
  readonly lastFullReason: FullRepaintReason | null;
}

export class DirtyTracker {
  private rects: Bounds[] = [];
  private collected = 0;

  /** Set by pan, zoom, resize, theme — anything that invalidates the whole surface. */
  private forced: FullRepaintReason | null = 'initial';

  private fullRepaints = 0;
  private lastFullReason: FullRepaintReason | null = 'initial';
  private lastMerged = 0;
  private lastCoverage = 0;

  /* ── collecting ─────────────────────────────────────────────────────────── */

  /**
   * Mark a region as needing repair, in **scene** space.
   *
   * Scene space, not screen, because a rectangle collected during this frame
   * must survive whatever the viewport does before the frame is drawn. Storing
   * screen coordinates means a pan between the mutation and the paint repairs
   * the wrong pixels — a bug that only appears when two things happen in the
   * same frame, which is to say, only under load.
   */
  add(rect: Bounds | null): void {
    if (rect === null) return;
    this.collected++;

    // Above the cap there is no point accumulating: the plan is already going to
    // be a full repaint, and growing the array only costs memory and merge time.
    if (this.rects.length > MAX_DIRTY_RECTS * 2) {
      this.force('count');
      return;
    }
    this.rects.push(rect);
  }

  /**
   * Both halves of a move, in one call.
   *
   * **A moved element dirties two rectangles**: the place it left, which needs
   * erasing, and the place it arrived, which needs painting. Forgetting the
   * first is *the* classic dirty-rect bug — the shape smears a trail across the
   * canvas — and it is easy to forget precisely because the code that has the
   * "after" bounds is the code that just computed them.
   *
   * `Scene.mutate` already reports both, so this exists to make the pairing hard
   * to get wrong at the call site.
   */
  addChange(before: Bounds | null, after: Bounds | null): void {
    this.add(before);
    this.add(after);
  }

  /**
   * Force a full repaint next frame.
   *
   * Some changes are not local, and pretending otherwise is how ghosts appear:
   * a pan moves every pixel, a resize clears the backing store, a theme change
   * repaints the background under everything.
   */
  force(reason: FullRepaintReason): void {
    this.forced = reason;
  }

  get isEmpty(): boolean {
    return this.forced === null && this.rects.length === 0;
  }

  /* ── deciding ───────────────────────────────────────────────────────────── */

  /**
   * Decide what to draw, and clear the collection.
   *
   * `viewport` is the visible scene rectangle, used for the coverage test and to
   * discard changes that happened off screen — repairing pixels nobody can see
   * is pure cost, and at 50,000 elements most changes are off screen.
   */
  plan(viewport: Bounds): RenderPlan {
    // Drain first, unconditionally. Every return path below must leave the
    // tracker empty, and doing it once here beats remembering it in six places —
    // a plan() that returns early without draining silently repairs the same
    // region on every subsequent frame, forever.
    const pending = this.rects;
    const forced = this.forced;
    this.lastCollected = this.collected;
    this.rects = [];
    this.collected = 0;
    this.forced = null;

    if (forced !== null) return this.fullPlan(forced);

    // Clip to the viewport. An element dragged 10,000 units off screen produces
    // two enormous rectangles that would trip the coverage test and force a full
    // repaint of a screen that did not visibly change at all.
    const onScreen: Bounds[] = [];
    for (const r of pending) {
      if (boundsIntersect(r, viewport)) onScreen.push(clampTo(r, viewport));
    }

    if (onScreen.length === 0) return this.nothingPlan();

    const merged = mergeRects(onScreen);
    const viewportArea = boundsArea(viewport);
    const coverage =
      viewportArea <= 0 ? 1 : merged.reduce((sum, r) => sum + boundsArea(r), 0) / viewportArea;

    this.lastMerged = merged.length;
    this.lastCoverage = coverage;

    if (merged.length > MAX_DIRTY_RECTS) return this.fullPlan('count');
    if (coverage > MAX_DIRTY_COVERAGE) return this.fullPlan('coverage');

    this.lastFullReason = null;
    return { kind: 'partial', rects: merged, coverage };
  }

  stats(): DirtyStats {
    return {
      collected: this.lastCollected,
      merged: this.lastMerged,
      coverage: this.lastCoverage,
      fullRepaints: this.fullRepaints,
      lastFullReason: this.lastFullReason,
    };
  }

  resetStats(): void {
    this.fullRepaints = 0;
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  private lastCollected = 0;

  private nothingPlan(): RenderPlan {
    this.lastMerged = 0;
    this.lastCoverage = 0;
    this.lastFullReason = null;
    return { kind: 'none' };
  }

  private fullPlan(reason: FullRepaintReason): RenderPlan {
    this.fullRepaints++;
    this.lastFullReason = reason;
    this.lastCoverage = 1;
    this.lastMerged = 1;
    return { kind: 'full', reason };
  }
}

/* ── geometry ─────────────────────────────────────────────────────────────── */

/** Intersection of `r` with `clip`. Callers must have checked they intersect. */
function clampTo(r: Bounds, clip: Bounds): Bounds {
  return {
    minX: Math.max(r.minX, clip.minX),
    minY: Math.max(r.minY, clip.minY),
    maxX: Math.min(r.maxX, clip.maxX),
    maxY: Math.min(r.maxY, clip.maxY),
  };
}

/**
 * Merge pairwise until nothing else is worth merging.
 *
 * O(n²) per pass, and that is fine *because the list is capped*. `MAX_DIRTY_RECTS`
 * is not only a fallback threshold — it is what keeps this loop bounded. An
 * uncapped list with a quadratic merge is a frame-time cliff waiting for the
 * first user who selects a thousand elements.
 *
 * Repeating until a pass changes nothing matters: merging A with B can bring the
 * result close enough to C that a second pass finds a merge the first could not.
 */
export function mergeRects(input: readonly Bounds[]): Bounds[] {
  let rects = [...input];
  let changed = true;

  while (changed) {
    changed = false;
    const out: Bounds[] = [];

    for (const rect of rects) {
      let current = rect;
      let merged = false;

      for (let i = 0; i < out.length; i++) {
        const other = out[i]!;
        if (worthMerging(current, other)) {
          out[i] = unionBounds(current, other);
          current = out[i]!;
          merged = true;
          changed = true;
          break;
        }
      }

      if (!merged) out.push(current);
    }

    rects = out;
  }

  return rects;
}

/**
 * Is one clip cheaper than two?
 *
 * Overlapping rectangles always merge: repainting the shared pixels twice is
 * both slower and, for anything semi-transparent, visibly wrong.
 */
export function worthMerging(a: Bounds, b: Bounds): boolean {
  if (boundsIntersect(a, b)) return true;
  const combined = boundsArea(a) + boundsArea(b);
  if (combined === 0) return true; // two degenerate points; one clip is plenty
  return boundsArea(unionBounds(a, b)) <= combined * MERGE_WASTE_RATIO;
}

/**
 * Snap outward to whole device pixels.
 *
 * ── The seam bug, and why this is not optional ──────────────────────────────
 *
 * Clipping to `x = 12.3` leaves a hairline of stale pixels at `x = 12`: the clip
 * excludes the fractional part, the clear never touches it, and the old content
 * survives as a one-pixel line that follows your shape around the canvas.
 *
 * Two rules, and the second is the one people get wrong:
 *
 *   1. Always floor the minimum and ceil the maximum — never round.
 *   2. Do it **after** converting to device pixels, not before. At dpr 2, a
 *      scene rectangle snapped to whole scene units still lands on a half device
 *      pixel, and the seam comes straight back.
 *
 * `pad` covers antialiasing bleed at the edges of what was drawn.
 */
export function snapToDevicePixels(deviceRect: Bounds, pad = 1): Bounds {
  const padded = expandBounds(deviceRect, pad);
  return {
    minX: Math.floor(padded.minX),
    minY: Math.floor(padded.minY),
    maxX: Math.ceil(padded.maxX),
    maxY: Math.ceil(padded.maxY),
  };
}
