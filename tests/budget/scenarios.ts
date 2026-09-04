/**
 * The workloads the budget is measured against.
 *
 * ── Why these live in their own module ──────────────────────────────────────
 *
 * The test asserts numbers; the regeneration script produces them. Both must
 * measure *exactly* the same thing or the budget is meaningless — a ceiling
 * derived from a slightly different scene is not a ceiling, it is a number.
 * One definition, two consumers.
 *
 * ── What a scenario is allowed to be ────────────────────────────────────────
 *
 * Deterministic, and cheap enough to run on every commit. Everything here is
 * seeded (§10.1) and DOM-free, so the same scene is built element-for-element
 * on a laptop and on a CI runner. That is the property the whole gate rests on:
 * if a scenario could differ between machines, a failing build would mean
 * "the runner is different" rather than "you made it slower", and a gate that
 * cries wolf is turned off within a month.
 */

import { Scene } from '@engine/scene/Scene';
import { generateScene } from '@engine/dev/generateScene';
import type { Bounds } from '@engine/util/geometry';

const view = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

/** Roughly a 1440×900 window at 100% zoom, centred on the drawing. */
export const SCREEN = view(-720, -450, 720, 450);

/** Zoomed right in. Almost nothing visible — the quadtree's best case. */
export const ZOOMED_IN = view(-40, -25, 40, 25);

/** Zoomed right out. Everything visible — the case an index cannot win. */
export const ZOOMED_OUT = view(-6000, -6000, 6000, 6000);

/**
 * Element counts the budget covers.
 *
 * 50,000 is deliberately absent. It is in `npm run bench`, where a human waits
 * for it; generating it costs ~1.2 s and buys no information this gate does not
 * already have from 10,000 — the ratio between 1,000 and 10,000 already shows
 * the complexity class. **A gate people skip because it is slow protects
 * nothing**, so the budget stays under a second and the expensive scene stays
 * where it belongs.
 */
export const BUDGET_COUNTS = [1_000, 10_000] as const;

/**
 * Build a scene of `count` elements.
 *
 * The seed is derived from the count so each size is a different arrangement
 * rather than a prefix of the same one — a prefix would make the 1,000-element
 * case a strict subset of the 10,000 one and hide any bug that only appears at
 * a particular density.
 */
export function budgetScene(count: number): Scene {
  const scene = new Scene();
  scene.load(generateScene({ count, seed: 0x5eed + count }).elements);
  scene.sorted();
  return scene;
}

/**
 * A scene packed into roughly one screen.
 *
 * The default `spread` of 4,000 scatters elements over an area ~20× the
 * viewport, so a click lands on empty space almost every time and a hit-test
 * budget measured there sums to nearly zero. Zero is not a budget — it cannot
 * go down, and anything above it looks like a regression.
 *
 * Density is also the honest case: hit testing is cheap in a sparse drawing by
 * definition. The question worth gating is what a click costs where the
 * elements actually are.
 */
export function denseScene(count: number): Scene {
  const scene = new Scene();
  scene.load(generateScene({ count, seed: 0xd0e5 + count, spread: 700 }).elements);
  scene.sorted();
  return scene;
}

/** Cached across the whole run: generation dominates measurement otherwise. */
const cache = new Map<string, Scene>();

function memo(key: string, build: () => Scene): Scene {
  let s = cache.get(key);
  if (s === undefined) {
    s = build();
    cache.set(key, s);
  }
  return s;
}

export const scene = (count: number): Scene => memo(`sparse:${count}`, () => budgetScene(count));
export const dense = (count: number): Scene => memo(`dense:${count}`, () => denseScene(count));
