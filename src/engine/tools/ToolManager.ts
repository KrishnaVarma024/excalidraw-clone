/**
 * The drawing tools, as a state machine.
 *
 * ── The rule that keeps this simple ─────────────────────────────────────────
 *
 * **An in-progress shape is not in the Scene.** It lives here, as `draft`, and
 * is drawn on the interactive canvas. It only becomes a real element on
 * `pointerup`.
 *
 * That one rule buys four things:
 *
 *   - `Escape` cancels by dropping a reference. No delete, no undo entry.
 *   - The draft never enters the spatial index (Phase 4), so a shape you are
 *     still dragging can never be hit-tested or selected.
 *   - It never enters history (Phase 8), so one gesture is one undo step rather
 *     than four hundred.
 *   - It lives on the cheap canvas, so redrawing it 60 times a second costs
 *     nothing regardless of how many committed elements exist.
 *
 * ── The machine ─────────────────────────────────────────────────────────────
 *
 *                         ┌────────┐
 *       shape tool         │  IDLE  │         selection tool
 *       pointerdown        └───┬────┘         pointerdown
 *            ┌─────────────────┴─────────────────┐
 *            ▼                                   ▼
 *      ┌───────────┐                    hit an element?
 *      │  DRAWING  │  move → reshape      ├─ yes → select it (shift toggles)
 *      │           │  Esc  → discard      │        stay IDLE
 *      └─────┬─────┘  up   → commit       └─ no  → ┌──────────┐
 *            ▼                                     │ MARQUEE  │ move → grow box
 *      Scene.add() → IDLE                          └────┬─────┘ Esc  → discard
 *                                                       ▼       up   → select
 *                                                     IDLE
 *
 * ── The rule that makes the selection branch simple ─────────────────────────
 *
 * **Selection is decided on `pointerdown`, not on `pointerup`.** A shape you
 * press on is selected immediately, before you know whether the gesture will
 * turn into a drag. That is what makes press-and-drag-to-move work in Phase 6
 * without a special case, and it is what every editor does — press on a shape
 * and it highlights before you have released.
 */

import { type Bounds, type Point, boundsFromRect } from '../util/geometry';
import type { Scene } from '../scene/Scene';
import type { Selection } from './Selection';
import {
  type GeometryPatch,
  type GroupSnapshot,
  type HandleKind,
  geometryOf,
  groupBoundsOf,
  cursorForHandle,
  hitTestHandles,
  moveGeometry,
  resizeGeometry,
  resizeGroup,
  rotateGeometry,
  rotateGroup,
} from '../scene/transform';
import { measurePointBased } from '../scene/bounds';
import {
  type Element,
  type ElementId,
  type ElementStyle,
  type FreedrawElement,
  type LinearElement,
} from '../scene/element.types';
import { newFreedraw, newShape, normalizeDrag, type ShapeToolType } from '../scene/elementFactory';
import { simplifyStroke } from '../util/simplify';
import { roundTo, TAU } from '../util/math';

export type ToolType = 'selection' | ShapeToolType | 'freedraw';

/** Keyboard shortcut → tool. Matches Excalidraw's, which is what people expect. */
export const TOOL_SHORTCUTS: Readonly<Record<string, ToolType>> = {
  v: 'selection',
  '1': 'selection',
  r: 'rectangle',
  '2': 'rectangle',
  d: 'diamond',
  '3': 'diamond',
  o: 'ellipse',
  '4': 'ellipse',
  a: 'arrow',
  '5': 'arrow',
  l: 'line',
  '6': 'line',
  p: 'freedraw',
  '7': 'freedraw',
};

/** Below this drag distance (scene units) a shape is discarded as a stray click. */
const MIN_DRAG = 2;

/** Shift-constrained line angles: 15° increments. */
const ANGLE_SNAP = TAU / 24;

/**
 * Freehand simplification tolerance, in scene units.
 *
 * Found empirically: 0.6 removes 75–90% of points on a typical stroke with no
 * difference visible even at 400% zoom. Larger values start rounding off
 * deliberate corners.
 */
const SIMPLIFY_TOLERANCE = 0.6;

export interface ToolCallbacks {
  /** The draft or the marquee changed — repaint the interactive layer. */
  onDraftChange: () => void;
  /** The selection changed — repaint, and tell React the count. */
  onSelectionChange: () => void;
  /** An element was committed — repaint the static layer. */
  onCommit: (element: Element) => void;
  /** The active tool changed — React needs to know. */
  onToolChange: (tool: ToolType) => void;
}

