/**
 * The index, tested in isolation.
 *
 * Every test here is plain rectangles and string ids. Nothing constructs an
 * `Element`, nothing touches `Scene`. That is deliberate: when one of these
 * fails, the bug is in the tree, and the failure message says so without
 * anybody having to work out whether the element model was involved.
 *
 * The last block is the one that matters. Structural assertions ("it subdivided",
 * "it grew") check that the implementation does what I *think* it does. The
 * randomised oracle checks that it does what it *promises* — and it is the only
 * test here capable of catching the failure mode this phase actually fears: an
 * entry that quietly stops being findable after it moves.
 */

import { describe, expect, it } from 'vitest';
import { QuadTree } from '@engine/spatial/QuadTree';
import { boundsIntersect, type Bounds } from '@engine/util/geometry';
import { makeRandom } from '@engine/util/math';

const box = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

/** A small square at (x, y). */
const at = (x: number, y: number, size = 2): Bounds =>
  box(x - size / 2, y - size / 2, x + size / 2, y + size / 2);

const EVERYTHING = box(-1e9, -1e9, 1e9, 1e9);

function ids(tree: QuadTree, range: Bounds): string[] {
  return tree
    .query(range)
    .map((e) => e.id)
    .sort();
}

describe('QuadTree — basics', () => {
  it('starts empty', () => {
    const t = new QuadTree();
    expect(t.size).toBe(0);
    expect(t.query(EVERYTHING)).toHaveLength(0);
  });

  it('finds what it stores', () => {
    const t = new QuadTree();
    t.insert('a', at(10, 10));
    t.insert('b', at(-500, 300));

    expect(t.size).toBe(2);
    expect(ids(t, EVERYTHING)).toEqual(['a', 'b']);
    expect(ids(t, box(0, 0, 20, 20))).toEqual(['a']);
    expect(ids(t, box(-600, 200, -400, 400))).toEqual(['b']);
  });

  it('counts an entry touching the range edge as a hit', () => {
    // Conservative on purpose. A broad phase that returns one extra candidate
    // costs a cheap narrow-phase test; one that misses a candidate is a shape
    // the user cannot click, and that bug is reported as "sometimes it doesn't
    // select" — the worst kind of report.
    const t = new QuadTree();
    t.insert('a', box(100, 100, 200, 200));
    expect(ids(t, box(200, 200, 300, 300))).toEqual(['a']);
  });

  it('removes, and reports whether it removed anything', () => {
    const t = new QuadTree();
    const b = at(10, 10);
    t.insert('a', b);

    expect(t.remove('a', b)).toBe(true);
    expect(t.size).toBe(0);
    expect(t.remove('a', b)).toBe(false);
    expect(t.remove('never-existed', b)).toBe(false);
  });

  it('clears without losing its root rectangle', () => {
    const t = new QuadTree();
    for (let i = 0; i < 100; i++) t.insert(`e${i}`, at(i * 10, i * 10));
    const before = t.rootBounds;

    t.clear();
    expect(t.size).toBe(0);
    expect(t.query(EVERYTHING)).toHaveLength(0);
    // Keeping the (possibly grown) root avoids re-growing from scratch on the
    // next load of a scene that is the same size as the last one.
    expect(t.rootBounds).toEqual(before);
  });
});

describe('QuadTree — subdivision', () => {
  it('subdivides once a node exceeds capacity', () => {
    const t = new QuadTree({ capacity: 4 });
    for (let i = 0; i < 4; i++) t.insert(`e${i}`, at(100 + i, 100));
    expect(t.stats().nodes).toBe(1);

    t.insert('e4', at(105, 100));
    expect(t.stats().nodes).toBeGreaterThan(1);
  });

  it('stops at maxDepth instead of recursing forever on coincident points', () => {
    // `capacity` alone cannot terminate. A hundred elements at identical
    // coordinates never separate no matter how finely you cut, so a
    // capacity-only rule recurses until the stack dies. This is the test that
    // says maxDepth is a correctness feature, not a tuning knob.
    const t = new QuadTree({ capacity: 2, maxDepth: 5 });
    for (let i = 0; i < 200; i++) t.insert(`e${i}`, at(7, 7));

    expect(t.stats().maxDepth).toBeLessThanOrEqual(5);
    expect(t.size).toBe(200);
    expect(ids(t, box(6, 6, 8, 8))).toHaveLength(200);
  });

  it('keeps a straddling entry in the parent rather than duplicating it', () => {
    // The whole reason `remove` is unambiguous. An entry lying across a split
    // line has exactly one home.
    const t = new QuadTree({ capacity: 1, initialExtent: 100 });
    t.insert('corner', box(-50, -50, 50, 50)); // dead centre, crosses both axes
    t.insert('a', at(-60, -60));
    t.insert('b', at(60, 60));

    expect(t.stats().rootItems).toBe(1);
    expect(t.query(EVERYTHING)).toHaveLength(3); // no duplicate of `corner`
    expect(ids(t, at(0, 0, 1))).toEqual(['corner']);
  });

  it('finds a straddler from any quadrant it overlaps', () => {
    const t = new QuadTree({ capacity: 1, initialExtent: 100 });
    t.insert('corner', box(-50, -50, 50, 50));
    for (let i = 0; i < 20; i++) t.insert(`f${i}`, at(-90 + i, -90));

    for (const corner of [at(-40, -40), at(40, -40), at(-40, 40), at(40, 40)]) {
      expect(ids(t, corner)).toContain('corner');
    }
  });
});

