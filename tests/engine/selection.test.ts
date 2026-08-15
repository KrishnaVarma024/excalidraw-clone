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
import type { Bounds, Point } from '@engine/util/geometry';

const FILLED = { ...DEFAULT_STYLE, backgroundColor: '#a5d8ff' };

const mods = (over: Partial<PointerModifiers> = {}): PointerModifiers => ({
  shiftKey: false,
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
