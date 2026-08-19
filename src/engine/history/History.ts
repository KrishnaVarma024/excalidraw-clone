/**
 * Undo and redo.
 *
 * ── Snapshots of the touched elements, not of the scene ─────────────────────
 *
 * Three designs are viable and the middle one wins:
 *
 *   whole-scene snapshot   trivially correct, O(scene) memory per entry. At
 *                          50,000 elements and 100 entries that is unusable.
 *   command + inverse      O(1)-ish memory, and every operation needs a
 *                          hand-written inverse. Those inverses drift from their
 *                          forward operations, and the drift is silent.
 *   element snapshots      O(elements the gesture touched). What this does.
 *
 * An entry holds, per touched element, the object as it was and the object as it
 * became. And it holds **references**, not copies, because `Scene.mutate` never
 * edits in place — the old object is still there, still effectively immutable.
 * Structural sharing with no copy-on-write machinery, which is the third feature
 * paid for by one rule established in Phase 2.
 *
 * ── The rule that makes an entry a gesture rather than a frame ──────────────
 *
 *   **first `before`, last `after`.**
 *
 * Dragging a shape for three seconds calls `mutate` about 180 times. The entry
 * must contain the geometry from before the drag started and the geometry after
 * it ended, and nothing in between. So the first time an id is touched inside a
 * batch its "before" is kept forever; its "after" is overwritten every time.
 *
 * Get this wrong and undo steps back one frame at a time — 180 undos to reverse
 * one drag — which is a bug users describe as "undo doesn't work".
 *
 * ── Undo is a mutation, not a special case ─────────────────────────────────
 *
 * Applying an entry goes through `Scene.mutate` and `Scene.add` like everything
 * else. That is not tidiness: those methods maintain the quadtree, the content
 * bounds, and the dirty rectangles. An undo path that writes into the element map
 * directly leaves the spatial index describing where shapes *used to be*, and the
 * symptom is clicks that miss — appearing minutes later, in a different part of
 * the app, with nothing connecting it to the undo.
 *
 * ── `version` must never go backwards ──────────────────────────────────────
 *
 * The obvious way to undo is to put the old object back. That restores its old
 * `version` too, and `version` is the cache key the Rough drawable cache and the
 * `id:version` invalidation logic have relied on since Phase 2.
 *
 * Concretely: an element goes v5 → v6 → v7. Undo restores the v5 object. Now the
 * user edits it and it becomes v6 again — with *different* geometry from the
 * first v6, and the drawable cached under `id:6` is the old shape. The canvas
 * draws a shape that no longer exists, and it will keep drawing it until
 * something evicts the entry.
 *
 * So an entry is applied as a **patch**, and `Scene.mutate` bumps the version as
 * it always does. Monotonicity is preserved and nothing else has to know that
 * undo happened.
 */

import type { Element, ElementId } from '../scene/element.types';
import type { ElementPatch } from '../scene/Scene';

/** How many entries to keep. Older ones fall off the bottom. */
export const MAX_HISTORY = 100;

/**
 * What the history needs from the scene.
 *
 * Structural, so `Scene` satisfies it without being told, and a test can pass a
 * real `Scene` rather than a fake. Narrow on purpose: history can read one
 * element, create one, and change one. It cannot query, cannot iterate, and
 * cannot reach the index — the three things that would let a bug here corrupt
 * something a long way away.
 */
export interface HistoryTarget {
  get(id: ElementId): Element | undefined;
  add(element: Element): void;
  mutate(id: ElementId, patch: ElementPatch): boolean;
}

export interface HistoryEntry {
  /** What each touched element was. `null` = it did not exist. */
  readonly before: ReadonlyMap<ElementId, Element | null>;
  /** What each touched element became. `null` = it ceased to exist. */
  readonly after: ReadonlyMap<ElementId, Element | null>;
  /** For the UI and for debugging. Never load-bearing. */
  readonly label: string;
  /** Element ids selected when the gesture began, so undo restores the selection. */
  readonly selectionBefore: readonly ElementId[];
  readonly selectionAfter: readonly ElementId[];
}