export interface PointerModifiers {
  shiftKey: boolean;
  /**
   * Click tolerance in **scene units**, supplied by the caller as `px / zoom`.
   *
   * It lives on the event rather than on the tool because it depends on the
   * viewport, and `ToolManager` deliberately knows nothing about the viewport —
   * that separation is what keeps the whole engine testable without a canvas.
   */
  hitThreshold: number;
  /** Alt/Option: resize about the centre instead of the opposite corner. */
  altKey: boolean;
  /**
   * Current zoom, needed because transform handles are a constant size on
   * SCREEN — an 8px square is `8 / zoom` scene units. Handles that scaled with
   * the document would be invisible at 10% and enormous at 3000%.
   */
  zoom: number;
  /** From `PointerEvent.pressure`. Mice report a constant 0.5. */
  pressure: number;
  /** `'mouse' | 'pen' | 'touch'`. Only a pen reports real pressure. */
  pointerType: string;
}

export class ToolManager {
  private tool: ToolType = 'selection';
  private style: ElementStyle;

  private drawing = false;
  private origin: Point = { x: 0, y: 0 };
  private draft: Element | null = null;

  /** Rubber-band rectangle in scene space, while the selection tool is dragging. */
  private marquee: Bounds | null = null;

  /**
   * The transform gesture in flight, or null.
   *
   * Holds the geometry of every affected element **as it was when the gesture
   * began**. Every frame recomputes from this snapshot rather than from the
   * element's current state — see the header of `scene/transform.ts` for the
   * three separate bugs that avoids.
   */
  private drag: DragState | null = null;
  private hovered: HandleKind | null = null;
  /** Shift was held when the marquee began — add to the selection rather than replace. */
  private marqueeAdditive = false;
  /** The selection as it was when the marquee began, so the preview can be live. */
  private marqueeBase: ReadonlySet<ElementId> = new Set();

  /** Raw samples for the freehand stroke in progress, before simplification. */
  private rawPoints: Point[] = [];
  private rawPressures: number[] = [];

  constructor(
    private readonly scene: Scene,
    private readonly selection: Selection,
    style: ElementStyle,
    private readonly cb: ToolCallbacks,
  ) {
    this.style = { ...style };
  }

  /* ── state ──────────────────────────────────────────────────────────────── */

  get activeTool(): ToolType {
    return this.tool;
  }

  get isDrawing(): boolean {
    return this.drawing;
  }

  /** The in-progress element, for the interactive layer. Null when idle. */
  get draftElement(): Element | null {
    return this.draft;
  }

  /** The rubber-band rectangle, for the interactive layer. Null when not dragging one. */
  get marqueeBox(): Bounds | null {
    return this.marquee;
  }

  /** Which handle is being dragged, for the cursor and the overlay. */
  get activeHandle(): HandleKind | null {
    return this.drag?.handle ?? null;
  }

  get isTransforming(): boolean {
    return this.drag !== null;
  }

  setTool(tool: ToolType): void {
    if (tool === this.tool) return;
    // Switching tools mid-gesture abandons it. Any other behaviour — finishing
    // the shape, or ignoring the switch — surprises people more.
    this.cancel();
    this.tool = tool;
    this.cb.onToolChange(tool);
  }

  setStyle(patch: Partial<ElementStyle>): void {
    this.style = { ...this.style, ...patch };
  }

  getStyle(): Readonly<ElementStyle> {
    return this.style;
  }

  /* ── the machine ────────────────────────────────────────────────────────── */

  /** @returns true if the tool consumed the event (so panning should not run). */
  onPointerDown(scene: Point, mod: PointerModifiers): boolean {
    if (this.tool === 'selection') return this.beginSelection(scene, mod);

    this.drawing = true;
    this.origin = scene;

    if (this.tool === 'freedraw') {
      this.rawPoints = [{ x: 0, y: 0 }];
      // A pen reports real pressure; a mouse and most trackpads report a
      // constant 0.5, so we ask perfect-freehand to synthesise it from velocity
      // instead. Without this, mouse strokes are flat ribbons with no taper.
      this.rawPressures = [mod.pressure];
      this.draft = newFreedraw({
        x: scene.x,
        y: scene.y,
        width: 0,
        height: 0,
        style: this.style,
        zIndex: this.scene.nextZIndex(),
        points: this.rawPoints,
        pressures: this.rawPressures,
        simulatePressure: mod.pointerType !== 'pen',
      });
    } else {
      this.draft = newShape(this.tool, {
        x: scene.x,
        y: scene.y,
        width: 0,
        height: 0,
        style: this.style,
        zIndex: this.scene.nextZIndex(),
      });
    }

    this.cb.onDraftChange();
    return true;
  }

