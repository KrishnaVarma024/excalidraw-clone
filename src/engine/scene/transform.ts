/**
 * Move, resize and rotate — the geometry, with no state and no canvas.
 *
 * ── The rule that makes every gesture in this phase correct ─────────────────
 *
 *   **Transform from a snapshot, never incrementally.**
 *
 * Every function here takes the element as it was when the gesture *started*
 * plus the pointer's current position, and returns what the element should be
 * now. Nothing here reads the element's current state, and nothing accumulates.
 *
 * The incremental version — "apply this frame's delta to whatever it is now" —
 * is the obvious implementation and it is wrong in three separate ways:
 *
 *   1. **Drift.** Sixty floating-point additions a second, and a shape that
 *      returns to its starting pixel is a few thousandths away from where it
 *      began. Rotate a shape 360° incrementally and it is no longer square.
 *   2. **Modifiers stop working.** Press Shift halfway through a resize and the
 *      aspect ratio must lock relative to the *original*, not to the accidental
 *      ratio the shape happens to have at that instant. Release it and the shape
 *      must return to following the cursor exactly. Incremental code cannot do
 *      either.
 *   3. **Undo becomes a diff of a diff.** Phase 8 wants "the element was X, now
 *      it is Y". A snapshot transform hands it that for free.
 *
 * ── Rotation is handled by moving the pointer, not the shape ────────────────
 *
 * Resizing a rotated rectangle by computing rotated corner positions is a page
 * of trigonometry with a sign error hiding in it. Instead:
 *
 *   1. Rotate the pointer *into* the element's local, un-rotated frame.
 *   2. Do the resize there, where the maths is `minX = pointer.x` and nothing else.
 *   3. Rotate the resulting centre back out to world space.
 *
 * Step 3 is the part people miss. Resizing in local space moves the local
 * centre, and the fixed anchor must stay fixed in **world** space — so the new
 * world centre is the old world centre plus the local centre delta, rotated.
 * Skip it and a rotated shape crawls sideways as you resize it, which looks like
 * a physics bug and is really a missing rotation.
 *
 * This is the same trick as `hitTest.ts` (rotate the point, not the shape) and
 * the mirror of `drawElement` (rotate the canvas, not the shape). Three
 * different problems, one idea.
 */

import {
  type Bounds,
  type Point,
  boundsFromRect,
  rotatePoint,
} from '../util/geometry';
import { normalizeAngle, roundTo, TAU } from '../util/math';
import type { Element, ElementId } from './element.types';
import { getElementCenter, getGeometryBounds } from './bounds';

/** The eight resize handles plus the rotation handle. */
export type HandleKind = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export const RESIZE_HANDLES: readonly HandleKind[] = [
  'nw',
  'n',
  'ne',
  'e',
  'se',
  's',
  'sw',
  'w',
];

/** Handle square size, in SCREEN pixels. Divided by zoom before use. */
export const HANDLE_SIZE_PX = 8;

/** How far above the top edge the rotation handle floats, in SCREEN pixels. */
export const ROTATE_OFFSET_PX = 22;

/** Rotation snaps to 15° with Shift, matching the line tool's angle snap. */
export const ROTATE_SNAP = TAU / 24;

/** Below this, a resize is refused rather than producing a zero or inverted shape. */
export const MIN_SIZE = 1;

/**
 * Anchor for each handle, in normalised local coordinates.
 *
 * `[0,0]` is the top-left of the un-rotated box, `[1,1]` the bottom-right. The
 * anchor is the point that stays *fixed* while the handle is dragged — the
 * opposite corner or edge. Expressing it as a table rather than a switch means
 * the eight cases cannot disagree with each other.
 */
const ANCHOR: Readonly<Record<Exclude<HandleKind, 'rotate'>, readonly [number, number]>> = {
  nw: [1, 1],
  n: [0.5, 1],
  ne: [0, 1],
  e: [0, 0.5],
  se: [0, 0],
  s: [0.5, 0],
  sw: [1, 0],
  w: [1, 0.5],
};

/** Which axes a handle actually changes. An edge handle moves one, a corner two. */
const AXES: Readonly<Record<Exclude<HandleKind, 'rotate'>, readonly [boolean, boolean]>> = {
  nw: [true, true],
  n: [false, true],
  ne: [true, true],
  e: [true, false],
  se: [true, true],
  s: [false, true],
  sw: [true, true],
  w: [true, false],
};

export interface HandlePosition {
  readonly kind: HandleKind;
  /** Centre of the handle, in SCENE space, already rotated with the element. */
  readonly point: Point;
}

