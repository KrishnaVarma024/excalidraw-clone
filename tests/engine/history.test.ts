/**
 * Undo and redo.
 *
 * `History` is exercised against a **real `Scene`**, not a fake. That is
 * deliberate: the whole argument for routing undo through `Scene.mutate` is that
 * it keeps the quadtree and the content bounds in step, and a fake target would
 * test the stack while quietly skipping the thing that actually breaks.
 *
 * The tests that carry weight are not the "push then pop" ones. They are:
 *
 *   - one gesture is one entry, whatever it did in between;
 *   - `version` never goes backwards;
 *   - the spatial index survives an undo;
 *   - undoing does not itself become an undoable action.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { History, MAX_HISTORY } from '@engine/history/History';
import { Scene } from '@engine/scene/Scene';
import { newRectangle } from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, type Element, type ElementId } from '@engine/scene/element.types';

let scene: Scene;
let history: History;

/** Wire the history to the scene the way the Engine does. */
function connect(selection: () => ElementId[] = () => []): History {
  const h = new History(selection);
  scene.subscribe((change) => {
    if (change.id === '') {
      h.clear();
      return;
    }
    h.record(change.id, change.beforeElement, change.afterElement);
  });
  return h;
}

function box(x: number, y: number, z = 1, size = 40): Element {
  return newRectangle({ x, y, width: size, height: size, style: DEFAULT_STYLE, zIndex: z });
}

beforeEach(() => {
  scene = new Scene();
  history = connect();
});

/* ── batching ─────────────────────────────────────────────────────────────── */

describe('one gesture, one entry', () => {
  it('collapses a whole drag into a single step', () => {
    /* THE test. A three-second drag calls `mutate` about 180 times. If each one
       became an entry, reversing that drag would take 180 undos — which users
       report as "undo doesn't work", not as "undo is too granular". */
    const el = box(0, 0);
    scene.add(el);
    const baseline = history.stats().undoDepth; // the `add` is itself an entry

    history.begin('move');
    for (let i = 1; i <= 180; i++) scene.mutate(el.id, { x: i, y: i });
    expect(history.commit()).toBe(true);

    // 180 mutations, exactly one new entry.
    expect(history.stats().undoDepth).toBe(baseline + 1);

    history.undo(scene);
    const after = scene.get(el.id)!;
    expect(after.x).toBe(0);
    expect(after.y).toBe(0);
  });

  it('keeps the FIRST before and the LAST after', () => {
    // The rule that makes the above work. Keep the last "before" instead and undo
    // steps back one frame; keep the first "after" and redo does nothing.
    const el = box(0, 0);
    scene.add(el);

    history.begin('move');
    scene.mutate(el.id, { x: 10 });
    scene.mutate(el.id, { x: 20 });
    scene.mutate(el.id, { x: 30 });
    history.commit();

    history.undo(scene);
    expect(scene.get(el.id)!.x).toBe(0);

    history.redo(scene);
    expect(scene.get(el.id)!.x).toBe(30);
  });

  it('nests, so a command inside a gesture does not close it', () => {
    /* Text editing depends on this: the editor opens a batch inside the pointer
       gesture, `onPointerUp` closes the outer one, and everything typed after
       that still lands in the same entry. */
    const el = box(0, 0);
    scene.add(el);

    const baseline = history.stats().undoDepth;

    history.begin('outer');
    history.begin('inner');
    scene.mutate(el.id, { x: 5 });
    expect(history.commit()).toBe(false); // inner: decrements only
    scene.mutate(el.id, { x: 15 });
    expect(history.commit()).toBe(true); // outer: pushes

    expect(history.stats().undoDepth).toBe(baseline + 1);
    history.undo(scene);
    expect(scene.get(el.id)!.x).toBe(0);
  });

  it('pushes nothing for a gesture that changed nothing', () => {
    // Press and release without moving. An empty entry means one wasted undo per
    // click, and the user pressing ⌘Z and watching nothing happen.
    history.begin('click');
    expect(history.commit()).toBe(false);
    expect(history.canUndo).toBe(false);
  });

  it('records outside a batch too, rather than silently dropping the change', () => {
    /* Record-by-default fails safer than batch-by-default. Forgetting a batch
       here gives an action that takes more undos than ideal; the alternative
       gives an action that is silently not undoable, which nobody notices until
       someone loses work. */
    const el = box(0, 0);
    scene.add(el);
    scene.mutate(el.id, { x: 99 });

    expect(history.stats().undoDepth).toBe(2); // the add, and the mutate
    history.undo(scene);
    expect(scene.get(el.id)!.x).toBe(0);
  });

  it('abort throws the batch away', () => {
    // A cancelled drag has already restored every element. Recording that round
    // trip gives an undo step that does nothing — worse than none, because the
    // user presses it twice.
    const el = box(0, 0);
    scene.add(el);
    history.begin('move');
    scene.mutate(el.id, { x: 50 });
    history.abort();

    expect(history.canUndo).toBe(true); // the add is still there
    history.undo(scene);
    expect(scene.get(el.id)!.isDeleted).toBe(true); // undid the add, not the move
  });

  it('suppress records nothing at all', () => {
    /* For changes the user did not make: loading a document, re-measuring every
       text element when a webfont arrives. An undo entry per font event fills
       the stack with changes nobody asked for and pushes the user's real work
       off the end of it. */
    const el = box(0, 0);
    history.suppress(() => {
      scene.add(el);
      scene.mutate(el.id, { x: 10 });
    });
    expect(history.canUndo).toBe(false);
  });
});

