/**
 * The static renderer — everything that has been committed to the scene.
 *
 * Still a full repaint per frame, and that is still the right answer for what
 * it currently does: any viewport change moves every element and every grid
 * line, so there is nothing worth preserving.
 *
 * What Phase 2 adds is **viewport culling**. The renderer asks the scene for
 * elements whose bounds intersect the visible rectangle and draws only those.
 * That is the difference between frame cost tracking *what exists* and tracking
 * *what you can see*.
 *
 * The cull is O(n): a bounds test per element, every frame. Fine at a few
 * thousand, and exactly the cost Phase 4's quadtree replaces with an O(log n)
 * range query. Phase 3 measures where the crossover actually is rather than
 * guessing.
 *
 * ── The structural rule, unchanged ──────────────────────────────────────────
 *
 * The renderer reads state and writes pixels. It mutates nothing. That purity
 * is what lets Phase 9 point this same code at an offscreen canvas with a
 * different transform and get an export, with no changes to this file.
 */

import type { Viewport } from '../viewport/Viewport';
import type { Scene } from '../scene/Scene';
import { type GridStyle, drawGrid } from './grid';
import { createRoughCanvas, drawElement } from './drawElement';
import { RoughCache } from './roughCache';
import type { StageTimer } from '../util/perf';
import type { RoughCanvas } from 'roughjs/bin/canvas';

export interface RenderStats {
  /** Grid lines stroked this frame. A cheap check that LOD is working. */
  gridLines: number;
  /** Elements drawn this frame — those that survived culling. */
  drawn: number;
  /** Live elements in the scene. `drawn / total` is the culling ratio. */
  total: number;
  /**
   * Elements *examined* by the cull.
   *
   * Equal to `total` under a linear scan; Phase 4's quadtree makes it grow
   * logarithmically instead. It is the headline number of this project, and it
   * is deterministic — unlike a timing, it reads the same on every machine.
   */
  tested: number;
  /** Rough.js drawable cache hit rate, 0…1. Sits at ~1 once warm. */
  cacheHitRate: number;
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
  private readonly rough: RoughCanvas;
  readonly cache = new RoughCache();

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    private readonly scene: Scene,
  ) {
    this.rough = createRoughCanvas(canvas);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  render(vp: Viewport, stages: StageTimer): RenderStats {
    const { ctx } = this;
    const dpr = vp.devicePixelRatio;
    const cssW = vp.width;
    const cssH = vp.height;

    this.cache.resetStats();

    /* ── 1. Clear, in DEVICE space ─────────────────────────────────────────
       Identity transform, so the clear covers the whole backing store whatever
       the scene transform is doing. Clearing under a scene transform while
       scrolled far from the origin is a reliable way to miss part of the canvas
       and leave stale pixels behind. */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, Math.ceil(cssW * dpr), Math.ceil(cssH * dpr));

    /* ── 2. Chrome, in SCREEN space ────────────────────────────────────────
       DPR only. The grid positions itself using the viewport transform but
       strokes 1-CSS-pixel lines, so it stays crisp at every zoom. */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stages.begin('grid');
    const gridLines = drawGrid(ctx, vp.get(), cssW, cssH, this.theme.grid);
    stages.end('grid');

    /* ── 3. Content, in SCENE space ────────────────────────────────────────
       From here on every draw call is in raw scene coordinates. Nothing below
       this line knows about zoom, scroll or devicePixelRatio. */
    const m = vp.deviceMatrix();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);

    /* Cull and draw are timed separately because they scale differently, and
       confusing them is how you optimise the wrong thing.

         cull  is O(total)   — it grows with everything you have ever drawn
         draw  is O(visible) — it grows with what fits on the screen

       At 50,000 elements zoomed in on a corner, `draw` is trivial and `cull` is
       the entire frame. Phase 4's quadtree attacks only the first number. If
       these were reported as one figure you could halve the cull and watch the
       total barely move, with no idea why. */
    stages.begin('cull');
    const visible = this.scene.visible(vp.visibleSceneBounds());
    stages.end('cull');

    stages.begin('draw');
    for (const el of visible) {
      drawElement(ctx, this.rough, this.cache, el);
    }
    stages.end('draw');

    const { hits, misses } = this.cache.stats();
    const lookups = hits + misses;

    return {
      gridLines,
      drawn: visible.length,
      total: this.scene.visibleCount,
      tested: this.scene.queryStats.tested,
      cacheHitRate: lookups === 0 ? 1 : hits / lookups,
    };
  }
}
