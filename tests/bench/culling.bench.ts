/**
 * The baseline benchmark: what does the linear cull actually cost?
 *
 * ── What a benchmark is for here ────────────────────────────────────────────
 *
 * `culling.test.ts` proves the *complexity class* by counting. This file
 * measures the *constant*, which is the other half of the question. An O(n)
 * scan with a very small constant beats an O(log n) structure with a large one
 * until n gets big — and "how big" is a number you have to measure, not derive.
 * Phase 4 is only worth shipping if it wins at a scale someone will actually
 * reach, and this is how that gets decided rather than assumed.
 *
 * ── How to read the output ──────────────────────────────────────────────────
 *
 * Vitest reports hz (ops/sec) and mean. The number that matters is the ratio
 * between adjacent element counts, not any absolute figure:
 *
 *     linear      → 10× the elements, ~10× the time
 *     logarithmic → 10× the elements, ~1.3× the time
 *
 * The absolute milliseconds are a property of the machine and belong in
 * `_learning/BASELINE.md` with the machine written next to them. The ratio is a
 * property of the algorithm and belongs in the PR description.
 *
 *     npm run bench
 *
 * ── Why the scenes are built once, outside the benchmark ────────────────────
 *
 * Building 50,000 elements takes far longer than culling them. Constructing
 * inside the measured function would drown the signal in allocation and make
 * every configuration look identical — the classic way to benchmark your setup
 * code and conclude that nothing matters.
 */

import { bench, describe } from 'vitest';
import { Scene } from '@engine/scene/Scene';
import { SCENE_PRESETS, generateScene } from '@engine/dev/generateScene';
import type { Bounds } from '@engine/util/geometry';

const view = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

/** Roughly a 1440×900 window at 100% zoom, centred on the drawing. */
const SCREEN = view(-720, -450, 720, 450);

/** Zoomed right in — a handful of elements visible out of however many exist. */
const ZOOMED_IN = view(-40, -25, 40, 25);

/** Zoomed right out — everything on screen at once. */
const ZOOMED_OUT = view(-6000, -6000, 6000, 6000);

const scenes = new Map<number, Scene>(
  SCENE_PRESETS.map((n) => {
    const scene = new Scene();
    scene.load(generateScene({ count: n, seed: 0x5eed + n }).elements);
    return [n, scene];
  }),
);

/**
 * `sorted()` is lazily rebuilt and cached. Priming it here keeps the one-off
 * 50,000-element sort out of the first measured iteration, where it would show
 * up as a phantom warmup cost that has nothing to do with culling.
 */
for (const scene of scenes.values()) scene.sorted();

describe('cull at typical zoom', () => {
  for (const n of SCENE_PRESETS) {
    bench(`${n.toLocaleString()} elements`, () => {
      scenes.get(n)!.visible(SCREEN);
    });
  }
});

describe('cull zoomed in — the case a spatial index is meant to win', () => {
  // Almost nothing is visible, so *every* element examined is wasted work. This
  // is the configuration where Phase 4 should look best, and reporting it
  // separately keeps that claim honest rather than hidden inside an average.
  for (const n of SCENE_PRESETS) {
    bench(`${n.toLocaleString()} elements`, () => {
      scenes.get(n)!.visible(ZOOMED_IN);
    });
  }
});

describe('cull zoomed out — the case where it cannot', () => {
  // Everything is visible, so the answer is "all of them" no matter how you
  // find it. A quadtree still has to walk every node and cannot beat a straight
  // array scan here — it may lose. Benchmarking only the flattering case is how
  // people end up shipping an optimisation that is a pessimisation in the
  // common path.
  for (const n of SCENE_PRESETS) {
    bench(`${n.toLocaleString()} elements`, () => {
      scenes.get(n)!.visible(ZOOMED_OUT);
    });
  }
});
