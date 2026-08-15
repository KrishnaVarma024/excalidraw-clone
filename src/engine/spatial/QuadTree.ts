/**
 * The spatial index.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * Phase 3 measured the thing this file exists to fix. Culling 50,000 elements
 * cost ~100 nanoseconds per element per frame — and, more damningly, it cost the
 * *same* whether forty elements were on screen or all fifty thousand. The work
 * was entirely unrelated to what you were looking at.
 *
 * A quadtree answers "what is inside this rectangle?" by descending only into
 * the regions that overlap it. Elements far from the query are never examined,
 * because the node containing them is rejected in one comparison.
 *
 * ── Why this file knows nothing about elements ──────────────────────────────
 *
 * It stores `{ id, bounds }` and nothing else. Not `Element`, not `Scene`.
 *
 * That is not fastidiousness. A spatial index that imports the element model
 * cannot be unit-tested without constructing elements, cannot be reused for the
 * dirty-rectangle tracker in Phase 5, and quietly acquires opinions about
 * z-order and soft-deletion that belong to `Scene`. The index answers exactly
 * one question — *"which ids have bounds overlapping this rectangle?"* — and
 * `Scene` owns everything that question does not cover.
 *
 * The practical consequence: every test in `tests/engine/quadtree.test.ts` is
 * plain rectangles and string ids, so a failure points at the index rather than
 * at whatever happened to be on top of it.
 *
 * ── The two design decisions worth defending ────────────────────────────────
 *
 * **1. Straddlers stay in the parent.** When a node subdivides, each item moves
 * down into the single child that *fully contains* it. An item overlapping a
 * split line stays where it is. The alternative — duplicating it into every
 * child it touches — makes queries return duplicates that need de-duplication,
 * and makes `remove` visit every copy. Keeping one authoritative location means
 * `remove` is unambiguous and `size` is exact. The cost is the pathological case
 * in §5.2 of ARCHITECTURE: a scene full of very large elements piles them all up
 * in the root, and the query degrades to the linear scan we started with. That
 * case is reachable on purpose via `generateScene({ sizeVariance: 1 })`, and the
 * benchmark measures it rather than hiding it.
 *
 * **2. Depth is not stored on the node.** It is passed down during traversal.
 *
 * That looks like a stylistic choice and is actually what makes an infinite
 * canvas possible. Re-rooting (§5.3, and `grow()` below) puts the old root
 * *underneath* a new one, which increments the depth of every node in the tree.
 * If depth were a field, each re-root would be an O(n) walk to fix it up, and
 * the whole "O(1) growth" claim would be false. Passing it as a parameter makes
 * re-rooting genuinely three assignments.
 */

import type { Bounds } from '../util/geometry';
import { boundsContains, boundsIntersect } from '../util/geometry';

/** What the index stores. Deliberately not an `Element`. */
export interface QuadEntry {
  readonly id: string;
  readonly bounds: Bounds;
}

export interface QuadTreeOptions {
  /** Items a node holds before it subdivides. */
  readonly capacity?: number;
  /**
   * Subdivision limit, measured from the *current* root.
   *
   * `capacity` alone cannot terminate: a hundred elements at identical
   * coordinates never separate no matter how finely you cut, so a
   * capacity-only rule recurses until the stack dies. `maxDepth` is the
   * backstop, and 8 levels bounds the tree at 4⁸ = 65,536 leaves.
   */
  readonly maxDepth?: number;
  /** Half-width of the initial root square, in scene units. */
  readonly initialExtent?: number;
}

/** Work performed by the last query. The honest version of "is it fast?". */
export interface QueryWork {
  /** Entry bounds tests performed. Directly comparable to the linear scan's count. */
  readonly tested: number;
  /** Entries returned. */
  readonly returned: number;
  /** Tree nodes descended into. */
  readonly nodes: number;
}

export interface QuadTreeStats {
  readonly size: number;
  readonly nodes: number;
  readonly maxDepth: number;
  readonly rootBounds: Bounds;
  /** Items held at the root itself — the straddler pile. High is bad. */
  readonly rootItems: number;
  /** How many times the root has doubled to swallow an out-of-bounds element. */
  readonly growths: number;
}