/**
 * Where the handles sit for a selection box at a given rotation.
 *
 * `zoom` is required because handles are a constant size *on screen*: the
 * rotation handle floats 22 screen pixels above the top edge, which is
 * `22 / zoom` scene units. Handles that scale with the document would be
 * unusable at both ends of the zoom range.
 */
export function getHandlePositions(box: Bounds, angle: number, zoom: number): HandlePosition[] {
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  const centre = { x: cx, y: cy };

  const at = (u: number, v: number): Point => ({
    x: box.minX + (box.maxX - box.minX) * u,
    y: box.minY + (box.maxY - box.minY) * v,
  });

  const local: [HandleKind, Point][] = [
    ['nw', at(0, 0)],
    ['n', at(0.5, 0)],
    ['ne', at(1, 0)],
    ['e', at(1, 0.5)],
    ['se', at(1, 1)],
    ['s', at(0.5, 1)],
    ['sw', at(0, 1)],
    ['w', at(0, 0.5)],
    ['rotate', { x: cx, y: box.minY - ROTATE_OFFSET_PX / zoom }],
  ];

  return local.map(([kind, point]) => ({
    kind,
    point: angle === 0 ? point : rotatePoint(point, centre, angle),
  }));
}

/**
 * Which handle is under `point`, or null.
 *
 * The hit area is generous — one and a half handle widths — because handles are
 * 8 screen pixels and a human aiming at an 8-pixel square with a mouse misses
 * constantly. Being generous costs nothing: the only thing behind a handle is
 * the element it belongs to, which is already selected.
 *
 * Tested in reverse order so `rotate` wins where it overlaps a corner.
 */
export function hitTestHandles(
  point: Point,
  box: Bounds,
  angle: number,
  zoom: number,
): HandleKind | null {
  const reach = (HANDLE_SIZE_PX * 1.5) / zoom;
  const handles = getHandlePositions(box, angle, zoom);

  for (let i = handles.length - 1; i >= 0; i--) {
    const h = handles[i]!;
    if (Math.abs(point.x - h.point.x) <= reach && Math.abs(point.y - h.point.y) <= reach) {
      return h.kind;
    }
  }
  return null;
}

/** The geometry a transform is allowed to change. */
export interface GeometryPatch {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
}

export interface TransformModifiers {
  /** Resize: lock the aspect ratio. Rotate: snap to 15°. */
  readonly shiftKey: boolean;
  /** Resize from the centre rather than from the opposite anchor. */
  readonly altKey: boolean;
}

export function geometryOf(el: Element): GeometryPatch {
  return { x: el.x, y: el.y, width: el.width, height: el.height, angle: el.angle };
}

/* ── move ─────────────────────────────────────────────────────────────────── */

/**
 * Translate. The only transform that is exact for every element type, because
 * points are stored relative to `x`/`y` — moving a 400-point stroke changes two
 * numbers, not eight hundred.
 */
export function moveGeometry(original: GeometryPatch, dx: number, dy: number): GeometryPatch {
  return { ...original, x: original.x + dx, y: original.y + dy };
}

/* ── resize ───────────────────────────────────────────────────────────────── */

/**
 * Resize one element by dragging `handle` to `pointer`.
 *
 * @param original geometry as it was when the gesture began — never the current
 *   geometry, for the reasons in the file header.
 */
