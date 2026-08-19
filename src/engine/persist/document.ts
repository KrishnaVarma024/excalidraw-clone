/**
 * The saved document, and the only function allowed to trust it.
 *
 * ── `restore` is the whole file ─────────────────────────────────────────────
 *
 * `serialize` is two lines of `JSON.stringify` and is uninteresting. Everything
 * that matters is on the way back in, because **the thing you are loading was
 * written by a different version of this program than the one reading it.** That
 * is true from the second release onwards and it is true right now for anything
 * saved before the last change you made.
 *
 * So `restore` never assumes. It validates the envelope, drops elements it does
 * not recognise, fills in fields that were added since, clamps values that cannot
 * be right, and re-derives everything derived. Every one of those is a decision
 * with a failure mode attached, and they are individually commented below.
 *
 * The alternative — `JSON.parse` and hand it to the scene — works perfectly until
 * the first user opens an old file, at which point it throws somewhere deep in
 * the renderer with a stack trace that mentions nothing about loading.
 *
 * ── The Phase 7 tie-in ─────────────────────────────────────────────────────
 *
 * Text elements carry **derived** fields: their wrapped lines, width, height,
 * ascent. Those were measured on whatever machine saved the file, against
 * whatever fonts that machine had. Re-measuring on load is not an optimisation,
 * it is the difference between a document that looks right and one that is subtly
 * wrong everywhere — wrapped in the wrong places, with a bounding box that
 * disagrees with its own glyphs, and therefore a spatial index that disagrees
 * with where the user can see the text.
 */

import {
  DEFAULT_STYLE,
  TRANSPARENT,
  type Element,
  type ElementId,
  type ElementType,
} from '../scene/element.types';
import { normalizeAngle } from '../util/math';
import { relayoutText } from '../scene/elementFactory';
import { DEFAULT_FONT_FAMILY, DEFAULT_FONT_SIZE, type TextMeasurer } from '../text/measure';

/** Identifies our files. A `.json` with no discriminator is a landmine. */
export const FILE_TYPE = 'excalidraw-clone';

/**
 * Bumped whenever the shape of a stored element changes incompatibly.
 *
 * A single integer rather than semver: this number's only job is to let `restore`
 * decide which migrations to run, and a range comparison on one integer is
 * something you can get right at 2am.
 */
export const SCHEMA_VERSION = 1;

export interface StoredAppState {
  readonly scrollX: number;
  readonly scrollY: number;
  readonly zoom: number;
}

export interface StoredDocument {
  readonly type: typeof FILE_TYPE;
  readonly version: number;
  /** Which build wrote it. Diagnostic only — never branched on. */
  readonly source: string;
  readonly elements: readonly Element[];
  readonly appState: StoredAppState;
}

export interface RestoreResult {
  readonly elements: Element[];
  readonly appState: StoredAppState;
  /** Elements thrown away: unrecognised type, or unrepairable. */
  readonly dropped: number;
  /** Elements that needed a field defaulted, a value clamped, or a re-measure. */
  readonly repaired: number;
  /** Set when the envelope itself was wrong. `elements` is then empty. */
  readonly error: string | null;
}

const DEFAULT_APP_STATE: StoredAppState = { scrollX: 0, scrollY: 0, zoom: 1 };

export function serialize(
  elements: readonly Element[],
  appState: StoredAppState,
  source = `v${SCHEMA_VERSION}`,
): StoredDocument {
  return {
    type: FILE_TYPE,
    version: SCHEMA_VERSION,
    source,
    /* Soft-deleted elements are NOT written. They exist so that undo and the
       selection can still reference them (§3.3); once the document is on disk
       there is nothing left to reference them, and carrying them forward means a
       file that grows monotonically as the user deletes things. */
    elements: elements.filter((el) => !el.isDeleted),
    appState,
  };
}

/** Element types this build knows how to draw. Anything else is dropped. */
const KNOWN_TYPES: ReadonlySet<string> = new Set<ElementType>([
  'rectangle',
  'diamond',
  'ellipse',
  'line',
  'arrow',
  'freedraw',
  'text',
]);

/**
 * Turn untrusted JSON into elements this build can render, or explain why not.
 *
 * Never throws. A corrupt document has to produce an empty canvas and a message,
 * not a stack trace — the user's other documents are still fine and the app has
 * to stay usable enough to say so.
 */
