/**
 * Move, resize and rotate.
 *
 * Named `elementTransform` rather than `transform` because `transform.test.ts`
 * is already taken by Phase 1's *viewport* transform. Two different things are
 * called "transform" in a canvas editor and they are worth keeping apart: one
 * maps scene space to the screen, the other changes what is in the scene.
 *
 * Everything below is a pure function over numbers, so the interesting cases are
 * the ones a demo gets wrong and a product gets right:
 *
 *   - the anchor stays fixed **in world space** when the shape is rotated;
 *   - Shift locks the aspect ratio to the shape's ORIGINAL proportions, not to
 *     whatever it happens to be at the instant the key went down;
 *   - a group rotation advances each child's own angle as well as orbiting it.
 */

import { describe, expect, it } from 'vitest';
import {
  HANDLE_SIZE_PX,
  cursorForHandle,
  MIN_SIZE,
  ROTATE_OFFSET_PX,
  ROTATE_SNAP,
  type GeometryPatch,
  type GroupSnapshot,
  type TransformModifiers,
  geometryOf,
  getHandlePositions,
  groupBoundsOf,
  hitTestHandles,
  moveGeometry,
  resizeGeometry,
  resizeGroup,
  rotateGeometry,
  rotateGroup,
} from '@engine/scene/transform';
import { newRectangle } from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, type Element, type ElementId } from '@engine/scene/element.types';
import { TAU } from '@engine/util/math';
import { rotatePoint, type Bounds, type Point } from '@engine/util/geometry';

const at = (x: number, y: number): Point => ({ x, y });

const NONE: TransformModifiers = { shiftKey: false, altKey: false };
const SHIFT: TransformModifiers = { shiftKey: true, altKey: false };
const ALT: TransformModifiers = { shiftKey: false, altKey: true };

const geo = (x: number, y: number, width: number, height: number, angle = 0): GeometryPatch => ({
  x,
  y,
  width,
  height,
  angle,
});

const box = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

const centreOf = (g: GeometryPatch): Point => ({
  x: g.x + g.width / 2,
  y: g.y + g.height / 2,
});

/** Where a normalised corner of a (possibly rotated) box actually lands. */
function worldCorner(g: GeometryPatch, u: number, v: number): Point {
  const p = { x: g.x + g.width * u, y: g.y + g.height * v };
  return g.angle === 0 ? p : rotatePoint(p, centreOf(g), g.angle);
}

function rect(x: number, y: number, w: number, h: number, angle = 0): Element {
  return newRectangle({ x, y, width: w, height: h, style: DEFAULT_STYLE, zIndex: 1, angle });
}

const find = (positions: ReturnType<typeof getHandlePositions>, kind: string): Point =>
  positions.find((h) => h.kind === kind)!.point;

/* ── handles ──────────────────────────────────────────────────────────────── */

describe('handle positions', () => {
  const B = box(0, 0, 100, 60);

  it('offers eight resize handles and one rotation handle', () => {
    const handles = getHandlePositions(B, 0, 1);
    expect(handles).toHaveLength(9);
    expect(handles.filter((h) => h.kind === 'rotate')).toHaveLength(1);
  });

  it('puts the corners on the corners and the edges on the edges', () => {
    const h = getHandlePositions(B, 0, 1);
    expect(find(h, 'nw')).toEqual(at(0, 0));
    expect(find(h, 'ne')).toEqual(at(100, 0));
    expect(find(h, 'se')).toEqual(at(100, 60));
    expect(find(h, 'sw')).toEqual(at(0, 60));
    expect(find(h, 'n')).toEqual(at(50, 0));
    expect(find(h, 'w')).toEqual(at(0, 30));
  });

  it('floats the rotation handle above the top edge', () => {
    // Above, not on. A rotation handle sitting on the shape is a rotation handle
    // you cannot tell apart from the top edge.
    const r = find(getHandlePositions(B, 0, 1), 'rotate');
    expect(r).toEqual(at(50, -ROTATE_OFFSET_PX));
  });

  it('keeps handles a constant size ON SCREEN, so the scene offset shrinks with zoom', () => {
    /* This is the whole reason `zoom` is a parameter. A handle that scaled with
       the document would be a speck at 10% and cover the shape at 3000%. The
       screen-space offset is fixed at ROTATE_OFFSET_PX; the SCENE offset is
       that divided by zoom. */
    const near = find(getHandlePositions(B, 0, 4), 'rotate');
    const far = find(getHandlePositions(B, 0, 0.25), 'rotate');

    expect(-near.y).toBeCloseTo(ROTATE_OFFSET_PX / 4, 10);
    expect(-far.y).toBeCloseTo(ROTATE_OFFSET_PX / 0.25, 10);

    // In screen pixels — the number the user's eye actually sees — both are 22.
    expect(-near.y * 4).toBeCloseTo(-far.y * 0.25, 10);
  });

  it('carries the handles round with the shape when it is rotated', () => {
    // A quarter turn about the centre of a 100×60 box centred at (50, 30):
    // the top-left corner swings to where the top-right used to be.
    const h = getHandlePositions(B, TAU / 4, 1);
    const nw = find(h, 'nw');
    expect(nw.x).toBeCloseTo(80, 8);
    expect(nw.y).toBeCloseTo(-20, 8);
  });
});