  /**
   * The pointer moved with no button down. Returns true if the cursor changed.
   *
   * This only ever tests **handles** — nine distance comparisons against a box
   * the tool already has. It deliberately does not hit-test the scene, which is
   * the expensive question and the one Phase 4b was careful to ask only on
   * press. A hover handler that ran a spatial query per mouse move would be
   * doing 60 queries a second whose results are all thrown away.
   */
  onPointerHover(scene: Point, mod: PointerModifiers): boolean {
    if (this.tool !== 'selection') return this.setHover(null);

    const box = this.selectionBox();
    if (box === null) return this.setHover(null);

    return this.setHover(hitTestHandles(scene, box.bounds, box.angle, mod.zoom));
  }

  private setHover(handle: HandleKind | null): boolean {
    if (this.hovered === handle) return false;
    this.hovered = handle;
    return true;
  }

  /**
   * What the canvas element's CSS cursor should be.
   *
   * Reported by the tool rather than computed in the React component, because
   * the answer depends on the selection's rotation — which is engine state the
   * view has no business reaching into.
   */
  get cursor(): string | null {
    if (this.drag !== null) {
      return this.drag.handle === 'rotate' ? 'grabbing' : this.cursorFor(this.drag.handle);
    }
    return this.hovered === null ? null : this.cursorFor(this.hovered);
  }

  private cursorFor(handle: HandleKind | null): string {
    const box = this.selectionBox();
    return cursorForHandle(handle, box?.angle ?? 0);
  }

  onPointerMove(scene: Point, mod: PointerModifiers): void {
    if (this.drag !== null) {
      this.updateTransform(scene, mod);
      return;
    }
    if (this.marquee !== null) {
      this.updateMarquee(scene);
      return;
    }
    if (!this.drawing || this.draft === null) return;

    if (this.draft.type === 'freedraw') {
      this.extendFreedraw(scene, mod);
    } else if (this.draft.type === 'line' || this.draft.type === 'arrow') {
      this.reshapeLinear(scene, mod);
    } else {
      this.reshapeBox(scene, mod);
    }

    this.cb.onDraftChange();
  }

  /** @returns the committed element, or null if the gesture produced nothing. */
  onPointerUp(): Element | null {
    if (this.drag !== null) {
      this.endTransform();
      return null;
    }

    if (this.marquee !== null) {
      this.endMarquee();
      return null;
    }

    if (!this.drawing || this.draft === null) {
      this.reset();
      return null;
    }

    const committed = this.finalise(this.draft);
    this.reset();

    if (committed === null) {
      this.cb.onDraftChange();
      return null;
    }

    this.scene.add(committed);
    this.cb.onCommit(committed);
    this.cb.onDraftChange();
    return committed;
  }

  /**
   * Abandon the in-progress gesture. Escape, tool switch, window blur.
   *
   * Escape while a marquee is open restores the selection to what it was when
   * the marquee started, rather than clearing it — an aborted gesture should
   * leave no trace, and destroying a selection the user spent effort building is
   * the opposite of that.
   */
  cancel(): void {
    if (this.drag !== null) {
      // Put everything back exactly as it was. Restoring from the snapshot is
      // exact; "apply the inverse delta" would leave floating-point residue.
      for (const { id, geometry } of this.drag.snapshot) this.scene.mutate(id, geometry);
      this.drag = null;
      this.cb.onDraftChange();
      return;
    }

    if (this.marquee !== null) {
      const base = this.marqueeBase;
      this.resetMarquee();
      if (this.selection.set(base)) this.cb.onSelectionChange();
      this.cb.onDraftChange();
      return;
    }
    if (!this.drawing && this.draft === null) {
      // Nothing in flight — Escape falls through to meaning "deselect", which
      // is what every editor does and what the hand expects.
      if (this.selection.clear()) this.cb.onSelectionChange();
      return;
    }
    this.reset();
    this.cb.onDraftChange();
  }

  private reset(): void {
    this.drawing = false;
    this.draft = null;
    this.rawPoints = [];
    this.rawPressures = [];
    this.drag = null;
    this.resetMarquee();
  }

