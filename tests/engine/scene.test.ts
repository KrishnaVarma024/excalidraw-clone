import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Scene, type SceneChange } from '@engine/scene/Scene';
import { newRectangle } from '@engine/scene/elementFactory';
import { DEFAULT_STYLE } from '@engine/scene/element.types';
import type { Bounds } from '@engine/util/geometry';

function rect(x: number, y: number, w = 10, h = 10, zIndex = 1) {
  return newRectangle({ x, y, width: w, height: h, style: DEFAULT_STYLE, zIndex });
}

const view = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

describe('Scene', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = new Scene();
  });

  describe('the version invariant', () => {
    /**
     * The whole render cache rests on this. If a mutation can happen without a
     * version bump, `roughCache` will hand back a stale drawable and the shape
     * on screen stops matching the data — with nothing to indicate why.
     */
    it('bumps version on every real mutation', () => {
      const el = rect(0, 0);
      scene.add(el);
      expect(scene.get(el.id)!.version).toBe(1);

      scene.mutate(el.id, { x: 5 });
      expect(scene.get(el.id)!.version).toBe(2);

      scene.mutate(el.id, { strokeColor: '#ff0000' });
      expect(scene.get(el.id)!.version).toBe(3);
    });

    it('does NOT bump version for a no-op patch', () => {
      // A mutator that reports change for a no-op means the canvas repaints
      // forever at 60fps while completely idle.
      const el = rect(0, 0);
      scene.add(el);

      expect(scene.mutate(el.id, { x: el.x })).toBe(false);
      expect(scene.mutate(el.id, {})).toBe(false);
      expect(scene.get(el.id)!.version).toBe(1);
    });

    it('reports false for an unknown id rather than throwing', () => {
      expect(scene.mutate('does-not-exist', { x: 1 })).toBe(false);
    });

    it('never mutates the original object — every change is a new reference', () => {
      // Structural sharing is what makes Phase 8's undo cheap: a snapshot can
      // hold the old object and know it will not change underneath it.
      const el = rect(0, 0);
      scene.add(el);
      const before = scene.get(el.id)!;

      scene.mutate(el.id, { x: 99 });
      const after = scene.get(el.id)!;

      expect(after).not.toBe(before);
      expect(before.x).toBe(0);
      expect(after.x).toBe(99);
    });
  });

  describe('soft delete', () => {
    it('hides the element without losing it', () => {
      const el = rect(0, 0);
      scene.add(el);

      scene.remove(el.id);

      expect(scene.visibleCount).toBe(0);
      expect(scene.sorted()).toHaveLength(0);
      // Still retrievable — which is exactly what makes undo a flag flip rather
      // than a resurrection.
      expect(scene.get(el.id)).toBeDefined();
      expect(scene.get(el.id)!.isDeleted).toBe(true);
      expect(scene.size).toBe(1);
    });

    it('restores by flipping the flag back', () => {
      const el = rect(0, 0);
      scene.add(el);
      scene.remove(el.id);
      scene.mutate(el.id, { isDeleted: false });

      expect(scene.visibleCount).toBe(1);
    });

    it('compact() physically drops deleted elements', () => {
      const a = rect(0, 0);
      const b = rect(20, 0);
      scene.add(a);
      scene.add(b);
      scene.remove(a.id);

      expect(scene.compact()).toBe(1);
      expect(scene.size).toBe(1);
      expect(scene.get(a.id)).toBeUndefined();
      expect(scene.get(b.id)).toBeDefined();
    });
  });

  describe('z-order', () => {
    it('sorts ascending, so higher zIndex draws last and appears on top', () => {
      const bottom = rect(0, 0, 10, 10, 1);
      const top = rect(0, 0, 10, 10, 5);
      const middle = rect(0, 0, 10, 10, 3);

      scene.add(top);
      scene.add(bottom);
      scene.add(middle);

      expect(scene.sorted().map((e) => e.id)).toEqual([bottom.id, middle.id, top.id]);
    });

    it('hands out increasing zIndex from nextZIndex()', () => {
      const a = rect(0, 0, 10, 10, scene.nextZIndex());
      scene.add(a);
      const b = rect(0, 0, 10, 10, scene.nextZIndex());
      scene.add(b);

      expect(b.zIndex).toBeGreaterThan(a.zIndex);
    });

    it('reorders without invalidating anything but the sort cache', () => {
      const a = rect(0, 0, 10, 10, 1);
      const b = rect(0, 0, 10, 10, 2);
      scene.add(a);
      scene.add(b);

      scene.mutate(a.id, { zIndex: 99 });
      expect(scene.sorted().map((e) => e.id)).toEqual([b.id, a.id]);
    });
  });

  describe('viewport culling', () => {
    it('returns only elements intersecting the view', () => {
      const inside = rect(0, 0, 10, 10);
      const outside = rect(10_000, 10_000, 10, 10);
      scene.add(inside);
      scene.add(outside);

      const visible = scene.visible(view(-100, -100, 100, 100));
      expect(visible.map((e) => e.id)).toEqual([inside.id]);
    });

    it('includes elements that only partially overlap', () => {
      // Conservative on purpose: an element clipped by the viewport edge must
      // still be drawn, or shapes visibly pop in as you pan.
      const straddling = rect(90, 90, 40, 40);
      scene.add(straddling);
      expect(scene.visible(view(0, 0, 100, 100))).toHaveLength(1);
    });

    it('accounts for render padding, not just geometry', () => {
      // An element whose geometry sits just outside the view can still paint
      // inside it, because the stroke straddles the path and rough.js jitters
      // outward. Culling on geometry bounds alone clips those pixels away.
      const el = newRectangle({
        x: 101,
        y: 0,
        width: 10,
        height: 10,
        style: { ...DEFAULT_STYLE, strokeWidth: 8, roughness: 2 },
        zIndex: 1,
      });
      scene.add(el);
      expect(scene.visible(view(0, 0, 100, 100))).toHaveLength(1);
    });

    it('excludes deleted elements', () => {
      const el = rect(0, 0);
      scene.add(el);
      scene.remove(el.id);
      expect(scene.visible(view(-100, -100, 100, 100))).toHaveLength(0);
    });

    it('returns results in z-order', () => {
      scene.add(rect(0, 0, 10, 10, 9));
      scene.add(rect(1, 1, 10, 10, 2));
      const z = scene.visible(view(-100, -100, 100, 100)).map((e) => e.zIndex);
      expect(z).toEqual([...z].sort((a, b) => a - b));
    });
  });

  describe('change notification', () => {
    /**
     * The `before`/`after` pair is not decoration. In Phase 5 a moved element
     * dirties TWO rectangles — where it was and where it is. Reporting only the
     * new bounds smears the shape across the canvas.
     */
    it('reports before and after bounds on a move', () => {
      const changes: SceneChange[] = [];
      const el = rect(0, 0, 10, 10);
      scene.add(el);
      scene.subscribe((c) => changes.push(c));

      scene.mutate(el.id, { x: 500 });

      expect(changes).toHaveLength(1);
      const [change] = changes;
      expect(change!.before).not.toBeNull();
      expect(change!.after).not.toBeNull();
      expect(change!.before!.minX).toBeLessThan(100);
      expect(change!.after!.minX).toBeGreaterThan(400);
    });

    it('reports a null "before" on add and a null "after" on delete', () => {
      const changes: SceneChange[] = [];
      scene.subscribe((c) => changes.push(c));

      const el = rect(0, 0);
      scene.add(el);
      expect(changes[0]!.before).toBeNull();
      expect(changes[0]!.after).not.toBeNull();

      scene.remove(el.id);
      expect(changes[1]!.before).not.toBeNull();
      expect(changes[1]!.after).toBeNull();
    });

    it('does not notify for a no-op', () => {
      const listener = vi.fn();
      const el = rect(0, 0);
      scene.add(el);
      scene.subscribe(listener);

      scene.mutate(el.id, { x: el.x });
      expect(listener).not.toHaveBeenCalled();
    });

    it('stops notifying after unsubscribe', () => {
      const listener = vi.fn();
      const unsubscribe = scene.subscribe(listener);
      unsubscribe();
      scene.add(rect(0, 0));
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('guards', () => {
    it('refuses a duplicate id rather than silently replacing', () => {
      const el = rect(0, 0);
      scene.add(el);
      // Silently overwriting would orphan every reference to the first element —
      // history entries, bound text, selection — with no error anywhere.
      expect(() => scene.add(el)).toThrow(/already contains/);
    });
  });
});