/* ── correctness ──────────────────────────────────────────────────────────── */

describe('applying an entry', () => {
  it('un-creates and re-creates', () => {
    const el = box(0, 0);
    scene.add(el);
    expect(scene.visibleCount).toBe(1);

    history.undo(scene);
    expect(scene.visibleCount).toBe(0);

    history.redo(scene);
    expect(scene.visibleCount).toBe(1);
  });

  it('un-deletes', () => {
    const el = box(0, 0);
    scene.add(el);
    history.begin('delete');
    scene.remove(el.id);
    history.commit();

    expect(scene.visibleCount).toBe(0);
    history.undo(scene);
    expect(scene.visibleCount).toBe(1);
    expect(scene.get(el.id)!.isDeleted).toBe(false);
  });

  it('never lets version go backwards', () => {
    /* The subtle one, and the reason an entry is applied as a *patch* rather than
       by putting the old object back.

       `version` is the cache key the Rough drawable cache has used since Phase 2.
       Restore the v5 object and the counter resets to 5; edit once more and the
       element is v6 again — with different geometry from the first v6, while the
       drawable cached under `id:6` is the old shape. The canvas then draws a
       shape that no longer exists. */
    const el = box(0, 0);
    scene.add(el);

    history.begin('a');
    scene.mutate(el.id, { x: 10 });
    history.commit();
    history.begin('b');
    scene.mutate(el.id, { x: 20 });
    history.commit();

    const peak = scene.get(el.id)!.version;
    history.undo(scene);
    history.undo(scene);

    expect(scene.get(el.id)!.version).toBeGreaterThan(peak);
  });

  it('keeps the spatial index in step', () => {
    /* Undo is a mutation, not a special case. An undo path that wrote into the
       element map directly leaves the quadtree describing where shapes USED to
       be, and the symptom — clicks missing shapes — surfaces minutes later with
       nothing connecting it to the undo. */
    const el = box(0, 0);
    scene.add(el);

    history.begin('move');
    scene.mutate(el.id, { x: 5000, y: 5000 });
    history.commit();

    /* Aim at the OUTLINE, not the middle. `DEFAULT_STYLE` is transparent, and a
       hollow rectangle is not hit through its interior — Phase 4b's behaviour,
       and the reason you can select something sitting behind an unfilled box. I
       wrote this test clicking the middle first, which is the same mistake the
       Phase 6 and Phase 7 smoke tests each made once. */
    expect(scene.hitTest({ x: 0, y: 20 }, 2)).toBeNull();
    expect(scene.hitTest({ x: 5000, y: 5020 }, 2)?.id).toBe(el.id);

    history.undo(scene);

    expect(scene.hitTest({ x: 5000, y: 5020 }, 2)).toBeNull();
    expect(scene.hitTest({ x: 0, y: 20 }, 2)?.id).toBe(el.id);
  });

  it('restores every field, not just geometry', () => {
    // Phase 7's derived text fields are the reason this matters: restoring a
    // string without its wrapped lines gives an element whose stored box
    // disagrees with its content, which the index believes.
    const el = box(0, 0);
    scene.add(el);

    history.begin('style');
    scene.mutate(el.id, { strokeColor: '#ff0000', opacity: 40, angle: 1.2 });
    history.commit();

    history.undo(scene);
    const after = scene.get(el.id)!;
    expect(after.strokeColor).toBe(DEFAULT_STYLE.strokeColor);
    expect(after.opacity).toBe(100);
    expect(after.angle).toBe(0);
  });

  it('touches only the elements the gesture touched', () => {
    const a = box(0, 0, 1);
    const b = box(200, 0, 2);
    scene.add(a);
    scene.add(b);

    history.begin('move a');
    scene.mutate(a.id, { x: 100 });
    history.commit();

    history.undo(scene);
    expect(scene.get(b.id)!.x).toBe(200); // untouched, and its version unchanged
    expect(scene.get(b.id)!.version).toBe(1);
  });
});

