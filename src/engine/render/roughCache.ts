/**
 * Rough.js drawable cache.
 *
 * ── What Rough.js actually does ─────────────────────────────────────────────
 *
 * `generator.rectangle(...)` does not draw. It returns a `Drawable`: a list of
 * operations describing a hand-drawn-looking path — dozens of bezier segments
 * with pseudo-random displacement, plus hachure lines if the shape is filled.
 * `roughCanvas.draw(drawable)` then replays those ops onto a context.
 *
 * Generating is the expensive half. Replaying is cheap.
 *
 * ── Why the cache is not optional ───────────────────────────────────────────
 *
 * Generation costs roughly 0.1–0.3 ms per shape, more for hachure fills. At
 * 5,000 visible shapes and 60 fps that is 30–90 ms *per frame* of pure garbage
 * creation — an order of magnitude over the entire 16.67 ms budget, before a
 * single pixel is drawn. Caching converts it into a `Map.get`.
 *
 * ── Why the key is `id:version` ─────────────────────────────────────────────
 *
 *   keyed on id alone      → stale the instant the element changes
 *   deep-compare per frame → O(fields) per element per frame, self-defeating
 *   keyed on id:version    → one string compare, and correct by construction
 *
 * "By construction" rests on the invariant that `Scene.mutate()` is the only
 * thing that writes to an element and always bumps `version`. Elements are
 * handed out as `Readonly<Element>`, so violating it is a compile error.
 *
 * ── Eviction ────────────────────────────────────────────────────────────────
 *
 * Drag one shape for ten seconds and it produces ~600 versions, of which
 * exactly one is live. Without eviction the map grows without bound for the
 * lifetime of the tab.
 *
 * The policy here is **drop older versions of the same id on insert**, tracked
 * by a second map from id to its current key. Constant memory per element, no
 * scanning, no timers. The alternatives considered:
 *
 *   - LRU with a size cap: correct, but needs a linked list or repeated map
 *     re-insertion, and the cap is a magic number that is wrong at some scene
 *     size.
 *   - WeakRef + FinalizationRegistry: elegant on paper, but GC timing is
 *     unspecified, so memory use becomes unpredictable and untestable.
 *
 * The failure mode of the chosen policy: nothing evicts entries for elements
 * that are deleted and never touched again. `evictDeleted()` handles that, and
 * the renderer calls it when the scene is cleared.
 */

import rough from 'roughjs';
import type { Drawable, Options } from 'roughjs/bin/core';
import type { RoughGenerator } from 'roughjs/bin/generator';
import type { Element, ElementId } from '../scene/element.types';
import { TRANSPARENT } from '../scene/element.types';
import { assertNever } from '../scene/element.types';

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

export class RoughCache {
  private readonly generator: RoughGenerator = rough.generator();
  private readonly drawables = new Map<string, Drawable>();
  /** id → the key currently live for that id, so we can evict the previous one. */
  private readonly liveKey = new Map<ElementId, string>();

  private hits = 0;
  private misses = 0;

  get(el: Element): Drawable {
    const key = `${el.id}:${el.version}`;

    const cached = this.drawables.get(key);
    if (cached !== undefined) {
      this.hits++;
      return cached;
    }

    this.misses++;
    const drawable = this.generate(el);

    const previous = this.liveKey.get(el.id);
    if (previous !== undefined && previous !== key) this.drawables.delete(previous);

    this.drawables.set(key, drawable);
    this.liveKey.set(el.id, key);
    return drawable;
  }

  /** Drop every entry for these ids. Called when elements leave the scene. */
  evict(ids: Iterable<ElementId>): void {
    for (const id of ids) {
      const key = this.liveKey.get(id);
      if (key !== undefined) {
        this.drawables.delete(key);
        this.liveKey.delete(id);
      }
    }
  }

  clear(): void {
    this.drawables.clear();
    this.liveKey.clear();
  }

  stats(): CacheStats {
    return { hits: this.hits, misses: this.misses, size: this.drawables.size };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
  }

  /* ── generation ─────────────────────────────────────────────────────────── */

  private options(el: Element): Options {
    const filled = el.backgroundColor !== TRANSPARENT;
    const dash = dashPattern(el);

    /* `exactOptionalPropertyTypes` is on, so an optional property cannot be
       *assigned* `undefined` — it must be absent. That distinction is usually
       pedantic and here it is genuinely useful: Rough.js treats a present
       `fill: undefined` differently from an absent `fill` in some code paths,
       and a spread that only adds the key when there is a value makes the
       intent unambiguous rather than relying on library behaviour. */
    return {
      ...(filled ? { fill: el.backgroundColor } : {}),
      ...(dash !== undefined ? { strokeLineDash: dash } : {}),
      // The stored seed is what makes the jitter stable across redraws. Rough.js
      // treats 0 as "no seed, use Math.random", so bias away from it.
      seed: el.seed === 0 ? 1 : el.seed,
      roughness: el.roughness,
      stroke: el.strokeColor,
      strokeWidth: el.strokeWidth,
      fillStyle: el.fillStyle,
      // Scale hachure spacing with stroke width, or a thick stroke on a hachured
      // fill turns into a solid block.
      hachureGap: el.strokeWidth * 4,
      fillWeight: el.strokeWidth / 2,
      // A single pass looks cleaner at small sizes and halves generation cost.
      // Rough.js's default double-stroke reads as "sketchy" at 100% and as
      // "blurry" at 25%.
      disableMultiStroke: el.roughness < 1,
      preserveVertices: true,
    };
  }

  private generate(el: Element): Drawable {
    const o = this.options(el);
    const { width: w, height: h } = el;

    switch (el.type) {
      case 'rectangle':
        // Drawn at the origin: the renderer translates to el.x/el.y and applies
        // rotation, so the drawable itself is position-independent. That means
        // moving an element does not invalidate its drawable — only resizing
        // does. A real saving during a drag.
        return this.generator.rectangle(0, 0, w, h, o);

      case 'diamond':
        return this.generator.polygon(
          [
            [w / 2, 0],
            [w, h / 2],
            [w / 2, h],
            [0, h / 2],
          ],
          o,
        );

      case 'ellipse':
        return this.generator.ellipse(w / 2, h / 2, w, h, o);

      case 'line':
      case 'arrow':
        return this.generator.linearPath(
          el.points.map((p) => [p.x, p.y] as [number, number]),
          o,
        );

      case 'freedraw':
        // Freehand is not drawn by Rough.js at all — perfect-freehand builds a
        // filled outline instead, in drawElement.ts. This branch exists so the
        // switch stays exhaustive; the drawable is never used.
        return this.generator.linearPath([[0, 0]], o);

      default:
        return assertNever(el, 'RoughCache.generate');
    }
  }
}

/**
 * Dash pattern in scene units, scaled by stroke width.
 *
 * A fixed pattern looks right at one stroke width and wrong at every other:
 * 8px dashes on a 1px line read as dashed, on an 8px line as a row of squares.
 */
function dashPattern(el: Element): number[] | undefined {
  switch (el.strokeStyle) {
    case 'dashed':
      return [el.strokeWidth * 4, el.strokeWidth * 3];
    case 'dotted':
      return [el.strokeWidth * 0.5, el.strokeWidth * 2.5];
    case 'solid':
      return undefined;
    default:
      return undefined;
  }
}