export function restore(raw: unknown, measurer: TextMeasurer): RestoreResult {
  const empty = (error: string): RestoreResult => ({
    elements: [],
    appState: DEFAULT_APP_STATE,
    dropped: 0,
    repaired: 0,
    error,
  });

  if (raw === null || typeof raw !== 'object') return empty('not an object');

  const doc = raw as Partial<StoredDocument>;

  /* Check the discriminator before anything else. Without it, any JSON file with
     an `elements` array looks close enough to load, and the failure surfaces as
     an unrecognisable drawing rather than "this is not one of ours". */
  if (doc.type !== FILE_TYPE) return empty(`not a ${FILE_TYPE} document`);

  const version = typeof doc.version === 'number' ? doc.version : 0;

  /* Refuse the future, repair the past.
   *
   * A file from a NEWER schema cannot be loaded safely: fields we do not know
   * about may carry meaning that changes how the ones we do know about should be
   * read, and guessing produces a document that looks plausible and is wrong.
   * Refusing is recoverable — the user updates. Guessing is not: they save over
   * it and the information is gone. */
  if (version > SCHEMA_VERSION) {
    return empty(`saved by a newer version (schema ${version}, this build reads ${SCHEMA_VERSION})`);
  }

  if (!Array.isArray(doc.elements)) return empty('missing elements array');

  const elements: Element[] = [];
  let dropped = 0;
  let repaired = 0;

  for (const candidate of doc.elements as unknown[]) {
    const result = restoreElement(candidate, measurer);
    if (result === null) {
      dropped++;
      continue;
    }
    if (result.repaired) repaired++;
    elements.push(result.element);
  }

  return {
    elements,
    appState: restoreAppState(doc.appState),
    dropped,
    repaired,
    error: null,
  };
}

interface RestoredElement {
  element: Element;
  repaired: boolean;
}

