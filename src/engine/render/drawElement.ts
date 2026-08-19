/**
 * Per-element drawing.
 *
 * Everything here draws in **scene coordinates**. The viewport transform is
 * already installed on the context by the renderer, so no function in this file
 * knows about zoom, scroll or devicePixelRatio. That is the payoff for folding
 * all three into one matrix once per frame.
 *
 * It is also what will let Phase 9 reuse this exact code to render an export at
 * a different scale to an offscreen canvas, with no changes. If export ever
 * needs to modify this file, that is a signal something in here is reading
 * screen state it should not be.
 */

import rough from 'roughjs';
import type { RoughCanvas } from 'roughjs/bin/canvas';
import getStroke from 'perfect-freehand';
import {
  type Element,
  type FreedrawElement,
  type LinearElement,
  type TextElement,
  assertNever,
} from '../scene/element.types';
import { fontString } from '../text/measure';
import { alignOffset } from '../text/wrap';
import { getElementCenter } from '../scene/bounds';
import type { RoughCache } from './roughCache';

/** Wrap a canvas for Rough.js. One per context; cheap, but not free. */
export function createRoughCanvas(canvas: HTMLCanvasElement): RoughCanvas {
  return rough.canvas(canvas);
}

/**
 * Draw one element.
 *
 * The caller is responsible for having installed the scene transform. This
 * function saves and restores context state around its own work, so callers do
 * not have to reason about leaked `globalAlpha` or a stray rotation.
 */
export function drawElement(
  ctx: CanvasRenderingContext2D,
  rc: RoughCanvas,
  cache: RoughCache,
  el: Element,
): void {
  ctx.save();

  ctx.globalAlpha = el.opacity / 100;

  /* ── Rotation ────────────────────────────────────────────────────────────
     Applied once, here, by moving the origin to the element's centre. Every
     draw function below can then behave as though `angle` were zero.

     The mirror image of this trick appears in Phase 4's hit-testing: rather
     than rotating the *shape*, it rotates the query *point* by the negative
     angle into this same local frame. One idea, used in both directions,
     replaces a dozen special cases. */
  if (el.angle !== 0) {
    const c = getElementCenter(el);
    ctx.translate(c.x, c.y);
    ctx.rotate(el.angle);
    ctx.translate(-c.x, -c.y);
  }

  switch (el.type) {
    case 'rectangle':
    case 'diamond':
    case 'ellipse':
      // Drawables are generated at the origin, so translating here means moving
      // an element never invalidates its cached drawable — only resizing does.
      ctx.translate(el.x, el.y);
      rc.draw(cache.get(el));
      break;

    case 'line':
      ctx.translate(el.x, el.y);
      rc.draw(cache.get(el));
      break;

    case 'arrow':
      ctx.translate(el.x, el.y);
      rc.draw(cache.get(el));
      drawArrowheads(ctx, el);
      break;

    case 'freedraw':
      drawFreedraw(ctx, el);
      break;

    case 'text':
      drawText(ctx, el);
      break;

    default:
      assertNever(el, 'drawElement');
  }

  ctx.restore();
}

/* ── freehand ─────────────────────────────────────────────────────────────── */

/**
 * Freehand strokes are **filled outlines**, not stroked polylines.
 *
 * That distinction is the whole reason freehand ink looks like ink. A
 * `lineTo` chain with `lineWidth` gives you a constant-width ribbon: no taper
 * at the ends, no thinning when the hand moves fast, visible corners wherever
 * two samples are far apart.
 *
 * perfect-freehand instead computes the *outline polygon* of the stroke —
 * offsetting perpendicular to the direction of travel by an amount that varies
 * with pressure and speed — and we fill that polygon. The result thins on fast
 * movement and tapers at both ends, the way a real pen does.
 *
 * `simulatePressure` matters because a mouse reports a constant 0.5 pressure
 * for every sample. When true, perfect-freehand synthesises pressure from
 * velocity instead, so mouse strokes get the same taper a stylus would give.
 */
export function drawFreedraw(ctx: CanvasRenderingContext2D, el: FreedrawElement): void {
  if (el.points.length === 0) return;

  const input: [number, number, number][] = el.points.map((p, i) => [
    p.x + el.x,
    p.y + el.y,
    el.pressures[i] ?? 0.5,
  ]);

  const outline = getStroke(input, {
    size: el.strokeWidth * 4.5,
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: el.simulatePressure,
    last: true,
  });

  if (outline.length < 3) return;

  ctx.fillStyle = el.strokeColor;
  ctx.beginPath();
  ctx.moveTo(outline[0]![0], outline[0]![1]);
  for (let i = 1; i < outline.length; i++) {
    ctx.lineTo(outline[i]![0], outline[i]![1]);
  }
  ctx.closePath();
  // `nonzero` rather than the default `evenodd`: a stroke that crosses itself —
  // a figure-eight, a scribble — has overlapping outline regions, and evenodd
  // punches holes in exactly those overlaps.
  ctx.fill('nonzero');
}