describe('hitTestHandles', () => {
  const B = box(0, 0, 200, 200);

  it('finds the corner you aimed at', () => {
    expect(hitTestHandles(at(200, 200), B, 0, 1)).toBe('se');
    expect(hitTestHandles(at(0, 0), B, 0, 1)).toBe('nw');
  });

  it('finds nothing in the middle of the shape', () => {
    // Deliberately: the middle of a selected shape is where a *move* starts.
    expect(hitTestHandles(at(100, 100), B, 0, 1)).toBeNull();
  });

  it('is forgiving, and forgiving in SCREEN pixels', () => {
    /* Handles are 8 screen pixels and humans miss 8-pixel squares constantly, so
       the reach is 1.5 handles. Being generous is free: the only thing behind a
       handle is the shape it belongs to, which is already selected.

       The reach must be a screen distance, though. 10 scene units is inside the
       reach at zoom 1 and outside it at zoom 2, because at zoom 2 those same 10
       units are 20 screen pixels away. */
    const near = at(200 - 10, 200 - 10);
    expect(HANDLE_SIZE_PX * 1.5).toBeGreaterThan(10); // reach at zoom 1
    expect(hitTestHandles(near, B, 0, 1)).toBe('se');
    expect(hitTestHandles(near, B, 0, 2)).toBeNull();
  });

  it('finds the rotation handle where it floats, not on the edge', () => {
    expect(hitTestHandles(at(100, -ROTATE_OFFSET_PX), B, 0, 1)).toBe('rotate');
    expect(hitTestHandles(at(100, 0), B, 0, 1)).toBe('n');
  });

  it('follows the shape into rotation', () => {
    // Grab where the corner *looks like it is*, not where its un-rotated
    // coordinates say. Same idea as hit-testing a rotated element in Phase 4b.
    const angle = TAU / 6;
    const nw = find(getHandlePositions(B, angle, 1), 'nw');
    expect(hitTestHandles(nw, B, angle, 1)).toBe('nw');
    expect(hitTestHandles(at(0, 0), B, angle, 1)).toBeNull();
  });
});

/* ── move ─────────────────────────────────────────────────────────────────── */

describe('move', () => {
  const original = geo(10, 20, 100, 60, TAU / 8);

  it('translates and touches nothing else', () => {
    const moved = moveGeometry(original, 30, -15);
    expect(moved).toEqual(geo(40, 5, 100, 60, TAU / 8));
  });

  it('is exact when the pointer comes home', () => {
    /* Bit-exact, asserted with `toBe` rather than `toBeCloseTo`, and that is the
       point of the snapshot rule. An implementation that adds each frame's delta
       to the current position cannot promise this — see the drift test at the
       bottom of this file. */
    const home = moveGeometry(original, 0, 0);
    expect(home.x).toBe(original.x);
    expect(home.y).toBe(original.y);
  });
});

/* ── resize ───────────────────────────────────────────────────────────────── */

