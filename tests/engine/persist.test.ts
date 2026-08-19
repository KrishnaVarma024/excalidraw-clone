/**
 * The saved document, and `restore`.
 *
 * `serialize` is two lines and is barely tested. Everything here is about the way
 * back in, because **the file you are loading was written by a different version
 * of this program than the one reading it** — true from the second release
 * onwards, and true right now for anything saved before the last change.
 *
 * So these tests are mostly hostile inputs. Each one is a real thing that reaches
 * a load path in production: a truncated write, a hand-edited file, a document
 * from a build that had a field this one does not, a document from a build that
 * has a field this one does not.
 */

import { describe, expect, it } from 'vitest';
import {
  FILE_TYPE,
  SCHEMA_VERSION,
  restore,
  serialize,
  type StoredAppState,
} from '@engine/persist/document';
import {
  newFreedraw,
  newLinear,
  newRectangle,
  newText,
} from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, type Element } from '@engine/scene/element.types';
import { createFixedMeasurer } from '@engine/text/measure';

const M = createFixedMeasurer(0.5);
const APP: StoredAppState = { scrollX: 12, scrollY: -34, zoom: 1.5 };

const rect = (over: Partial<Parameters<typeof newRectangle>[0]> = {}) =>
  newRectangle({ x: 0, y: 0, width: 40, height: 30, style: DEFAULT_STYLE, zIndex: 1, ...over });

/** Round-trip through JSON, which is what actually happens. */
function roundTrip(elements: readonly Element[], app = APP) {
  return restore(JSON.parse(JSON.stringify(serialize(elements, app))), M);
}

/* ── the happy path ───────────────────────────────────────────────────────── */

describe('round trip', () => {
  it('preserves every element type', () => {
    const elements = [
      rect(),
      newLinear({
        x: 0,
        y: 0,
        width: 100,
        height: 0,
        style: DEFAULT_STYLE,
        zIndex: 2,
        type: 'arrow',
        points: [
          { x: 0, y: 0 },
          { x: 100, y: 0 },
        ],
      }),
      newFreedraw({
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        style: DEFAULT_STYLE,
        zIndex: 3,
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
        ],
        pressures: [0.4, 0.6],
        simulatePressure: true,
      }),
      newText({ x: 0, y: 0, text: 'hello', style: DEFAULT_STYLE, zIndex: 4 }, M),
    ];

    const result = roundTrip(elements);
    expect(result.error).toBeNull();
    expect(result.dropped).toBe(0);
    expect(result.elements.map((e) => e.type)).toEqual(['rectangle', 'arrow', 'freedraw', 'text']);
  });

  it('preserves the seed, so a hand-drawn shape looks the same after a reload', () => {
    /* Not fatal to lose, but visible: the wobble changes, which reads as the
       document having been edited by something. */
    const el = rect();
    expect(roundTrip([el]).elements[0]!.seed).toBe(el.seed);
  });

  it('preserves the viewport', () => {
    expect(roundTrip([rect()]).appState).toEqual(APP);
  });

  it('does not write soft-deleted elements', () => {
    /* They exist so undo and the selection can still reference them. Once the
       document is on disk there is nothing left to reference them, and carrying
       them forward means a file that grows forever as the user deletes things. */
    const kept = rect();
    const gone = { ...rect({ zIndex: 2 }), isDeleted: true };
    const doc = serialize([kept, gone], APP);
    expect(doc.elements).toHaveLength(1);
  });
});

/* ── the envelope ─────────────────────────────────────────────────────────── */

describe('the envelope', () => {
  it('refuses anything without the discriminator', () => {
    /* Without this check, any JSON with an `elements` array looks close enough to
       load, and the failure surfaces as an unrecognisable drawing rather than
       "this is not one of ours". */
    expect(restore({ elements: [] }, M).error).toMatch(/not a/u);
    expect(restore({ type: 'something-else', elements: [] }, M).error).toMatch(/not a/u);
  });

  it('refuses a document from a NEWER schema', () => {
    /* Refuse the future, repair the past.
       Fields we do not know about may change how the ones we do know about should
       be read. Guessing produces a document that looks plausible and is wrong —
       and then the user saves over it and the information is gone. Refusing is
       recoverable: they update. */
    const doc = { type: FILE_TYPE, version: SCHEMA_VERSION + 1, elements: [] };
    expect(restore(doc, M).error).toMatch(/newer version/u);
  });

  it('never throws, whatever it is handed', () => {
    // A corrupt document has to produce an empty canvas and a message, not a
    // stack trace: the user's other documents are fine and the app has to stay
    // usable enough to say so.
    for (const junk of [null, undefined, 42, 'a string', [], {}, { type: FILE_TYPE }]) {
      expect(() => restore(junk, M)).not.toThrow();
      expect(restore(junk, M).elements).toEqual([]);
    }
  });
});

/* ── hostile elements ─────────────────────────────────────────────────────── */

