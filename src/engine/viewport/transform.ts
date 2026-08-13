/**
 * The coordinate-space transform. Pure functions only — no state, no DOM.
 *
 * ── The three spaces (ARCHITECTURE §4) ──────────────────────────────────────
 *
 *   SCREEN   CSS pixels, origin at the canvas's top-left corner.
 *            Where pointer events live. `e.clientX - rect.left`.
 *
 *   SCENE    The infinite plane. Where every element's coordinates are stored.
 *            Unbounded in all four directions. DPR-independent by construction.
 *
 *   DEVICE   Physical pixels. `screen * devicePixelRatio`.
 *            What `canvas.width`, `clearRect` and clip rectangles are measured in.
 *
 * Confusing any two of these is the single largest source of bugs in canvas
 * applications. The defence is that this file is the *only* place the
 * conversions are written, every function name says which space it takes and
 * which it returns, and the round-trips are property-tested.
 *
 * ── The transform ───────────────────────────────────────────────────────────
 *
 *   screen = (scene + scroll) * zoom
 *   scene  = screen / zoom - scroll
 *
 * `scroll` is stored in SCENE units, `zoom` is a dimensionless scalar.
 *
 * Storing scroll in scene units rather than screen units is the choice that
 * makes {@link zoomAtPoint} derivable in three lines instead of six, because
 * it keeps zoom out of the scroll term. The cost is that panning has to divide
 * the screen-space delta by zoom — one division, in one place.
 *
 * Note that DPR appears in exactly one function ({@link buildDeviceMatrix}).
 * Once that matrix is installed on the context, every draw call downstream is
 * written in plain scene coordinates and no drawing code ever thinks about
 * pixel ratios again.
 */

import type { Bounds, Point } from '../util/geometry';
import { clamp } from '../util/math';

export interface ViewportState {
  /** Scene-space horizontal offset. */
  readonly scrollX: number;
  /** Scene-space vertical offset. */
  readonly scrollY: number;
  /** Scale factor. 1 = 100%. */
  readonly zoom: number;
}

/**
 * Zoom limits.
 *
 * The lower bound is not a UX preference — it is a numerical one. Scene
 * coordinates are float64; at very small zoom a single screen pixel spans a
 * huge scene distance, and the reverse at very large zoom. 0.1 … 30 keeps the
 * useful range comfortably inside the precision envelope while covering
 * "the whole diagram" to "align two strokes by eye".
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 30;

export const DEFAULT_VIEWPORT: ViewportState = { scrollX: 0, scrollY: 0, zoom: 1 };

export function clampZoom(zoom: number): number {
  return clamp(zoom, MIN_ZOOM, MAX_ZOOM);
}

/* ── scene → screen ───────────────────────────────────────────────────────── */

export function sceneToScreenX(sceneX: number, vp: ViewportState): number {
  return (sceneX + vp.scrollX) * vp.zoom;
}

export function sceneToScreenY(sceneY: number, vp: ViewportState): number {
  return (sceneY + vp.scrollY) * vp.zoom;
}

export function sceneToScreen(p: Point, vp: ViewportState): Point {
  return { x: sceneToScreenX(p.x, vp), y: sceneToScreenY(p.y, vp) };
}

/* ── screen → scene ───────────────────────────────────────────────────────── */

export function screenToSceneX(screenX: number, vp: ViewportState): number {
  return screenX / vp.zoom - vp.scrollX;
}

export function screenToSceneY(screenY: number, vp: ViewportState): number {
  return screenY / vp.zoom - vp.scrollY;
}

export function screenToScene(p: Point, vp: ViewportState): Point {
  return { x: screenToSceneX(p.x, vp), y: screenToSceneY(p.y, vp) };
}

/**
 * Convert a scene-space *length* to screen pixels, and back.
 *
 * Distinct from converting a *position* — a length has no origin, so scroll
 * does not apply. Mixing the two up produces the bug where a stroke width or a
 * hit-test threshold drifts as you pan, which is baffling until you notice
 * that only the translation term was wrong.
 */
export function sceneToScreenLength(len: number, vp: ViewportState): number {
  return len * vp.zoom;
}

export function screenToSceneLength(len: number, vp: ViewportState): number {
  return len / vp.zoom;
}

/* ── the matrix ───────────────────────────────────────────────────────────── */

/** A 2D affine matrix in `setTransform(a, b, c, d, e, f)` order. */
export type Matrix2D = readonly [number, number, number, number, number, number];

/**
 * Build the matrix installed once per frame, before anything is drawn.
 *
 * `setTransform(a, b, c, d, e, f)` maps `(x, y) → (ax + cy + e, bx + dy + f)`.
 * With `b = c = 0` that is scale-then-translate, which is exactly our
 * transform with DPR folded in:
 *
 *   deviceX = screenX * dpr = (sceneX + scrollX) * zoom * dpr
 *           = (zoom * dpr) * sceneX + (scrollX * zoom * dpr)
 *              └─── a ───┘            └────── e ──────┘
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/setTransform
 */