  private resetMarquee(): void {
    this.marquee = null;
    this.marqueeAdditive = false;
    this.marqueeBase = new Set();
  }

  /* ── the selection tool ─────────────────────────────────────────────────── */

  /**
   * Press with the selection tool: either grab a shape or start a marquee.
   *
   * Always returns `true` — the selection tool consumes left-button presses even
   * when it hits nothing, because hitting nothing is how you start a rubber
   * band. Navigation still wins: `InputRouter` checks space-drag and
   * middle-button *before* asking the tool, so panning is unaffected.
   */
  private beginSelection(scene: Point, mod: PointerModifiers): boolean {
    /* Handles are tested BEFORE elements, and the order is not arbitrary.
       Handles are drawn on top, they sit partly outside the shape they belong
       to, and the rotation handle floats over whatever is above the selection.
       Test elements first and grabbing a corner handle selects whatever happens
       to be behind it — which reads as "the handles do not work". */
    const box = this.selectionBox();
    if (box !== null) {
      const handle = hitTestHandles(scene, box.bounds, box.angle, mod.zoom);
      if (handle !== null) {
        this.beginTransform(handle, scene, box);
        return true;
      }
    }

    const hit = this.scene.hitTest(scene, mod.hitThreshold);

    if (hit !== null) {
      const changed = mod.shiftKey
        ? this.selection.toggle(hit.id)
        : this.selection.has(hit.id)
          ? false // already selected — leave a multi-selection intact for a drag
          : this.selection.set([hit.id]);

      if (changed) this.cb.onSelectionChange();

      /* Shift-click is a selection gesture, not a drag: starting a move here
         would nudge the shape the user was only trying to add. */
      if (!mod.shiftKey && !this.selection.isEmpty) this.beginTransform(null, scene, null);
      return true;
    }

    // Empty canvas: start a rubber band. A plain click clears the selection;
    // shift-click keeps it and adds to it.
    this.origin = scene;
    this.marqueeAdditive = mod.shiftKey;
    this.marqueeBase = new Set(this.selection.ids());
    this.marquee = boundsFromRect(scene.x, scene.y, 0, 0);

    if (!mod.shiftKey && this.selection.clear()) this.cb.onSelectionChange();
    this.cb.onDraftChange();
    return true;
  }

  /**
   * Grow the rubber band, and update the selection **live**.
   *
   * Recomputing the selection on every move rather than only on release is what
   * makes the gesture feel like direct manipulation instead of a guess — you see
   * exactly what you are about to get. It is affordable precisely because of
   * Phase 4a: `elementsInBox` is an index query, so the cost tracks the size of
   * the box rather than the size of the document.
   */
  private updateMarquee(scene: Point): void {
    this.marquee = boundsFromRect(
      this.origin.x,
      this.origin.y,
      scene.x - this.origin.x,
      scene.y - this.origin.y,
    );

    const inside = this.scene.elementsInBox(this.marquee).map((el) => el.id);
    const next = this.marqueeAdditive ? new Set([...this.marqueeBase, ...inside]) : new Set(inside);

    if (this.selection.set(next)) this.cb.onSelectionChange();
    this.cb.onDraftChange();
  }

  private endMarquee(): void {
    this.resetMarquee();
    this.cb.onDraftChange();
  }

  /* ── selection commands ─────────────────────────────────────────────────── */

  selectAll(): boolean {
    const changed = this.selection.set(this.scene.sorted().map((el) => el.id));
    if (changed) this.cb.onSelectionChange();
    return changed;
  }

  clearSelection(): boolean {
    const changed = this.selection.clear();
    if (changed) this.cb.onSelectionChange();
    return changed;
  }

  /**
   * Delete every selected element. @returns how many.
   *
   * Soft delete, so Phase 8's undo is a flag flip rather than a resurrection —
   * and note the selection is emptied afterwards. Leaving deleted ids selected
   * would show a count for things that are not there, and the next command would
   * silently do nothing for them.
   */
  /* ── move / resize / rotate ─────────────────────────────────────────────── */

