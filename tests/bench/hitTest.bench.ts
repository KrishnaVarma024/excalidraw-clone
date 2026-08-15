/**
 * Hit testing: the operation the index was really built for.
 *
 * ── Why this benchmark matters more than the cull one ───────────────────────
 *
 * The render cull runs once per *frame* — 60 Hz at most, and only when something
 * changed. This runs once per `pointermove`, which a trackpad emits at
 * **120–240 Hz**, and it runs whether or not anything changed, because its
 * answer decides the cursor and the hover highlight.
 *
 * So the budget is not 16.67 ms. At 240 Hz the whole event budget is ~4 ms, and
 * hit testing is only one thing happening in it. A 30 ms hit test does not make
 * the app feel slow; it makes the pointer stop moving.
 *
 * ── What the comparison is ──────────────────────────────────────────────────
 *
 * `linear scan` is what this would be without Phase 4a: an exact geometry test
 * on every element in the document, in reverse z-order. It is not a strawman —
 * it is the obvious implementation, and it is what the app did until this phase.
 *
 *     npm run bench
 */

import { bench, describe } from 'vitest';
import { Scene } from '@engine/scene/Scene';
import { SCENE_PRESETS, generateScene } from '@engine/dev/generateScene';
import { hitTestElement } from '@engine/scene/hitTest';
import type { Point } from '@engine/util/geometry';

/** 10 screen px at 100% zoom — what `Engine` passes in practice. */
const THRESHOLD = 10;

/** Middle of the drawing, where there is plenty to hit. */
const BUSY: Point = { x: 0, y: 0 };

/** Empty space. The worst case: every candidate is rejected. */
const EMPTY: Point = { x: 250_000, y: 250_000 };

const scenes = new Map<number, Scene>(
  SCENE_PRESETS.map((n) => {
    const scene = new Scene();
    scene.load(generateScene({ count: n, seed: 0x5eed + n }).elements);
    scene.sorted(); // prime the z-sort cache, as a running app would have
    return [n, scene];
  }),
);

/** What the app did before Phase 4a. Reverse z-order, exact test, no index. */
function linearHitTest(scene: Scene, point: Point): string | null {
  const all = scene.sorted();
  for (let i = all.length - 1; i >= 0; i--) {
    const el = all[i]!;
    if (hitTestElement(el, point, THRESHOLD)) return el.id;
  }
  return null;
}

describe('hit test in a busy area', () => {
  for (const n of SCENE_PRESETS) {
    bench(`index · ${n.toLocaleString()} elements`, () => {
      scenes.get(n)!.hitTest(BUSY, THRESHOLD);
    });
  }
});

describe('hit test in a busy area — linear scan, for comparison', () => {
  for (const n of SCENE_PRESETS) {
    bench(`scan · ${n.toLocaleString()} elements`, () => {
      linearHitTest(scenes.get(n)!, BUSY);
    });
  }
});

describe('hit test on empty canvas — the worst case', () => {
  // Nothing is hit, so the linear scan cannot exit early and must test every
  // element. This is the configuration that decides whether moving the mouse
  // over blank space is free or catastrophic, and it is the one people forget to
  // measure because "nothing happened".
  for (const n of SCENE_PRESETS) {
    bench(`index · ${n.toLocaleString()} elements`, () => {
      scenes.get(n)!.hitTest(EMPTY, THRESHOLD);
    });
  }
});

describe('hit test on empty canvas — linear scan, for comparison', () => {
  for (const n of SCENE_PRESETS) {
    bench(`scan · ${n.toLocaleString()} elements`, () => {
      linearHitTest(scenes.get(n)!, EMPTY);
    });
  }
});
