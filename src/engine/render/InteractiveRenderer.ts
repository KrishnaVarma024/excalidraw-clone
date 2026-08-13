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
import { createRoughCanvas, drawElement } from './drawElement';
import { RoughCache } from './roughCache';
import type { RoughCanvas } from 'roughjs/bin/canvas';

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
  render(vp: Viewport, draft: Element | null): boolean {
    const { ctx } = this;
    const dpr = vp.devicePixelRatio;

    // clearRect rather than fillRect: this layer must be transparent so the
    // static canvas shows through. Filling it with the background colour would
    // hide every committed element behind an opaque sheet.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, Math.ceil(vp.width * dpr), Math.ceil(vp.height * dpr));

    if (draft === null) return false;

    const m = vp.deviceMatrix();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    drawElement(ctx, this.rough, this.cache, draft);
    return true;
  }

  /** Drop cached drawables for a finished draft. Called on commit or cancel. */
  releaseDraft(id: string): void {
    this.cache.evict([id]);
  }
}