export function resizeGeometry(
  original: GeometryPatch,
  handle: Exclude<HandleKind, 'rotate'>,
  pointer: Point,
  mod: TransformModifiers,
): GeometryPatch {
  const centre = {
    x: original.x + original.width / 2,
    y: original.y + original.height / 2,
  };

  // Step 1: into the element's local, un-rotated frame.
  const local = original.angle === 0 ? pointer : rotatePoint(pointer, centre, -original.angle);

  const [ax, ay] = ANCHOR[handle];
  const [movesX, movesY] = AXES[handle];

  // The anchor, in local space. This is what stays put.
  const anchor = {
    x: original.x + original.width * ax,
    y: original.y + original.height * ay,
  };

  let minX = original.x;
  let minY = original.y;
  let width = original.width;
  let height = original.height;

  if (mod.altKey) {
    /* Alt resizes about the centre: the handle and its opposite move together.
       Half the distance from the centre to the pointer is the new half-extent,
       so the full size is twice that. */
    if (movesX) width = Math.abs(local.x - centre.x) * 2;
    if (movesY) height = Math.abs(local.y - centre.y) * 2;
  } else {
    if (movesX) width = Math.abs(local.x - anchor.x);
    if (movesY) height = Math.abs(local.y - anchor.y);
  }

  if (mod.shiftKey && movesX && movesY) {
    /* Lock the aspect ratio to the ORIGINAL, not to whatever the shape happens
       to be right now — that is the whole reason `original` is a parameter.
       Taking the larger scale factor makes the shape follow the cursor on its
       dominant axis, which is what every editor does and what the hand expects. */
    const ratio = original.height === 0 ? 1 : original.width / original.height;
    if (ratio !== 0 && Number.isFinite(ratio)) {
      const byWidth = width;
      const byHeight = height * ratio;
      const size = Math.max(byWidth, byHeight);
      width = size;
      height = ratio === 0 ? height : size / ratio;
    }
  }

  width = Math.max(width, MIN_SIZE);
  height = Math.max(height, MIN_SIZE);

  if (mod.altKey) {
    minX = centre.x - width / 2;
    minY = centre.y - height / 2;
  } else {
    // Place the box so the anchor lands exactly where it was.
    minX = anchor.x - width * ax;
    minY = anchor.y - height * ay;
  }

  /* Step 3, the one people forget.
     The resize happened in local space, so the local centre moved. The anchor
     must stay fixed in WORLD space, so the world centre has to move by the same
     delta — rotated into world space. Without this a rotated shape slides
     sideways as you resize it. */
  const newLocalCentre = { x: minX + width / 2, y: minY + height / 2 };
  const worldCentre =
    original.angle === 0
      ? newLocalCentre
      : rotatePoint(newLocalCentre, centre, original.angle);

  return {
    x: worldCentre.x - width / 2,
    y: worldCentre.y - height / 2,
    width,
    height,
    angle: original.angle,
  };
}

/* ── rotate ───────────────────────────────────────────────────────────────── */

/**
 * Rotate one element so its rotation handle follows the pointer.
 *
 * The handle starts directly above the centre, so the angle is measured from
 * "up" — `atan2(dy, dx) + π/2`. Getting that offset wrong gives a shape that
 * jumps 90° the instant you grab it, which is the single most common rotation
 * bug and is invisible in a screenshot.
 */
export function rotateGeometry(
  original: GeometryPatch,
  pointer: Point,
  mod: TransformModifiers,
): GeometryPatch {
  const cx = original.x + original.width / 2;
  const cy = original.y + original.height / 2;

  let angle = Math.atan2(pointer.y - cy, pointer.x - cx) + TAU / 4;
  if (mod.shiftKey) angle = roundTo(angle, ROTATE_SNAP);

  return { ...original, angle: normalizeAngle(angle) };
}

/* ── groups ───────────────────────────────────────────────────────────────── */

export interface GroupSnapshot {
  readonly id: ElementId;
  readonly geometry: GeometryPatch;
}

/**
 * Resize a whole selection by dragging a handle on its bounding box.
 *
 * Each element's position and size scale by the same factors relative to the
 * group's fixed anchor. That is exact for un-rotated elements.
 *
 * ── The honest limitation ──────────────────────────────────────────────────
 *
 * For a **rotated** child under a **non-uniform** scale (sx ≠ sy), the correct
 * result is a sheared shape — and shear is not representable in this element
 * model, which stores `{x, y, width, height, angle}` and nothing else. Every
 * editor with this model hits the same wall; the options are to store a full
 * 2×3 matrix per element, to bake the shear into the geometry, or to accept the
 * approximation.
 *
 * This accepts the approximation and scales the child's box anyway, which is
 * exact when `sx === sy` and visibly wrong only for rotated children under
 * strongly non-uniform scaling. Shift-drag gives uniform scaling and is the
 * documented path. The alternative — refusing to resize groups containing
 * rotated elements — is worse, because the user cannot tell why nothing happens.
 */
export function resizeGroup(
  snapshot: readonly GroupSnapshot[],
  groupBox: Bounds,
  handle: Exclude<HandleKind, 'rotate'>,
  pointer: Point,
  mod: TransformModifiers,
): Map<ElementId, GeometryPatch> {
  const boxGeometry: GeometryPatch = {
    x: groupBox.minX,
    y: groupBox.minY,
    width: groupBox.maxX - groupBox.minX,
    height: groupBox.maxY - groupBox.minY,
    angle: 0,
  };

  const next = resizeGeometry(boxGeometry, handle, pointer, mod);

  const sx = boxGeometry.width === 0 ? 1 : next.width / boxGeometry.width;
  const sy = boxGeometry.height === 0 ? 1 : next.height / boxGeometry.height;

  const out = new Map<ElementId, GeometryPatch>();
  for (const { id, geometry } of snapshot) {
    out.set(id, {
      x: next.x + (geometry.x - boxGeometry.x) * sx,
      y: next.y + (geometry.y - boxGeometry.y) * sy,
      width: Math.max(geometry.width * sx, MIN_SIZE),
      height: Math.max(geometry.height * sy, MIN_SIZE),
      angle: geometry.angle,
    });
  }
  return out;
}

