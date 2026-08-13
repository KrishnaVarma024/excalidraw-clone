/**
 * The infinite background grid, with level-of-detail.
 *
 * ── Why LOD is not optional ─────────────────────────────────────────────────
 *
 * A grid with fixed scene-space spacing is unusable on an infinite canvas. At
 * 20 scene units and zoom 0.1 the lines are 2 screen pixels apart — a grey
 * smear, and a loop over hundreds of thousands of positions. At zoom 10 they
 * are 200 pixels apart and stop conveying scale at all.
 *
 * So the spacing is chosen *per frame* from the zoom. The user perceives a grid
 * that stays put; what actually happens is that it silently walks a ladder of
 * spacings as they zoom.
 *
 * ── Two levels, and why the ladder must be nested ───────────────────────────
 *
 * Drawing a single level makes the grid *pop*: cross a rung boundary while
 * zooming and most of the lines vanish between one frame and the next, which
 * reads as a rendering glitch. The fix is to draw two adjacent rungs and
 * cross-fade the finer one in as it earns its space.
 *
 * That only works if the two lattices are **nested** — every coarse line must
 * also be a fine line. My first attempt used the 1-2-5 ladder (1, 2, 5, 10, 20,
 * 50 …) because those are the intervals humans read fluently, and it was wrong
 * twice over:
 *
 *   1. 5 is not a multiple of 2. With fine = 2 and coarse = 5 the drawn
 *      positions are 2, 4, 5, 6, 8, 10, 12, 14, 15, 16 … — visibly irregular
 *      spacing, before any transition happens at all.
 *   2. At the 2 → 5 handover, every line at an odd multiple of 5 goes from
 *      fully opaque to not drawn in one frame. A cross-fade cannot rescue a
 *      lattice that simply is not a subset of the next one.
 *
 * Powers of two are nested by construction. Every rung is exactly half the one
 * above, so:
 *
 *   - the union of the two lattices is always a regular grid
 *   - at each handover the fine level (already at alpha 1) becomes the coarse
 *     level, the old coarse level is still drawn because it is a multiple of
 *     the new coarse step, and a new fine level appears at alpha 0
 *
 * Every line's opacity is therefore a continuous function of zoom. That is not
 * an aesthetic claim — `grid.test.ts` samples it across the entire zoom range
 * and asserts no line's opacity ever moves more than 2% for a 0.2% zoom change.
 *
 * ── What that costs ─────────────────────────────────────────────────────────
 *
 * Spacings are 8, 16, 32, 64 rather than 10, 20, 50, 100. Round decimal numbers
 * genuinely do read better — but there are no rulers or numeric labels in v1,
 * so nobody ever reads the number, while everybody sees the popping. Given the
 * choice between "reads nicely in a spec" and "provably smooth on screen", the
 * second one is the product.
 *
 * If v2 adds rulers with labels, the honest options are: switch to 1-2-5 and
 * accept the pop, or keep powers of two and label them (8, 16, 32 is fine on a
 * ruler), or draw labels from a 1-2-5 sequence decoupled from the lattice.
 */

import type { ViewportState } from '../viewport/transform';
import { getVisibleSceneBounds, sceneToScreenX, sceneToScreenY } from '../viewport/transform';
import { clamp, inverseLerp } from '../util/math';

/** Minimum on-screen spacing of the coarse grid, in CSS pixels. */
const TARGET_SPACING_PX = 26;

/** Nested ladder ratio. Powers of two — see the header. */
export const RUNG_RATIO = 2;

/**
 * Hard cap on lines per axis per frame.
 *
 * The LOD maths already holds the count near constant, so this should never
 * bind. It exists because "should never" and "does never" are different claims,
 * and the failure mode without it is a frozen tab rather than a slightly wrong
 * grid.
 */
const MAX_LINES_PER_AXIS = 500;

export interface GridLevel {
  /** Coarse spacing, scene units. A power of two. Always fully opaque. */
  readonly coarseStep: number;
  /** Fine spacing, scene units. Exactly half of `coarseStep`. */
  readonly fineStep: number;
  /** Coarse spacing on screen, CSS px. Provably in [target, 2 × target). */
  readonly coarseScreenStep: number;
  /** Fine spacing on screen, CSS px. Provably in [target/2, target). */
  readonly fineScreenStep: number;
  /** 0…1 — opacity of the fine level. Continuous in zoom. */
  readonly fineAlpha: number;
}

/**
 * Pick the two grid rungs to draw at this zoom.
 *
 * `ceil(log2(ideal))` is the smallest power of two at or above the ideal
 * spacing, which is what pins `coarseScreenStep` into `[target, 2 × target)`.
 */
export function chooseGridLevel(zoom: number, targetPx = TARGET_SPACING_PX): GridLevel {
  const ideal = targetPx / zoom;

  // Powers of two are exactly representable in float64 across our whole range,
  // so this introduces no drift — which matters, because a step that wobbles by
  // one ULP between frames makes the whole grid shimmer.
  const coarseStep = 2 ** Math.ceil(Math.log2(ideal));
  const fineStep = coarseStep / RUNG_RATIO;

  const coarseScreenStep = coarseStep * zoom;
  const fineScreenStep = fineStep * zoom;

  // Ramp the fine level in across exactly the span it occupies: it appears at
  // target/2 (the instant the previous handover happened) and reaches full
  // opacity at target (the instant it is promoted to coarse). Because those two
  // moments coincide with the rung change, opacity never jumps.
  const fineAlpha = clamp(
    inverseLerp(targetPx / RUNG_RATIO, targetPx, fineScreenStep),
    0,
    1,
  );

  return { coarseStep, fineStep, coarseScreenStep, fineScreenStep, fineAlpha };
}