/* ── the stack ────────────────────────────────────────────────────────────── */

describe('the stack', () => {
  it('does not record its own undos', () => {
    /* The mutations an undo performs come back through the same change feed the
       history is listening to. Without the re-entrancy guard, undoing pushes an
       entry describing the undo and the next undo reverses it — the stack
       oscillates between two states and the user can never reach the third. */
    const el = box(0, 0);
    scene.add(el);
    history.begin('a');
    scene.mutate(el.id, { x: 10 });
    history.commit();
    history.begin('b');
    scene.mutate(el.id, { x: 20 });
    history.commit();

    history.undo(scene);
    history.undo(scene);
    expect(scene.get(el.id)!.x).toBe(0);
    expect(history.stats().undoDepth).toBe(1); // only the add is left
  });

  it('drops the redo branch when a new action happens', () => {
    // Otherwise redo walks into a state the current elements were never part of.
    const el = box(0, 0);
    scene.add(el);
    history.begin('a');
    scene.mutate(el.id, { x: 10 });
    history.commit();

    history.undo(scene);
    expect(history.canRedo).toBe(true);

    history.begin('c');
    scene.mutate(el.id, { y: 77 });
    history.commit();

    expect(history.canRedo).toBe(false);
  });

  it('is bounded', () => {
    const el = box(0, 0);
    scene.add(el);

    for (let i = 0; i < MAX_HISTORY + 20; i++) {
      history.begin(`m${i}`);
      scene.mutate(el.id, { x: i + 1 });
      history.commit();
    }
    expect(history.stats().undoDepth).toBe(MAX_HISTORY);
  });

  it('reports nothing to do on an empty stack', () => {
    expect(history.undo(scene)).toBeNull();
    expect(history.redo(scene)).toBeNull();
  });

  it('clears when the scene is replaced wholesale', () => {
    // A load or a generated scene. Keeping the stacks would offer undos
    // referencing elements this document has never contained.
    const el = box(0, 0);
    scene.add(el);
    expect(history.canUndo).toBe(true);

    scene.load([box(500, 500)]);
    expect(history.canUndo).toBe(false);
  });

  it('remembers the selection so undo puts you back where you were', () => {
    // Undoing a delete and finding nothing selected means hunting for what just
    // came back. An undo that leaves you somewhere you were not is half an undo.
    let selection: ElementId[] = [];
    scene = new Scene();
    history = connect(() => selection);

    const el = box(0, 0);
    scene.add(el);
    selection = [el.id];

    history.begin('delete');
    scene.remove(el.id);
    selection = [];
    history.commit();

    expect(history.undo(scene)).toEqual([el.id]);
  });
});

describe('memory', () => {
  it('holds references, not copies, so a long drag costs two objects', () => {
    /* Structural sharing for free, and it works *because* `Scene.mutate` never
       edits in place. A 400-point freehand stroke dragged for three seconds
       produces ~180 objects; history keeps exactly two of them and the other 178
       are collected. */
    const el = box(0, 0);
    scene.add(el);

    history.begin('move');
    for (let i = 0; i < 200; i++) scene.mutate(el.id, { x: i });
    history.commit();

    // Two entries — the add and the move — each tracking one element.
    expect(history.stats().trackedElements).toBe(2);
  });
});
