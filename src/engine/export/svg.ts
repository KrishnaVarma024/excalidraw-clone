/**
 * SVG export.
 *
 * ── The one thing that cannot reuse `drawElement` ──────────────────────────
 *
 * PNG export reuses `drawElement` untouched, because that file has never been
 * allowed to read `zoom`, `scroll` or `devicePixelRatio` — it reads six numbers
 * off a 2D context and does not care where they came from. Install an export
 * transform instead of a viewport transform and the same code renders the same
 * drawing at a different size. That is the payoff for a rule set in Phase 2.
 *
 * SVG cannot: there is no 2D context to install a transform on. It needs a
 * second renderer.
 *
 * That would be a real duplication problem — two renderers drifting apart, and a
 * drawing that looks different depending on which button you pressed — except
 * for one thing:
 *
 *   **Rough.js hands out the geometry, not just the drawing.**
 *
 * `generator.toPaths(drawable)` returns the same sketchy path data the canvas
 * renderer strokes, as SVG `d` strings. So both exporters consume the *same*
 * `Drawable`, generated from the *same* stored `seed`, and the wobble is
 * identical. The duplication is real but it is confined to "how do I put a path
 * on the page", which is the part that genuinely differs between the two
 * formats.
 *
 * This is why `roughCache.ts` was built to hand out `Drawable`s rather than to
 * draw. At the time it looked like an over-abstraction with one caller.
 *
 * ── Byte-reproducibility ───────────────────────────────────────────────────
 *
 * Exporting the same scene twice produces the same bytes, because `seed` is
 * stored on the element (Phase 2, §3.1) rather than regenerated. That is what
 * makes visual-regression testing possible in Phase 10, and it is the reason the
 * seed was made a stored field three phases before anything used it.
 *
 * It also means this whole module unit-tests in Node: `rough.generator()` needs
 * no DOM, and the output is a string.
 */

import type { Drawable } from 'roughjs/bin/core';
import type { RoughGenerator } from 'roughjs/bin/generator';
import rough from 'roughjs';
import getStroke from 'perfect-freehand';
import {
  type Element,
  type FreedrawElement,
  type LinearElement,
  type TextElement,
  TRANSPARENT,
  assertNever,
} from '../scene/element.types';
import { getElementCenter } from '../scene/bounds';
import { RoughCache } from '../render/roughCache';
import { FONT_STACKS, fontString } from '../text/measure';
import { alignOffset } from '../text/wrap';
import { type Bounds, boundsHeight, boundsWidth } from '../util/geometry';
import { EXPORT_PADDING, exportBounds } from './bounds';

export interface SvgOptions {
  /** Background colour, or null for a transparent export. */
  readonly background: string | null;
  readonly padding?: number;
  /** Multiplies the `width`/`height` attributes. The `viewBox` never changes. */
  readonly scale?: number;
}

/**
 * Serialise elements to an SVG document.
 *
 * Returns null for an empty scene, matching `exportBounds` — a 0×0 SVG is not a
 * useful thing to hand anybody.
 */
export function toSvg(elements: readonly Element[], options: SvgOptions): string | null {
  const live = elements.filter((el) => !el.isDeleted);
  const bounds = exportBounds(live, options.padding ?? EXPORT_PADDING);
  if (bounds === null) return null;

  const scale = options.scale ?? 1;
  const w = boundsWidth(bounds);
  const h = boundsHeight(bounds);

  const cache = new RoughCache();
  const generator = rough.generator();

  const body: string[] = [];

  if (options.background !== null && options.background !== TRANSPARENT) {
    body.push(
      `<rect x="${n(bounds.minX)}" y="${n(bounds.minY)}" width="${n(w)}" height="${n(h)}" fill="${attr(options.background)}"/>`,
    );
  }

  /* Painter's order, explicitly. The array arrives sorted from `Scene.sorted()`
     in the app, and from wherever the caller got it in a test — an export that
     silently depended on the caller having sorted would be correct in the app
     and wrong in every other use, which is the worst kind of dependency. */
  for (const el of [...live].sort((a, b) => a.zIndex - b.zIndex)) {
    body.push(elementToSvg(el, cache, generator));
  }

  /* `width`/`height` in pixels, `viewBox` in scene units. That separation is
     what makes an SVG resolution-independent: the scale changes how big it is
     placed by default, and nothing about the geometry inside. A PNG has to bake
     the choice in; this does not. */
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"`,
    ` width="${n(w * scale)}" height="${n(h * scale)}"`,
    ` viewBox="${n(bounds.minX)} ${n(bounds.minY)} ${n(w)} ${n(h)}">`,
    body.join(''),
    `</svg>`,
  ].join('');
}