const DEFAULT_CAPACITY = 8;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_EXTENT = 4096;

/** Quadrant order is fixed and relied upon by `grow()`. y grows downward. */
const NW = 0;
const NE = 1;
const SW = 2;
const SE = 3;

class QuadNode {
  items: QuadEntry[] = [];
  children: [QuadNode, QuadNode, QuadNode, QuadNode] | null = null;

  constructor(readonly bounds: Bounds) {}
}

export class QuadTree {
  private root: QuadNode;
  private count = 0;
  private growths = 0;

  private readonly capacity: number;
  private readonly maxDepth: number;

  private lastQuery: QueryWork = { tested: 0, returned: 0, nodes: 0 };

  constructor(options: QuadTreeOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

    const e = options.initialExtent ?? DEFAULT_EXTENT;
    // Square, and centred on the origin — which is where `Viewport` starts, so
    // the first few hundred elements a user draws land inside it and no growth
    // is needed. A non-square root would make quadrants non-square and skew
    // subdivision along one axis forever.
    this.root = new QuadNode({ minX: -e, minY: -e, maxX: e, maxY: e });
  }

  get size(): number {
    return this.count;
  }

  get rootBounds(): Bounds {
    return this.root.bounds;
  }

  /** Work done by the most recent `query`. See `Scene.queryStats`. */
  get lastQueryWork(): QueryWork {
    return this.lastQuery;
  }

  /* ── writing ────────────────────────────────────────────────────────────── */

  insert(id: string, bounds: Bounds): void {
    // Grow first, so the descent below can assume containment.
    while (!boundsContains(this.root.bounds, bounds)) this.grow(bounds);

    this.insertInto(this.root, { id, bounds }, 0);
    this.count++;
  }

  /**
   * Remove an entry.
   *
   * **`bounds` must be the bounds the entry was inserted with.** They decide
   * which path down the tree the entry took, and a wrong rectangle walks a
   * different path, finds nothing, and returns `false` — leaving a ghost in the
   * index forever. That ghost is invisible: queries return an id whose element
   * has moved, so a shape becomes unclickable in one place and clickable in a
   * place where nothing is drawn.
   *
   * This is the single most dangerous contract in the phase, which is why
   * `Scene.mutate` captures `before` bounds *before* applying the patch, why
   * this returns a boolean rather than failing silently, and why
   * `tests/engine/quadtree.test.ts` includes a randomised move-and-verify
   * property test.
   */
  remove(id: string, bounds: Bounds): boolean {
    const removed = this.removeFrom(this.root, id, bounds, 0);
    if (removed) this.count--;
    return removed;
  }

  /**
   * Move an entry to new bounds.
   *
   * The fast path is not "the bounds are equal" — it is **"the entry still lives
   * in the same node"**. Dragging a shape a few pixels changes its bounds every
   * frame while almost never changing which quadrant contains it, so the common
   * case is a remove and re-insert that puts the entry back exactly where it
   * was, having walked the tree twice for nothing.
   */
  update(id: string, oldBounds: Bounds, newBounds: Bounds): void {
    if (boundsContains(this.root.bounds, newBounds)) {
      const node = this.findNode(this.root, oldBounds);
      if (this.nodeWouldStillHold(node, newBounds)) {
        for (let i = 0; i < node.items.length; i++) {
          if (node.items[i]!.id === id) {
            node.items[i] = { id, bounds: newBounds };
            return;
          }
        }
      }
    }

    this.remove(id, oldBounds);
    this.insert(id, newBounds);
  }

  clear(): void {
    this.root = new QuadNode(this.root.bounds);
    this.count = 0;
  }

  /* ── reading ────────────────────────────────────────────────────────────── */

