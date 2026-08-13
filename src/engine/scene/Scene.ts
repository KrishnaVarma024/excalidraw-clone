/**
 * The element store.
 *
 * Canvas is an immediate-mode API: you issue draw commands, pixels land, and
 * the canvas immediately forgets. There is no rectangle object anywhere in the
 * browser — only pixels arranged like one. So **we** have to keep the scene
 * graph, and this is it.
 *
 * ── The one invariant ───────────────────────────────────────────────────────
 *
 *   Every write to an element goes through `mutate()`, which bumps `version`.
 *
 * That single rule is what makes the render cache in `roughCache.ts` provably
 * correct rather than hopefully correct, and in Phase 4 it is what keeps the
 * spatial index from silently drifting out of sync with reality. Elements are
 * handed out as `Readonly<Element>` so that writing to one directly is a
 * compile error rather than a subtle bug.
 *
 * ── Storage ────────────────────────────────────────────────────────────────
 *
 * A `Map` keyed by id, not an array. Lookup by id is the common operation
 * (hit-testing returns ids, history references ids, Phase 7's text binds to a
 * container id), and z-order lives in a numeric field rather than in array
 * position — so reordering does not invalidate anything.
 *
 * The z-sorted list is cached and invalidated by a dirty flag, because sorting
 * on every frame at 50,000 elements is 50,000·log(50,000) ≈ 800k comparisons
 * for a list that usually has not changed.
 */

import type { Bounds } from '../util/geometry';
import { boundsIntersect } from '../util/geometry';
import { getRenderBounds } from './bounds';
import type { Element, ElementId } from './element.types';

/** What changed, so the renderer can decide what to repaint. */
export interface SceneChange {
  readonly id: ElementId;
  /** Pixels the element could touch *before* the change. */
  readonly before: Bounds | null;
  /** Pixels it can touch *after*. Null when it was removed from the scene. */
  readonly after: Bounds | null;
}

export type SceneListener = (change: SceneChange) => void;

/**
 * Fields that may never be patched.
 *
 * `id` and `seed` are identity — changing either would silently create a
 * different element wearing the same name, and would invalidate every cache and
 * history entry pointing at it. `version` is owned by `mutate` itself; letting
 * callers set it would break the cache-key invariant this whole class exists to
 * maintain.
 */
export type ElementPatch = Partial<Omit<Element, 'id' | 'seed' | 'version' | 'type'>>;

/** Work performed by a spatial query. See `Scene.queryStats`. */
export interface QueryStats {
  /** Elements examined. Under a linear scan this equals the live element count. */
  readonly tested: number;
  /** Elements returned. `returned / tested` is the selectivity of the query. */
  readonly returned: number;
}

export class Scene {
  private readonly elements = new Map<ElementId, Element>();
  private readonly listeners = new Set<SceneListener>();

  /** Lazily rebuilt z-sorted view of non-deleted elements. */
  private sortedCache: Element[] | null = null;
  private maxZ = 0;

  private lastQuery: QueryStats = { tested: 0, returned: 0 };

  /* ── reading ────────────────────────────────────────────────────────────── */

  get size(): number {
    return this.elements.size;
  }

  /** Count excluding soft-deleted elements — what the UI should show. */
  get visibleCount(): number {
    return this.sorted().length;
  }

  get(id: ElementId): Readonly<Element> | undefined {
    return this.elements.get(id);
  }

  /** Every live element, in ascending z-order (painter's algorithm). */
  sorted(): readonly Element[] {
    if (this.sortedCache === null) {
      this.sortedCache = [...this.elements.values()]
        .filter((el) => !el.isDeleted)
        .sort((a, b) => a.zIndex - b.zIndex);
    }
    return this.sortedCache;
  }

  /**
   * Live elements whose render bounds intersect `view`, in z-order.
   *
   * This is **viewport culling**, and it is the reason frame cost tracks what is
   * on screen rather than what exists. Drawing 50,000 elements when 40 are
   * visible is the difference between 800 ms and 2 ms.
   *
   * It is O(n) — a bounds test per element, every frame. That is fine at a few
   * thousand and is exactly the cost Phase 4's quadtree replaces with an
   * O(log n) range query. Phase 3 measures the crossover rather than guessing
   * it.
   */
  visible(view: Bounds): readonly Element[] {
    const all = this.sorted();
    const out: Element[] = [];
    for (const el of all) {
      if (boundsIntersect(getRenderBounds(el), view)) out.push(el);
    }

    this.lastQuery = { tested: all.length, returned: out.length };
    return out;
  }

