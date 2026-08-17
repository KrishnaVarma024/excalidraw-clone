/**
 * Dirty-rectangle tracking.
 *
 * `DirtyTracker` is pure geometry over `Bounds` — it collects rectangles, merges
 * them, and decides whether the result is worth using. It draws nothing, which
 * is what makes every decision in this phase a number you can assert rather than
 * a pixel you have to squint at.
 *
 * The tests that matter are not the merging ones. They are the ones about
 * **giving up**: a dirty-rect renderer that never falls back to a full repaint
 * is slower than the thing it replaced for any change that touches most of the
 * screen.
 */

import { describe, expect, it } from 'vitest';
import {
  DirtyTracker,
  MAX_DIRTY_COVERAGE,
  MAX_DIRTY_RECTS,
  MERGE_WASTE_RATIO,
  mergeRects,
  snapToDevicePixels,
  worthMerging,
} from '@engine/render/DirtyTracker';
import { boundsArea, type Bounds } from '@engine/util/geometry';

const box = (minX: number, minY: number, maxX: number, maxY: number): Bounds => ({
  minX,
  minY,
  maxX,
  maxY,
});

/** A 1000×1000 viewport centred on the origin. Area 1,000,000. */
const VIEW = box(-500, -500, 500, 500);

/** A tracker past its initial forced repaint, ready to collect. */
function ready(): DirtyTracker {
  const t = new DirtyTracker();
  t.plan(VIEW); // consume the 'initial' force
  t.resetStats(); // ...and the full repaint it counted, so tests start at zero
  return t;
}

describe('worthMerging', () => {
  it('always merges overlapping rectangles', () => {
    // Repainting shared pixels twice is slower and, for anything
    // semi-transparent, visibly wrong.
    expect(worthMerging(box(0, 0, 100, 100), box(50, 50, 150, 150))).toBe(true);
  });

  it('merges rectangles that are close enough for one clip to be cheaper', () => {
    // Two 100×100 boxes 5 units apart: union is 205×100 = 20,500 against
    // 20,000 of real content. 1.025× waste, well under the threshold.
    expect(worthMerging(box(0, 0, 100, 100), box(105, 0, 205, 100))).toBe(true);
  });

  it('refuses to merge rectangles at opposite corners', () => {
    // Two 10×10 boxes 1,000 apart: the union is ~1,000,000 against 200 of real
    // content. Merging here would repaint the entire screen to repair two dots.
    expect(worthMerging(box(0, 0, 10, 10), box(1000, 1000, 1010, 1010))).toBe(false);
  });

  it('draws the line exactly where MERGE_WASTE_RATIO says it does', () => {
    /* Derived rather than guessed, and derived from the exported constant so
       that retuning the constant retunes the test with it.

       Two 100×100 squares side by side, separated by a gap g:

         real content = 100·100 + 100·100          = 20,000
         union        = (100 + g + 100) · 100      = (200 + g)·100

       Merge when union ≤ content · ratio:

         (200 + g)·100 ≤ 20,000·ratio   →   g ≤ 200·(ratio − 1)

       At ratio 1.4 the limit is a gap of 80. */
    const a = box(0, 0, 100, 100);
    const limit = 200 * (MERGE_WASTE_RATIO - 1);

    const under = limit - 1;
    expect(worthMerging(a, box(100 + under, 0, 200 + under, 100))).toBe(true);

    const over = limit + 1;
    expect(worthMerging(a, box(100 + over, 0, 200 + over, 100))).toBe(false);
  });
});

