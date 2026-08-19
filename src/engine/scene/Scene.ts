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

import type { Bounds, Point } from '../util/geometry';
import { boundsArea, boundsContains, boundsIntersect, unionBounds } from '../util/geometry';
import { QuadTree, type QuadTreeStats } from '../spatial/QuadTree';
import { getRenderBounds, getRotatedBounds } from './bounds';
import { hitTestBox, hitTestElement } from './hitTest';
import type { Element, ElementId } from './element.types';

/** What changed, so the renderer can decide what to repaint. */
export interface SceneChange {
  readonly id: ElementId;
  /** Pixels the element could touch *before* the change. */
  readonly before: Bounds | null;
  /** Pixels it can touch *after*. Null when it was removed from the scene. */
  readonly after: Bounds | null;
  /**
   * The element objects themselves, before and after. Null when it did not
   * exist.
   *
   * ── Why references and not copies ───────────────────────────────────────
   *
   * `mutate` never edits an element in place; it builds a new object. So the
   * "before" object is still intact, still immutable in practice, and handing out
   * a reference to it costs nothing. Phase 8's history stores these references
   * directly — a 400-point freehand stroke dragged for three seconds produces
   * ~180 objects, and history keeps exactly two of them while the other 178 are
   * collected.
   *
   * That is the third feature bought by one rule from Phase 2 — *one mutator,
   * always a new object* — after the Rough drawable cache and the memoised render
   * bounds. Structural sharing for free, with no copy-on-write machinery.
   */
  readonly beforeElement: Element | null;
  readonly afterElement: Element | null;
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

/** Which strategy `Scene.visible` chose. See the comment on that method. */
export type QueryPath =
  /** Everything was visible; the cached sorted array was returned untouched. */
  | 'all'
  /** Linear filter over the sorted array — chosen when most of the scene is on screen. */
  | 'scan'
  /** Quadtree range query — chosen when the viewport is a small window on a big scene. */
  | 'index';

/**
 * View-area ÷ index-root-area at or above which `visible()` scans instead of
 * querying.
 *
 * Not a guess. The two costs are `c₁·n` for the scan and `c₁·tested + c₂·k log k`
 * for the query, so the crossover is wherever `k/n` makes the sort dominate.
 * Measured on the bench at 50,000 elements, that is somewhere around a fifth of
 * the scene on screen; 0.25 sits just past it, biased toward the scan because
 * the scan's cost is flat and predictable while the query's degrades sharply
 * once `k` is large.
 *
 * Exported so `tests/engine/culling.test.ts` can assert against the real number
 * rather than restating it and drifting.
 */
export const SCAN_AREA_RATIO = 0.25;

const EMPTY: readonly Element[] = [];

/** Work performed by a hit test. The broad/narrow split, made countable. */
export interface HitStats {
  /** Candidates the broad phase examined — the quadtree's `tested`. */
  readonly broad: number;
  /** Candidates that survived to an exact geometry test. */
  readonly narrow: number;
  /** Whether anything was hit. */
  readonly hit: boolean;
}

/** Work performed by a spatial query. See `Scene.queryStats`. */
export interface QueryStats {
  /** Elements examined. Under a linear scan this equalled the live element count. */
  readonly tested: number;
  /** Elements returned. `returned / tested` is the selectivity of the query. */
  readonly returned: number;
  /** Quadtree nodes descended into. Zero unless the `index` path ran. */
  readonly nodes: number;
  /**
   * Which strategy ran.
   *
   * Reported rather than inferred, because "the cull got slower" and "the cull
   * took a different path" look identical in a timing and have completely
   * different fixes. Phase 3's lesson, applied one phase later.
   */
  readonly path: QueryPath;
}

export class Scene {
  private readonly elements = new Map<ElementId, Element>();
  private readonly listeners = new Set<SceneListener>();

  /** Lazily rebuilt z-sorted view of non-deleted elements. */
  private sortedCache: Element[] | null = null;

  /**
   * Where each element sits in `sortedCache`. Built with it, discarded with it.
   *
   * This exists because of a bug Phase 4 exposed that had been latent since
   * Phase 2. `mutate` replaces the element object rather than editing it — that
   * is what makes undo cheap — so after a move, `sortedCache` holds a reference
   * to the *old* object. Nothing noticed, because until now there was exactly
   * one way to read the scene and it was consistently stale.
   *
   * Phase 4 added a second path: the index returns ids, which are looked up
   * fresh in `elements`. Suddenly two readers disagreed about where a shape was,
   * and the brute-force oracle in `culling.test.ts` caught it immediately.
   *
   * Rebuilding the sort on every mutation would fix it at O(n log n) per frame
   * of a drag, which is the cost this phase exists to remove. Patching one slot
   * is O(1), which is why the position map is worth its memory.
   */
  private sortedIndex: Map<ElementId, number> | null = null;
  private maxZ = 0;