/* ── per element ──────────────────────────────────────────────────────────── */

function elementToSvg(el: Element, cache: RoughCache, generator: RoughGenerator): string {
  const inner = shapeToSvg(el, cache, generator);
  if (inner === '') return '';

  const transforms: string[] = [];

  /* Rotation as an SVG transform rather than baked into the coordinates, for the
     same reason `drawElement` rotates the canvas rather than the shape: one
     transform replaces a dozen rotated-corner special cases, and the emitted
     path data stays identical between a rotated and an unrotated element — which
     is what keeps the two exporters comparable. */
  if (el.angle !== 0) {
    const c = getElementCenter(el);
    transforms.push(`rotate(${n((el.angle * 180) / Math.PI)} ${n(c.x)} ${n(c.y)})`);
  }

  /* Shapes are generated at the origin so that moving an element never
     invalidates its cached drawable (Phase 2). The translate puts them back —
     the same `ctx.translate(el.x, el.y)` the canvas renderer does. Text and
     freehand are already in scene coordinates and must NOT be translated again. */
  if (needsTranslate(el)) transforms.push(`translate(${n(el.x)} ${n(el.y)})`);

  const opacity = el.opacity === 100 ? '' : ` opacity="${n(el.opacity / 100)}"`;
  const transform = transforms.length === 0 ? '' : ` transform="${transforms.join(' ')}"`;

  return `<g${transform}${opacity}>${inner}</g>`;
}

function needsTranslate(el: Element): boolean {
  return el.type !== 'freedraw' && el.type !== 'text';
}

function shapeToSvg(el: Element, cache: RoughCache, generator: RoughGenerator): string {
  switch (el.type) {
    case 'rectangle':
    case 'diamond':
    case 'ellipse':
    case 'line':
      return drawableToSvg(cache.get(el), generator, el);

    case 'arrow':
      return drawableToSvg(cache.get(el), generator, el) + arrowheadsToSvg(el);

    case 'freedraw':
      return freedrawToSvg(el);

    case 'text':
      return textToSvg(el);

    default:
      return assertNever(el, 'shapeToSvg');
  }
}

/**
 * A Rough.js `Drawable` as SVG paths.
 *
 * `toPaths` returns one entry per op set — an outline, a fill, a hachure sketch —
 * each already carrying the stroke and fill Rough.js decided on. Recomputing
 * those here from the element's style would work for solid fills and quietly
 * disagree for hachure, where the "stroke" of the fill sketch is the *fill*
 * colour.
 */
