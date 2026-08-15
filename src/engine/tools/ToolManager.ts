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

  onPointerMove(scene: Point, mod: PointerModifiers): void {
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
    const hit = this.scene.hitTest(scene, mod.hitThreshold);

    if (hit !== null) {
      const changed = mod.shiftKey
        ? this.selection.toggle(hit.id)
        : this.selection.has(hit.id)
          ? false // already selected — leave a multi-selection intact for a drag
          : this.selection.set([hit.id]);

      if (changed) this.cb.onSelectionChange();
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