  /**
   * The spatial index.
   *
   * **A derived cache, never the source of truth.** `elements` is. If the two
   * ever disagree the map wins, and the bug is in whoever forgot to call
   * `index.update`. That is why every write in this class funnels through
   * `add` / `mutate` / `load` / `clear` and nothing else can touch an element.
   *
   * It holds only live elements — soft-deleted ones are removed on delete and
   * re-inserted on undelete, so a query never has to filter.
   */
  private readonly index = new QuadTree();

  /**
   * Union of the render bounds of every element ever inserted. **Grow-only.**
   *
   * Used to pick a strategy in `visible()`. The exact union would have to shrink
   * when an element moves inward, and recomputing it is O(n) — on every frame of
   * a drag, which is the workload this phase exists to make cheap. Growing
   * monotonically costs one `unionBounds` per write and is wrong only in the
   * safe direction: a box that is too big makes `visible()` *miss* a shortcut,
   * never take one it shouldn't. `load()` recomputes it exactly, so opening a
   * file resets the drift.
   */
  private contentBounds: Bounds | null = null;

  private lastQuery: QueryStats = { tested: 0, returned: 0, nodes: 0, path: 'all' };
  private lastHit: HitStats = { broad: 0, narrow: 0, hit: false };

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
      this.sortedIndex = new Map();
      for (let i = 0; i < this.sortedCache.length; i++) {
        this.sortedIndex.set(this.sortedCache[i]!.id, i);
      }
    }
    return this.sortedCache;
  }

  /** Drop the z-order cache. Called when membership or ordering changes. */
  private invalidateSorted(): void {
    this.sortedCache = null;
    this.sortedIndex = null;
  }

  /**
   * Live elements whose render bounds intersect `view`, in z-order.
   *
   * ── Three paths, and two of them exist because a benchmark said so ─────────
   *
   * The naive version of this method is one line — ask the quadtree, sort the
   * answer. It is also a **2.8× regression** at 50,000 elements zoomed out, and
   * the only reason that is written here rather than shipped is that
   * `tests/bench/culling.bench.ts` has measured the zoomed-out case since Phase
   * 3, before any of this existed, precisely so it could not hide.
   *
   * The cost model that explains it:
   *
   *     linear scan   c₁·n                     ordering is free — the array is
   *                                            already sorted and stays sorted
   *     index query   c₁·tested + c₂·k·log k   ordering is NOT free — the tree
   *                                            returns tree order, not z-order
   *
   * When `k` (what is on screen) is a small fraction of `n`, the query wins by
   * two orders of magnitude. When `k` approaches `n`, `k log k` is strictly
   * worse than the `n` it replaced — at 50,000 elements the sort alone is
   * ~18 ms, which is a whole frame. **The quadtree is not faster. It is faster
   * for one shape of query**, and shipping it unconditionally trades a win you
   * measured for a loss you didn't.
   *
   * So the path is chosen per call:
   *
   *   `all`   — the view contains the index's root rectangle, so everything is
   *             visible by construction. Return the cached sorted array: no
   *             bounds tests, no tree walk, no sort. `tested` is honestly 0.
   *   `scan`  — the view covers a large fraction of the indexed area, so `k` will
   *             be close to `n`. Filter the sorted array: O(n) and z-ordered for
   *             free. This is Phase 3's code, kept deliberately.
   *   `index` — otherwise. Query, map, sort.
   *
   * ── Why the ratio is measured against the index root, not the content ──────
   *
   * The honest proxy for `k/n` is view-area over *content*-area. Maintaining
   * exact content bounds means a union that has to shrink when an element moves
   * inward, which is O(n) to recompute — and it would be recomputed on every
   * frame of a drag, which is precisely the workload this phase exists to make
   * cheap. Root bounds are already maintained, only ever grow, and are never
   * smaller than the content. Using them can only cause the `scan` path to be
   * *missed*, never wrongly taken, and the failure mode costs one sort rather
   * than a wrong answer.
   */
  visible(view: Bounds): readonly Element[] {
    const content = this.contentBounds;
    if (content === null) {
      this.lastQuery = { tested: 0, returned: 0, nodes: 0, path: 'all' };
      return EMPTY;
    }

    if (boundsContains(view, content)) {
      const all = this.sorted();
      this.lastQuery = { tested: 0, returned: all.length, nodes: 0, path: 'all' };
      return all;
    }

    if (boundsArea(view) >= boundsArea(content) * SCAN_AREA_RATIO) {
      const all = this.sorted();
      const out: Element[] = [];
      for (const el of all) {
        if (boundsIntersect(getRenderBounds(el), view)) out.push(el);
      }
      this.lastQuery = { tested: all.length, returned: out.length, nodes: 0, path: 'scan' };
      return out;
    }

    const entries = this.index.query(view);
    const out: Element[] = [];
    for (const entry of entries) {
      const el = this.elements.get(entry.id);
      // `undefined` would mean the index has drifted from the map. It cannot
      // happen through this class's API, and skipping is the right response if
      // it somehow does: draw slightly less rather than crash the render loop.
      if (el !== undefined) out.push(el);
    }
    out.sort((a, b) => a.zIndex - b.zIndex);

    const work = this.index.lastQueryWork;
    this.lastQuery = {
      tested: work.tested,
      returned: out.length,
      nodes: work.nodes,
      path: 'index',
    };
    return out;
  }

  /* ── hit testing ────────────────────────────────────────────────────────── */

  /**
   * The topmost element under `point`, or null.
   *
   * ── Why this is the method the quadtree was really built for ──────────────
   *
   * The render cull runs once per *frame* — 60 Hz, and only when something
   * changed. This runs once per `pointermove`, which a trackpad emits at
   * 120–240 Hz, and it runs whether or not anything changed, because the answer
   * is what decides the cursor and the hover highlight.
   *
   * A linear scan with an exact geometry test per element is 30–80 ms at 50,000
   * elements (ARCHITECTURE §5.1). At 240 Hz that is not a slow app, it is a
   * frozen one. Phase 4a's index turns the candidate list into a handful before
   * any real geometry runs.
   *
   * ── Two phases, and why the order matters ─────────────────────────────────
   *
   *   broad   the index, rectangles only, over-inclusive by design
   *   narrow  `hitTestElement`, exact, in reverse z-order, first hit wins
   *
   * Reverse z-order is not a detail: the topmost element is the one the user
   * believes they clicked, and it is the one drawn last. Iterating forwards
   * returns whatever is *underneath*, which reads as "clicks go through shapes"
   * and is maddening to use.
   *
   * @param threshold tolerance in scene units. Callers pass `k / zoom` so a thin
   *   line stays equally clickable at every zoom level.
   */
  hitTest(point: Point, threshold: number): Readonly<Element> | null {
    const candidates = this.candidatesAt(point, threshold);

    // Descending z: the last thing drawn is the first thing hit.
    candidates.sort((a, b) => b.zIndex - a.zIndex);

    let narrow = 0;
    for (const el of candidates) {
      narrow++;
      if (hitTestElement(el, point, threshold)) {
        this.lastHit = { broad: candidates.length, narrow, hit: true };
        return el;
      }
    }

    this.lastHit = { broad: candidates.length, narrow, hit: false };
    return null;
  }

  /**
   * Every element under `point`, topmost first.
   *
   * Used by alt-click-to-cycle in Phase 6, and by the tests, which want to
   * assert the full stack rather than just the winner.
   */
  hitTestAll(point: Point, threshold: number): Readonly<Element>[] {
    const hits = this.candidatesAt(point, threshold).filter((el) =>
      hitTestElement(el, point, threshold),
    );
    hits.sort((a, b) => b.zIndex - a.zIndex);
    return hits;
  }

  /**
   * Elements a marquee touches, in ascending z-order.
   *
   * No narrow phase worth the name — a marquee is a rectangle and so are the
   * candidates' bounds, so the broad phase's own test is already the right one.
   * The only refinement is testing against rotated bounds rather than render
   * bounds, so a shape is not selected because the marquee clipped its stroke
   * padding.
   */
  elementsInBox(box: Bounds): Readonly<Element>[] {
    const out: Element[] = [];
    for (const entry of this.index.query(box)) {
      const el = this.elements.get(entry.id);
      if (el !== undefined && hitTestBox(el, box)) out.push(el);
    }
    out.sort((a, b) => a.zIndex - b.zIndex);
    return out;
  }

  /** Union of the geometry-ish bounds of a set of ids. Null when none exist. */
  boundsOf(ids: Iterable<ElementId>): Bounds | null {
    let acc: Bounds | null = null;
    for (const id of ids) {
      const el = this.elements.get(id);
      if (el === undefined || el.isDeleted) continue;
      const b = getRotatedBounds(el);
      acc = acc === null ? b : unionBounds(acc, b);
    }
    return acc;
  }

  /** Work done by the last `hitTest`. The broad/narrow ratio is the headline. */
  get hitStats(): Readonly<HitStats> {
    return this.lastHit;
  }

  /**
   * Broad phase: everything whose indexed rectangle is within `threshold`.
   *
   * The query box is the point grown by the threshold. That is correct *because*
   * the index stores render bounds, which are already padded by stroke width and
   * Rough.js jitter — so a shape whose drawn pixels reach the cursor is a
   * candidate even when its geometry does not.
   */
  private candidatesAt(point: Point, threshold: number): Element[] {
    const box: Bounds = {
      minX: point.x - threshold,
      minY: point.y - threshold,
      maxX: point.x + threshold,
      maxY: point.y + threshold,
    };

    const out: Element[] = [];
    for (const entry of this.index.query(box)) {
      const el = this.elements.get(entry.id);
      if (el !== undefined && !el.isDeleted) out.push(el);
    }
    return out;
  }

  /** Index diagnostics. Used by the dev panel and by the structural tests. */
  indexStats(): QuadTreeStats {
    return this.index.stats();
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
   * Through Phase 3 `tested` equalled the live element count on every frame —
   * the definition of a linear scan, and the deficiency the assertion in
   * `tests/engine/culling.test.ts` was written to document. Phase 4's quadtree
   * makes it grow with what is on screen instead of with what exists, and the
   * very same assertion went from documenting the problem to proving the fix.
   * Reading that one line's diff is the shortest possible summary of this phase.
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
    const bounds = getRenderBounds(element);
    this.elements.set(element.id, element);
    this.maxZ = Math.max(this.maxZ, element.zIndex);
    this.invalidateSorted();
    if (!element.isDeleted) {
      this.index.insert(element.id, bounds);
      this.growContentBounds(bounds);
    }
    this.emit({
      id: element.id,
      before: null,
      after: bounds,
      beforeElement: null,
      afterElement: element,
    });
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

    const afterBounds = getRenderBounds(updated);

    this.elements.set(id, updated);
    /* Ordering or membership changed → the cached array is structurally wrong,
       so throw it away. Otherwise only the *contents* of one slot are stale, and
       replacing that one reference is O(1). Getting this wrong in the cheap
       direction (never invalidating) is the bug described on `sortedIndex`;
       getting it wrong in the expensive direction (always invalidating) re-sorts
       the whole scene on every frame of a drag. */
    if (patch.zIndex !== undefined) {
      this.maxZ = Math.max(this.maxZ, updated.zIndex);
      this.invalidateSorted();
    } else if (patch.isDeleted !== undefined) {
      this.invalidateSorted();
    } else if (this.sortedCache !== null && this.sortedIndex !== null) {
      const slot = this.sortedIndex.get(id);
      if (slot === undefined) this.invalidateSorted();
      else this.sortedCache[slot] = updated;
    }

    /* ── Keep the index in sync ────────────────────────────────────────────
       Four cases, and the reason this lives *here* rather than in a listener is
       that a listener runs after the mutation is already visible — a query
       between the two would read a stale index. Ordering matters more than it
       looks.

       `beforeBounds` was captured before the patch was applied. That is the
       entire contract `QuadTree.remove` depends on: remove retraces the path
       the entry took on the way in, so it must be handed the rectangle the
       entry was inserted with. Compute it after, and the entry is orphaned. */
    const wasLive = !current.isDeleted;
    const isLive = !updated.isDeleted;

    if (wasLive && isLive) this.index.update(id, beforeBounds, afterBounds);
    else if (wasLive) this.index.remove(id, beforeBounds); // deleted
    else if (isLive) this.index.insert(id, afterBounds); // undeleted
    if (isLive) this.growContentBounds(afterBounds);

    this.emit({
      id,
      before: beforeBounds,
      after: isLive ? afterBounds : null,
      beforeElement: current,
      afterElement: updated,
    });
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
    if (dropped > 0) this.invalidateSorted();
    // Nothing to do to the index: soft-deleted elements were removed from it at
    // the moment they were deleted, so compaction only touches the map.
    return dropped;
  }

  /** Replace the entire scene. Used by load (Phase 8) and tests. */
  load(elements: readonly Element[]): void {
    this.elements.clear();
    this.index.clear();
    this.contentBounds = null; // recomputed exactly below — the one place drift resets
    this.maxZ = 0;
    for (const el of elements) {
      this.elements.set(el.id, el);
      this.maxZ = Math.max(this.maxZ, el.zIndex);
      if (!el.isDeleted) {
        const b = getRenderBounds(el);
        this.index.insert(el.id, b);
        this.growContentBounds(b);
      }
    }
    this.invalidateSorted();
    /* A whole-scene replacement, not a change to one element. Consumers detect it
       by the empty id: the dirty tracker forces a full repaint and the history
       clears its stacks, because there is no meaningful "before" to undo to. */
    this.emit({ id: '', before: null, after: null, beforeElement: null, afterElement: null });
  }

  /* ── notification ───────────────────────────────────────────────────────── */

  subscribe(listener: SceneListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private growContentBounds(b: Bounds): void {
    this.contentBounds = this.contentBounds === null ? b : unionBounds(this.contentBounds, b);
  }

  private emit(change: SceneChange): void {
    for (const l of this.listeners) l(change);
  }
}
