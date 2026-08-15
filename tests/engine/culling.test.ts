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
 *
 *   2. It measures the wrong thing. A constant-factor speedup and an
 *      algorithmic one both move a stopwatch, and only one of them still works
 *      at 500,000 elements.
 *
 * Counting the elements the cull *examines* has neither problem: exactly
 * reproducible, identical on every machine, and it measures the shape of the
 * work directly. `Scene.queryStats` is that counter.
 *
 * ── What changed in Phase 4, and what didn't ────────────────────────────────
 *
 * Phase 3 wrote the assertions below as `toBe(total)` — a linear scan examining
 * every live element on every frame. They were written to be flipped, and the
 * diff on this file is the shortest honest summary of the phase.
 *
 * They flipped, but **not as far as I predicted**. `tested` fell from 100% of
 * the scene to about 6%, and then stayed at about 6% as the scene grew — so the
 * quadtree bought a ~16× smaller constant rather than a better complexity class.
 * The assertions below say 6%, because 6% is what is true. Asserting the
 * O(log n) I hoped for would have produced a green test suite describing a
 * program that does not exist.
 *
 * PR-phase-4a explains where the floor comes from (elements stop separating once
 * a node is only a few times their size) and why removing it is not worth doing
 * (what remains is 0.04 ms of a 16.67 ms frame).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { SCAN_AREA_RATIO, Scene } from '@engine/scene/Scene';
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

/** A window far smaller than the drawing: the case the index exists for. */
const PINHOLE = view(0, 0, 1, 1);

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
    expect(new Scene().queryStats).toEqual({ tested: 0, returned: 0, nodes: 0, path: 'all' });
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

  it('drops a soft-deleted element out of the index entirely', () => {
    // Not merely filtered at query time — removed on delete and re-inserted on
    // undelete, so a query never pays for elements that are not there.
    const first = scene.sorted()[0]!;
    scene.visible(PINHOLE);
    const before = scene.queryStats.tested;

    scene.remove(first.id);
    scene.visible(PINHOLE);
    expect(scene.queryStats.tested).toBeLessThanOrEqual(before);
    expect(scene.visible(EVERYTHING)).toHaveLength(scene.visibleCount);

    scene.mutate(first.id, { isDeleted: false });
    expect(scene.visible(EVERYTHING).map((e) => e.id)).toContain(first.id);
  });
});

describe('the index — this is the Phase 4 acceptance test', () => {
  /**
   * PHASE 3 WROTE THIS AS `toBe(total)`. It is the line the whole phase exists
   * to change, and it is kept and renamed rather than deleted, so that
   * `git log -p tests/engine/culling.test.ts` reads as the before and after of
   * the optimisation in one diff.
   */
  it('examines a small fraction of the scene when little of it is visible', () => {
    const scene = sceneOf(5000);

    const returned = scene.visible(PINHOLE).length;
    const { tested, path } = scene.queryStats;

    expect(returned).toBeLessThan(60);
    expect(path).toBe('index');
    expect(tested).toBeLessThan(scene.visibleCount * 0.1); // ← Phase 3 asserted equality
  });

  it('holds that fraction roughly steady as the scene grows', () => {
    // The honest shape of the result. If `tested` were O(log n) this ratio would
    // fall as the scene grew; it does not. It sits near 6% from 500 elements to
    // 10,000 — a constant-factor win, large and useful, and not the asymptotic
    // one the word "quadtree" invites you to claim.
    for (const n of [500, 2000, 10_000]) {
      const scene = sceneOf(n);
      scene.visible(PINHOLE);
      const ratio = scene.queryStats.tested / scene.visibleCount;
      expect(ratio).toBeGreaterThan(0.02);
      expect(ratio).toBeLessThan(0.1);
    }
  });

  it('still grows its work with the scene — just 8× more slowly', () => {
    // Phase 3's version asserted this ratio was ~10 (perfectly linear) and
    // predicted Phase 4 would push it toward ~1.3. It went to 8.5. Recording
    // the number I got rather than the number I wanted is the entire reason the
    // counter exists.
    const small = sceneOf(500);
    small.visible(PINHOLE);

    const big = sceneOf(5000);
    big.visible(PINHOLE);

    const ratio = big.queryStats.tested / small.queryStats.tested;
    expect(ratio).toBeGreaterThan(5);
    expect(ratio).toBeLessThan(10);
  });

  it('visits a near-constant number of nodes, which is the part that did work', () => {
    // `nodes` is where the tree's structure shows up cleanly: 20× the elements
    // for well under 2.5× the nodes descended into. `tested` is dominated by how
    // many entries those few nodes happen to hold.
    const small = sceneOf(500);
    small.visible(PINHOLE);
    const big = sceneOf(10_000);
    big.visible(PINHOLE);

    expect(big.queryStats.nodes / small.queryStats.nodes).toBeLessThan(2.5);
  });
});

