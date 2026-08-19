/**
 * The element model.
 *
 * Every element is a **plain, JSON-serialisable object** in a discriminated
 * union — not an instance of a class. That is the single most consequential
 * decision in this file, so it is worth stating the reasons before the code.
 *
 * ── Why a discriminated union and not a class hierarchy ─────────────────────
 *
 * 1. **Exhaustiveness checking.** Switching on `type` with a `never` default
 *    means adding `type: 'image'` later produces a compile error at every site
 *    that needs updating. With classes and `instanceof` you get a silent
 *    runtime miss. This alone justifies TypeScript on this project.
 *
 * 2. **Serialisation is free.** Persistence, export, clipboard, and (in v2) a
 *    CRDT all want to move these over a wire or into storage. A class with
 *    methods and a prototype does not survive `JSON.stringify` → `parse`; a
 *    plain object round-trips exactly.
 *
 * 3. **Structural sharing.** Undo (Phase 8) snapshots only the elements a
 *    gesture touched. Cheap object spread gives that; deep-cloning class
 *    instances does not.
 *
 * What we give up: polymorphic dispatch and encapsulation. Behaviour lives in
 * free functions that switch on `type` — `drawElement`, `getElementBounds`,
 * and in Phase 4 `hitTest`. That is more verbose than a virtual method, and it
 * is the price of the three properties above.
 *
 * ── Coordinates ────────────────────────────────────────────────────────────
 *
 * All positions and sizes are in **scene space** (ARCHITECTURE §4). No element
 * ever stores a screen coordinate; the viewport transform is applied once per
 * frame by the renderer, and nothing in this file knows about zoom or DPR.
 */

import type { Point } from '../util/geometry';
import type { FontFamily, TextAlign } from '../text/measure';

export type ElementId = string;

/** Every element type that can exist. Adding one here forces every switch to update. */
export type ElementType =
  | 'rectangle'
  | 'diamond'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'freedraw'
  | 'text';

export type FillStyle = 'solid' | 'hachure' | 'cross-hatch';
export type StrokeStyle = 'solid' | 'dashed' | 'dotted';

/** Sentinel for "no fill". A real colour string everywhere else. */
export const TRANSPARENT = 'transparent';

/** Fields present on every element, no exceptions. */
export interface ElementBase {
  readonly id: ElementId;

  /**
   * Monotonic revision counter, bumped on **every** mutation.
   *
   * This is the cheapest correct cache-invalidation signal in graphics.
   * Regenerating a Rough.js drawable costs ~0.1–0.3 ms; at a few thousand
   * shapes that is tens of milliseconds of pure garbage per frame. So we cache
   * — but a cache is only as good as its key:
   *
   *   keyed on `id` alone      → goes stale the moment the element changes
   *   deep-compare each frame  → O(fields) per element per frame, self-defeating
   *   keyed on `id:version`    → O(1) string compare, and provably correct
   *
   * "Provably" rests on one invariant: `Scene.mutate()` is the only thing that
   * writes to an element, and it always bumps this. See `roughCache.ts`.
   */
  version: number;

  /** Top-left in scene space, before rotation. */
  x: number;
  y: number;
  width: number;
  height: number;

  /** Radians, clockwise, about the element's centre. Always normalised to [0, 2π). */
  angle: number;

  strokeColor: string;
  /** `TRANSPARENT` means unfilled — which changes hit-testing in Phase 4. */
  backgroundColor: string;
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;

  /** 0 = ruler-straight, 1 = artist, 2 = cartoonist. Rough.js's scale. */
  roughness: number;

  /** 0…100. */
  opacity: number;

  /**
   * Frozen at creation, never changed.
   *
   * Rough.js turns this into the specific wobble of this shape's hand-drawn
   * strokes. Because it is *stored* rather than regenerated, the wobble
   * survives redraws, pans, reloads and exports. Regenerate it per frame and
   * every shape on screen shimmers as you move the mouse — try it once, it is
   * unmistakable.
   *
   * It is also what makes export byte-reproducible (Phase 9), which is what
   * makes visual-regression testing possible (Phase 10). One stored integer,
   * three downstream capabilities.
   */
  readonly seed: number;

  /**
   * Soft delete. Never splice the array.
   *
   * Not an optimisation — a correctness decision. A hard delete breaks undo
   * (you must remember the element *and* its exact index and every reference
   * to it), dangles references from other elements, and forces an immediate,
   * exception-safe removal from the spatial index. Flipping a flag does none of
   * those. `Scene.compact()` physically drops them at save time.
   */
  isDeleted: boolean;

  /**
   * Painter's-algorithm ordering key. Higher draws later, so on top.
   *
   * A number rather than an array position, so reordering never invalidates the
   * spatial index built in Phase 4. The grown-up version is *fractional
   * indexing* — a string key like "a0", "a1", where inserting between two items
   * yields "a0V" with no renumbering and no coordination. That is what
   * collaborative reordering needs; noted for v2, not built.
   */
  zIndex: number;
}

export interface RectangleElement extends ElementBase {
  readonly type: 'rectangle';
}

export interface DiamondElement extends ElementBase {
  readonly type: 'diamond';
}

export interface EllipseElement extends ElementBase {
  readonly type: 'ellipse';
}

export type Arrowhead = 'arrow' | 'dot' | null;

