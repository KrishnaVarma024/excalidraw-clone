/**
 * Every claim this project makes, reduced to a number.
 *
 * ── The idea ────────────────────────────────────────────────────────────────
 *
 * Nine phases made load-bearing claims. "Culling is sublinear." "The dirty-rect
 * merge is bounded." "The broad phase does the work, not the narrow phase."
 * Each one is currently defended by a document and by whoever remembers writing
 * it, which is a defence with a half-life of about one quarter.
 *
 * This file turns each claim into an integer, and `budget.test.ts` fails the
 * build when one moves. Not "is it fast" — *how much work does it do*, counted
 * exactly (ARCHITECTURE §10.1): a count is identical on every machine, and it
 * distinguishes an algorithmic regression from a constant-factor one, which a
 * stopwatch cannot.
 *
 * ── Why the output is a flat record ─────────────────────────────────────────
 *
 * Because the artefact people actually read is the *diff* on `budget.json`. A
 * nested shape produces a diff you have to reconstruct in your head; a flat one
 * produces
 *
 *     - "cull.zoomed-in.10000.tested": 46,
 *     + "cull.zoomed-in.10000.tested": 10000,
 *
 * which is a code review that has already happened. The gate's real job is not
 * to fail the build — it is to make the regression legible in the pull request
 * that caused it.
 */

import { DirtyTracker } from '@engine/render/DirtyTracker';
import { getRenderBounds } from '@engine/scene/bounds';
import { serialize } from '@engine/persist/document';
import { toSvg } from '@engine/export/svg';
import { generateScene } from '@engine/dev/generateScene';
import type { Scene } from '@engine/scene/Scene';
import type { Bounds } from '@engine/util/geometry';
import { BUDGET_COUNTS, SCREEN, ZOOMED_IN, ZOOMED_OUT, dense, scene } from './scenarios';

export type Measurements = Record<string, number | string>;

const VIEWS: readonly (readonly [string, Bounds])[] = [
  ['screen', SCREEN],
  ['zoomed-in', ZOOMED_IN],
  ['zoomed-out', ZOOMED_OUT],
];

/**
 * Points probed by the hit-test budget: a 5×5 lattice over the screen rectangle.
 *
 * A lattice rather than "the centre of element 27", because element 27 moves the
 * moment anyone touches the generator's type weights, and the budget would then
 * record a change that means nothing about hit testing. Fixed points in scene
 * space ask a stable question: *how much work to answer a click here.*
 *
 * Twenty-five of them rather than three, because a handful of probes in a
 * sparse scene mostly land on empty space and sum to zero — and a budget whose
 * value is zero cannot detect the regression it exists for. Aggregating over a
 * lattice keeps the number well away from the floor without making it depend on
 * which element happens to be where.
 */
const HIT_POINTS: readonly { x: number; y: number }[] = (() => {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      pts.push({
        x: SCREEN.minX + ((SCREEN.maxX - SCREEN.minX) * (i + 0.5)) / 5,
        y: SCREEN.minY + ((SCREEN.maxY - SCREEN.minY) * (j + 0.5)) / 5,
      });
    }
  }
  return pts;
})();

/** Matches `Selection`'s screen-space slop at 100% zoom. */
const HIT_THRESHOLD = 8;