describe('resize — the anchor stays put', () => {
  const original = geo(0, 0, 100, 60);

  it('holds the top-left when the bottom-right handle moves', () => {
    const next = resizeGeometry(original, 'se', at(300, 200), NONE);
    expect(next.x).toBeCloseTo(0, 10);
    expect(next.y).toBeCloseTo(0, 10);
    expect(next.width).toBeCloseTo(300, 10);
    expect(next.height).toBeCloseTo(200, 10);
  });

  it('holds the bottom-right when the top-left handle moves', () => {
    const next = resizeGeometry(original, 'nw', at(-40, -40), NONE);
    expect(next.x + next.width).toBeCloseTo(100, 10);
    expect(next.y + next.height).toBeCloseTo(60, 10);
    expect(next.width).toBeCloseTo(140, 10);
    expect(next.height).toBeCloseTo(100, 10);
  });

  it('lets an edge handle move exactly one axis', () => {
    // The AXES table is what stops `n` from squashing the width to wherever the
    // cursor's x happened to be.
    const north = resizeGeometry(original, 'n', at(9999, -40), NONE);
    expect(north.width).toBeCloseTo(100, 10);
    expect(north.x).toBeCloseTo(0, 10);
    expect(north.height).toBeCloseTo(100, 10);

    const east = resizeGeometry(original, 'e', at(250, 9999), NONE);
    expect(east.height).toBeCloseTo(60, 10);
    expect(east.y).toBeCloseTo(0, 10);
    expect(east.width).toBeCloseTo(250, 10);
  });

  it('never produces a negative size when dragged past the anchor', () => {
    /* v1 mirrors the size rather than flipping the shape through its anchor. A
       negative width would break every downstream consumer — bounds, hit test,
       the quadtree — so `Math.abs` here is load-bearing, not defensive. */
    const next = resizeGeometry(original, 'se', at(-50, -30), NONE);
    expect(next.width).toBeCloseTo(50, 10);
    expect(next.height).toBeCloseTo(30, 10);
    expect(next.width).toBeGreaterThan(0);
    expect(next.height).toBeGreaterThan(0);
  });

  it('clamps to MIN_SIZE instead of collapsing', () => {
    // A zero-size element is invisible, unselectable and impossible to recover
    // from with the mouse. Refusing to make one is cheaper than an undo.
    const next = resizeGeometry(original, 'se', at(0, 0), NONE);
    expect(next.width).toBe(MIN_SIZE);
    expect(next.height).toBe(MIN_SIZE);
  });

  it('leaves the angle alone', () => {
    const rotated = geo(0, 0, 100, 60, 1.1);
    expect(resizeGeometry(rotated, 'se', at(200, 200), NONE).angle).toBe(1.1);
  });
});

describe('resize — rotated, and the step people forget', () => {
  const original = geo(0, 0, 100, 60, TAU / 8);

  it('keeps the anchor fixed in WORLD space', () => {
    /* The one assertion this whole module exists for.

       Resizing happens in the element's local frame, which moves the local
       centre. The anchor has to stay where the user can see it — in world
       space — so the new world centre is the old one plus the local centre
       delta, rotated back out. */
    const before = worldCorner(original, 0, 0); // 'se' anchors on the top-left
    const next = resizeGeometry(original, 'se', at(150, 90), NONE);
    const after = worldCorner(next, 0, 0);

    expect(after.x).toBeCloseTo(before.x, 8);
    expect(after.y).toBeCloseTo(before.y, 8);
  });

  it('and the naive version — no rotate-back — visibly drifts', () => {
    /* Documenting the bug this avoids, because "it works" is not evidence that
       the tricky line is doing anything. This is `resizeGeometry` with step 3
       deleted: resize in local space, keep the local box. */
    const naive = (g: GeometryPatch, pointer: Point): GeometryPatch => {
      const c = centreOf(g);
      const local = rotatePoint(pointer, c, -g.angle);
      return { ...g, width: Math.abs(local.x - g.x), height: Math.abs(local.y - g.y) };
    };

    const before = worldCorner(original, 0, 0);
    const after = worldCorner(naive(original, at(150, 90)), 0, 0);
    const slide = Math.hypot(after.x - before.x, after.y - before.y);

    // Tens of scene units — the shape crawls out from under the cursor. It looks
    // like a physics bug and it is a missing rotation.
    expect(slide).toBeGreaterThan(10);
  });

  it('grows along the shape’s own axes, not the screen’s', () => {
    // Dragging 'e' on a shape rotated a quarter turn must make it wider in the
    // shape's frame, which on screen is taller.
    const quarter = geo(0, 0, 100, 60, TAU / 4);
    const pointer = rotatePoint(at(200, 30), centreOf(quarter), TAU / 4);
    const next = resizeGeometry(quarter, 'e', pointer, NONE);

    expect(next.width).toBeCloseTo(200, 6);
    expect(next.height).toBeCloseTo(60, 6);
  });
});