export interface HistoryStats {
  readonly undoDepth: number;
  readonly redoDepth: number;
  readonly lastLabel: string | null;
  /** Elements referenced across every entry. A rough memory proxy. */
  readonly trackedElements: number;
}

interface OpenBatch {
  label: string;
  before: Map<ElementId, Element | null>;
  after: Map<ElementId, Element | null>;
  selectionBefore: readonly ElementId[];
  /** Batches nest: a command inside a gesture must not commit the gesture. */
  depth: number;
}

export class History {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private batch: OpenBatch | null = null;

  /**
   * True while an entry is being applied.
   *
   * The mutations undo performs come back through the same change feed history is
   * listening to. Without this flag, undoing pushes a new entry describing the
   * undo, and the next undo reverses it — the stack oscillates between two states
   * and the user can never get back to the third.
   */
  private applying = false;

  /** True inside `suppress`. See that method. */
  private suppressed = false;

  private lastLabel: string | null = null;

  constructor(private readonly selectionOf: () => readonly ElementId[] = () => []) {}

  /* ── recording ──────────────────────────────────────────────────────────── */

  /**
   * Open a batch. Everything recorded until the matching `commit` is one entry.
   *
   * Nestable, counted rather than boolean, because a command can legitimately run
   * inside a gesture — deleting during a drag, a style change applied to a
   * multi-selection — and the inner one must not close the outer one.
   */
  begin(label: string): void {
    if (this.batch !== null) {
      this.batch.depth++;
      return;
    }
    this.batch = {
      label,
      before: new Map(),
      after: new Map(),
      selectionBefore: this.selectionOf(),
      depth: 1,
    };
  }

  /**
   * Record one element change.
   *
   * Called for every scene change, from the change feed. Outside a batch this
   * still records: an implicit single-change batch is opened and closed at once.
   *
   * ── Why record-by-default rather than batch-by-default ──────────────────
   *
   * The alternative is to ignore anything outside an explicit batch. It looks
   * safer and it fails worse: forget to open a batch and the operation is
   * *silently not undoable*, which nobody notices until a user loses work.
   * Recording by default means forgetting a batch gives you an operation that is
   * undoable in more steps than ideal — annoying, visible, and not data loss.
   *
   * Changes that are genuinely not user actions go through `suppress`.
   */
  record(id: ElementId, before: Element | null, after: Element | null): void {
    if (this.applying || this.suppressed) return;

    const implicit = this.batch === null;
    if (implicit) this.begin('change');

    const batch = this.batch!;
    // FIRST before, LAST after. The whole gesture in one entry.
    if (!batch.before.has(id)) batch.before.set(id, before);
    batch.after.set(id, after);

    if (implicit) this.commit();
  }

  /**
   * Close the batch and push an entry. Returns whether anything was pushed.
   *
   * An empty batch pushes nothing. That matters: pressing and releasing without
   * moving opens and closes a batch, and an empty entry would mean one wasted
   * undo per click.
   */
  commit(): boolean {
    const batch = this.batch;
    if (batch === null) return false;
    if (--batch.depth > 0) return false;

    this.batch = null;
    if (batch.before.size === 0) return false;

    /* A batch where nothing actually differs is also not an entry. It happens:
       a drag below the movement threshold, a style click that re-picks the
       current colour. `Scene.mutate` already refuses no-ops, so this catches the
       case where separate changes cancelled out within one gesture. */
    if (!differs(batch.before, batch.after)) return false;

    this.undoStack.push({
      before: batch.before,
      after: batch.after,
      label: batch.label,
      selectionBefore: batch.selectionBefore,
      selectionAfter: this.selectionOf(),
    });

    // A new action invalidates the redo branch. Keeping it would let the user
    // redo their way into a state the current elements were never part of.
    this.redoStack = [];
    this.lastLabel = batch.label;

    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    return true;
  }

