/**
 * How big is the export, and is that a size the browser can actually make?
 *
 * ── Export is not a screenshot ─────────────────────────────────────────────
 *
 * `canvas.toBlob()` on the live canvas captures the current viewport, at the
 * current zoom, with the selection handles in it. Wrong on three counts, and the
 * third is the one that gets shipped: nobody notices the handles until a user
 * puts the image in a slide deck.
 *
 * An export has its own viewport, unrelated to the screen's — it frames the
 * *content*, at a scale the caller chose, with nothing on top.
 *
 * ── Why this file is separate from the one that draws ──────────────────────
 *
 * Everything here is arithmetic over rectangles. No canvas, no DOM. That means
 * the decisions that actually go wrong — an empty scene, a scene one element
 * wide, a scale the browser will silently refuse — are unit-testable in Node,
 * and the part that needs a canvas is reduced to a loop that calls
 * `drawElement`.
 *
 * Same move as Phase 7's `TextMeasurer`: push the untestable thing to the edge
 * until what is left is arithmetic.
 */

import { type Bounds, boundsHeight, boundsWidth, expandBounds, unionBounds } from '../util/geometry';
import { getRenderBounds } from '../scene/bounds';
import type { Element } from '../scene/element.types';

/**
 * Largest side a canvas may have, in device pixels.
 *
 * Browsers cap canvas dimensions and **do not tell you** when you exceed them:
 * `getContext` succeeds, drawing succeeds, and `toBlob` hands back a blank image
 * or null. No exception, no console warning, and no API to ask the limit.
 *
 * ── This number is a compromise, not a safe floor ──────────────────────────
 *
 * 16,384 covers desktop Chrome, Firefox and Safari. It does **not** cover iOS,
 * which MDN documents as capping at **4,096** — a quarter of this. Using 4,096
 * everywhere would cripple desktop exports of large drawings to fix a case that
 * only arises on one platform, so the trade taken is:
 *
 *   - clamp to 16,384 here, which is right for the overwhelming majority;
 *   - and let `toPng` catch the null from `toBlob` and say *"the browser refused
 *     a WxH image — try a smaller scale"*, which is the honest iOS path.
 *
 * That is a worse experience on iOS than getting it right the first time, and
 * it is a recoverable one. Detecting the real limit means binary-searching
 * canvas allocations at startup, which is what the `canvas-size` library does
 * and is more machinery than this earns today.
 */
export const MAX_CANVAS_DIMENSION = 16_384;

/**
 * Largest total area, in device pixels.
 *
 * The one people miss. A canvas can be under the per-side cap on both axes and
 * still be refused: Chrome's limit is roughly 2^28 pixels, so 16,384 × 16,384 is
 * exactly at it and 20,000 × 15,000 — both sides legal — is not.
 */
export const MAX_CANVAS_AREA = 268_435_456;

export const EXPORT_PADDING = 24;
export const EXPORT_SCALES = [1, 2, 3] as const;
export type ExportScale = (typeof EXPORT_SCALES)[number];

/**
 * The rectangle an export should frame.
 *
 * `getRenderBounds`, not `getGeometryBounds`: the padded box that includes the
 * stroke width, Rough.js's outward jitter, and a pixel of antialiasing. Frame
 * the geometry box instead and every shape on the edge of the drawing is shaved
 * — visible on the outermost stroke of every export, and easy to mistake for a
 * rendering bug rather than a framing one.
 *
 * Returns null for an empty scene. An empty export is not a 0×0 image, it is a
 * thing the caller has to refuse.
 */
export function exportBounds(
  elements: readonly Element[],
  padding = EXPORT_PADDING,
): Bounds | null {
  let acc: Bounds | null = null;
  for (const el of elements) {
    if (el.isDeleted) continue;
    const b = getRenderBounds(el);
    acc = acc === null ? b : unionBounds(acc, b);
  }
  return acc === null ? null : expandBounds(acc, padding);
}

export interface ExportSize {
  /** Pixel dimensions of the output. Always whole numbers. */
  readonly width: number;
  readonly height: number;
  /** The scale actually used, which may be below the one requested. */
  readonly scale: number;
  /** True when the requested scale had to be reduced to fit the browser's caps. */
  readonly clamped: boolean;
}

/**
 * Turn a scene rectangle and a requested scale into a canvas size the browser
 * will accept.
 *
 * ── Clamping rather than refusing ──────────────────────────────────────────
 *
 * The alternative is an error: *"this export is too large."* It is worse. The
 * user asked for a picture of their drawing; a slightly smaller picture is
 * almost always what they wanted, and an error leaves them guessing which
 * number to change. So the scale comes down and the caller is *told* it came
 * down — `clamped` exists so the UI can say "exported at 1.4× instead of 3×"
 * rather than silently doing something different from what was asked.
 *
 * Two constraints, and both have to be applied: a side cap and an area cap. Fit
 * the sides first, then check the area, because the area fix is a square root
 * and applying it first can still leave a side over the cap on a very long thin
 * drawing.
 */
export function fitExportSize(bounds: Bounds, requestedScale: number): ExportSize {
  const w = Math.max(1, boundsWidth(bounds));
  const h = Math.max(1, boundsHeight(bounds));

  let scale = Math.max(0.01, requestedScale);

  // 1. Neither side may exceed the per-side cap.
  const sideLimit = Math.min(MAX_CANVAS_DIMENSION / w, MAX_CANVAS_DIMENSION / h);
  if (scale > sideLimit) scale = sideLimit;

  // 2. Nor may the product exceed the area cap. `scale²·w·h ≤ AREA`.
  const areaLimit = Math.sqrt(MAX_CANVAS_AREA / (w * h));
  if (scale > areaLimit) scale = areaLimit;

  /* Ceil, then re-clamp. Rounding up can push a dimension one pixel past the cap
     when the scale landed exactly on it — a one-pixel overflow that still
     produces a blank image, and the least findable bug in this file. */
  const width = Math.min(MAX_CANVAS_DIMENSION, Math.max(1, Math.ceil(w * scale)));
  const height = Math.min(MAX_CANVAS_DIMENSION, Math.max(1, Math.ceil(h * scale)));

  return {
    width,
    height,
    scale,
    // A tolerance rather than `!==`: the arithmetic above can shave a scale by
    // 10⁻¹⁵ without meaning anything by it, and telling the user their 2× export
    // was clamped to 1.9999999999999998× is worse than not telling them.
    clamped: scale < requestedScale - 1e-9,
  };
}

/**
 * The transform that maps scene coordinates onto the export canvas.
 *
 * A **fresh** transform, unrelated to the screen's viewport — which is the whole
 * point of §9 and the reason `drawElement` has never been allowed to read
 * `zoom`, `scroll` or `devicePixelRatio`. It reads six numbers off the context
 * and does not care where they came from.
 *
 * `[a, b, c, d, e, f]` in the order `ctx.setTransform` takes them.
 */
export function exportMatrix(
  bounds: Bounds,
  scale: number,
): [number, number, number, number, number, number] {
  return [scale, 0, 0, scale, -bounds.minX * scale, -bounds.minY * scale];
}