describe('QuadTree — growing to fit an infinite canvas', () => {
  it('accepts an entry far outside its initial root', () => {
    const t = new QuadTree({ initialExtent: 100 });
    t.insert('far', at(1_000_000, -2_000_000));

    expect(t.size).toBe(1);
    expect(ids(t, at(1_000_000, -2_000_000, 10))).toEqual(['far']);
  });

  it('reaches a distant coordinate in a logarithmic number of growths', () => {
    // Doubling is the entire argument. Reaching 10⁹ from an extent of 100 needs
    // about log₂(10⁷) ≈ 24 growths — each O(1), each three assignments. Linear
    // growth would need 10⁷ of them, and a "just make the root enormous"
    // approach spends every level of depth on empty space.
    const t = new QuadTree({ initialExtent: 100 });
    t.insert('far', at(1e9, 1e9));

    expect(t.stats().growths).toBeLessThan(40);
    expect(ids(t, at(1e9, 1e9, 10))).toEqual(['far']);
  });

  it('keeps everything findable after growing in each direction', () => {
    // Getting the old-root-to-quadrant mapping backwards produces a tree that
    // still answers queries — slowly and, for some entries, wrongly. It is the
    // kind of bug that shows up as "one shape in the corner is unclickable", so
    // it is asserted directly rather than left to a benchmark to notice.
    for (const [dx, dy] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ] as const) {
      const t = new QuadTree({ initialExtent: 100, capacity: 2 });
      const home: string[] = [];
      for (let i = 0; i < 12; i++) {
        const id = `home${i}`;
        home.push(id);
        t.insert(id, at(-80 + i * 10, -80 + i * 10));
      }

      t.insert('far', at(dx * 5000, dy * 5000));

      expect(t.stats().growths).toBeGreaterThan(0);
      expect(t.size).toBe(13);
      expect(ids(t, EVERYTHING).length).toBe(13);
      for (const id of home) {
        expect(ids(t, at(Number(id.slice(4)) * 10 - 80, Number(id.slice(4)) * 10 - 80, 4))).toContain(
          id,
        );
      }
    }
  });

  it('converges when an entry overflows the root on both sides at once', () => {
    // The growth direction is chosen by comparing centres, so a symmetric
    // overflow alternates left and right. It still terminates, because each
    // growth doubles — but "it terminates" is exactly the kind of claim that
    // deserves a test rather than an argument.
    const t = new QuadTree({ initialExtent: 10 });
    t.insert('huge', box(-10_000, -10_000, 10_000, 10_000));

    expect(t.size).toBe(1);
    expect(ids(t, at(0, 0, 1))).toEqual(['huge']);
  });
});

describe('QuadTree — moving entries', () => {
  it('follows an entry that moves within its node', () => {
    const t = new QuadTree();
    t.insert('a', at(100, 100));
    t.update('a', at(100, 100), at(103, 100));

    expect(t.size).toBe(1);
    expect(ids(t, at(103, 100, 2))).toEqual(['a']);
    expect(ids(t, at(100, 100, 0.5))).toHaveLength(0);
  });

  it('follows an entry that moves across the tree', () => {
    const t = new QuadTree({ capacity: 2 });
    for (let i = 0; i < 40; i++) t.insert(`e${i}`, at(i * 20, 50));

    t.update('e0', at(0, 50), at(-3000, -3000));

    expect(t.size).toBe(40);
    expect(ids(t, at(-3000, -3000, 10))).toEqual(['e0']);
    expect(ids(t, at(0, 50, 2))).toHaveLength(0);
  });

  it('follows an entry that moves outside the root, growing on the way', () => {
    const t = new QuadTree({ initialExtent: 100 });
    t.insert('a', at(10, 10));
    t.update('a', at(10, 10), at(50_000, 50_000));

    expect(t.size).toBe(1);
    expect(t.stats().growths).toBeGreaterThan(0);
    expect(ids(t, at(50_000, 50_000, 10))).toEqual(['a']);
  });
});