  /** Throw the open batch away without pushing. For a cancelled gesture. */
  abort(): void {
    this.batch = null;
  }

  /**
   * Run `fn` with recording turned off.
   *
   * For changes the user did not make and cannot meaningfully undo:
   *
   *   - loading a document;
   *   - re-measuring every text element when a webfont finishes loading
   *     (Phase 7) — an undo entry per font event would fill the stack with
   *     changes nobody asked for and push the user's real work off the end;
   *   - migrations applied during `restore`.
   *
   * Restores the previous value rather than clearing the flag, so it nests.
   */
  suppress<T>(fn: () => T): T {
    const was = this.suppressed;
    this.suppressed = true;
    try {
      return fn();
    } finally {
      this.suppressed = was;
    }
  }

  /* ── applying ───────────────────────────────────────────────────────────── */

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** @returns the selection to restore, or null if there was nothing to undo. */
  undo(target: HistoryTarget): readonly ElementId[] | null {
    const entry = this.undoStack.pop();
    if (entry === undefined) return null;

    this.apply(target, entry.before);
    this.redoStack.push(entry);
    this.lastLabel = entry.label;
    return entry.selectionBefore;
  }

  redo(target: HistoryTarget): readonly ElementId[] | null {
    const entry = this.redoStack.pop();
    if (entry === undefined) return null;

    this.apply(target, entry.after);
    this.undoStack.push(entry);
    this.lastLabel = entry.label;
    return entry.selectionAfter;
  }

  /**
   * Write one side of an entry back into the scene.
   *
   * Three cases, and the third is the one people miss:
   *
   *   target state is null      the element should not exist → soft-delete it.
   *   element exists            patch it back. `Scene.mutate` bumps `version`, so
   *                             monotonicity survives — see the file header.
   *   element is GONE entirely  re-add it. Only reachable if something physically
   *                             dropped it, which `Scene.compact` does at save
   *                             time. Handling it is three lines; not handling it
   *                             is an undo that silently does nothing.
   */
  private apply(target: HistoryTarget, states: ReadonlyMap<ElementId, Element | null>): void {
    this.applying = true;
    try {
      for (const [id, state] of states) {
        if (state === null) {
          target.mutate(id, { isDeleted: true });
          continue;
        }
        if (target.get(id) === undefined) {
          target.add(state);
          continue;
        }
        target.mutate(id, patchOf(state));
      }
    } finally {
      this.applying = false;
    }
  }

  /* ── lifecycle ──────────────────────────────────────────────────────────── */

  /**
   * Forget everything.
   *
   * Called when the scene is replaced wholesale — a load, or the dev panel's
   * scene generator. Keeping the stacks would offer undos that reference elements
   * the current document has never contained, and applying one would resurrect
   * them into the middle of an unrelated drawing.
   */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.batch = null;
    this.lastLabel = null;
  }

  stats(): HistoryStats {
    let tracked = 0;
    for (const e of this.undoStack) tracked += e.before.size;
    for (const e of this.redoStack) tracked += e.before.size;

    return {
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
      lastLabel: this.lastLabel,
      trackedElements: tracked,
    };
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

/**
 * Every field a patch may legally carry.
 *
 * `id`, `type`, `seed` and `version` are excluded by `ElementPatch` itself:
 * the first three are identity and must never change, and the fourth is
 * `Scene.mutate`'s to bump.
 */
function patchOf(el: Element): ElementPatch {
  const { id: _id, type: _type, seed: _seed, version: _version, ...rest } = el;
  return rest as ElementPatch;
}

/** Did anything actually change across the batch? */
function differs(
  before: ReadonlyMap<ElementId, Element | null>,
  after: ReadonlyMap<ElementId, Element | null>,
): boolean {
  for (const [id, b] of before) {
    // Object identity is enough, and it is enough *because* of the Phase 2 rule:
    // a changed element is a different object, always.
    if (after.get(id) !== b) return true;
  }
  return false;
}
