/**
 * Element constructors.
 *
 * One place that knows how to build a valid element, so "what does a new
 * rectangle look like?" has exactly one answer. Every field is set explicitly —
 * no partial objects, no `undefined` holes to trip over three phases later.
 */

import { newId, newSeed } from '../util/id';
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  type FontFamily,
  type TextAlign,
  type TextMeasurer,
} from '../text/measure';
import { layoutText } from '../text/wrap';
import { normalizeAngle } from '../util/math';
import type { Point } from '../util/geometry';
import {
  type DiamondElement,
  type Element,
  type ElementStyle,
  type EllipseElement,
  type FreedrawElement,
  type LinearElement,
  type RectangleElement,
  type TextElement,
  assertNever,
} from './element.types';

interface CommonArgs {
  x: number;
  y: number;
  width: number;
  height: number;
  style: ElementStyle;
  zIndex: number;
  angle?: number;
}

function base(args: CommonArgs) {
  return {
    id: newId(),
    version: 1,
    x: args.x,
    y: args.y,
    width: args.width,
    height: args.height,
    angle: normalizeAngle(args.angle ?? 0),
    strokeColor: args.style.strokeColor,
    backgroundColor: args.style.backgroundColor,
    fillStyle: args.style.fillStyle,
    strokeWidth: args.style.strokeWidth,
    strokeStyle: args.style.strokeStyle,
    roughness: args.style.roughness,
    opacity: args.style.opacity,
    seed: newSeed(),
    isDeleted: false,
    zIndex: args.zIndex,
  };
}

export function newRectangle(args: CommonArgs): RectangleElement {
  return { ...base(args), type: 'rectangle' };
}

export function newDiamond(args: CommonArgs): DiamondElement {
  return { ...base(args), type: 'diamond' };
}

export function newEllipse(args: CommonArgs): EllipseElement {
  return { ...base(args), type: 'ellipse' };
}

export function newLinear(
  args: CommonArgs & { type: 'line' | 'arrow'; points: readonly Point[] },
): LinearElement {
  return {
    ...base(args),
    type: args.type,
    points: args.points,
    startArrowhead: null,
    endArrowhead: args.type === 'arrow' ? 'arrow' : null,
  };
}

export function newFreedraw(
  args: CommonArgs & {
    points: readonly Point[];
    pressures: readonly number[];
    simulatePressure: boolean;
  },
): FreedrawElement {
  return {
    ...base(args),
    type: 'freedraw',
    points: args.points,
    pressures: args.pressures,
    simulatePressure: args.simulatePressure,
  };
}

/**
 * Build the right element for a tool, from a drag rectangle.
 *
 * The `never` default is the exhaustiveness guard: add a shape tool to the
 * union and this fails to compile until it is handled here.
 */
export type ShapeToolType = 'rectangle' | 'diamond' | 'ellipse' | 'line' | 'arrow';

export function newShape(
  type: ShapeToolType,
  args: CommonArgs & { points?: readonly Point[] },
): Element {
  switch (type) {
    case 'rectangle':
      return newRectangle(args);
    case 'diamond':
      return newDiamond(args);
    case 'ellipse':
      return newEllipse(args);
    case 'line':
    case 'arrow':
      return newLinear({
        ...args,
        type,
        points: args.points ?? [
          { x: 0, y: 0 },
          { x: args.width, y: args.height },
        ],
      });
    default:
      return assertNever(type, 'newShape');
  }
}

/* ── text ─────────────────────────────────────────────────────────────────── */

export interface TextArgs {
  x: number;
  y: number;
  text: string;
  style: ElementStyle;
  zIndex: number;
  angle?: number;
  fontSize?: number;
  fontFamily?: FontFamily;
  textAlign?: TextAlign;
  /** null = auto-width. See TextElement. */
  wrapWidth?: number | null;
}

/**
 * A text element, laid out at construction.
 *
 * The measurer is a required argument rather than a module-level singleton, and
 * that is the whole design of this phase in one signature: the caller supplies
 * the browser (or, in a test, a deterministic stand-in), and nothing under
 * `src/engine/scene/` ever reaches for a canvas of its own.
 */
