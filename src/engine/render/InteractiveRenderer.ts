/**
 * The interactive layer — the second canvas.
 *
 * ── Why two canvases ────────────────────────────────────────────────────────
 *
 * This is the highest-leverage structural decision in the rendering design, and
 * most clones never make it.
 *
 * |                 | static canvas          | interactive canvas (this one)   |
 * |-----------------|------------------------|---------------------------------|
 * | contains        | committed elements     | the shape you are drawing,      |
 * |                 |                        | and from Phase 4 the selection  |
 * |                 |                        | outline, handles and marquee    |
 * | element count   | 1 → 100,000            | 0 → ~20                         |
 * | repaint         | only when scene or     | full clear + redraw, every      |
 * |                 | viewport changes       | frame during interaction        |
 * | background      | opaque theme colour    | fully transparent               |
 *
 * The payoff: while you drag out a rectangle across a scene of 50,000 shapes,
 * the static canvas is **not touched at all**. You are clearing and redrawing
 * one shape on a transparent layer — a fraction of a millisecond, independent
 * of scene size.
 *
 * Without the split, every frame of every gesture repaints the entire scene,
 * and drawing gets slower the more you have already drawn. That is the single
 * most common reason canvas whiteboards feel worse the longer you use them.
 *
 * ── Why it can afford to be naive ───────────────────────────────────────────
 *
 * It clears everything and redraws everything, every frame — exactly what
 * Phase 5 will stop the static canvas from doing. That is not inconsistent:
 * the whole point of the split is that this layer holds so few things that the
 * cheapest possible strategy is also the best one. Dirty rectangles here would
 * be pure overhead.
 */

import type { Viewport } from '../viewport/Viewport';
import type { Element } from '../scene/element.types';
import type { Bounds } from '../util/geometry';
import { getElementCenter, getGeometryBounds } from '../scene/bounds';
import { HANDLE_SIZE_PX, getHandlePositions } from '../scene/transform';
import { createRoughCanvas, drawElement } from './drawElement';
import { RoughCache } from './roughCache';
import type { RoughCanvas } from 'roughjs/bin/canvas';

/** Everything drawn on top of the draft: selection feedback. */
export interface SelectionOverlay {
  /** The transform box and its rotation, when something is selected. */
  readonly transform: { readonly bounds: Bounds; readonly angle: number } | null;
  /** Selected elements that are currently on screen. May be empty by policy. */
  readonly outlines: readonly Element[];
  /** Box round the whole selection. Null for 0 or 1 elements. */
  readonly groupBounds: Bounds | null;
  /** The rubber band, while one is being dragged. */
  readonly marquee: Bounds | null;
}

const EMPTY_OVERLAY: SelectionOverlay = {
  outlines: [],
  groupBounds: null,
  marquee: null,
  transform: null,
};

const ACCENT = '#5b57d1';
const MARQUEE_FILL = 'rgba(91, 87, 209, 0.08)';
const HANDLE_FILL = '#ffffff';

export class InteractiveRenderer {
  private readonly rough: RoughCanvas;