  /**
   * The selection's box and rotation, or null when nothing is selected.
   *
   * A single selected element keeps its own rotation, so its handles hug the
   * shape. A multi-selection gets an axis-aligned box at angle 0 — there is no
   * meaningful shared rotation for a group of differently-rotated shapes, and
   * inventing one produces handles that do not line up with anything.
   */
  private selectionBox(): { bounds: Bounds; angle: number; elements: Element[] } | null {
    const elements: Element[] = [];
    for (const id of this.selection.ids()) {
      const el = this.scene.get(id);
      if (el !== undefined && !el.isDeleted) elements.push(el);
    }
    if (elements.length === 0) return null;

    if (elements.length === 1) {
      const only = elements[0]!;
      return {
        bounds: {
          minX: only.x,
          minY: only.y,
          maxX: only.x + only.width,
          maxY: only.y + only.height,
        },
        angle: only.angle,
        elements,
      };
    }

    const bounds = groupBoundsOf(elements);
    return bounds === null ? null : { bounds, angle: 0, elements };
  }

  /** The selection box, for the interactive layer's handles. */
  get transformBox(): { bounds: Bounds; angle: number } | null {
    const box = this.selectionBox();
    return box === null ? null : { bounds: box.bounds, angle: box.angle };
  }

  /**
   * Capture everything the gesture will need, once.
   *
   * `handle === null` means a move. Everything else is a resize or a rotate.
   */
  private beginTransform(
    handle: HandleKind | null,
    origin: Point,
    box: { bounds: Bounds; angle: number; elements: Element[] } | null,
  ): void {
    const resolved = box ?? this.selectionBox();
    if (resolved === null) return;

    const centre = {
      x: (resolved.bounds.minX + resolved.bounds.maxX) / 2,
      y: (resolved.bounds.minY + resolved.bounds.maxY) / 2,
    };

    this.drag = {
      handle,
      origin,
      box: resolved.bounds,
      snapshot: resolved.elements.map((el) => ({ id: el.id, geometry: geometryOf(el) })),
      // Where the rotation gesture started, measured the same way it will be
      // measured every frame — so a group rotation begins at zero delta rather
      // than snapping to wherever the handle happens to be.
      startAngle: Math.atan2(origin.y - centre.y, origin.x - centre.x) + TAU / 4,
      moved: false,
    };
  }

  private updateTransform(scene: Point, mod: PointerModifiers): void {
    const drag = this.drag;
    if (drag === null) return;

    if (!drag.moved) {
      // Below the threshold this is still a click, not a drag. Without it, every
      // selection click nudges the shape by a pixel or two — which users
      // experience as the canvas being "twitchy" and never report precisely.
      if (Math.hypot(scene.x - drag.origin.x, scene.y - drag.origin.y) < MIN_DRAG) return;
      drag.moved = true;
    }

    const patches = this.computeTransform(drag, scene, mod);
    for (const [id, geometry] of patches) this.scene.mutate(id, geometry);
    this.cb.onDraftChange();
  }

  private computeTransform(
    drag: DragState,
    pointer: Point,
    mod: PointerModifiers,
  ): Map<ElementId, GeometryPatch> {
    const out = new Map<ElementId, GeometryPatch>();
    const single = drag.snapshot.length === 1 ? drag.snapshot[0]! : null;

    if (drag.handle === null) {
      const dx = pointer.x - drag.origin.x;
      const dy = pointer.y - drag.origin.y;
      for (const { id, geometry } of drag.snapshot) out.set(id, moveGeometry(geometry, dx, dy));
      return out;
    }

    if (drag.handle === 'rotate') {
      if (single !== null) {
        out.set(single.id, rotateGeometry(single.geometry, pointer, mod));
        return out;
      }
      return rotateGroup(drag.snapshot, drag.box, pointer, mod, drag.startAngle);
    }

    if (single !== null) {
      out.set(single.id, resizeGeometry(single.geometry, drag.handle, pointer, mod));
      return out;
    }
    return resizeGroup(drag.snapshot, drag.box, drag.handle, pointer, mod);
  }

  private endTransform(): void {
    this.drag = null;
    // The shape is no longer where it was when the pointer landed, so the last
    // hover answer is about a box that has moved. Forget it and let the next
    // hover recompute rather than showing a resize cursor over empty canvas.
    this.hovered = null;
    this.cb.onDraftChange();
  }

  deleteSelected(): number {
    const ids = [...this.selection.ids()];
    if (ids.length === 0) return 0;

    let removed = 0;
    for (const id of ids) if (this.scene.remove(id)) removed++;

    this.selection.clear();
    this.cb.onSelectionChange();
    return removed;
  }

  /* ── reshaping ──────────────────────────────────────────────────────────── */