describe('QuadTree — the oracle', () => {
  /**
   * The test that actually protects this phase.
   *
   * Everything above asserts something I already believed. This one builds a
   * scene with a seeded PRNG, hammers it with inserts, moves and removes, and
   * after every batch compares the tree's answer to a brute-force scan over the
   * same rectangles.
   *
   * Brute force is the right oracle here for the reason brute force is usually
   * the right oracle: it is obviously correct, it shares no code with the thing
   * under test, and it is far too slow to ship — which is the entire reason the
   * tree exists. If the two ever disagree, the tree is wrong.
   */
  it('agrees with a brute-force scan through 400 random mutations', () => {
    const rnd = makeRandom(0xc0ffee);
    const truth = new Map<string, Bounds>();
    const tree = new QuadTree({ capacity: 4, maxDepth: 6, initialExtent: 256 });

    const randomBox = (): Bounds => {
      const x = (rnd() - 0.5) * 4000;
      const y = (rnd() - 0.5) * 4000;
      const w = 1 + rnd() * 300;
      const h = 1 + rnd() * 300;
      return box(x, y, x + w, y + h);
    };

    const check = (): void => {
      const ranges: Bounds[] = [
        EVERYTHING,
        box(-50, -50, 50, 50),
        box(0, 0, 1, 1),
        box(-2500, -2500, 0, 0),
        randomBox(),
      ];
      for (const range of ranges) {
        const expected = [...truth.entries()]
          .filter(([, b]) => boundsIntersect(b, range))
          .map(([id]) => id)
          .sort();
        expect(ids(tree, range)).toEqual(expected);
      }
      expect(tree.size).toBe(truth.size);
    };

    let next = 0;
    for (let step = 0; step < 400; step++) {
      const roll = rnd();
      const existing = [...truth.keys()];

      if (roll < 0.5 || existing.length === 0) {
        const id = `e${next++}`;
        const b = randomBox();
        truth.set(id, b);
        tree.insert(id, b);
      } else if (roll < 0.85) {
        // Move. The dangerous operation: `remove` retraces the path the entry
        // took on the way in, so it must be given the OLD rectangle. Handing it
        // the new one leaves a ghost, and the ghost is invisible until a query
        // returns an id whose element is somewhere else entirely.
        const id = existing[Math.floor(rnd() * existing.length)]!;
        const before = truth.get(id)!;
        const after = randomBox();
        tree.update(id, before, after);
        truth.set(id, after);
      } else {
        const id = existing[Math.floor(rnd() * existing.length)]!;
        expect(tree.remove(id, truth.get(id)!)).toBe(true);
        truth.delete(id);
      }

      if (step % 25 === 0) check();
    }

    check();
    expect(truth.size).toBeGreaterThan(50); // the run did real work
  });

  it('leaves nothing behind when everything is removed', () => {
    // A size that returns to zero is the cheapest possible check that no
    // remove silently missed. Ghost entries are the failure mode of this
    // design, so they get their own assertion.
    const rnd = makeRandom(99);
    const tree = new QuadTree({ capacity: 3, initialExtent: 64 });
    const entries: [string, Bounds][] = [];

    for (let i = 0; i < 300; i++) {
      const x = (rnd() - 0.5) * 8000;
      const y = (rnd() - 0.5) * 8000;
      const b = box(x, y, x + 1 + rnd() * 100, y + 1 + rnd() * 100);
      entries.push([`e${i}`, b]);
      tree.insert(`e${i}`, b);
    }

    for (const [id, b] of entries) expect(tree.remove(id, b)).toBe(true);

    expect(tree.size).toBe(0);
    expect(tree.query(EVERYTHING)).toHaveLength(0);
    expect(tree.allIds()).toHaveLength(0);
  });
});

describe('QuadTree — the work it reports', () => {
  it('examines a small fraction of the tree for a small query', () => {
    const rnd = makeRandom(5);
    const t = new QuadTree();
    for (let i = 0; i < 5000; i++) {
      const x = (rnd() - 0.5) * 8000;
      const y = (rnd() - 0.5) * 8000;
      t.insert(`e${i}`, box(x, y, x + 20, y + 20));
    }

    t.query(box(0, 0, 40, 40));
    const work = t.lastQueryWork;

    expect(work.tested).toBeLessThan(5000 * 0.15);
    // Node count is the number that behaves logarithmically. `tested` does not,
    // and PR-phase-4a explains at length why not.
    expect(work.nodes).toBeLessThan(60);
  });

  it('visits every node when the range covers everything', () => {
    const t = new QuadTree({ capacity: 2 });
    for (let i = 0; i < 50; i++) t.insert(`e${i}`, at(i * 30, i * 30));

    t.query(EVERYTHING);
    expect(t.lastQueryWork.nodes).toBe(t.stats().nodes);
    expect(t.lastQueryWork.tested).toBe(50);
    expect(t.lastQueryWork.returned).toBe(50);
  });
});