  /**
   * Every entry whose bounds intersect `range`.
   *
   * Order is tree order, which is **not** z-order. `Scene` sorts. Putting the
   * sort here would make the index carry an opinion it has no business having —
   * the dirty-rectangle tracker in Phase 5 queries this same structure and does
   * not care about z at all.
   */
  query(range: Bounds): QuadEntry[] {
    const out: QuadEntry[] = [];
    let tested = 0;
    let nodes = 0;

    // Explicit stack rather than recursion. Re-rooting pushes old subtrees
    // deeper than `maxDepth` — depth is bounded by maxDepth + growths, not by
    // maxDepth — so the recursion depth is not a compile-time constant. An
    // explicit stack makes that a non-question.
    const stack: QuadNode[] = [this.root];

    while (stack.length > 0) {
      const node = stack.pop()!;
      nodes++;

      for (const entry of node.items) {
        tested++;
        if (boundsIntersect(entry.bounds, range)) out.push(entry);
      }

      const kids = node.children;
      if (kids !== null) {
        // The whole point of the structure is on this line: a child whose
        // rectangle misses the range is never opened, and neither is anything
        // beneath it.
        for (const child of kids) {
          if (boundsIntersect(child.bounds, range)) stack.push(child);
        }
      }
    }

    this.lastQuery = { tested, returned: out.length, nodes };
    return out;
  }

  /**
   * Every id currently in the index, in unspecified order.
   *
   * Only for tests and diagnostics — a caller that needs all elements should ask
   * `Scene`, which has them z-sorted already.
   */
  allIds(): string[] {
    const out: string[] = [];
    const stack: QuadNode[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      for (const e of node.items) out.push(e.id);
      if (node.children !== null) stack.push(...node.children);
    }
    return out;
  }