function restoreElement(raw: unknown, measurer: TextMeasurer): RestoredElement | null {
  if (raw === null || typeof raw !== 'object') return null;

  const el = raw as Record<string, unknown>;

  /* Identity first. An element with no id or an unknown type cannot be repaired
     into anything meaningful, and inventing an id for it means the same file
     loads as different elements each time — which breaks any future sync. */
  if (typeof el['id'] !== 'string' || el['id'] === '') return null;
  if (typeof el['type'] !== 'string' || !KNOWN_TYPES.has(el['type'])) return null;

  let repaired = false;
  const need = <T>(value: T | undefined, fallback: T): T => {
    if (value === undefined) {
      repaired = true;
      return fallback;
    }
    return value;
  };

  const num = (key: string, fallback: number): number => {
    const v = el[key];
    /* `Number.isFinite` rather than `typeof === 'number'`: NaN and Infinity are
       both numbers and both poison everything downstream. A NaN width makes the
       element's bounds NaN, which makes every quadtree comparison false, which
       makes the element permanently unclickable and invisible to the cull — with
       nothing in the UI to suggest why. */
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      repaired = true;
      return fallback;
    }
    return v;
  };

  const str = (key: string, fallback: string): string => {
    const v = el[key];
    if (typeof v !== 'string') {
      repaired = true;
      return fallback;
    }
    return v;
  };

  const base = {
    id: el['id'] as ElementId,
    // A restored element starts at the version it was saved with, or 1. It only
    // has to be monotonic from here; its absolute value means nothing.
    version: Math.max(1, Math.floor(num('version', 1))),
    x: num('x', 0),
    y: num('y', 0),
    width: Math.max(0, num('width', 0)),
    height: Math.max(0, num('height', 0)),
    angle: normalizeAngle(num('angle', 0)),
    strokeColor: str('strokeColor', DEFAULT_STYLE.strokeColor),
    backgroundColor: str('backgroundColor', TRANSPARENT),
    fillStyle: need(el['fillStyle'] as never, DEFAULT_STYLE.fillStyle),
    strokeWidth: Math.max(0.1, num('strokeWidth', DEFAULT_STYLE.strokeWidth)),
    strokeStyle: need(el['strokeStyle'] as never, DEFAULT_STYLE.strokeStyle),
    roughness: clamp(num('roughness', DEFAULT_STYLE.roughness), 0, 3),
    opacity: clamp(num('opacity', 100), 0, 100),
    /* The seed is what makes a hand-drawn shape look the same after a reload
       (§3.1). Losing it is not fatal but it is visible: the shape's wobble
       changes, which reads as the document having been edited. */
    seed: Math.floor(num('seed', 1)),
    isDeleted: false,
    zIndex: num('zIndex', 0),
  };

  const type = el['type'] as ElementType;

  if (type === 'line' || type === 'arrow') {
    const points = restorePoints(el['points']);
    // A linear element needs two points to be a line. One point is a dot nobody
    // can see or select, and zero points crashes the arrowhead code.
    if (points === null || points.length < 2) return null;
    return {
      element: {
        ...base,
        type,
        points,
        startArrowhead: (el['startArrowhead'] ?? null) as never,
        endArrowhead: (el['endArrowhead'] ?? (type === 'arrow' ? 'arrow' : null)) as never,
      },
      repaired,
    };
  }

  if (type === 'freedraw') {
    const points = restorePoints(el['points']);
    if (points === null || points.length === 0) return null;

    /* `pressures` runs parallel to `points`, and perfect-freehand indexes into it
       positionally. A file where the two lengths disagree — truncated write, hand
       edit, an older schema — would silently taper the wrong parts of the stroke.
       Pad or trim to match rather than trusting it. */
    const raw = Array.isArray(el['pressures']) ? (el['pressures'] as unknown[]) : [];
    const pressures = points.map((_, i) => {
      const p = raw[i];
      return typeof p === 'number' && Number.isFinite(p) ? clamp(p, 0, 1) : 0.5;
    });
    if (raw.length !== points.length) repaired = true;

    return {
      element: {
        ...base,
        type: 'freedraw',
        points,
        pressures,
        simulatePressure: el['simulatePressure'] !== false,
      },
      repaired,
    };
  }

  if (type === 'text') {
    const text = str('text', '');

    /* ── The Phase 7 tie-in, and the reason this function takes a measurer ──
     *
     * `lines`, `width`, `height`, `ascent` and `lineHeight` are all derived, and
     * they were derived on the machine that saved the file, against the fonts
     * that machine had. Trusting them gives you text whose stored box disagrees
     * with its own glyphs — wrapped in the wrong places, and with a spatial index
     * that says the text is somewhere it visibly is not.
     *
     * So they are thrown away and recomputed, unconditionally. The saved values
     * are not even read. */
    const wrapWidthRaw = el['wrapWidth'];
    const wrapWidth =
      typeof wrapWidthRaw === 'number' && Number.isFinite(wrapWidthRaw) && wrapWidthRaw > 0
        ? wrapWidthRaw
        : null;

    const shell = {
      ...base,
      type: 'text' as const,
      text,
      fontSize: clamp(num('fontSize', DEFAULT_FONT_SIZE), 4, 400),
      fontFamily: need(el['fontFamily'] as never, DEFAULT_FONT_FAMILY),
      textAlign: need(el['textAlign'] as never, 'left' as const),
      wrapWidth,
      lines: [],
      ascent: 0,
      lineHeight: 0,
    };

    const laid = { ...shell, ...relayoutText(shell, {}, measurer) };
    return { element: laid, repaired: true }; // always re-measured, so always "repaired"
  }

  // rectangle | diamond | ellipse
  return { element: { ...base, type } as Element, repaired };
}

function restorePoints(raw: unknown): { x: number; y: number }[] | null {
  if (!Array.isArray(raw)) return null;
  const out: { x: number; y: number }[] = [];
  for (const p of raw as unknown[]) {
    if (p === null || typeof p !== 'object') return null;
    const point = p as Record<string, unknown>;
    const x = point['x'];
    const y = point['y'];
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push({ x, y });
  }
  return out;
}

function restoreAppState(raw: unknown): StoredAppState {
  if (raw === null || typeof raw !== 'object') return DEFAULT_APP_STATE;
  const a = raw as Record<string, unknown>;

  const n = (key: string, fallback: number): number => {
    const v = a[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  };

  return {
    scrollX: n('scrollX', 0),
    scrollY: n('scrollY', 0),
    /* Clamped to the same range the viewport enforces. A saved zoom of 0 makes
       every scene-to-screen conversion divide by zero, and a saved zoom of 10^6
       makes the grid loop for a very long time before drawing nothing. */
    zoom: clamp(n('zoom', 1), 0.1, 30),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