function drawableToSvg(drawable: Drawable, generator: RoughGenerator, el: Element): string {
  const out: string[] = [];

  for (const path of generator.toPaths(drawable)) {
    const fill = path.fill === undefined || path.fill === 'none' ? 'none' : attr(path.fill);
    const dash = dashArray(el);

    out.push(
      `<path d="${attr(roundPath(path.d))}" stroke="${attr(path.stroke)}" fill="${fill}"` +
        ` stroke-width="${n(path.strokeWidth)}"${dash}` +
        ` stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }

  return out.join('');
}

/**
 * `stroke-dasharray`, matching the canvas renderer's `setLineDash`.
 *
 * The pattern scales with stroke width for the same reason it does on the
 * canvas: a fixed pattern looks right at one width and wrong at every other.
 */
function dashArray(el: Element): string {
  if (el.strokeStyle === 'solid') return '';
  const w = Math.max(1, el.strokeWidth);
  return el.strokeStyle === 'dashed'
    ? ` stroke-dasharray="${n(w * 4)} ${n(w * 3)}"`
    : ` stroke-dasharray="${n(w)} ${n(w * 2.5)}"`;
}

/* ── freehand ─────────────────────────────────────────────────────────────── */

/**
 * Freehand strokes are **filled outlines**, not stroked polylines — the same
 * distinction the canvas renderer makes, and the reason ink looks like ink.
 *
 * perfect-freehand computes the outline polygon; this fills it. `fill-rule` is
 * `nonzero` rather than the SVG default `evenodd`, because a stroke that crosses
 * itself has overlapping outline regions and `evenodd` punches holes in exactly
 * those overlaps. A scribble exported with the default rule comes out looking
 * like lace.
 */
function freedrawToSvg(el: FreedrawElement): string {
  if (el.points.length === 0) return '';

  const outline = getStroke(
    el.points.map((p, i) => [p.x + el.x, p.y + el.y, el.pressures[i] ?? 0.5]),
    {
      size: el.strokeWidth * 4.5,
      thinning: 0.6,
      smoothing: 0.5,
      streamline: 0.5,
      simulatePressure: el.simulatePressure,
      last: true,
    },
  );
  if (outline.length < 3) return '';

  const d =
    `M${n(outline[0]![0])} ${n(outline[0]![1])}` +
    outline.slice(1).map((p) => `L${n(p[0])} ${n(p[1])}`).join('') +
    'Z';

  return `<path d="${d}" fill="${attr(el.strokeColor)}" fill-rule="nonzero" stroke="none"/>`;
}

/* ── text ─────────────────────────────────────────────────────────────────── */

/**
 * Text as `<text>` elements, one per line.
 *
 * ── The trade, stated ──────────────────────────────────────────────────────
 *
 *   `<text>`         small, still selectable and searchable, still editable in
 *                    a vector tool — and **renders in whatever font the viewer
 *                    has**, so a machine without the family sees different
 *                    metrics and different line breaks.
 *   outlined paths   pixel-identical everywhere, self-contained, unselectable,
 *                    and an order of magnitude larger.
 *
 * v1 emits `<text>`, for a reason that is about this codebase rather than about
 * SVG: converting glyphs to paths needs font outlines, and the Canvas 2D API
 * does not expose them. Doing it properly means shipping a font parser
 * (opentype.js) and the font file itself, which is a dependency and a licensing
 * question in exchange for a fidelity nobody has asked for yet.
 *
 * The mitigation is the same one §7.4 uses for the fallback problem: emit the
 * whole stack, ending in a generic family, so a viewer without the exact font
 * lands somewhere sensible rather than in the browser default.
 *
 * **The lines are the ones already stored on the element.** Re-wrapping here
 * would need a measurer, and worse, could produce different breaks from the ones
 * on screen — an export that does not match what the user was looking at.
 */
function textToSvg(el: TextElement): string {
  if (el.lines.length === 0) return '';

  const family = FONT_STACKS[el.fontFamily];
  const out: string[] = [];

  for (let i = 0; i < el.lines.length; i++) {
    const line = el.lines[i]!;
    if (line === '') continue;

    /* Alignment by offset, not by `text-anchor`, so it matches the canvas
       renderer exactly — and so it stays correct inside the rotation transform
       on the enclosing <g>, where `text-anchor` would anchor against a different
       origin. */
    const offset =
      el.textAlign === 'left'
        ? 0
        : alignOffset(estimateWidth(line, el), el.width, el.textAlign);

    out.push(
      `<text x="${n(el.x + offset)}" y="${n(el.y + el.ascent + i * el.lineHeight)}"` +
        ` font-family="${attr(family)}" font-size="${n(el.fontSize)}px"` +
        ` fill="${attr(el.strokeColor)}"` +
        // `alphabetic`, matching the canvas. `top` means something slightly
        // different in every font, so identical text sits at different heights.
        ` dominant-baseline="alphabetic"` +
        ` xml:space="preserve">${text(line)}</text>`,
    );
  }

  return out.join('');
}

/**
 * A width estimate, used only for centring and right-alignment.
 *
 * There is no measurer here on purpose: threading one through would put a
 * `TextMeasurer` into a pure string function, and the *stored* `el.width` is
 * already the real measurement of the widest line. Interpolating from it is
 * exact for a single-line run — the common case by far — and slightly off for
 * the short lines of a centred paragraph.
 *
 * Named `estimate` rather than `measure` so nobody later mistakes it for the
 * real thing.
 */
function estimateWidth(line: string, el: TextElement): number {
  let widest = 0;
  for (const l of el.lines) if (l.length > widest) widest = l.length;
  if (widest === 0) return 0;
  return (el.width * line.length) / widest;
}

/* ── arrowheads ───────────────────────────────────────────────────────────── */

const ARROWHEAD_ANGLE = Math.PI / 7;

function arrowheadsToSvg(el: LinearElement): string {
  const pts = el.points;
  if (pts.length < 2) return '';

  const size = Math.min(Math.max(el.strokeWidth * 5, 8), 40);
  const out: string[] = [];

  if (el.endArrowhead !== null) {
    out.push(head(pts[pts.length - 2]!, pts[pts.length - 1]!, size, el, el.endArrowhead));
  }
  if (el.startArrowhead !== null) {
    out.push(head(pts[1]!, pts[0]!, size, el, el.startArrowhead));
  }
  return out.join('');
}

function head(
  from: { x: number; y: number },
  tip: { x: number; y: number },
  size: number,
  el: LinearElement,
  kind: 'arrow' | 'dot',
): string {
  if (kind === 'dot') {
    return `<circle cx="${n(tip.x)}" cy="${n(tip.y)}" r="${n(size / 3)}" fill="${attr(el.strokeColor)}"/>`;
  }

  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const a = { x: tip.x - size * Math.cos(angle - ARROWHEAD_ANGLE), y: tip.y - size * Math.sin(angle - ARROWHEAD_ANGLE) };
  const b = { x: tip.x - size * Math.cos(angle + ARROWHEAD_ANGLE), y: tip.y - size * Math.sin(angle + ARROWHEAD_ANGLE) };

  return (
    `<path d="M${n(a.x)} ${n(a.y)}L${n(tip.x)} ${n(tip.y)}L${n(b.x)} ${n(b.y)}"` +
    ` stroke="${attr(el.strokeColor)}" fill="none" stroke-width="${n(el.strokeWidth)}"` +
    ` stroke-linecap="round" stroke-linejoin="round"/>`
  );
}

/* ── serialisation ────────────────────────────────────────────────────────── */

/**
 * Numbers, to two decimal places.
 *
 * Not cosmetic. Rough.js emits full float precision, and at ~17 characters per
 * coordinate a busy drawing produces an SVG several times larger than it needs
 * to be. Two decimals is well below one device pixel at any sane export scale.
 *
 * It also makes the output **stable**: two runs that differ in the sixteenth
 * decimal place produce identical bytes, which is what Phase 10's
 * visual-regression testing needs.
 */
/**
 * Round every number inside a path `d` string.
 *
 * `n()` only reaches numbers this module formats itself. The `d` attributes come
 * straight out of Rough.js at full float precision — and they are the bulk of
 * the file, by a wide margin. A path for one rectangle carries dozens of
 * coordinates like `28.589694857597355`, seventeen characters each.
 *
 * A regex over the string rather than Rough's own `opsToPath(set, decimals)`,
 * on purpose. Using that would mean rebuilding the set → path mapping by hand,
 * including deciding stroke and fill per op-set type — and the note above
 * `drawableToSvg` explains why that is a trap: for hachure, the "stroke" of the
 * fill sketch is the *fill* colour. This transform makes no assumptions about
 * Rough's internals at all.
 *
 * Found by a test asserting the output contained no five-decimal numbers. It
 * did, in every path.
 */
function roundPath(d: string): string {
  return d.replace(/-?\d+\.\d+/gu, (m) => n(Number(m)));
}

function n(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 100) / 100);
}

/**
 * XML-escape an attribute value.
 *
 * Every colour, font family and path string goes through this. A font stack
 * contains `"Comic Sans MS"` — with the quotes — and pasting that into a
 * double-quoted attribute unescaped produces an SVG that no parser will open.
 * The failure is total and it is silent until something tries to read the file.
 */
function attr(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

/**
 * XML-escape text content.
 *
 * The one that bites in the real world: a user types `a < b` into a text element
 * and the export is a corrupt file. No apostrophe escaping — it is legal in
 * content and escaping it makes the output noisier for no gain.
 */
function text(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** Re-exported so callers building a filename do not import two modules. */
export { fontString };
export type { Bounds };