export function buildDeviceMatrix(vp: ViewportState, dpr: number): Matrix2D {
  const s = vp.zoom * dpr;
  return [s, 0, 0, s, vp.scrollX * s, vp.scrollY * s];
}

/* ── operations ───────────────────────────────────────────────────────────── */

/**
 * Pan by a screen-space delta.
 *
 * The division by zoom is the whole content of this function and it is easy to
 * forget: dragging 10 screen pixels at 4× zoom moves the scene by 2.5 units,
 * not 10. Without it, panning feels correct at 100% and increasingly wrong as
 * you zoom in — the classic "it works on my machine at default zoom" bug.
 */
export function panByScreenDelta(vp: ViewportState, dx: number, dy: number): ViewportState {
  return {
    scrollX: vp.scrollX + dx / vp.zoom,
    scrollY: vp.scrollY + dy / vp.zoom,
    zoom: vp.zoom,
  };
}

/**
 * Zoom while keeping one screen point pinned to the same scene point.
 *
 * Derived rather than guessed. State the invariant first:
 *
 *   Let P be the anchor in screen space (the cursor — it does not move).
 *   Let S = screenToScene(P, vpOld)   — the scene point currently under it.
 *
 *   Require:  screenToScene(P, vpNew) === S
 *             P / zoomNew - scrollNew === S
 *             scrollNew = P / zoomNew - S
 *
 * That is the last line of the function. Nothing else is needed, and there is
 * no case analysis — it works for zooming in, out, and about any point,
 * including points outside the canvas.
 *
 * @param anchor screen-space point to keep fixed
 */
export function zoomAtPoint(
  vp: ViewportState,
  anchor: Point,
  nextZoom: number,
): ViewportState {
  const zoom = clampZoom(nextZoom);

  // Pin the scene point currently under the anchor…
  const sceneX = screenToSceneX(anchor.x, vp);
  const sceneY = screenToSceneY(anchor.y, vp);

  // …then solve for the scroll that puts it back under the anchor at the new zoom.
  return {
    zoom,
    scrollX: anchor.x / zoom - sceneX,
    scrollY: anchor.y / zoom - sceneY,
  };
}

/**
 * Multiplicative zoom step.
 *
 * Zoom must compound, not accumulate. Perceived scale is logarithmic: 1.0 → 1.1
 * is an obvious jump, 10.0 → 10.1 is invisible. `zoom * factor` feels uniform
 * at every level; `zoom + delta` feels violent when zoomed out and dead when
 * zoomed in.
 *
 * `Math.exp` rather than repeated multiplication so that a continuous wheel
 * delta maps smoothly, and so that scrolling +d then −d returns to where you
 * started (exp(d) * exp(-d) === 1, to within float error).
 */
export function zoomStep(zoom: number, delta: number, sensitivity = 0.01): number {
  return clampZoom(zoom * Math.exp(-delta * sensitivity));
}

/* ── derived queries ──────────────────────────────────────────────────────── */

/**
 * The rectangle of scene space currently visible.
 *
 * From Phase 4 this becomes the quadtree query that culls everything off-screen,
 * which is what makes frame cost independent of scene size. Here it already
 * earns its keep by bounding the grid-drawing loop — without it, an infinite
 * canvas means an infinite loop.
 */
export function getVisibleSceneBounds(
  vp: ViewportState,
  cssWidth: number,
  cssHeight: number,
): Bounds {
  return {
    minX: screenToSceneX(0, vp),
    minY: screenToSceneY(0, vp),
    maxX: screenToSceneX(cssWidth, vp),
    maxY: screenToSceneY(cssHeight, vp),
  };
}

/**
 * Viewport that fits `bounds` into the canvas with `padding` fraction of slack.
 *
 * Two independent constraints — fit horizontally, fit vertically — so take the
 * smaller zoom, then centre. Guards against a zero-sized target, which happens
 * with a single point element or an empty selection and would otherwise produce
 * `zoom = Infinity` and a blank canvas with no error.
 */
export function fitToBounds(
  bounds: Bounds,
  cssWidth: number,
  cssHeight: number,
  padding = 0.1,
): ViewportState {
  const w = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const h = Math.max(bounds.maxY - bounds.minY, 1e-6);

  const usableW = cssWidth * (1 - padding);
  const usableH = cssHeight * (1 - padding);
  const zoom = clampZoom(Math.min(usableW / w, usableH / h));

  // Centre: put the midpoint of `bounds` at the midpoint of the canvas.
  //   sceneToScreen(mid) === canvasCentre
  //   (mid + scroll) * zoom === centre     ⟹   scroll = centre/zoom - mid
  const midX = (bounds.minX + bounds.maxX) / 2;
  const midY = (bounds.minY + bounds.maxY) / 2;

  return {
    zoom,
    scrollX: cssWidth / 2 / zoom - midX,
    scrollY: cssHeight / 2 / zoom - midY,
  };
}

/** Do two viewports describe the same view? Used to skip redundant redraws. */
export function viewportEquals(a: ViewportState, b: ViewportState): boolean {
  return a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.zoom === b.zoom;
}