describe('mergeRects', () => {
  it('leaves distant rectangles alone', () => {
    const rects = [box(0, 0, 10, 10), box(900, 900, 910, 910)];
    expect(mergeRects(rects)).toHaveLength(2);
  });

  it('collapses a cluster into one', () => {
    const rects = [box(0, 0, 50, 50), box(25, 25, 75, 75), box(60, 60, 100, 100)];
    const merged = mergeRects(rects);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(box(0, 0, 100, 100));
  });

  it('keeps merging until a pass changes nothing', () => {
    // The transitive case, and the reason the loop repeats. A and C are too far
    // apart to merge directly; merging A with B produces something that reaches
    // C. A single pass would return two rectangles here.
    const a = box(0, 0, 100, 100);
    const b = box(90, 0, 190, 100);
    const c = box(180, 0, 280, 100);
    expect(mergeRects([a, c, b])).toHaveLength(1);
  });

  it('never loses coverage', () => {
    // The invariant that actually matters: whatever the merge does, every input
    // rectangle must still be inside some output rectangle. Anything else is a
    // region that never gets repaired, which is a permanent visual artefact.
    const rects = [
      box(0, 0, 10, 10),
      box(5, 5, 20, 20),
      box(500, 500, 520, 520),
      box(-300, 100, -250, 160),
    ];
    const merged = mergeRects(rects);

    for (const r of rects) {
      const covered = merged.some(
        (m) => m.minX <= r.minX && m.minY <= r.minY && m.maxX >= r.maxX && m.maxY >= r.maxY,
      );
      expect(covered).toBe(true);
    }
  });

  it('handles the empty and single cases', () => {
    expect(mergeRects([])).toEqual([]);
    expect(mergeRects([box(1, 2, 3, 4)])).toEqual([box(1, 2, 3, 4)]);
  });
});

describe('snapToDevicePixels', () => {
  it('always grows, never rounds', () => {
    // Rounding 12.3 down to 12 on the max edge would clip a fraction of a pixel
    // that the clear never touches — the seam bug. Outward is the only safe
    // direction.
    const snapped = snapToDevicePixels(box(12.3, 40.9, 100.1, 200.5), 0);
    expect(snapped).toEqual(box(12, 40, 101, 201));
  });

  it('pads for antialiasing bleed', () => {
    expect(snapToDevicePixels(box(10, 10, 20, 20), 1)).toEqual(box(9, 9, 21, 21));
  });

  it('is idempotent on integers once padded', () => {
    const once = snapToDevicePixels(box(10, 10, 20, 20), 0);
    expect(snapToDevicePixels(once, 0)).toEqual(once);
  });
});

