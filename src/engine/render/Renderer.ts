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
 * Phase 4 replaced the O(n) cull with a quadtree range query — and, because the
 * index is not unconditionally better, with a choice between three strategies
 * made per frame. The renderer does not know or care which one ran; it asks
 * `Scene.visible` for what is on screen and reports the answer's cost. See
 * `Scene.visible` for the cost model, and `RenderStats.path` for what it chose.
 *
 * ── The structural rule, unchanged ──────────────────────────────────────────
 *
 * The renderer reads state and writes pixels. It mutates nothing. That purity
 * is what lets Phase 9 point this same code at an offscreen canvas with a
 * different transform and get an export, with no changes to this file.
 */

import type { Viewport } from '../viewport/Viewport';
import { sceneToScreenX, sceneToScreenY } from '../viewport/transform';
import type { Bounds } from '../util/geometry';
import type { QueryPath, Scene } from '../scene/Scene';
import { type GridStyle, drawGrid } from './grid';
import { createRoughCanvas, drawElement } from './drawElement';
import { RoughCache } from './roughCache';
import type { StageTimer } from '../util/perf';
import { type RenderPlan, snapToDevicePixels } from './DirtyTracker';
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
  /** Quadtree nodes descended into. Near-constant as the scene grows. */
  nodes: number;
  /**
   * Which of `Scene.visible`'s three strategies ran.
   *
   * On screen because "the cull got slower" and "the cull took a different
   * path" look identical in a timing and have completely different fixes.
   */
  path: QueryPath;
  /** Rough.js drawable cache hit rate, 0…1. Sits at ~1 once warm. */
  cacheHitRate: number;
  /** Regions repainted this frame. 0 on a full repaint, which is reported as such. */
  dirtyRects: number;
  /** Fraction of the viewport repainted, 0…1. The number this phase exists to lower. */
  dirtyCoverage: number;
  /** Whether this frame repainted everything. */
  fullRepaint: boolean;
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

  /**
   * Paint, following `plan`.
   *
   * A full repaint is the old code path, unchanged and deliberately kept — it is
   * what every global change falls back to, and it is the reference the partial
   * path is checked against.
   */
  render(vp: Viewport, stages: StageTimer, plan: RenderPlan): RenderStats {
    this.cache.resetStats();
    return plan.kind === 'partial'
      ? this.renderPartial(vp, stages, plan.rects, plan.coverage)
      : this.renderFull(vp, stages);
  }

  /* ── full repaint ───────────────────────────────────────────────────────── */

  private renderFull(vp: Viewport, stages: StageTimer): RenderStats {
    const { ctx } = this;
    const dpr = vp.devicePixelRatio;

    /* ── 1. Clear, in DEVICE space ─────────────────────────────────────────
       Identity transform, so the clear covers the whole backing store whatever
       the scene transform is doing. Clearing under a scene transform while
       scrolled far from the origin is a reliable way to miss part of the canvas
       and leave stale pixels behind. */
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.theme.background;
    ctx.fillRect(0, 0, Math.ceil(vp.width * dpr), Math.ceil(vp.height * dpr));

    /* ── 2. Chrome, in SCREEN space ────────────────────────────────────────
       DPR only. The grid positions itself using the viewport transform but
       strokes 1-CSS-pixel lines, so it stays crisp at every zoom. */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stages.begin('grid');
    const gridLines = drawGrid(ctx, vp.get(), vp.width, vp.height, this.theme.grid);
    stages.end('grid');

    /* ── 3. Content, in SCENE space ────────────────────────────────────────
       From here on every draw call is in raw scene coordinates. Nothing below
       this line knows about zoom, scroll or devicePixelRatio. */
    this.applySceneTransform(vp);

    stages.begin('cull');
    const visible = this.scene.visible(vp.visibleSceneBounds());
    stages.end('cull');

    stages.begin('draw');
    for (const el of visible) drawElement(ctx, this.rough, this.cache, el);
    stages.end('draw');

    return this.finish(gridLines, visible.length, 0, 1, true);
  }

  /* ── partial repaint ────────────────────────────────────────────────────── */

  /**
   * Repair only the given scene rectangles.
   *
   * Each region is an independent mini-frame: clip to it, repaint the background
   * and grid inside it, then redraw every element that overlaps it — **all of
   * them, in z-order**, not just the one that moved. An element sitting on top
   * of the moved one has just had its pixels erased by the clear, and only
   * redrawing the whole stack inside the region puts it back.
   *
   * That is the step people skip, and the symptom is shapes that vanish where
   * something passed beneath them.
   */
  private renderPartial(
    vp: Viewport,
    stages: StageTimer,
    rects: readonly Bounds[],
    coverage: number,
  ): RenderStats {
    const { ctx } = this;
    const dpr = vp.devicePixelRatio;
    const view = vp.get();

    let gridLines = 0;
    let drawn = 0;
    let tested = 0;
    let nodes = 0;

    for (const sceneRect of rects) {
      /* Scene → device, then snap OUTWARD to whole device pixels.
         Snapping after the conversion is the whole trick: a rectangle snapped in
         scene units still lands on a half device pixel at dpr 2, and the seam it
         leaves is a one-pixel ghost that follows the shape around. */
      const device = snapToDevicePixels({
        minX: sceneToScreenX(sceneRect.minX, view) * dpr,
        minY: sceneToScreenY(sceneRect.minY, view) * dpr,
        maxX: sceneToScreenX(sceneRect.maxX, view) * dpr,
        maxY: sceneToScreenY(sceneRect.maxY, view) * dpr,
      });

      const w = device.maxX - device.minX;
      const h = device.maxY - device.minY;
      if (w <= 0 || h <= 0) continue;

      ctx.save();

      // Clip in DEVICE space, where the integers we just computed mean what they
      // say. Clipping under the scene transform would re-introduce fractions.
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.rect(device.minX, device.minY, w, h);
      ctx.clip();

      ctx.fillStyle = this.theme.background;
      ctx.fillRect(device.minX, device.minY, w, h);

      stages.begin('grid');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      gridLines += drawGrid(ctx, view, vp.width, vp.height, this.theme.grid);
      stages.end('grid');

      this.applySceneTransform(vp);

      stages.begin('cull');
      const overlapping = this.scene.visible(sceneRect);
      stages.end('cull');
      tested += this.scene.queryStats.tested;
      nodes += this.scene.queryStats.nodes;

      stages.begin('draw');
      for (const el of overlapping) drawElement(ctx, this.rough, this.cache, el);
      stages.end('draw');
      drawn += overlapping.length;

      ctx.restore();
    }

    return this.finish(gridLines, drawn, rects.length, coverage, false, tested, nodes);
  }

  private applySceneTransform(vp: Viewport): void {
    const m = vp.deviceMatrix();
    this.ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }

  private finish(
    gridLines: number,
    drawn: number,
    dirtyRects: number,
    dirtyCoverage: number,
    fullRepaint: boolean,
    tested = this.scene.queryStats.tested,
    nodes = this.scene.queryStats.nodes,
  ): RenderStats {
    const { hits, misses } = this.cache.stats();
    const lookups = hits + misses;

    return {
      gridLines,
      drawn,
      total: this.scene.visibleCount,
      tested,
      nodes,
      path: this.scene.queryStats.path,
      cacheHitRate: lookups === 0 ? 1 : hits / lookups,
      dirtyRects,
      dirtyCoverage,
      fullRepaint,
    };
  }
}
