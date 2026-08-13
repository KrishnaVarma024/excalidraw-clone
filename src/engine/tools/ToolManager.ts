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
 *                    ┌────────┐
 *      shape tool    │  IDLE  │   selection tool
 *      pointerdown   └───┬────┘   pointerdown → (Phase 4: select / marquee)
 *            ┌───────────┘
 *            ▼
 *      ┌───────────┐  pointermove → reshape draft
 *      │  DRAWING  │  Escape      → discard, back to IDLE
 *      └─────┬─────┘  pointerup   → commit
 *            ▼
 *      Scene.add() → IDLE
 */

import type { Point } from '../util/geometry';
import type { Scene } from '../scene/Scene';
import { measurePointBased } from '../scene/bounds';
import {
  type Element,
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
  /** The draft changed — repaint the interactive layer. */
  onDraftChange: () => void;
  /** An element was committed — repaint the static layer. */
  onCommit: (element: Element) => void;
  /** The active tool changed — React needs to know. */
  onToolChange: (tool: ToolType) => void;
}

export interface PointerModifiers {
  shiftKey: boolean;
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

  /** Raw samples for the freehand stroke in progress, before simplification. */
  private rawPoints: Point[] = [];
  private rawPressures: number[] = [];

  constructor(
    private readonly scene: Scene,
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
    // Selection is a placeholder until Phase 4 — it deliberately does nothing,
    // so space-drag panning still works underneath it.
    if (this.tool === 'selection') return false;

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

  /** Abandon the in-progress shape. Escape, tool switch, window blur. */
  cancel(): void {
    if (!this.drawing && this.draft === null) return;
    this.reset();
    this.cb.onDraftChange();
  }

  private reset(): void {
    this.drawing = false;
    this.draft = null;
    this.rawPoints = [];
    this.rawPressures = [];
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