describe('resize — modifiers', () => {
  const original = geo(0, 0, 100, 50); // ratio 2:1

  it('locks the aspect ratio with Shift', () => {
    const next = resizeGeometry(original, 'se', at(40, 300), SHIFT);
    expect(next.width / next.height).toBeCloseTo(2, 8);
  });

  it('locks to the ORIGINAL ratio, not to the current one', () => {
    /* The reason `original` is a parameter and the reason this module never
       reads the live element.

       Drag the shape to 400×400 (ratio 1) without Shift, then press Shift. An
       incremental implementation locks to 1:1, because 1:1 is what the shape is
       at that instant. It must lock to 2:1 — what the user drew. */
    const squareish = resizeGeometry(original, 'se', at(400, 400), NONE);
    expect(squareish.width / squareish.height).toBeCloseTo(1, 8);

    const locked = resizeGeometry(original, 'se', at(400, 400), SHIFT);
    expect(locked.width / locked.height).toBeCloseTo(2, 8);
  });

  it('follows the cursor exactly again when Shift is released', () => {
    // Same snapshot, same pointer, no modifier: back to free resizing with no
    // memory of the locked frames in between.
    const free = resizeGeometry(original, 'se', at(400, 400), NONE);
    expect(free.width).toBeCloseTo(400, 8);
    expect(free.height).toBeCloseTo(400, 8);
  });

  it('ignores Shift on an edge handle, because one axis cannot have a ratio', () => {
    const next = resizeGeometry(original, 's', at(0, 500), SHIFT);
    expect(next.width).toBeCloseTo(100, 10);
    expect(next.height).toBeCloseTo(500, 10);
  });

  it('resizes about the centre with Alt', () => {
    const before = centreOf(original);
    const next = resizeGeometry(original, 'se', at(150, 90), ALT);

    expect(centreOf(next).x).toBeCloseTo(before.x, 8);
    expect(centreOf(next).y).toBeCloseTo(before.y, 8);
    // Twice the centre-to-pointer distance on each axis.
    expect(next.width).toBeCloseTo((150 - 50) * 2, 8);
    expect(next.height).toBeCloseTo((90 - 25) * 2, 8);
  });
});

/* ── rotate ───────────────────────────────────────────────────────────────── */

describe('rotate', () => {
  const original = geo(0, 0, 100, 60); // centre (50, 30)

  it('reads zero when the pointer is straight above the centre', () => {
    /* The handle STARTS above the centre, so the angle is measured from "up":
       atan2(dy, dx) + a quarter turn. Get that offset wrong and the shape jumps
       90° the instant you grab it — the most common rotation bug there is, and
       invisible in a screenshot. */
    expect(rotateGeometry(original, at(50, -100), NONE).angle).toBeCloseTo(0, 10);
  });

  it('reads a quarter turn to the right and a half turn below', () => {
    expect(rotateGeometry(original, at(500, 30), NONE).angle).toBeCloseTo(TAU / 4, 10);
    expect(rotateGeometry(original, at(50, 500), NONE).angle).toBeCloseTo(TAU / 2, 10);
  });

  it('snaps to 15° with Shift', () => {
    // 20° from up is nearer 15° than 30°.
    const pointer = rotatePoint(at(50, -100), centreOf(original), (20 / 360) * TAU);
    const snapped = rotateGeometry(original, pointer, SHIFT).angle;
    expect(snapped).toBeCloseTo(ROTATE_SNAP, 8);
    expect(snapped).toBeCloseTo((15 / 360) * TAU, 8);
  });

  it('moves nothing but the angle', () => {
    const next = rotateGeometry(original, at(500, 500), NONE);
    expect(next.x).toBe(original.x);
    expect(next.y).toBe(original.y);
    expect(next.width).toBe(original.width);
    expect(next.height).toBe(original.height);
  });

  it('normalises into [0, TAU)', () => {
    // Otherwise the angle wanders off to ±40 radians over a long session and
    // every comparison against it needs a modulo the caller will forget.
    const left = rotateGeometry(original, at(-500, 30), NONE).angle;
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThan(TAU);
    expect(left).toBeCloseTo((TAU * 3) / 4, 10);
  });
});

/* ── groups ───────────────────────────────────────────────────────────────── */

describe('groupBoundsOf', () => {
  it('is null for an empty selection', () => {
    expect(groupBoundsOf([])).toBeNull();
  });

  it('unions the children', () => {
    expect(groupBoundsOf([rect(0, 0, 10, 10), rect(100, 50, 20, 20)])).toEqual(
      box(0, 0, 120, 70),
    );
  });

  it('wraps what a rotated child LOOKS like, not what its numbers say', () => {
    /* A 100×100 square turned 45° still reads x:0 y:0 w:100 h:100, but it
       occupies a diamond ~141 units across. Use the raw numbers and the handles
       cut through the corners of the shape they are supposed to contain. */
    const b = groupBoundsOf([rect(0, 0, 100, 100, TAU / 8)])!;
    const half = 100 * Math.SQRT2 / 2;
    expect(b.minX).toBeCloseTo(50 - half, 6);
    expect(b.maxX).toBeCloseTo(50 + half, 6);
  });
});