/* ── text ─────────────────────────────────────────────────────────────────── */

/**
 * Draw the pre-wrapped lines.
 *
 * Note what is *not* here: no measuring, no wrapping, no font-metric lookup.
 * `el.lines`, `el.ascent` and `el.lineHeight` were computed when the text last
 * changed and stored on the element. This function is a loop over strings.
 *
 * That is the payoff for the awkward part of the design. Drawing runs on every
 * frame that touches this element; laying out runs on every keystroke. Keeping
 * them apart means the expensive one happens at the rate a human types rather
 * than the rate a monitor refreshes.
 *
 * ── Baselines ──────────────────────────────────────────────────────────────
 *
 * `textBaseline = 'alphabetic'` — the default, and the one that is stable.
 * `'top'` is tempting because it matches how the box is described, and it means
 * something slightly different in every font, so identical text sits at
 * different heights depending on family. Positioning from the baseline and
 * carrying an explicit `ascent` keeps the offset a number this codebase owns.
 */
export function drawText(ctx: CanvasRenderingContext2D, el: TextElement): void {
  if (el.lines.length === 0) return;

  ctx.fillStyle = el.strokeColor;
  ctx.font = fontString(el);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left'; // alignment is done by offset, so it works inside the box

  for (let i = 0; i < el.lines.length; i++) {
    const line = el.lines[i]!;
    if (line === '') continue; // a blank line still advances y, but draws nothing

    /* Alignment is computed against the *box*, not the canvas, so it keeps
       working when the element is rotated — the rotation is already installed on
       the context above. Using `ctx.textAlign` instead would align against the
       x coordinate passed to fillText, which is the same thing only for
       'left'. */
    const offset =
      el.textAlign === 'left' ? 0 : alignOffset(ctx.measureText(line).width, el.width, el.textAlign);

    ctx.fillText(line, el.x + offset, el.y + el.ascent + i * el.lineHeight);
  }
}

/* ── arrowheads ───────────────────────────────────────────────────────────── */

const ARROWHEAD_ANGLE = Math.PI / 7;

/**
 * Arrowheads drawn as plain paths rather than through Rough.js.
 *
 * A hand-drawn arrowhead at typical sizes is 10–20 scene units; Rough.js's
 * jitter at that scale makes it read as a smudge rather than an arrow. Real
 * whiteboard tools do the same thing — the sketchy aesthetic is applied to
 * shapes, not to small directional marks.
 *
 * Size scales with stroke width but is clamped: a 1px arrow needs a visible
 * head, and a 20px arrow does not need a 100-unit one.
 */
function drawArrowheads(ctx: CanvasRenderingContext2D, el: LinearElement): void {
  const pts = el.points;
  if (pts.length < 2) return;

  const size = Math.min(Math.max(el.strokeWidth * 5, 8), 40);

  ctx.strokeStyle = el.strokeColor;
  ctx.lineWidth = el.strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Arrowheads are drawn as solid marks even on a dashed line — a dashed
  // arrowhead is just a broken triangle.
  ctx.setLineDash([]);

  if (el.endArrowhead !== null) {
    const tip = pts[pts.length - 1]!;
    const from = pts[pts.length - 2]!;
    drawHead(ctx, from, tip, size, el.endArrowhead);
  }

  if (el.startArrowhead !== null) {
    const tip = pts[0]!;
    const from = pts[1]!;
    drawHead(ctx, from, tip, size, el.startArrowhead);
  }
}

function drawHead(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  tip: { x: number; y: number },
  size: number,
  kind: 'arrow' | 'dot',
): void {
  if (kind === 'dot') {
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, size / 3, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
    return;
  }

  // Direction of travel at the tip. atan2 handles all four quadrants and the
  // axis-aligned cases without any sign analysis.
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);

  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(
    tip.x - size * Math.cos(angle - ARROWHEAD_ANGLE),
    tip.y - size * Math.sin(angle - ARROWHEAD_ANGLE),
  );
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(
    tip.x - size * Math.cos(angle + ARROWHEAD_ANGLE),
    tip.y - size * Math.sin(angle + ARROWHEAD_ANGLE),
  );
  ctx.stroke();
}
