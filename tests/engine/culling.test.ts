/**
 * The cost of culling, measured by counting rather than by timing.
 *
 * ── Why not just time it ────────────────────────────────────────────────────
 *
 * The obvious test is "assert the cull takes under N milliseconds". It is a bad
 * test for two independent reasons:
 *
 *   1. It is flaky. A shared CI runner under load can make a correct O(log n)
 *      implementation miss a threshold that a broken O(n) one hit yesterday.
 *      A test that fails for reasons unrelated to the code is a test people
 *      learn to re-run rather than read.
 *
 *   2. It measures the wrong thing. A constant-factor speedup and an
 *      algorithmic one both move a stopwatch. Only one of them still works at
 *      500,000 elements, and a timing assertion cannot tell you which you got.
 *
 * Counting the elements the cull *examines* has neither problem. It is exactly
 * reproducible, it is identical on every machine, and it measures the complexity
 * class directly. `Scene.queryStats.tested` is that counter.
 *
 * ── What this file is for ───────────────────────────────────────────────────
 *
 * Right now these assertions document a deficiency: the cull is a linear scan,
 * so `tested` always equals the live element count. Phase 4 replaces the scan
 * with a quadtree, `tested` starts growing logarithmically, and the marked
 * assertions below flip from `toBe(total)` to `toBeLessThan(total)`.
 *
 * Writing the acceptance test for a phase *before* building it is the difference
 * between "the quadtree feels faster" and "here is the number, and here is the
 * test that fails if it regresses".
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { Scene } from '@engine/scene/Scene';
import { generateScene } from '@engine/dev/generateScene';
import { getRenderBounds } from '@engine/scene/bounds';
import type { Element } from '@engine/scene/element.types';
import type { Bounds } from '@engine/util/geometry';

const view = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

/** The whole plane, near enough — every element intersects this. */
const EVERYTHING = view(-1e9, -1e9, 1e9, 1e9);

function sceneOf(count: number, seed = 42): Scene {
  const scene = new Scene();
  scene.load(generateScene({ count, seed }).elements);
  return scene;
}

describe('cull instrumentation', () => {
  let scene: Scene;

  beforeEach(() => {
    scene = sceneOf(500);
  });

  it('reports zero work before any query', () => {
    expect(new Scene().queryStats).toEqual({ tested: 0, returned: 0 });
  });

  it('records what the last query returned', () => {
    const returned = scene.visible(EVERYTHING).length;
    expect(scene.queryStats.returned).toBe(returned);
    expect(returned).toBe(scene.visibleCount);
  });

  it('reflects only the most recent query', () => {
    scene.visible(EVERYTHING);
    scene.visible(view(1e8, 1e8, 1e8 + 1, 1e8 + 1));
    expect(scene.queryStats.returned).toBe(0);
  });

  it('does not examine soft-deleted elements', () => {
    const before = scene.visibleCount;
    const first = scene.sorted()[0]!;
    scene.remove(first.id);

    scene.visible(EVERYTHING);
    expect(scene.queryStats.tested).toBe(before - 1);
  });
});

describe('the cull is O(n) — this is the Phase 4 acceptance test', () => {
  /**
   * PHASE 4: change `toBe(total)` to `toBeLessThan(total * 0.1)` here.
   *
   * Leave the test name alone, so `git log -p` on this file reads as the
   * before/after of the whole optimisation in one diff.
   */
  it('examines every live element regardless of how few are visible', () => {
    const scene = sceneOf(5000);

    // A one-scene-unit window: essentially nothing can be inside it.
    const returned = scene.visible(view(0, 0, 1, 1)).length;

    expect(returned).toBeLessThan(60);
    expect(scene.queryStats.tested).toBe(scene.visibleCount); // ← Phase 4 flips this
  });

  it('scales its work with the scene, not with the viewport', () => {
    // The defining signature of a linear scan: hold the viewport still, make
    // the document ten times bigger, and the cull does ten times the work — even
    // though the screen shows the same amount of stuff.
    const tiny = view(0, 0, 1, 1);

    const small = sceneOf(500);
    small.visible(tiny);

    const big = sceneOf(5000);
    big.visible(tiny);

    const ratio = big.queryStats.tested / small.queryStats.tested;
    expect(ratio).toBeCloseTo(10, 1); // ← Phase 4 should push this towards ~1.3
  });

  it('wastes almost all of its work at scale', () => {
    // Selectivity: the fraction of examined elements that were worth examining.
    // This number is the argument for Phase 4, stated as a ratio.
    const scene = sceneOf(10_000);
    scene.visible(view(-200, -200, 200, 200));

    const { tested, returned } = scene.queryStats;
    expect(returned / tested).toBeLessThan(0.15);
  });
});

describe('culling still returns the right answer', () => {
  // Fast and wrong is not an optimisation. These assertions are the ones the
  // quadtree must not break, and they are deliberately independent of how the
  // query is implemented.

  it('returns exactly the elements a brute-force scan would', () => {
    const scene = sceneOf(2000);
    const window = view(-500, -500, 500, 500);

    const fromScene = new Set(scene.visible(window).map((e) => e.id));
    const bruteForce = scene.sorted().filter((el) => overlaps(el, window));

    expect(fromScene.size).toBe(bruteForce.length);
    for (const el of bruteForce) expect(fromScene.has(el.id)).toBe(true);
  });

  it('returns results in ascending z-order', () => {
    // Painter's algorithm: the renderer draws in the order it is handed. A
    // spatial index returns things in tree order, which is not z-order — so this
    // is the assertion Phase 4 is most likely to break.
    const scene = sceneOf(2000);
    const z = scene.visible(view(-1000, -1000, 1000, 1000)).map((e) => e.zIndex);
    expect(z).toEqual([...z].sort((a, b) => a - b));
  });

  it('returns everything when the view covers the plane', () => {
    const scene = sceneOf(1000);
    expect(scene.visible(EVERYTHING)).toHaveLength(scene.visibleCount);
  });

  it('returns nothing when the view is empty space far from the drawing', () => {
    const scene = sceneOf(1000);
    expect(scene.visible(view(1e7, 1e7, 1e7 + 100, 1e7 + 100))).toHaveLength(0);
  });
});

/**
 * Overlap, spelled out longhand rather than by calling `boundsIntersect`.
 *
 * The point of an oracle is that it fails independently of the thing under
 * test. Reusing the same helper the implementation uses would make this test
 * pass happily even if `boundsIntersect` had an inverted comparison in it.
 */
function overlaps(el: Element, window: Bounds): boolean {
  const b = getRenderBounds(el);
  return !(b.maxX < window.minX || b.minX > window.maxX || b.maxY < window.minY || b.minY > window.maxY);
}
