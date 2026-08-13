/**
 * The renderer.
 *
 * Phase 1 does the simplest correct thing: clear everything, draw everything.
 * There are no elements yet, so "everything" is the grid — which genuinely does
 * have to be fully redrawn on every viewport change, because panning moves
 * every single line.
 *
 * That is worth saying out loud, because Phase 5 replaces this with
 * dirty-rectangle rendering and it would be easy to read the change as
 * "full repaint was wrong, partial repaint is right". It is not that simple:
 *
 *   - full repaint is CORRECT and optimal when most of the screen changed
 *     (panning, zooming, resizing, theme switches)
 *   - partial repaint wins when a small region changed (dragging one shape,
 *     editing text, a blinking caret)
 *
 * Phase 5 does not delete this path. It adds the other one and a heuristic for
 * choosing between them — and this code stays as the escape hatch.
 *
 * ── The one structural rule ─────────────────────────────────────────────────
 *
 * The renderer reads state and writes pixels. It never mutates the viewport,
 * the scene, or anything else. That purity is what will let Phase 9 reuse this
 * exact code path to render an export at a different scale, with a different
 * transform, to an offscreen canvas — with no changes.
 */

import type { Viewport } from '../viewport/Viewport';
import { type GridStyle, drawGrid } from './grid';

export interface RenderStats {
  /** Grid lines stroked this frame. Sanity check that LOD is working. */
  gridLines: number;
}

export interface Theme {
  readonly background: string;
  readonly grid: GridStyle;
}

export const LIGHT_THEME: Theme = {
  background: '#ffffff',
  grid: {
    fineColor: 'rgba(27, 27, 31, 0.09)',
    coarseColor: 'rgba(27, 27, 31, 0.17)',
    axisColor: 'rgba(91, 87, 209, 0.55)',
  },
};

export const DARK_THEME: Theme = {
  background: '#121212',
  grid: {
    fineColor: 'rgba(236, 236, 241, 0.07)',
    coarseColor: 'rgba(236, 236, 241, 0.15)',
    axisColor: 'rgba(168, 165, 255, 0.55)',
  },
};

export class Renderer {
  private theme: Theme = LIGHT_THEME;

  constructor(private readonly ctx: CanvasRenderingContext2D) {}

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  render(vp: Viewport): RenderStats {
    const { ctx } = this;
    const dpr = vp.devicePixelRatio;
    const cssW = vp.width;
    const cssH = vp.height;

    /* ── 1. Clear, in DEVICE space ─────────────────────────────────────────
       The identity transform here is not laziness — it means the clear covers
       the entire backing store regardless of what the scene transform is doing.
       Clearing under a scene transform while scrolled far from the origin is a
       classic way to miss part of the canvas and leave stale pixels behind. */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, Math.ceil(cssW * dpr), Math.ceil(cssH * dpr));

    /* ── 2. Chrome, in SCREEN space ────────────────────────────────────────
       Scale by DPR only. The grid positions itself using the viewport
       transform internally but strokes 1-CSS-pixel lines, so it stays crisp at
       every zoom. See the note in grid.ts about chrome vs content. */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const gridLines = drawGrid(ctx, vp.get(), cssW, cssH, this.theme.grid);

    /* ── 3. Content, in SCENE space ────────────────────────────────────────
       From here on, draw code uses raw scene coordinates and never thinks
       about zoom, scroll, or devicePixelRatio again — that is the entire
       purpose of folding all three into one matrix.

       Phase 2 fills this in with elements. */
    const m = vp.deviceMatrix();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);

    // (nothing to draw yet)

    return { gridLines };
  }
}