export function measure(): Measurements {
  const out: Measurements = {};

  /* ── Cull: the headline claim ─────────────────────────────────────────────
     `tested` is what Phase 4 exists to lower. Recording `path` alongside it is
     the part people leave out: "the cull got slower" and "the cull took a
     different strategy" produce the same number and have completely different
     fixes, so the strategy is pinned too. A silent fall back from `index` to
     `scan` is exactly the regression this catches. */
  for (const count of BUDGET_COUNTS) {
    const s = scene(count);
    for (const [label, view] of VIEWS) {
      const returned = s.visible(view).length;
      const q = s.queryStats;
      const key = `cull.${label}.${count}`;
      out[`${key}.tested`] = q.tested;
      out[`${key}.nodes`] = q.nodes;
      out[`${key}.returned`] = returned;
      out[`${key}.path`] = q.path;
    }
  }

  /* ── Hit test: the broad/narrow split ─────────────────────────────────────
     The narrow phase is the expensive one — exact geometry, per element. The
     whole design is that the broad phase hands it almost nothing. Budgeting
     both makes that visible: `narrow` creeping toward `broad` means the broad
     phase has stopped filtering, which no timing would name. */
  for (const count of BUDGET_COUNTS) {
    const s = dense(count);
    let broad = 0;
    let narrow = 0;
    for (const p of HIT_POINTS) {
      s.hitTest(p, HIT_THRESHOLD);
      broad += s.hitStats.broad;
      narrow += s.hitStats.narrow;
    }
    out[`hit.${count}.broad`] = broad;
    out[`hit.${count}.narrow`] = narrow;
  }

  /* ── Dirty rectangles: is the merge still bounded, and does the escape
        hatch still open? ─────────────────────────────────────────────────────
     Two cases, because the interesting behaviour is the *threshold* between
     them, and one case cannot pin a threshold.

     The cases are defined by REGION, not by element count, because that is what
     a box-select produces: a tight selection of neighbours, or a sweep across
     the screen. Four elements chosen from opposite corners would merge into one
     screen-sized rectangle and force a full repaint — a true measurement of a
     situation no user creates, which is the classic way a budget ends up
     defending the wrong thing.

     `local` must stay `partial` — that is the optimisation working. `wide` must
     go `full` — that is the escape hatch working, and it is the half people
     forget to test. Budget only the partial case and someone can raise
     MAX_DIRTY_COVERAGE to 0.95, watch every test pass, and ship a build that
     clips forty rectangles in order to repaint almost the whole screen. */
  {
    const CASES: readonly (readonly [string, Scene, Bounds])[] = [
      // A tight box-select of neighbours. Must stay partial — this is the win.
      ['local', scene(1_000), { minX: -240, minY: -160, maxX: 240, maxY: 160 }],
      // A sweep across the viewport in a sparse drawing. Still partial, and
      // sitting right on MAX_DIRTY_RECTS — so any change to the merge heuristic
      // pushes it over and shows up here first.
      ['wide', scene(1_000), SCREEN],
      // The same sweep in a dense drawing. Must go full: this is the escape
      // hatch, and it is the half people forget to test.
      ['dense', dense(1_000), SCREEN],
    ];

    for (const [label, s, region] of CASES) {
      const tracker = new DirtyTracker();

      /* Drain the tracker's `initial` force before measuring.
         A fresh DirtyTracker starts with `forced = 'initial'` so the very first
         frame paints everything — correct, and a trap for this file. Measure
         without draining it and every scenario records `plan: "full",
         coverage: 1.0`, which looks like a legitimate result, passes review, and
         pins a budget on the one code path the drag never takes. The gate would
         then be permanently green no matter what happened to the merge.

         Found by reading a number that was *too round*: coverage came out at
         exactly 1.000 for three small shapes in a corner of the screen. **A
         suspiciously clean measurement is a bug report about the measurement.** */
      tracker.plan(SCREEN);

      for (const el of s.elementsInBox(region)) {
        const before = getRenderBounds(el);
        const after: Bounds = {
          minX: before.minX + 17,
          minY: before.minY + 11,
          maxX: before.maxX + 17,
          maxY: before.maxY + 11,
        };
        tracker.addChange(before, after);
      }
      const plan = tracker.plan(SCREEN);
      const stats = tracker.stats();
      out[`dirty.${label}.collected`] = stats.collected;
      out[`dirty.${label}.merged`] = stats.merged;
      out[`dirty.${label}.plan`] = plan.kind;
      /* Per-mille rather than a float: JSON round-trips 0.1 + 0.2 faithfully but
         an exact assertion on a float is a trap waiting for the first person who
         changes the arithmetic order. An integer is the same measurement without
         the trap. */
      out[`dirty.${label}.coverage_permille`] = Math.round(stats.coverage * 1000);
    }
  }

  /* ── Bytes on disk ────────────────────────────────────────────────────────
     Phase 8 chose IndexedDB over localStorage on a measurement (24.69 MB at
     50k against a ~5 MB quota). That measurement decays silently: add one field
     to the element model and every saved document grows, with nothing to say
     so. Budgeting the serialised size makes the schema's cost visible at the
     moment it is added, which is the only moment anyone can cheaply reconsider. */
  for (const count of BUDGET_COUNTS) {
    const s = scene(count);
    const doc = serialize(s.sorted(), { scrollX: 0, scrollY: 0, zoom: 1 }, 'budget');
    out[`bytes.document.${count}`] = JSON.stringify(doc).length;
  }

  /* ── Export size ──────────────────────────────────────────────────────────
     Phase 9's coordinate rounding more than halved the SVG. Nothing enforces
     that it stays rounded — `roundPath` is one regex, and deleting it breaks no
     test while doubling every export. Here it is a number. */
  for (const count of [100, 1_000] as const) {
    const els = generateScene({ count, seed: 0x5eed + count }).elements;
    const svg = toSvg(els, { background: '#ffffff' });
    out[`bytes.svg.${count}`] = svg === null ? 0 : svg.length;
  }

  return out;
}