/**
 * Opacity a given scene-space lattice is drawn at, at a given zoom.
 *
 * Exported for the tests: this is the function whose continuity *is* the
 * anti-pop guarantee, and asserting it directly is much stronger than eyeballing
 * the canvas. A line sits on the coarse lattice if its spacing is a multiple of
 * `coarseStep`; coarse is drawn after fine, so it wins where they coincide.
 */
export function latticeAlpha(sceneStep: number, zoom: number, targetPx?: number): number {
  const { coarseStep, fineStep, fineAlpha } = chooseGridLevel(zoom, targetPx);
  if (sceneStep % coarseStep === 0) return 1;
  if (sceneStep % fineStep === 0) return fineAlpha;
  return 0;
}

export interface GridStyle {
  readonly fineColor: string;
  readonly coarseColor: string;
  readonly axisColor: string;
}

/**
 * Draw the grid in SCREEN space, with the scene transform *not* applied.
 *
 * Drawing in scene space would be shorter, but then every line would be scaled
 * by zoom — at 5× the "1px" lines are 5px wide, at 0.2× they vanish below one
 * pixel. Grid lines are chrome: one crisp pixel at every zoom level.
 *
 * That distinction — chrome in screen space, content in scene space — recurs
 * throughout the project. Selection handles, hit-test thresholds and snap
 * guides are all chrome, and all measured in screen pixels.
 *
 * @returns lines actually stroked — surfaced in the stats overlay as a cheap
 *          check that LOD is doing its job. It should stay roughly constant
 *          across the entire zoom range.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  vp: ViewportState,
  cssWidth: number,
  cssHeight: number,
  style: GridStyle,
): number {
  const level = chooseGridLevel(vp.zoom);
  const view = getVisibleSceneBounds(vp, cssWidth, cssHeight);

  ctx.save();
  ctx.lineWidth = 1;

  let drawn = 0;
  // Fine first, so coarse lines paint over them where the lattices coincide.
  if (level.fineAlpha > 0.01) {
    drawn += strokeLattice(ctx, vp, view, cssWidth, cssHeight, level.fineStep, {
      color: style.fineColor,
      alpha: level.fineAlpha,
    });
  }
  drawn += strokeLattice(ctx, vp, view, cssWidth, cssHeight, level.coarseStep, {
    color: style.coarseColor,
    alpha: 1,
  });

  // The scene origin, so "where am I?" always has an answer while panning.
  ctx.globalAlpha = 1;
  ctx.strokeStyle = style.axisColor;
  ctx.beginPath();
  const originX = Math.round(sceneToScreenX(0, vp)) + 0.5;
  const originY = Math.round(sceneToScreenY(0, vp)) + 0.5;
  if (originX >= -1 && originX <= cssWidth + 1) {
    ctx.moveTo(originX, 0);
    ctx.lineTo(originX, cssHeight);
  }
  if (originY >= -1 && originY <= cssHeight + 1) {
    ctx.moveTo(0, originY);
    ctx.lineTo(cssWidth, originY);
  }
  ctx.stroke();

  ctx.restore();
  return drawn;
}

/**
 * Stroke one full lattice at `step`, as a single path.
 *
 * One `beginPath` and one `stroke` for the whole lattice rather than per line.
 * Changing `strokeStyle` or issuing `stroke()` mid-lattice is one of the
 * reliably expensive things you can do to a 2D context: it flushes driver state
 * and can force a separate rasterisation pass per call.
 */
function strokeLattice(
  ctx: CanvasRenderingContext2D,
  vp: ViewportState,
  view: { minX: number; minY: number; maxX: number; maxY: number },
  cssWidth: number,
  cssHeight: number,
  step: number,
  paint: { color: string; alpha: number },
): number {
  // Snap the loop bounds outward onto the lattice, so lines do not shimmer in
  // and out of existence as you pan.
  const startX = Math.floor(view.minX / step) * step;
  const startY = Math.floor(view.minY / step) * step;

  const countX = Math.ceil((view.maxX - startX) / step) + 1;
  const countY = Math.ceil((view.maxY - startY) / step) + 1;
  if (countX > MAX_LINES_PER_AXIS || countY > MAX_LINES_PER_AXIS) return 0;

  ctx.globalAlpha = paint.alpha;
  ctx.strokeStyle = paint.color;
  ctx.beginPath();

  let drawn = 0;

  for (let i = 0; i < countX; i++) {
    const x = Math.round(sceneToScreenX(startX + i * step, vp)) + 0.5;
    if (x < -1 || x > cssWidth + 1) continue;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssHeight);
    drawn++;
  }

  for (let i = 0; i < countY; i++) {
    const y = Math.round(sceneToScreenY(startY + i * step, vp)) + 0.5;
    if (y < -1 || y > cssHeight + 1) continue;
    ctx.moveTo(0, y);
    ctx.lineTo(cssWidth, y);
    drawn++;
  }

  ctx.stroke();
  return drawn;
}

export { TARGET_SPACING_PX };