/**
 * Rotate a whole selection about the group's centre.
 *
 * Two things happen to each child, and doing only one of them is the bug:
 * its **centre orbits** the group centre, and its **own angle** advances by the
 * same amount. Rotate the centres without the angles and the shapes slide
 * around a circle while staying upright, like horses on a carousel.
 */
export function rotateGroup(
  snapshot: readonly GroupSnapshot[],
  groupBox: Bounds,
  pointer: Point,
  mod: TransformModifiers,
  startAngle: number,
): Map<ElementId, GeometryPatch> {
  const centre = {
    x: (groupBox.minX + groupBox.maxX) / 2,
    y: (groupBox.minY + groupBox.maxY) / 2,
  };

  let angle = Math.atan2(pointer.y - centre.y, pointer.x - centre.x) + TAU / 4;
  if (mod.shiftKey) angle = roundTo(angle, ROTATE_SNAP);
  const delta = angle - startAngle;

  const out = new Map<ElementId, GeometryPatch>();
  for (const { id, geometry } of snapshot) {
    const childCentre = {
      x: geometry.x + geometry.width / 2,
      y: geometry.y + geometry.height / 2,
    };
    const orbited = rotatePoint(childCentre, centre, delta);

    out.set(id, {
      x: orbited.x - geometry.width / 2,
      y: orbited.y - geometry.height / 2,
      width: geometry.width,
      height: geometry.height,
      angle: normalizeAngle(geometry.angle + delta),
    });
  }
  return out;
}

/* ── cursors ──────────────────────────────────────────────────────────────── */

/**
 * The four CSS resize cursors, in 45° order starting from "up".
 *
 * There are only four, because each one is a double-headed arrow that stands in
 * for two opposite directions: `ns` is up *and* down.
 */
const CURSOR_BY_OCTANT: readonly string[] = [
  'ns-resize', // 0°   — up
  'nesw-resize', // 45°
  'ew-resize', // 90°  — right
  'nwse-resize', // 135°
];

/** Direction each handle points, measured clockwise from "up", in turns. */
const HANDLE_DIRECTION: Readonly<Record<Exclude<HandleKind, 'rotate'>, number>> = {
  n: 0,
  ne: 1 / 8,
  e: 2 / 8,
  se: 3 / 8,
  s: 4 / 8,
  sw: 5 / 8,
  w: 6 / 8,
  nw: 7 / 8,
};

/**
 * The cursor for a handle, **rotated with the shape**.
 *
 * The detail that separates this from a lookup table: on a shape turned 90°,
 * the handle still called `nw` is visually in the top-*right*, and showing a
 * `nwse-resize` arrow there points the wrong way. Rotate the handle's direction
 * by the element's angle first, then bucket into one of the four cursors.
 *
 * Nobody files a bug about this. They just find the editor slightly harder to
 * use than the one they are comparing it to.
 */
export function cursorForHandle(handle: HandleKind | null, angle: number): string {
  if (handle === null) return 'move';
  if (handle === 'rotate') return 'grab';

  const turns = HANDLE_DIRECTION[handle] + normalizeAngle(angle) / TAU;
  // Eight octants collapse to four cursors, because each arrow is double-headed.
  const octant = Math.round(turns * 8) % 8;
  return CURSOR_BY_OCTANT[octant % 4]!;
}

/** Union of the un-rotated geometry boxes. What the group handles wrap. */
export function groupBoundsOf(elements: readonly Element[]): Bounds | null {
  if (elements.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const el of elements) {
    // Rotated children contribute their rotated extent, so the group box wraps
    // what the user can actually see rather than what the numbers say.
    const b = el.angle === 0 ? getGeometryBounds(el) : rotatedBox(el);
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  return { minX, minY, maxX, maxY };
}

function rotatedBox(el: Element): Bounds {
  const g = getGeometryBounds(el);
  const c = getElementCenter(el);
  const corners = [
    { x: g.minX, y: g.minY },
    { x: g.maxX, y: g.minY },
    { x: g.maxX, y: g.maxY },
    { x: g.minX, y: g.maxY },
  ].map((p) => rotatePoint(p, c, el.angle));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of corners) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Re-export so callers building a box from a drag do not import two modules. */
export { boundsFromRect };