describe('repairing elements', () => {
  const doc = (elements: unknown[]) => ({
    type: FILE_TYPE,
    version: SCHEMA_VERSION,
    source: 'test',
    elements,
    appState: APP,
  });

  it('drops an element with an unknown type, and keeps its neighbours', () => {
    // Forward compatibility: a build that added `image` writes one, and this
    // build has to open the rest of the document rather than refuse all of it.
    const result = restore(doc([{ ...rect() }, { ...rect(), type: 'image' }]), M);
    expect(result.elements).toHaveLength(1);
    expect(result.dropped).toBe(1);
    expect(result.error).toBeNull();
  });

  it('drops an element with no id', () => {
    // Inventing one means the same file loads as different elements each time,
    // which breaks anything that later syncs or merges documents.
    expect(restore(doc([{ ...rect(), id: undefined }]), M).dropped).toBe(1);
  });

  it('replaces NaN and Infinity rather than letting them through', () => {
    /* The nastiest of the lot. A NaN width makes the element's bounds NaN, which
       makes every quadtree comparison false, which makes the element permanently
       unclickable AND invisible to the cull — with nothing in the UI to suggest
       why. It is not a crash, it is a shape that quietly stops existing. */
    const result = restore(doc([{ ...rect(), width: NaN, x: Infinity, angle: -Infinity }]), M);
    const el = result.elements[0]!;
    expect(Number.isFinite(el.width)).toBe(true);
    expect(Number.isFinite(el.x)).toBe(true);
    expect(Number.isFinite(el.angle)).toBe(true);
    expect(result.repaired).toBe(1);
  });

  it('defaults a field that did not exist in the older schema', () => {
    const { opacity: _drop, ...older } = rect() as unknown as Record<string, unknown>;
    const el = restore(doc([older]), M).elements[0]!;
    expect(el.opacity).toBe(100);
  });

  it('clamps values outside their legal range', () => {
    const el = restore(doc([{ ...rect(), opacity: 900, roughness: -5, strokeWidth: 0 }]), M)
      .elements[0]!;
    expect(el.opacity).toBe(100);
    expect(el.roughness).toBe(0);
    expect(el.strokeWidth).toBeGreaterThan(0);
  });

  it('clamps a saved zoom that would break the transform', () => {
    // A zoom of 0 makes every scene-to-screen conversion divide by zero; 10^6
    // makes the grid loop for a long time before drawing nothing.
    expect(restore({ ...doc([]), appState: { zoom: 0 } }, M).appState.zoom).toBeGreaterThan(0);
    expect(restore({ ...doc([]), appState: { zoom: 1e6 } }, M).appState.zoom).toBeLessThan(100);
  });

  it('drops a line with fewer than two points', () => {
    // One point is a dot nobody can see or select; zero crashes the arrowhead
    // code, which indexes `points[length - 2]` without checking.
    const line = newLinear({
      x: 0,
      y: 0,
      width: 10,
      height: 0,
      style: DEFAULT_STYLE,
      zIndex: 1,
      type: 'line',
      points: [{ x: 0, y: 0 }],
    });
    expect(restore(doc([line]), M).dropped).toBe(1);
  });

  it('re-aligns a freehand stroke whose pressures do not match its points', () => {
    /* `pressures` runs parallel to `points` and perfect-freehand indexes into it
       positionally. A truncated write or a hand edit would silently taper the
       wrong parts of the stroke — visible, but impossible to attribute. */
    const stroke = newFreedraw({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      style: DEFAULT_STYLE,
      zIndex: 1,
      points: [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 9, y: 9 },
      ],
      pressures: [0.5],
      simulatePressure: false,
    });

    const el = restore(doc([stroke]), M).elements[0]!;
    if (el.type !== 'freedraw') throw new Error('expected freedraw');
    expect(el.pressures).toHaveLength(el.points.length);
  });
});

/* ── the Phase 7 tie-in ───────────────────────────────────────────────────── */

describe('text is re-measured on load, not trusted', () => {
  it('recomputes the derived fields against THIS machine’s fonts', () => {
    /* The saved lines, width, height and ascent were measured wherever the file
       was written, against whatever fonts that machine had. Trusting them gives
       text whose stored box disagrees with its own glyphs — wrapped in the wrong
       places, with a spatial index that says the text is somewhere it visibly is
       not. */
    const el = newText({ x: 0, y: 0, text: 'hello', style: DEFAULT_STYLE, zIndex: 1 }, M);
    expect(el.width).toBe(50); // 5 chars × 20px × 0.5

    const wider = createFixedMeasurer(0.9); // this machine's font is wider
    const restored = restore(
      JSON.parse(JSON.stringify(serialize([el], APP))),
      wider,
    ).elements[0]!;

    if (restored.type !== 'text') throw new Error('expected text');
    expect(restored.width).toBeCloseTo(5 * 20 * 0.9, 6);
    expect(restored.lines).toEqual(['hello']);
  });

  it('re-wraps against the saved wrap width', () => {
    const el = newText(
      { x: 0, y: 0, text: 'aaa bbb ccc', style: DEFAULT_STYLE, zIndex: 1, wrapWidth: 70 },
      M,
    );
    const restored = roundTrip([el]).elements[0]!;
    if (restored.type !== 'text') throw new Error('expected text');
    expect(restored.wrapWidth).toBe(70);
    expect(restored.lines).toEqual(['aaa bbb', 'ccc']);
  });

  it('survives a text element with a corrupt wrap width', () => {
    const el = newText({ x: 0, y: 0, text: 'hello', style: DEFAULT_STYLE, zIndex: 1 }, M);
    const raw = {
      type: FILE_TYPE,
      version: SCHEMA_VERSION,
      elements: [{ ...el, wrapWidth: -5, lines: 'not an array', ascent: NaN }],
      appState: APP,
    };
    const restored = restore(raw, M).elements[0]!;
    if (restored.type !== 'text') throw new Error('expected text');
    expect(restored.wrapWidth).toBeNull(); // negative → auto-width
    expect(Array.isArray(restored.lines)).toBe(true);
    expect(Number.isFinite(restored.ascent)).toBe(true);
  });
});