export function newText(args: TextArgs, measurer: TextMeasurer): TextElement {
  const font = {
    fontSize: args.fontSize ?? DEFAULT_FONT_SIZE,
    fontFamily: args.fontFamily ?? DEFAULT_FONT_FAMILY,
  };
  const wrapWidth = args.wrapWidth ?? null;
  const layout = layoutText(args.text, wrapWidth, font, measurer);

  return {
    ...base({
      x: args.x,
      y: args.y,
      width: layout.width,
      height: layout.height,
      style: args.style,
      zIndex: args.zIndex,
      ...(args.angle === undefined ? {} : { angle: args.angle }),
    }),
    type: 'text',
    text: args.text,
    fontSize: font.fontSize,
    fontFamily: font.fontFamily,
    textAlign: args.textAlign ?? 'left',
    wrapWidth,
    lines: layout.lines,
    ascent: layout.ascent,
    lineHeight: layout.lineHeight,
  };
}

/**
 * The patch that re-lays-out a text element after any layout-affecting change.
 *
 * **Every** write to `text`, `fontSize`, `fontFamily` or `wrapWidth` must go
 * through here, in the same `Scene.mutate` call that makes the change. The
 * derived fields on a `TextElement` are only correct because this is the single
 * place that recomputes them, in exactly the way `Scene.mutate` is the single
 * place that bumps `version`.
 *
 * It returns a patch rather than mutating, so it composes with everything else:
 *
 *     scene.mutate(id, { ...relayout(el, { text: next }, measurer) })
 */
export function relayoutText(
  el: TextElement,
  patch: Partial<Pick<TextElement, 'text' | 'fontSize' | 'fontFamily' | 'wrapWidth'>>,
  measurer: TextMeasurer,
): Partial<TextElement> {
  const text = patch.text ?? el.text;
  const font = {
    fontSize: patch.fontSize ?? el.fontSize,
    fontFamily: patch.fontFamily ?? el.fontFamily,
  };
  const wrapWidth = patch.wrapWidth === undefined ? el.wrapWidth : patch.wrapWidth;

  const layout = layoutText(text, wrapWidth, font, measurer);

  return {
    ...patch,
    text,
    fontSize: font.fontSize,
    fontFamily: font.fontFamily,
    wrapWidth,
    /* Reuse the existing array when the lines came out identical.
     *
     * `Scene.mutate` decides "did anything change" with `Object.is` per key, so
     * a freshly-allocated array of the same strings reads as a change. Every
     * other field here is a number and compares by value; `lines` is the one
     * that does not, and it is the one a re-measure recomputes most often.
     *
     * Without this, `remeasureText()` — which runs on `document.fonts.ready`,
     * for every text element in the document — bumps `version` on all of them
     * even when the metrics turned out identical. That invalidates the Rough
     * cache, invalidates the memoised render bounds, and forces a full repaint,
     * on a code path whose entire job is "check whether anything moved".
     *
     * Found by a test that asserted a no-op re-measure returns 0. It returned 1.
     */
    lines: sameLines(el.lines, layout.lines) ? el.lines : layout.lines,
    ascent: layout.ascent,
    lineHeight: layout.lineHeight,
    width: layout.width,
    height: layout.height,
  };
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Normalise a drag into a positive-size rectangle.
 *
 * Dragging up-and-left produces a negative width and height. Normalising here,
 * at the one place elements are born, means nothing downstream — bounds,
 * rendering, hit-testing, export — ever has to ask "what if width is negative?"
 *
 * Note that lines and arrows deliberately do *not* use this: for them the drag
 * direction is meaningful, since it decides which end gets the arrowhead. That
 * asymmetry is why this is a separate function rather than something baked into
 * the factory.
 */
export function normalizeDrag(
  origin: Point,
  current: Point,
): { x: number; y: number; width: number; height: number } {
  const width = current.x - origin.x;
  const height = current.y - origin.y;
  return {
    x: width >= 0 ? origin.x : current.x,
    y: height >= 0 ? origin.y : current.y,
    width: Math.abs(width),
    height: Math.abs(height),
  };
}