  /**
   * A cache separate from the static renderer's.
   *
   * The draft element changes on every pointer move, so it produces a new
   * version — and therefore a new cache key — many times a second. Keeping
   * those out of the static cache stops a single drag from evicting thousands
   * of committed drawables that are about to be needed again.
   */
  private readonly cache = new RoughCache();

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
  ) {
    this.rough = createRoughCanvas(canvas);
  }

  /** @returns whether anything was actually drawn. */
  render(vp: Viewport, draft: Element | null, overlay: SelectionOverlay = EMPTY_OVERLAY): boolean {
    const { ctx } = this;
    const dpr = vp.devicePixelRatio;

    // clearRect rather than fillRect: this layer must be transparent so the
    // static canvas shows through. Filling it with the background colour would
    // hide every committed element behind an opaque sheet.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, Math.ceil(vp.width * dpr), Math.ceil(vp.height * dpr));

    const nothingToDo =
      draft === null &&
      overlay.outlines.length === 0 &&
      overlay.groupBounds === null &&
      overlay.marquee === null &&
      overlay.transform === null;
    if (nothingToDo) return false;

    const m = vp.deviceMatrix();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);

    if (draft !== null) drawElement(ctx, this.rough, this.cache, draft);
    this.drawOverlay(vp, overlay);
    return true;
  }

  /**
   * Selection outlines and the rubber band.
   *
   * ── Why every width and dash is divided by zoom ───────────────────────────
   *
   * The context is under the scene transform, so a `lineWidth` of 1 means one
   * *scene* unit — which is 10 screen pixels at 1000% zoom and a tenth of one at
   * 10%. Dividing by zoom makes the outline exactly `n` screen pixels at every
   * zoom level, which is what chrome should be: a constant visual weight
   * regardless of how far in you are looking.
   *
   * Getting this wrong is not subtle. Skip the division and the selection border
   * grows into a thick slab as you zoom in and vanishes entirely as you zoom
   * out. Every piece of UI drawn in scene space needs it — handles in Phase 6
   * will too.
   */
  private drawOverlay(vp: Viewport, overlay: SelectionOverlay): void {
    const { ctx } = this;
    const { zoom } = vp;

    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1 / zoom;

    for (const el of overlay.outlines) this.strokeElementOutline(el, zoom);

    if (overlay.groupBounds !== null) {
      ctx.setLineDash([6 / zoom, 4 / zoom]);
      ctx.lineWidth = 1.5 / zoom;
      const pad = 4 / zoom;
      const b = overlay.groupBounds;
      ctx.strokeRect(
        b.minX - pad,
        b.minY - pad,
        b.maxX - b.minX + pad * 2,
        b.maxY - b.minY + pad * 2,
      );
      ctx.setLineDash([]);
    }

    if (overlay.transform !== null) {
      this.drawHandles(overlay.transform.bounds, overlay.transform.angle, zoom);
    }

    if (overlay.marquee !== null) {
      const b = overlay.marquee;
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      ctx.fillStyle = MARQUEE_FILL;
      ctx.fillRect(b.minX, b.minY, w, h);
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([]);
      ctx.strokeRect(b.minX, b.minY, w, h);
    }

    ctx.restore();
  }

  /**
   * The eight resize handles and the rotation handle.
   *
   * ── Everything here is divided by zoom, and that is the whole point ───────
   *
   * Handles are chrome, not content: an 8-pixel square at 10% zoom and at 3000%
   * zoom, so they are always the same thing to aim at. In scene units that is
   * `8 / zoom`, and the same applies to the stalk connecting the rotation
   * handle and to every stroke width.
   *
   * Miss one division and the handles either vanish into single pixels when you
   * zoom out or grow into slabs that cover the shape when you zoom in — and
   * either way the tool becomes unusable at one end of the range while looking
   * perfect at the other.
   */
  private drawHandles(box: Bounds, angle: number, zoom: number): void {
    const { ctx } = this;
    const size = HANDLE_SIZE_PX / zoom;
    const half = size / 2;

    ctx.save();
    ctx.lineWidth = 1 / zoom;
    ctx.strokeStyle = ACCENT;

    const handles = getHandlePositions(box, angle, zoom);

    // The stalk from the top edge to the rotation handle, so it reads as
    // attached to the shape rather than floating near it.
    const top = handles.find((h) => h.kind === 'n');
    const rotate = handles.find((h) => h.kind === 'rotate');
    if (top !== undefined && rotate !== undefined) {
      ctx.beginPath();
      ctx.moveTo(top.point.x, top.point.y);
      ctx.lineTo(rotate.point.x, rotate.point.y);
      ctx.stroke();
    }

    for (const h of handles) {
      ctx.fillStyle = HANDLE_FILL;
      if (h.kind === 'rotate') {
        // Round, because it does something different from the eight squares.
        // Shape carries the affordance; colour alone would not.
        ctx.beginPath();
        ctx.arc(h.point.x, h.point.y, half, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        continue;
      }

      ctx.save();
      if (angle !== 0) {
        // Rotate the squares with the shape so they sit square to its edges.
        ctx.translate(h.point.x, h.point.y);
        ctx.rotate(angle);
        ctx.translate(-h.point.x, -h.point.y);
      }
      ctx.fillRect(h.point.x - half, h.point.y - half, size, size);
      ctx.strokeRect(h.point.x - half, h.point.y - half, size, size);
      ctx.restore();
    }

    ctx.restore();
  }

  /**
   * One shape's outline, following its rotation.
   *
   * Drawn by rotating the *canvas* rather than by computing rotated corners —
   * the same trick as `drawElement`, and the mirror image of hit testing, which
   * rotates the point instead. Both avoid ever writing rotated-rectangle maths.
   */
  private strokeElementOutline(el: Element, zoom: number): void {
    const { ctx } = this;
    const b = getGeometryBounds(el);
    const pad = 2 / zoom;

    ctx.save();
    if (el.angle !== 0) {
      const c = getElementCenter(el);
      ctx.translate(c.x, c.y);
      ctx.rotate(el.angle);
      ctx.translate(-c.x, -c.y);
    }
    ctx.strokeRect(
      b.minX - pad,
      b.minY - pad,
      b.maxX - b.minX + pad * 2,
      b.maxY - b.minY + pad * 2,
    );
    ctx.restore();
  }

  /** Drop cached drawables for a finished draft. Called on commit or cancel. */
  releaseDraft(id: string): void {
    this.cache.evict([id]);
  }
}