  private reshapeBox(current: Point, mod: PointerModifiers): void {
    let target = current;

    // Shift constrains to a square/circle. Computed from the *origin* rather
    // than by adjusting the previous frame's size, so it stays correct when
    // Shift is pressed or released mid-drag.
    if (mod.shiftKey) {
      const dx = current.x - this.origin.x;
      const dy = current.y - this.origin.y;
      const size = Math.max(Math.abs(dx), Math.abs(dy));
      target = {
        x: this.origin.x + Math.sign(dx || 1) * size,
        y: this.origin.y + Math.sign(dy || 1) * size,
      };
    }

    const rect = normalizeDrag(this.origin, target);
    this.draft = { ...this.draft!, ...rect } as Element;
  }

  private reshapeLinear(current: Point, mod: PointerModifiers): void {
    let dx = current.x - this.origin.x;
    let dy = current.y - this.origin.y;

    // Shift snaps to 15°. Derived rather than special-cased into "horizontal,
    // vertical or 45°", so it generalises and reads correctly at any angle.
    if (mod.shiftKey) {
      const length = Math.hypot(dx, dy);
      const angle = roundTo(Math.atan2(dy, dx), ANGLE_SNAP);
      dx = Math.cos(angle) * length;
      dy = Math.sin(angle) * length;
    }

    // Lines are deliberately NOT normalised: drag direction decides which end
    // gets the arrowhead, so it carries meaning that a normalised box discards.
    const line = this.draft as LinearElement;
    this.draft = {
      ...line,
      width: dx,
      height: dy,
      points: [
        { x: 0, y: 0 },
        { x: dx, y: dy },
      ],
    };
  }

  private extendFreedraw(current: Point, mod: PointerModifiers): void {
    const local = { x: current.x - this.origin.x, y: current.y - this.origin.y };

    // Drop samples that land on top of the previous one. The browser happily
    // emits duplicate positions when the pointer is still, and they add nothing
    // but work for perfect-freehand.
    const last = this.rawPoints[this.rawPoints.length - 1];
    if (last !== undefined && last.x === local.x && last.y === local.y) return;

    this.rawPoints.push(local);
    this.rawPressures.push(mod.pressure);

    const stroke = this.draft as FreedrawElement;
    this.draft = {
      ...stroke,
      // New arrays each time rather than mutating in place: the draft is handed
      // to the renderer, and a renderer holding a reference to a list that
      // mutates underneath it is a whole category of bug not worth having.
      points: [...this.rawPoints],
      pressures: [...this.rawPressures],
    };
  }

  /* ── commit ─────────────────────────────────────────────────────────────── */

  /**
   * Turn a draft into a committed element, or reject it.
   *
   * Two jobs. Reject strays — a click with no drag would otherwise leave a
   * zero-sized invisible element in the scene, which is confusing precisely
   * because you cannot see it. And simplify the freehand stroke, once, here:
   * doing it during the drag would make the line behind the cursor visibly
   * rewrite itself.
   */
  private finalise(draft: Element): Element | null {
    if (draft.type === 'freedraw') {
      if (this.rawPoints.length < 2) return null;

      const { points, pressures } = simplifyStroke(
        this.rawPoints,
        this.rawPressures,
        SIMPLIFY_TOLERANCE,
      );

      const measured = measurePointBased({ ...draft, points, pressures });
      if (measured === null) return null;

      return { ...draft, ...measured, pressures } as Element;
    }

    if (draft.type === 'line' || draft.type === 'arrow') {
      if (Math.hypot(draft.width, draft.height) < MIN_DRAG) return null;
      return draft;
    }

    if (draft.width < MIN_DRAG && draft.height < MIN_DRAG) return null;
    return draft;
  }
}

/**
 * A transform gesture in flight.
 *
 * Everything here is captured at `pointerdown` and never updated. That is the
 * point: each frame recomputes the result from these values plus the current
 * pointer, so the gesture is a pure function of where the mouse is rather than
 * an accumulation of where it has been.
 */
interface DragState {
  /** null = move. Otherwise the handle being dragged. */
  readonly handle: HandleKind | null;
  readonly origin: Point;
  /** The selection box as it was when the gesture began. */
  readonly box: Bounds;
  readonly snapshot: GroupSnapshot[];
  /** Pointer angle about the box centre at gesture start, for group rotation. */
  readonly startAngle: number;
  /** Has the pointer travelled far enough for this to be a drag rather than a click? */
  moved: boolean;
}
