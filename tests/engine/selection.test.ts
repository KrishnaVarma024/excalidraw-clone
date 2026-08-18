/**
 * Selection: the state, the two-phase hit test, and the tool's state machine.
 *
 * `ToolManager` is exercised directly rather than through the DOM. It takes a
 * scene point and a modifier bag and returns whether it consumed the event —
 * that is the whole interface, and it was designed that way in Phase 2 precisely
 * so the interaction logic could be tested in Node in milliseconds instead of in
 * a browser in seconds.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene } from '@engine/scene/Scene';
import { Selection } from '@engine/tools/Selection';
import { ToolManager, type PointerModifiers } from '@engine/tools/ToolManager';
import { newRectangle } from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, TRANSPARENT, type Element } from '@engine/scene/element.types';
import { generateScene } from '@engine/dev/generateScene';
import { hitTestElement } from '@engine/scene/hitTest';
import { MIN_SIZE, ROTATE_OFFSET_PX } from '@engine/scene/transform';
import type { Bounds, Point } from '@engine/util/geometry';

const FILLED = { ...DEFAULT_STYLE, backgroundColor: '#a5d8ff' };

const mods = (over: Partial<PointerModifiers> = {}): PointerModifiers => ({
  shiftKey: false,
  altKey: false,
  zoom: 1,
  hitThreshold: 5,
  pressure: 0.5,
  pointerType: 'mouse',
  ...over,
});

const at = (x: number, y: number): Point => ({ x, y });

function box(x: number, y: number, z: number, size = 40): Element {
  return newRectangle({ x, y, width: size, height: size, style: FILLED, zIndex: z });
}

describe('Selection', () => {
  it('starts empty', () => {
    const s = new Selection();
    expect(s.isEmpty).toBe(true);
    expect(s.size).toBe(0);
  });

  it('reports whether each operation actually changed anything', () => {
    // Same contract as `Scene.mutate`. A mutator that claims a change on a no-op
    // means a repaint every frame while the user does nothing at all.
    const s = new Selection();
    expect(s.clear()).toBe(false);
    expect(s.set(['a', 'b'])).toBe(true);
    expect(s.set(['b', 'a'])).toBe(false); // same set, different order
    expect(s.add(['a'])).toBe(false);
    expect(s.add(['c'])).toBe(true);
    expect(s.remove(['zzz'])).toBe(false);
    expect(s.clear()).toBe(true);
  });

  it('toggles', () => {
    const s = new Selection();
    s.toggle('a');
    expect(s.has('a')).toBe(true);
    s.toggle('a');
    expect(s.has('a')).toBe(false);
  });

  it('drops ids that no longer exist', () => {
    // A stale id is invisible: the count is wrong and the next command silently
    // does nothing for that entry rather than failing loudly.
    const s = new Selection();
    s.set(['a', 'b', 'c']);
    expect(s.retain((id) => id !== 'b')).toBe(true);
    expect([...s.ids()].sort()).toEqual(['a', 'c']);
  });
});

describe('Scene.hitTest — broad phase then narrow phase', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = new Scene();
  });

  it('returns the topmost element, not the first one it finds', () => {
    // Reverse z-order is not a detail. Iterating forwards returns whatever is
    // underneath, which reads as "my clicks go through shapes".
    const bottom = box(0, 0, 1);
    const top = box(10, 10, 5);
    scene.add(bottom);
    scene.add(top);

    expect(scene.hitTest(at(20, 20), 1)?.id).toBe(top.id);
    expect(scene.hitTest(at(5, 5), 1)?.id).toBe(bottom.id);
  });

  it('returns null on empty canvas', () => {
    scene.add(box(0, 0, 1));
    expect(scene.hitTest(at(500, 500), 1)).toBeNull();
  });

  it('ignores deleted elements', () => {
    const el = box(0, 0, 1);
    scene.add(el);
    scene.remove(el.id);
    expect(scene.hitTest(at(20, 20), 1)).toBeNull();
  });

  it('reports the broad and narrow counts separately', () => {
    // The two numbers that justify the whole arrangement: the index turns
    // thousands of candidates into a handful, and only that handful pays for an
    // exact geometry test.
    scene.load(generateScene({ count: 5000, seed: 11 }).elements);
    scene.hitTest(at(0, 0), 5);

    const { broad, narrow } = scene.hitStats;
    expect(broad).toBeLessThan(scene.visibleCount * 0.02);
    expect(narrow).toBeLessThanOrEqual(broad);
  });

  it('agrees with a brute-force scan over the whole scene', () => {
    // The oracle. Brute force is obviously correct, shares no code with the
    // broad phase, and is far too slow to ship — which is why the broad phase
    // exists at all.
    scene.load(generateScene({ count: 1500, seed: 3 }).elements);
    const threshold = 4;

    for (const point of [at(0, 0), at(120, -80), at(-400, 250), at(1000, 1000), at(37, 91)]) {
      const bruteForce = scene
        .sorted()
        .filter((el) => hitTestElement(el, point, threshold))
        .sort((a, b) => b.zIndex - a.zIndex);

      expect(scene.hitTest(point, threshold)?.id ?? null).toBe(bruteForce[0]?.id ?? null);
      expect(scene.hitTestAll(point, threshold).map((e) => e.id)).toEqual(
        bruteForce.map((e) => e.id),
      );
    }
  });

  it('finds a shape whose stroke reaches the cursor but whose geometry does not', () => {
    // The index stores RENDER bounds, which include stroke width and Rough.js
    // jitter, so the broad phase is conservative in the right direction. Culling
    // on geometry bounds would make fat strokes unclickable at their edges.
    const fat = newRectangle({
      x: 0,
      y: 0,
      width: 50,
      height: 50,
      style: { ...DEFAULT_STYLE, backgroundColor: TRANSPARENT, strokeWidth: 12 },
      zIndex: 1,
    });
    scene.add(fat);
    expect(scene.hitTest(at(-3, 25), 4)).not.toBeNull();
  });
});

describe('Scene.elementsInBox', () => {
  it('returns everything a marquee touches, in z-order', () => {
    const scene = new Scene();
    scene.add(box(0, 0, 3));
    scene.add(box(100, 100, 1));
    scene.add(box(1000, 1000, 2));

    const inside = scene.elementsInBox({ minX: -10, minY: -10, maxX: 150, maxY: 150 });
    expect(inside).toHaveLength(2);
    expect(inside.map((e) => e.zIndex)).toEqual([1, 3]);
  });

  it('agrees with a brute-force scan', () => {
    const scene = new Scene();
    scene.load(generateScene({ count: 2000, seed: 8 }).elements);
    const window: Bounds = { minX: -300, minY: -300, maxX: 300, maxY: 300 };

    const fromIndex = new Set(scene.elementsInBox(window).map((e) => e.id));
    const bruteForce = scene.sorted().filter((el) => {
      const b = { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
      // Only unrotated elements can be compared against a naive geometry box;
      // rotated ones are checked by the hitTest suite instead.
      if (el.angle !== 0) return fromIndex.has(el.id);
      return !(b.maxX < window.minX || b.minX > window.maxX || b.maxY < window.minY || b.minY > window.maxY);
    });

    expect(fromIndex.size).toBe(bruteForce.length);
  });
});

describe('the selection tool', () => {
  let scene: Scene;
  let selection: Selection;
  let tools: ToolManager;
  let onSelectionChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scene = new Scene();
    selection = new Selection();
    onSelectionChange = vi.fn();
    tools = new ToolManager(scene, selection, DEFAULT_STYLE, {
      onDraftChange: vi.fn(),
      onSelectionChange,
      onCommit: vi.fn(),
      onToolChange: vi.fn(),
    });
    tools.setTool('selection');
  });

  it('selects on pointerdown, not on pointerup', () => {
    // Press-and-highlight is what makes press-and-drag-to-move work in Phase 6
    // without a special case, and it is what the hand expects.
    const el = box(0, 0, 1);
    scene.add(el);

    tools.onPointerDown(at(20, 20), mods());
    expect(selection.has(el.id)).toBe(true);
    expect(tools.marqueeBox).toBeNull();
  });

  it('consumes the event even when it hits nothing', () => {
    // Hitting nothing is how a rubber band starts. Navigation is unaffected:
    // InputRouter checks space-drag and middle-click before asking the tool.
    expect(tools.onPointerDown(at(0, 0), mods())).toBe(true);
    expect(tools.marqueeBox).not.toBeNull();
  });

  it('replaces the selection on a plain click and toggles on shift-click', () => {
    const a = box(0, 0, 1);
    const b = box(200, 0, 2);
    scene.add(a);
    scene.add(b);

    tools.onPointerDown(at(20, 20), mods());
    tools.onPointerUp();
    expect([...selection.ids()]).toEqual([a.id]);

    tools.onPointerDown(at(220, 20), mods({ shiftKey: true }));
    tools.onPointerUp();
    expect([...selection.ids()].sort()).toEqual([a.id, b.id].sort());

    tools.onPointerDown(at(220, 20), mods({ shiftKey: true }));
    tools.onPointerUp();
    expect([...selection.ids()]).toEqual([a.id]);
  });

  it('leaves a multi-selection intact when pressing an already-selected member', () => {
    // Otherwise pressing one of five selected shapes to drag them all would
    // collapse the selection to that one shape, and the drag would move a single
    // element. Phase 6 depends on this.
    const a = box(0, 0, 1);
    const b = box(200, 0, 2);
    scene.add(a);
    scene.add(b);
    selection.set([a.id, b.id]);

    tools.onPointerDown(at(20, 20), mods());
    expect(selection.size).toBe(2);
  });

  it('clears the selection when clicking empty canvas', () => {
    const el = box(0, 0, 1);
    scene.add(el);
    selection.set([el.id]);

    tools.onPointerDown(at(5000, 5000), mods());
    expect(selection.isEmpty).toBe(true);
    tools.onPointerUp();
  });

  describe('the rubber band', () => {
    beforeEach(() => {
      scene.add(box(0, 0, 1));
      scene.add(box(100, 0, 2));
      scene.add(box(1000, 1000, 3));
    });

    it('updates the selection live, not only on release', () => {
      // Direct manipulation: you see what you are about to get. Affordable only
      // because `elementsInBox` is an index query, so the cost tracks the size
      // of the box rather than the size of the document.
      tools.onPointerDown(at(-20, -20), mods());
      tools.onPointerMove(at(50, 50), mods());
      expect(selection.size).toBe(1);

      tools.onPointerMove(at(200, 100), mods());
      expect(selection.size).toBe(2);

      tools.onPointerUp();
      expect(selection.size).toBe(2);
      expect(tools.marqueeBox).toBeNull();
    });

    it('works when dragged up and to the left', () => {
      // `boundsFromRect` normalises negative width and height. Without it, an
      // up-left drag produces an inverted rectangle that intersects nothing —
      // the classic "marquee only works one way" bug.
      tools.onPointerDown(at(200, 100), mods());
      tools.onPointerMove(at(-20, -20), mods());
      expect(selection.size).toBe(2);
      tools.onPointerUp();
    });

    it('adds to the existing selection when shift is held', () => {
      const far = scene.sorted().find((e) => e.x === 1000)!;
      selection.set([far.id]);

      tools.onPointerDown(at(-20, -20), mods({ shiftKey: true }));
      tools.onPointerMove(at(50, 50), mods({ shiftKey: true }));
      tools.onPointerUp();

      expect(selection.size).toBe(2);
      expect(selection.has(far.id)).toBe(true);
    });

    it('restores the previous selection when cancelled', () => {
      // An aborted gesture should leave no trace. Destroying a selection the
      // user spent effort building is the opposite of what Escape means.
      const first = scene.sorted()[0]!;
      selection.set([first.id]);

      tools.onPointerDown(at(500, 500), mods({ shiftKey: true }));
      tools.onPointerMove(at(1500, 1500), mods({ shiftKey: true }));
      expect(selection.size).toBe(2);

      tools.cancel();
      expect([...selection.ids()]).toEqual([first.id]);
      expect(tools.marqueeBox).toBeNull();
    });
  });

  describe('commands', () => {
    beforeEach(() => {
      scene.add(box(0, 0, 1));
      scene.add(box(100, 0, 2));
      scene.add(box(200, 0, 3));
    });

    it('selects all, and reports no change when everything already is', () => {
      expect(tools.selectAll()).toBe(true);
      expect(selection.size).toBe(3);
      expect(tools.selectAll()).toBe(false);
    });

    it('deletes the selection and empties it', () => {
      // Leaving deleted ids selected would show a count for things that are not
      // there, and the next command would silently skip them.
      tools.selectAll();
      expect(tools.deleteSelected()).toBe(3);

      expect(scene.visibleCount).toBe(0);
      expect(selection.isEmpty).toBe(true);
      expect(scene.hitTest(at(20, 20), 2)).toBeNull();
    });

    it('deletes nothing, and notifies nobody, when the selection is empty', () => {
      onSelectionChange.mockClear();
      expect(tools.deleteSelected()).toBe(0);
      expect(onSelectionChange).not.toHaveBeenCalled();
    });

    it('deselects on Escape when nothing is in flight', () => {
      tools.selectAll();
      tools.cancel();
      expect(selection.isEmpty).toBe(true);
    });
  });

  /* ── transform gestures (Phase 6) ───────────────────────────────────────── */

  describe('press and drag to move', () => {
    /**
     * The whole gesture is three calls, and the state between them lives in one
     * `DragState` captured on pointerdown. That is what makes it testable in
     * Node: no canvas, no DOM, no pointer capture.
     */
    it('moves the selected shape instead of starting a marquee', () => {
      const el = box(0, 0, 1);
      scene.add(el);

      tools.onPointerDown(at(20, 20), mods());
      tools.onPointerMove(at(70, 45), mods());
      tools.onPointerUp();

      const after = scene.get(el.id)!;
      expect(after.x).toBeCloseTo(50, 8);
      expect(after.y).toBeCloseTo(25, 8);
      expect(tools.marqueeBox).toBeNull();
    });

    it('ignores a twitch, so clicking does not nudge', () => {
      /* Without the threshold every selection click moves the shape by a pixel
         or two. Users experience that as the canvas being "twitchy" and never
         report it precisely enough to find. */
      const el = box(0, 0, 1);
      scene.add(el);

      tools.onPointerDown(at(20, 20), mods());
      tools.onPointerMove(at(21, 20), mods());
      tools.onPointerUp();

      const after = scene.get(el.id)!;
      expect(after.x).toBe(0);
      expect(after.y).toBe(0);
    });

    it('moves the whole selection together', () => {
      const a = box(0, 0, 1);
      const b = box(100, 0, 2);
      scene.add(a);
      scene.add(b);

      tools.selectAll();
      tools.onPointerDown(at(20, 20), mods());
      tools.onPointerMove(at(20, 220), mods());
      tools.onPointerUp();

      expect(scene.get(a.id)!.y).toBeCloseTo(200, 8);
      expect(scene.get(b.id)!.y).toBeCloseTo(200, 8);
      expect(scene.get(b.id)!.x).toBeCloseTo(100, 8); // relative layout preserved
    });

    it('does not start a move on shift-click', () => {
      // Shift-click is a selection gesture. Starting a drag here nudges the
      // shape the user was only trying to add to the selection.
      const a = box(0, 0, 1);
      const b = box(100, 0, 2);
      scene.add(a);
      scene.add(b);

      tools.onPointerDown(at(20, 20), mods());
      tools.onPointerUp();
      tools.onPointerDown(at(120, 20), mods({ shiftKey: true }));
      tools.onPointerMove(at(200, 100), mods({ shiftKey: true }));
      tools.onPointerUp();

      expect(selection.size).toBe(2);
      expect(scene.get(b.id)!.x).toBe(100);
    });

    it('puts everything back exactly on Escape', () => {
      /* Restoring from the snapshot is exact. "Apply the inverse delta" leaves
         floating-point residue, so a cancelled drag would leave the shape a
         fraction of a unit from where it started — every time. */
      const el = box(10, 20, 1);
      scene.add(el);

      tools.onPointerDown(at(30, 40), mods());
      tools.onPointerMove(at(333.7, 291.3), mods());
      tools.cancel();

      const after = scene.get(el.id)!;
      expect(after.x).toBe(10);
      expect(after.y).toBe(20);
    });
  });

  describe('handles win over whatever is behind them', () => {
    it('resizes from a corner rather than selecting the shape underneath', () => {
      /* Handles are drawn on top and sit partly OUTSIDE the shape they belong
         to. Hit-test elements first and grabbing a corner selects whatever
         happens to be behind it — which reads as "the handles do not work". */
      const front = box(0, 0, 2);            // selected, 40×40 at the origin
      const behind = box(30, 30, 1);         // sits under the 'se' handle
      scene.add(behind);
      scene.add(front);

      tools.onPointerDown(at(20, 20), mods()); // select the front one
      tools.onPointerUp();
      expect([...selection.ids()]).toEqual([front.id]);

      tools.onPointerDown(at(40, 40), mods()); // the 'se' handle
      tools.onPointerMove(at(140, 140), mods());
      tools.onPointerUp();

      expect([...selection.ids()]).toEqual([front.id]); // selection unchanged
      expect(scene.get(front.id)!.width).toBeCloseTo(140, 6);
      expect(scene.get(behind.id)!.width).toBe(40);     // untouched
    });

    it('rotates from the handle floating above the shape', () => {
      const el = box(0, 0, 1); // 40×40, centre (20, 20)
      scene.add(el);

      tools.onPointerDown(at(20, 20), mods());
      tools.onPointerUp();

      tools.onPointerDown(at(20, -ROTATE_OFFSET_PX), mods());
      tools.onPointerMove(at(500, 20), mods()); // straight to the right
      tools.onPointerUp();

      const after = scene.get(el.id)!;
      expect(after.angle).toBeCloseTo(Math.PI / 2, 6);
      expect(after.width).toBe(40); // rotation changes the angle and nothing else
      expect(after.x).toBe(0);
    });

    it('refuses to collapse a shape to nothing', () => {
      const el = box(0, 0, 1);
      scene.add(el);

      tools.onPointerDown(at(20, 20), mods());
      tools.onPointerUp();
      tools.onPointerDown(at(40, 40), mods());
      tools.onPointerMove(at(0, 0), mods());
      tools.onPointerUp();

      expect(scene.get(el.id)!.width).toBe(MIN_SIZE);
    });

    it('exposes the box the overlay draws its handles on', () => {
      const el = box(10, 20, 1);
      scene.add(el);
      expect(tools.transformBox).toBeNull();

      tools.onPointerDown(at(30, 40), mods());
      tools.onPointerUp();

      expect(tools.transformBox).toEqual({
        bounds: { minX: 10, minY: 20, maxX: 50, maxY: 60 },
        angle: 0,
      });
    });

    it('gives a multi-selection an axis-aligned box', () => {
      // There is no meaningful shared rotation for a group of differently
      // rotated shapes, and inventing one produces handles that line up with
      // nothing on screen.
      const a = newRectangle({ x: 0, y: 0, width: 40, height: 40, style: FILLED, zIndex: 1, angle: 0.9 });
      const b = box(100, 0, 2);
      scene.add(a);
      scene.add(b);
      tools.selectAll();

      expect(tools.transformBox!.angle).toBe(0);
    });
  });

  describe('hover', () => {
    it('reports a cursor over a handle and nothing over open canvas', () => {
      const el = box(0, 0, 1); // 40×40
      scene.add(el);
      expect(tools.cursor).toBeNull();

      tools.onPointerDown(at(20, 20), mods());
      tools.onPointerUp();

      expect(tools.onPointerHover(at(40, 40), mods())).toBe(true);
      expect(tools.cursor).toBe('nwse-resize');

      expect(tools.onPointerHover(at(500, 500), mods())).toBe(true);
      expect(tools.cursor).toBeNull();
    });

    it('reports a change only when the answer actually changed', () => {
      /* The reason this returns a boolean at all. The Engine calls
         `refreshSnapshot` on true, and a hover that claimed a change every time
         would push a new snapshot 60 times a second to set the same string. */
      const el = box(0, 0, 1);
      scene.add(el);
      tools.onPointerDown(at(20, 20), mods());
      tools.onPointerUp();

      expect(tools.onPointerHover(at(40, 40), mods())).toBe(true);
      expect(tools.onPointerHover(at(41, 41), mods())).toBe(false); // same handle
    });

    it('never touches the scene index', () => {
      // Nine distance checks against a box the tool already has. The expensive
      // question — what element is under the pointer — is still asked only on
      // press, which is what Phase 4b was careful about.
      const el = box(0, 0, 1);
      scene.add(el);
      tools.onPointerDown(at(20, 20), mods());
      tools.onPointerUp();

      const spy = vi.spyOn(scene, 'hitTest');
      for (let x = 0; x < 100; x++) tools.onPointerHover(at(x, 20), mods());
      expect(spy).not.toHaveBeenCalled();
    });

    it('says nothing while a shape tool is active', () => {
      const el = box(0, 0, 1);
      scene.add(el);
      tools.onPointerDown(at(20, 20), mods());
      tools.onPointerUp();
      tools.onPointerHover(at(40, 40), mods());

      tools.setTool('rectangle');
      tools.onPointerHover(at(40, 40), mods());
      expect(tools.cursor).toBeNull();
    });
  });

  it('does not hit-test at all while a shape tool is active', () => {
    // The selection tool is the only one that reads the scene on pointerdown.
    // A shape tool that ran a hit test per press would be doing work whose
    // result it throws away — and at 50,000 elements that is a visible hitch at
    // the start of every stroke.
    const el = box(0, 0, 1);
    scene.add(el);
    const spy = vi.spyOn(scene, 'hitTest');

    tools.setTool('rectangle');
    tools.onPointerDown(at(20, 20), mods());

    expect(spy).not.toHaveBeenCalled();
    expect(selection.isEmpty).toBe(true);
  });
});