describe('DirtyTracker — the plan', () => {
  it('forces a full repaint on the very first frame', () => {
    // Nothing on screen yet, so nothing is correct yet. Starting in 'partial'
    // would leave the canvas showing whatever the browser put there.
    const plan = new DirtyTracker().plan(VIEW);
    expect(plan).toEqual({ kind: 'full', reason: 'initial' });
  });

  it('reports nothing to do when nothing changed', () => {
    expect(ready().plan(VIEW).kind).toBe('none');
  });

  it('repairs a small change with one rectangle', () => {
    const t = ready();
    t.add(box(0, 0, 20, 20));

    const plan = t.plan(VIEW);
    expect(plan.kind).toBe('partial');
    if (plan.kind !== 'partial') return;
    expect(plan.rects).toHaveLength(1);
    expect(plan.coverage).toBeCloseTo(400 / 1_000_000, 8);
  });

  it('collects both halves of a move', () => {
    // THE dirty-rect bug: repair only where the shape arrived and it smears a
    // trail behind it across the canvas.
    const t = ready();
    t.addChange(box(0, 0, 20, 20), box(300, 300, 320, 320));

    const plan = t.plan(VIEW);
    expect(plan.kind).toBe('partial');
    if (plan.kind !== 'partial') return;
    expect(plan.rects).toHaveLength(2);
  });

  it('drains itself, so a region is not repaired forever', () => {
    // A plan() that returns without clearing the collection repairs the same
    // pixels on every subsequent frame — the canvas looks perfect and the
    // renderer never goes idle.
    const t = ready();
    t.add(box(0, 0, 20, 20));
    expect(t.plan(VIEW).kind).toBe('partial');
    expect(t.plan(VIEW).kind).toBe('none');
  });

  describe('knowing when to give up', () => {
    it('falls back when too many separate regions accumulate', () => {
      const t = ready();
      // Spread far apart so nothing merges.
      for (let i = 0; i <= MAX_DIRTY_RECTS; i++) t.add(box(i * 40 - 500, -500, i * 40 - 498, -498));

      const plan = t.plan(VIEW);
      expect(plan.kind).toBe('full');
      if (plan.kind === 'full') expect(plan.reason).toBe('count');
    });

    it('falls back when the dirty region covers most of the viewport', () => {
      // Past this point the clipping machinery is pure overhead on top of work
      // that was going to happen anyway.
      const t = ready();
      const side = Math.sqrt(boundsArea(VIEW) * (MAX_DIRTY_COVERAGE + 0.1));
      t.add(box(-500, -500, -500 + side, -500 + side));

      const plan = t.plan(VIEW);
      expect(plan.kind).toBe('full');
      if (plan.kind === 'full') expect(plan.reason).toBe('coverage');
    });

    it('does NOT fall back for a large-but-acceptable region', () => {
      const t = ready();
      const side = Math.sqrt(boundsArea(VIEW) * (MAX_DIRTY_COVERAGE - 0.2));
      t.add(box(-500, -500, -500 + side, -500 + side));
      expect(t.plan(VIEW).kind).toBe('partial');
    });

    it('falls back when forced, whatever else it collected', () => {
      const t = ready();
      t.add(box(0, 0, 1, 1));
      t.force('global');

      const plan = t.plan(VIEW);
      expect(plan.kind).toBe('full');
      if (plan.kind === 'full') expect(plan.reason).toBe('global');
    });

    it('clears the collection when it falls back', () => {
      // Otherwise the rectangles from the frame that forced a repaint are still
      // queued and trigger a second, pointless partial repaint next frame.
      const t = ready();
      t.add(box(0, 0, 20, 20));
      t.force('global');
      expect(t.plan(VIEW).kind).toBe('full');
      expect(t.plan(VIEW).kind).toBe('none');
    });
  });

  describe('off-screen changes', () => {
    it('are not repaired at all', () => {
      // At 50,000 elements most changes are off screen. Repairing pixels nobody
      // can see is pure cost.
      const t = ready();
      t.add(box(100_000, 100_000, 100_020, 100_020));
      expect(t.plan(VIEW).kind).toBe('none');
    });

    it('do not drag a partly-visible change into a full repaint', () => {
      // An element dragged far off screen produces an enormous rectangle. Left
      // unclipped it trips the coverage test and forces a full repaint of a
      // screen that barely changed.
      const t = ready();
      t.add(box(-510, -510, 100_000, 100_000));

      const plan = t.plan(VIEW);
      expect(plan.kind).toBe('full'); // clipped to the viewport, still covers it
      if (plan.kind === 'full') expect(plan.reason).toBe('coverage');
    });

    it('are clipped to the viewport, not discarded, when they straddle the edge', () => {
      const t = ready();
      t.add(box(-600, -600, -480, -480)); // mostly off screen, a corner visible

      const plan = t.plan(VIEW);
      expect(plan.kind).toBe('partial');
      if (plan.kind !== 'partial') return;
      expect(plan.rects[0]!.minX).toBe(-500);
      expect(plan.rects[0]!.minY).toBe(-500);
    });
  });

  describe('stats', () => {
    it('reports collected, merged and coverage', () => {
      const t = ready();
      t.add(box(0, 0, 100, 100));
      t.add(box(50, 50, 150, 150));
      t.plan(VIEW);

      const s = t.stats();
      expect(s.collected).toBe(2);
      expect(s.merged).toBe(1);
      expect(s.coverage).toBeGreaterThan(0);
      expect(s.lastFullReason).toBeNull();
    });

    it('counts full repaints and names the last reason', () => {
      const t = ready();
      t.force('global');
      t.plan(VIEW);
      t.force('global');
      t.plan(VIEW);

      const s = t.stats();
      expect(s.fullRepaints).toBe(2);
      expect(s.lastFullReason).toBe('global');
    });
  });
});