describe('resizeGroup', () => {
  const a: GroupSnapshot = { id: 'a' as ElementId, geometry: geo(0, 0, 50, 50) };
  const b: GroupSnapshot = { id: 'b' as ElementId, geometry: geo(150, 100, 50, 100) };
  const groupBox = box(0, 0, 200, 200);

  it('scales offsets and sizes by the same factors', () => {
    // Drag 'se' from (200, 200) to (400, 400): everything doubles about (0, 0).
    const out = resizeGroup([a, b], groupBox, 'se', at(400, 400), NONE);

    const A = out.get(a.id)!;
    expect(A.x).toBeCloseTo(0, 8);
    expect(A.width).toBeCloseTo(100, 8);

    const B = out.get(b.id)!;
    expect(B.x).toBeCloseTo(300, 8);
    expect(B.y).toBeCloseTo(200, 8);
    expect(B.width).toBeCloseTo(100, 8);
    expect(B.height).toBeCloseTo(200, 8);
  });

  it('holds the group anchor still', () => {
    const out = resizeGroup([a, b], groupBox, 'nw', at(-200, -200), NONE);
    const B = out.get(b.id)!;
    // The bottom-right of the group box was (200, 200) and must stay there.
    expect(B.x + B.width).toBeCloseTo(200, 6);
    expect(B.y + B.height).toBeCloseTo(200, 6);
  });

  it('keeps each child’s own rotation', () => {
    const spun: GroupSnapshot = { id: 'c' as ElementId, geometry: geo(0, 0, 50, 50, 0.7) };
    const out = resizeGroup([spun], groupBox, 'se', at(400, 400), NONE);
    expect(out.get(spun.id)!.angle).toBe(0.7);
  });

  it('clamps a shrinking child to MIN_SIZE', () => {
    const out = resizeGroup([a, b], groupBox, 'se', at(1, 1), NONE);
    expect(out.get(a.id)!.width).toBeGreaterThanOrEqual(MIN_SIZE);
    expect(out.get(b.id)!.height).toBeGreaterThanOrEqual(MIN_SIZE);
  });
});

describe('rotateGroup', () => {
  const groupBox = box(0, 0, 100, 100); // centre (50, 50)
  const child: GroupSnapshot = { id: 'a' as ElementId, geometry: geo(0, 0, 20, 20) };
  /** Gesture started straight above the centre, so `delta` is the whole angle. */
  const START = 0;

  it('orbits each child around the group centre', () => {
    // Quarter turn: the child at the top-left swings to the top-right.
    const out = rotateGroup([child], groupBox, at(500, 50), NONE, START);
    const c = out.get(child.id)!;
    expect(c.x + c.width / 2).toBeCloseTo(90, 6);
    expect(c.y + c.height / 2).toBeCloseTo(10, 6);
  });

  it('advances each child’s OWN angle too — the carousel bug', () => {
    /* Orbit the centres without turning the shapes and the selection slides
       around a circle staying upright, like horses on a carousel. Both halves
       or neither. */
    const out = rotateGroup([child], groupBox, at(500, 50), NONE, START);
    expect(out.get(child.id)!.angle).toBeCloseTo(TAU / 4, 8);
  });

  it('adds to whatever angle the child already had', () => {
    const spun: GroupSnapshot = { id: 'b' as ElementId, geometry: geo(0, 0, 20, 20, TAU / 8) };
    const out = rotateGroup([spun], groupBox, at(500, 50), NONE, START);
    expect(out.get(spun.id)!.angle).toBeCloseTo(TAU / 8 + TAU / 4, 8);
  });

  it('does nothing at all at zero delta', () => {
    // Where the gesture began. A group that jumps the moment you touch the
    // handle is the same off-by-a-quarter-turn bug as the single-element case,
    // and `startAngle` is what prevents it.
    const out = rotateGroup([child], groupBox, at(50, -500), NONE, START);
    const c = out.get(child.id)!;
    expect(c.x).toBeCloseTo(0, 8);
    expect(c.y).toBeCloseTo(0, 8);
    expect(c.angle).toBeCloseTo(0, 8);
  });

  it('snaps with Shift', () => {
    const pointer = rotatePoint(at(50, -500), { x: 50, y: 50 }, (20 / 360) * TAU);
    const out = rotateGroup([child], groupBox, pointer, SHIFT, START);
    expect(out.get(child.id)!.angle).toBeCloseTo(ROTATE_SNAP, 6);
  });
});