describe('choosing a strategy per query', () => {
  // Three paths, because the index is not unconditionally better. Using the
  // query path for every call was a measured 2.8× regression at 50,000 elements
  // zoomed out — caught by a benchmark written in Phase 3, before any of this
  // existed, for exactly that purpose.

  it('short-circuits to the sorted array when everything is on screen', () => {
    const scene = sceneOf(2000);
    const all = scene.visible(EVERYTHING);

    expect(scene.queryStats.path).toBe('all');
    expect(scene.queryStats.tested).toBe(0); // containment proved once, for the lot
    expect(all).toBe(scene.sorted()); // the same array, not a copy
  });

  it('scans rather than queries when most of the scene is on screen', () => {
    // Between "all of it" and "a pinhole" there is a band where the query would
    // return most of the scene and then pay O(k log k) to put it back into
    // z-order. The scan gets that ordering for free.
    const scene = sceneOf(2000);
    const content = boundsOf(scene.sorted());

    const w = (content.maxX - content.minX) * 0.8;
    const h = (content.maxY - content.minY) * 0.8;
    scene.visible(view(content.minX, content.minY, content.minX + w, content.minY + h));

    expect(SCAN_AREA_RATIO).toBeLessThan(0.8 * 0.8);
    expect(scene.queryStats.path).toBe('scan');
    expect(scene.queryStats.tested).toBe(scene.visibleCount);
  });

  it('uses the index for an ordinary viewport on a large drawing', () => {
    const scene = sceneOf(10_000);
    scene.visible(view(-720, -450, 720, 450));
    expect(scene.queryStats.path).toBe('index');
  });

  it('reports an empty scene without touching the index', () => {
    const scene = new Scene();
    expect(scene.visible(view(0, 0, 100, 100))).toHaveLength(0);
  });
});

describe('culling still returns the right answer', () => {
  // Fast and wrong is not an optimisation. These are the assertions the index
  // had to not break, written so they hold whichever of the three paths runs.

  it('returns exactly the elements a brute-force scan would, on every path', () => {
    const scene = sceneOf(2000);

    const windows: [string, Bounds][] = [
      ['all', EVERYTHING],
      ['scan', shrunk(boundsOf(scene.sorted()), 0.85)],
      ['index', view(-500, -500, 500, 500)],
      ['pinhole', PINHOLE],
    ];

    for (const [label, window] of windows) {
      const fromScene = new Set(scene.visible(window).map((e) => e.id));
      const bruteForce = scene.sorted().filter((el) => overlaps(el, window));

      // Label folded into the assertion so a failure names the path.
      expect(`${label}:${fromScene.size}`).toBe(`${label}:${bruteForce.length}`);
      for (const el of bruteForce) expect(fromScene.has(el.id)).toBe(true);
    }
  });

  it('returns results in ascending z-order', () => {
    // Painter's algorithm: the renderer draws in the order it is handed. The
    // index returns entries in *tree* order, which is not z-order — so this is
    // the assertion Phase 4 was most likely to break, and the sort that fixes it
    // is the cost that made the third path necessary.
    const scene = sceneOf(2000);
    for (const window of [EVERYTHING, view(-500, -500, 500, 500), view(-60, -60, 60, 60)]) {
      const z = scene.visible(window).map((e) => e.zIndex);
      expect(z).toEqual([...z].sort((a, b) => a - b));
    }
  });

  it('keeps answering correctly while elements move', () => {
    // The index is a derived cache. Every geometry change has to reach it, and
    // it has to be handed the OLD bounds so `remove` can retrace the path the
    // entry took on the way in. This exercises that contract through the public
    // API rather than against the tree directly.
    const scene = sceneOf(400);
    const targets = scene.sorted().slice(0, 40);

    for (const el of targets) scene.mutate(el.id, { x: el.x + 5000, y: el.y + 5000 });

    const window = view(4800, 4800, 6000, 6000);
    const fromScene = new Set(scene.visible(window).map((e) => e.id));
    const bruteForce = scene.sorted().filter((el) => overlaps(el, window));

    expect(fromScene.size).toBe(bruteForce.length);
    for (const el of bruteForce) expect(fromScene.has(el.id)).toBe(true);
  });

  it('returns nothing in empty space far from the drawing', () => {
    const scene = sceneOf(1000);
    expect(scene.visible(view(1e7, 1e7, 1e7 + 100, 1e7 + 100))).toHaveLength(0);
  });
});

/**
 * Overlap, spelled out longhand rather than by calling `boundsIntersect`.
 *
 * The point of an oracle is that it fails independently of the thing under
 * test. Reusing the helper the implementation uses would make this test pass
 * happily even if `boundsIntersect` had an inverted comparison in it.
 */
function overlaps(el: Element, window: Bounds): boolean {
  const b = getRenderBounds(el);
  return !(
    b.maxX < window.minX ||
    b.minX > window.maxX ||
    b.maxY < window.minY ||
    b.minY > window.maxY
  );
}

function boundsOf(elements: readonly Element[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const b = getRenderBounds(el);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}

/** `b` scaled about its centre. */
function shrunk(b: Bounds, factor: number): Bounds {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const w = ((b.maxX - b.minX) * factor) / 2;
  const h = ((b.maxY - b.minY) * factor) / 2;
  return { minX: cx - w, minY: cy - h, maxX: cx + w, maxY: cy + h };
}