export interface LinearElement extends ElementBase {
  readonly type: 'line' | 'arrow';
  /**
   * Vertices **relative to (x, y)**. `points[0]` is always `[0, 0]`.
   *
   * Relative rather than absolute so that moving the element is a change to
   * `x`/`y` alone, rather than a rewrite of every point. That matters in
   * Phase 6 (dragging 500 elements) and in Phase 8 (a snapshot of a moved
   * 400-point stroke would otherwise be 400 changed numbers).
   */
  points: readonly Point[];
  startArrowhead: Arrowhead;
  endArrowhead: Arrowhead;
}

export interface FreedrawElement extends ElementBase {
  readonly type: 'freedraw';
  /** Relative to (x, y), same reasoning as LinearElement. */
  points: readonly Point[];
  /**
   * Parallel to `points`, 0…1, from `PointerEvent.pressure`.
   *
   * Mice report a constant 0.5, so a mouse-drawn stroke has no natural taper.
   * `simulatePressure` tells perfect-freehand to synthesise one from velocity
   * instead — fast movement thins the line, which is how a real pen behaves.
   */
  pressures: readonly number[];
  simulatePressure: boolean;
}

/**
 * Text.
 *
 * ── The one element whose size is not an input ─────────────────────────────
 *
 * Every other variant here is told how big it is. Text is *asked*: the browser
 * decides how wide a string is, and `width`, `height`, `lines` and `ascent`
 * below are all **derived data, cached on the element**.
 *
 * That is a deliberate and slightly uncomfortable choice, so the reasoning is
 * here rather than in a commit message:
 *
 *   - Computing them on demand would mean `getGeometryBounds` needs a canvas,
 *     which puts a DOM dependency into the layer that unit-tests in Node in nine
 *     seconds. `tests/engine/boundary.test.ts` exists to prevent exactly that
 *     kind of drift.
 *   - The spatial index (Phase 4a) stores bounds at insert time and the
 *     dirty-rect tracker (Phase 5) memoises them per object. Both already assume
 *     bounds are cheap to read. A `measureText` behind `el.width` would be a
 *     synchronous shaping call inside the cull.
 *
 * The cost is staleness, and the discipline that pays for it is: **every write
 * to `text`, `fontSize`, `fontFamily` or `wrapWidth` must go through
 * `relayoutText`, in the same `Scene.mutate` call.** Miss one and the element
 * renders at the wrong size until something else touches it. `Scene.mutate`
 * already enforces "one mutator, always a new object"; this is that rule
 * carrying one more invariant.
 */
export interface TextElement extends ElementBase {
  readonly type: 'text';
  /** The raw string, with real newlines. What the editing textarea holds. */
  text: string;
  fontSize: number;
  fontFamily: FontFamily;
  textAlign: TextAlign;
  /**
   * `null` = auto-width: the box grows with the text and only explicit newlines
   * break. A number = wrap at that width, and the box grows downwards instead.
   *
   * Null rather than `Infinity` because these are two different behaviours, not
   * one behaviour with an extreme parameter — and because `Infinity` survives
   * arithmetic silently until something multiplies it.
   */
  wrapWidth: number | null;

  /* ── derived, cached — see the note above ──────────────────────────────── */

  /** The wrapped display lines. `text` split by `wrapText`. */
  lines: readonly string[];
  /** Baseline of the first line, from the top of the box. */
  ascent: number;
  lineHeight: number;
}

export type Element =
  | RectangleElement
  | DiamondElement
  | EllipseElement
  | LinearElement
  | FreedrawElement
  | TextElement;

/** Elements whose geometry is a point list rather than a box. */
export type PointBasedElement = LinearElement | FreedrawElement;

export function isPointBased(el: Element): el is PointBasedElement {
  return el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw';
}

export function isFilled(el: Element): boolean {
  // Freehand strokes are always filled outlines; the "background" concept does
  // not apply to them. See drawElement.ts.
  if (el.type === 'freedraw') return true;
  /* Text is hit as a solid box even though the glyphs are mostly whitespace.
     Per-glyph hit testing is possible and it is the wrong answer: clicking the
     hole in an 'o' would miss, and clicking the space between two words would
     miss, so text would feel broken in a way users could never describe. Every
     editor treats a text run as a rectangle. */
  if (el.type === 'text') return true;
  return el.backgroundColor !== TRANSPARENT;
}

/**
 * The subset of element properties the style panel edits.
 *
 * Kept separate from `Element` because it is also the *pending* style for the
 * next shape you draw — it exists before any element does.
 */
export interface ElementStyle {
  strokeColor: string;
  backgroundColor: string;
  fillStyle: FillStyle;
  strokeWidth: number;
  strokeStyle: StrokeStyle;
  roughness: number;
  opacity: number;
}

export const DEFAULT_STYLE: ElementStyle = {
  strokeColor: '#1b1b1f',
  backgroundColor: TRANSPARENT,
  fillStyle: 'hachure',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
};

/**
 * Compile-time exhaustiveness guard.
 *
 * Call this in the `default` branch of any switch over `Element['type']`. If a
 * new member is added to the union and a switch forgets it, `el` is no longer
 * `never` and the build fails — pointing at exactly the switch that needs
 * updating, rather than failing silently at runtime six weeks later.
 */
export function assertNever(value: never, context: string): never {
  throw new Error(`Unhandled element variant in ${context}: ${JSON.stringify(value)}`);
}