/* ── cursors ──────────────────────────────────────────────────────────────── */

describe('cursorForHandle', () => {
  it('names the four resize cursors correctly on an upright shape', () => {
    expect(cursorForHandle('n', 0)).toBe('ns-resize');
    expect(cursorForHandle('s', 0)).toBe('ns-resize');
    expect(cursorForHandle('e', 0)).toBe('ew-resize');
    expect(cursorForHandle('w', 0)).toBe('ew-resize');
    expect(cursorForHandle('nw', 0)).toBe('nwse-resize');
    expect(cursorForHandle('se', 0)).toBe('nwse-resize');
    expect(cursorForHandle('ne', 0)).toBe('nesw-resize');
    expect(cursorForHandle('sw', 0)).toBe('nesw-resize');
  });

  it('rotates the cursor with the shape', () => {
    /* The detail nobody files a bug about and everybody feels. On a shape turned
       a quarter turn, the handle still *called* `nw` is visually in the
       top-right, so a `nwse` arrow there points across the shape instead of
       along the direction it will actually resize. */
    expect(cursorForHandle('nw', TAU / 4)).toBe('nesw-resize');
    expect(cursorForHandle('n', TAU / 4)).toBe('ew-resize');
    expect(cursorForHandle('e', TAU / 4)).toBe('ns-resize');
  });

  it('snaps to the nearest octant rather than only at exact multiples', () => {
    // Shapes are rarely at exactly 45°. A cursor that only rotated at the
    // boundaries would be wrong for every angle in between.
    expect(cursorForHandle('n', TAU / 4 + 0.2)).toBe('ew-resize');
    expect(cursorForHandle('n', TAU / 4 - 0.2)).toBe('ew-resize');
  });

  it('handles negative and over-turn angles', () => {
    // `normalizeAngle` inside means callers never have to.
    expect(cursorForHandle('n', -TAU / 4)).toBe('ew-resize');
    expect(cursorForHandle('n', TAU * 3 + TAU / 4)).toBe('ew-resize');
  });

  it('uses move and grab for the two non-resize cases', () => {
    expect(cursorForHandle(null, 0)).toBe('move');
    expect(cursorForHandle('rotate', 1.3)).toBe('grab');
  });
});

/* ── the rule ─────────────────────────────────────────────────────────────── */

describe('why every function here takes a snapshot', () => {
  it('a snapshot resize is bit-exact after an out-and-back drag; incremental is not', () => {
    /* Drag the 'e' handle out 100 units and back, one pixel-ish per frame, and
       ask what the width is.

       Snapshot: the pointer is where it started, so the answer is the number it
       started at — exactly, `toBe`, no tolerance.

       Incremental: 1,200 multiplications by a per-frame ratio, and the shape is
       a fraction of a unit narrower than it was. One drag is invisible. Ten
       minutes of fiddling is a shape that no longer lines up with the one next
       to it, and there is nothing in the UI to explain why. */
    const original = geo(0, 0, 100, 60);

    const path: number[] = [];
    for (let i = 1; i <= 300; i++) path.push(100 + i / 3);
    for (let i = 299; i >= 0; i--) path.push(100 + i / 3);

    let snapshotWidth = original.width;
    for (const x of path) {
      snapshotWidth = resizeGeometry(original, 'e', at(x, 30), NONE).width;
    }
    expect(snapshotWidth).toBe(100);

    let incrementalWidth = original.width;
    let previous = 100;
    for (const x of path) {
      incrementalWidth = incrementalWidth * (x / previous);
      previous = x;
    }
    expect(incrementalWidth).not.toBe(100);
    expect(incrementalWidth).toBeCloseTo(100, 8); // small, and it never comes back
  });

  it('geometryOf takes only the five numbers a transform may change', () => {
    // Not the id, not the version, not the points. A transform that can touch
    // `version` can defeat the render cache from Phase 2 by accident.
    const el = rect(3, 4, 5, 6, 0.5);
    expect(geometryOf(el)).toEqual(geo(3, 4, 5, 6, 0.5));
  });
});