  stats(): QuadTreeStats {
    let nodes = 0;
    let maxDepth = 0;

    const stack: { node: QuadNode; depth: number }[] = [{ node: this.root, depth: 0 }];
    while (stack.length > 0) {
      const { node, depth } = stack.pop()!;
      nodes++;
      if (depth > maxDepth) maxDepth = depth;
      if (node.children !== null) {
        for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
      }
    }

    return {
      size: this.count,
      nodes,
      maxDepth,
      rootBounds: this.root.bounds,
      rootItems: this.root.items.length,
      growths: this.growths,
    };
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  private insertInto(node: QuadNode, entry: QuadEntry, depth: number): void {
    if (node.children !== null) {
      const child = this.childContaining(node, entry.bounds);
      if (child !== null) {
        this.insertInto(child, entry, depth + 1);
        return;
      }
      // Straddles a split line — this node keeps it. See the header note.
      node.items.push(entry);
      return;
    }

    node.items.push(entry);

    if (node.items.length > this.capacity && depth < this.maxDepth) {
      this.subdivide(node, depth);
    }
  }

  private subdivide(node: QuadNode, depth: number): void {
    const { minX, minY, maxX, maxY } = node.bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    node.children = [
      new QuadNode({ minX, minY, maxX: midX, maxY: midY }), // NW
      new QuadNode({ minX: midX, minY, maxX, maxY: midY }), // NE
      new QuadNode({ minX, minY: midY, maxX: midX, maxY }), // SW
      new QuadNode({ minX: midX, minY: midY, maxX, maxY }), // SE
    ];

    // Re-home what is already here. Anything straddling stays.
    const staying: QuadEntry[] = [];
    for (const entry of node.items) {
      const child = this.childContaining(node, entry.bounds);
      if (child === null) staying.push(entry);
      else this.insertInto(child, entry, depth + 1);
    }
    node.items = staying;
  }

  /**
   * The one child fully containing `bounds`, or null if it straddles.
   *
   * Note `boundsContains`, not `boundsIntersect`. Quadrants share edges, so an
   * item sitting exactly on a split line is contained by *neither* child under a
   * strict reading and by two under a loose one. Containment gives at most one
   * answer, which is what makes `remove` able to retrace the path.
   */
  private childContaining(node: QuadNode, bounds: Bounds): QuadNode | null {
    const kids = node.children;
    if (kids === null) return null;
    for (const child of kids) {
      if (boundsContains(child.bounds, bounds)) return child;
    }
    return null;
  }

  private removeFrom(node: QuadNode, id: string, bounds: Bounds, depth: number): boolean {
    const child = this.childContaining(node, bounds);
    if (child !== null && this.removeFrom(child, id, bounds, depth + 1)) return true;

    // Not below us (or we are a leaf) — it must be in our own item list.
    for (let i = 0; i < node.items.length; i++) {
      if (node.items[i]!.id === id) {
        // Order within a node is meaningless — z-order is Scene's job — so
        // swap-with-last beats splice, which is O(n) in the node's item count.
        const last = node.items.pop()!;
        if (i < node.items.length) node.items[i] = last;
        return true;
      }
    }
    return false;
  }

  /**
   * The node whose item list would hold an entry with these bounds.
   *
   * Terminates without a depth guard: `childContaining` returns null at a leaf,
   * which is the base case.
   */
  private findNode(node: QuadNode, bounds: Bounds): QuadNode {
    const child = this.childContaining(node, bounds);
    return child === null ? node : this.findNode(child, bounds);
  }

  /**
   * Would `node` still be the right home for an entry that moved to `next`?
   *
   * Two conditions, and the second is the one people forget: the node must still
   * contain the new bounds, **and** the new bounds must not have shrunk enough
   * to fit inside one of the node's children. Skipping that check leaves the
   * entry sitting higher in the tree than it belongs — still correct, still
   * found by every query, and permanently slower. Bugs that only cost
   * performance are the ones that survive longest.
   */
  private nodeWouldStillHold(node: QuadNode, next: Bounds): boolean {
    if (!boundsContains(node.bounds, next)) return false;
    return this.childContaining(node, next) === null;
  }

  /**
   * Double the root, expanding toward `target`.
   *
   * The old root becomes one of the four quadrants of a new root twice its size,
   * chosen so the new space appears on the side the out-of-bounds element is on.
   * Three assignments and four allocations — no items are touched, no bounds are
   * recomputed, nothing is re-inserted.
   *
   * Doubling is what makes this cheap in the limit: reaching a coordinate `d`
   * away takes O(log d) growths, so panning to 10⁹ scene units and drawing costs
   * about thirty allocations, once, ever. Linear growth would cost 10⁹/4096.
   */
  private grow(target: Bounds): void {
    const b = this.root.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;

    // Expand toward the side the target overflows. Comparing against the root's
    // centre (rather than its edges) also handles a target that overflows both
    // sides at once — one growth per axis per call, and the `while` in `insert`
    // keeps going until it fits.
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const right = (target.minX + target.maxX) / 2 >= cx;
    const down = (target.minY + target.maxY) / 2 >= cy;

    const bounds: Bounds = {
      minX: right ? b.minX : b.minX - w,
      maxX: right ? b.maxX + w : b.maxX,
      minY: down ? b.minY : b.minY - h,
      maxY: down ? b.maxY + h : b.maxY,
    };

    const newRoot = new QuadNode(bounds);
    const { minX, minY, maxX, maxY } = bounds;
    const midX = (minX + maxX) / 2;
    const midY = (minY + maxY) / 2;

    newRoot.children = [
      new QuadNode({ minX, minY, maxX: midX, maxY: midY }),
      new QuadNode({ minX: midX, minY, maxX, maxY: midY }),
      new QuadNode({ minX, minY: midY, maxX: midX, maxY }),
      new QuadNode({ minX: midX, minY: midY, maxX, maxY }),
    ];

    // Expanding right+down means the old root is the top-left quadrant, and so
    // on. Getting this mapping backwards produces a tree that still answers
    // queries correctly and slowly, which is the worst kind of wrong — so
    // `quadtree.test.ts` asserts the old contents are still findable after a
    // growth in each of the four directions.
    const slot = right ? (down ? NW : SW) : down ? NE : SE;
    newRoot.children[slot] = this.root;

    this.root = newRoot;
    this.growths++;
  }
}