  /**
   * Work done by the last `visible()` call.
   *
   * `tested` is the number of elements examined, and counting it rather than
   * timing it is the point.
   *
   * A test that asserts "the cull got faster" by measuring wall-clock time is
   * flaky in CI and says nothing about complexity — a loaded machine can make
   * O(log n) look worse than O(n). A test that asserts *how many elements were
   * examined* proves the complexity class directly and gives the same answer on
   * every machine.
   *
   * Right now `tested` equals the live element count on every frame, which is
   * the definition of a linear scan. Phase 4's quadtree makes it grow
   * logarithmically, and the very same assertion goes from documenting the
   * problem to proving the fix.
   */
  get queryStats(): Readonly<QueryStats> {
    return this.lastQuery;
  }

  /* ── writing ────────────────────────────────────────────────────────────── */

  /** Next z-index for a newly created element: on top of everything. */
  nextZIndex(): number {
    return this.maxZ + 1;
  }

  add(element: Element): void {
    if (this.elements.has(element.id)) {
      throw new Error(`Scene already contains an element with id ${element.id}`);
    }
    this.elements.set(element.id, element);
    this.maxZ = Math.max(this.maxZ, element.zIndex);
    this.sortedCache = null;
    this.emit({ id: element.id, before: null, after: getRenderBounds(element) });
  }

  /**
   * The only way to change an element.
   *
   * Captures the bounds before and after, bumps `version`, and reports both. The
   * "before" half is not decoration: a moved element dirties **two** rectangles,
   * the place it left and the place it arrived. Forget the first and Phase 5
   * smears the shape across the canvas — the classic dirty-rect bug.
   *
   * Returns `false` when nothing changed, so callers can skip a repaint. A
   * mutator that reports change for a no-op means the canvas repaints forever at
   * 60fps while idle.
   */
  mutate(id: ElementId, patch: ElementPatch): boolean {
    const current = this.elements.get(id);
    if (current === undefined) return false;

    // `as unknown as` because `Element` is a discriminated union of interfaces
    // with no index signature — TypeScript will not narrow a dynamic key access
    // on it, and there is no way to express "any own property" for a union.
    // The double assertion is the honest spelling of "I am doing a dynamic
    // lookup and I know the compiler cannot help me here".
    const before = current as unknown as Record<string, unknown>;

    let changed = false;
    for (const key of Object.keys(patch) as (keyof ElementPatch)[]) {
      const next = patch[key];
      if (next !== undefined && !Object.is(before[key], next)) {
        changed = true;
        break;
      }
    }
    if (!changed) return false;

    const beforeBounds = getRenderBounds(current);
    const updated = { ...current, ...patch, version: current.version + 1 } as Element;

    this.elements.set(id, updated);
    if (patch.zIndex !== undefined) {
      this.maxZ = Math.max(this.maxZ, updated.zIndex);
      this.sortedCache = null;
    }
    if (patch.isDeleted !== undefined) this.sortedCache = null;

    this.emit({ id, before: beforeBounds, after: updated.isDeleted ? null : getRenderBounds(updated) });
    return true;
  }

  /** Soft delete. Reversible by patching `isDeleted` back to false. */
  remove(id: ElementId): boolean {
    return this.mutate(id, { isDeleted: true });
  }

  /** Soft-delete everything. One notification per element. */
  clear(): void {
    for (const id of this.elements.keys()) this.remove(id);
  }

  /**
   * Physically drop soft-deleted elements.
   *
   * Only safe once nothing references them — no history entry, no selection, no
   * bound text. Called at save/export time, never during editing. Until Phase 8
   * exists there is nothing to reference them, but the guard belongs with the
   * method rather than in a comment somewhere else.
   */
  compact(): number {
    let dropped = 0;
    for (const [id, el] of this.elements) {
      if (el.isDeleted) {
        this.elements.delete(id);
        dropped++;
      }
    }
    if (dropped > 0) this.sortedCache = null;
    return dropped;
  }

  /** Replace the entire scene. Used by load (Phase 8) and tests. */
  load(elements: readonly Element[]): void {
    this.elements.clear();
    this.maxZ = 0;
    for (const el of elements) {
      this.elements.set(el.id, el);
      this.maxZ = Math.max(this.maxZ, el.zIndex);
    }
    this.sortedCache = null;
    this.emit({ id: '', before: null, after: null });
  }

  /* ── notification ───────────────────────────────────────────────────────── */

  subscribe(listener: SceneListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: SceneChange): void {
    for (const l of this.listeners) l(change);
  }
}
