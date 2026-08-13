/**
 * Deterministic scene generator.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Phase 4 replaces an O(n) scan with a quadtree, and Phase 5 replaces full
 * repaint with dirty rectangles. Both are worth doing. Neither is worth
 * *claiming* without a before number.
 *
 * Almost every canvas project says "I used a quadtree and dirty rects for
 * performance." Very few can say *"the cull was 1.9 ms at 50,000 elements and
 * 0.02 ms after; here is the flamegraph."* This file is what makes the second
 * sentence possible, and the whole of Phase 3 exists to produce it.
 *
 * ── Why seeded, and exactly how far the determinism goes ────────────────────
 *
 * A benchmark you cannot reproduce is an anecdote. Same seed → same scene → two
 * measurements that differ only because of the change you made. `makeRandom`
 * (mulberry32) rather than `Math.random()`, for exactly the reason it was
 * written in Phase 0.
 *
 * The honest scope of that guarantee:
 *
 *   reproduced — position, size, type, rotation, style, z-order, and the
 *                rough.js `seed`. Every input that changes how long a frame
 *                takes.
 *   not reproduced — element `id`, which still comes from `crypto` in the
 *                factory.
 *
 * That split is deliberate rather than an oversight. `seed` decides the exact
 * hand-drawn wobble, which decides how many path segments rough.js emits, which
 * shows up directly in the `draw` stage — so leaving it random would put noise
 * inside the number being measured. `id` is pure identity: nothing downstream
 * reads it as a quantity, so making it deterministic would buy nothing and cost
 * the collision-resistance argument in `util/id.ts`.
 *
 * The rule worth taking away: **make it deterministic exactly where
 * non-determinism would move the measurement.**
 *
 * ── Why the distribution is deliberately uneven ─────────────────────────────
 *
 * A grid of identical rectangles is the easiest possible input and would
 * flatter every structure I am about to build. Real drawings are clustered —
 * dense diagrams with empty space between them — and have wildly varying
 * element sizes. Both matter:
 *
 *   - clustering is where a quadtree's advantage over a uniform grid shows up
 *   - size variance is where it *degrades*, because large elements straddle
 *     node boundaries and pile up in the parent (ARCHITECTURE §5.2)
 *
 * So `cluster` and `sizeVariance` are knobs, and Phase 4's adversarial exercise
 * turns them up until the quadtree loses.
 */

import { makeRandom } from '../util/math';
import type { Element, ElementStyle } from '../scene/element.types';
import { TRANSPARENT } from '../scene/element.types';
import {
  newDiamond,
  newEllipse,
  newFreedraw,
  newLinear,
  newRectangle,
} from '../scene/elementFactory';
import type { Point } from '../util/geometry';

export interface GenerateOptions {
  /** How many elements to create. */
  count: number;
  /** Half-width of the square region elements are scattered over, in scene units. */
  spread?: number;
  /**
   * 0 = uniform scatter, 1 = tight clusters with empty space between them.
   *
   * The interesting parameter. Real drawings cluster; uniform scatter is the
   * case that makes every spatial index look equally good.
   */
  cluster?: number;
  /**
   * 0 = every element the same size, 1 = sizes span three orders of magnitude.
   *
   * Turn this up in Phase 4 to find the quadtree's worst case: a few very large
   * elements straddle the root's centre, cannot be pushed into any child, and
   * turn every query into a linear scan of the root's item list.
   */
  sizeVariance?: number;
  /** Reproducibility. Same seed, same scene, byte for byte. */
  seed?: number;
  /** z-index of the first element; each subsequent one is +1. */
  startZ?: number;
}

const PALETTE = ['#1b1b1f', '#e03131', '#2f9e44', '#1971c2', '#f08c00'] as const;
const FILLS = [TRANSPARENT, '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99'] as const;

/**
 * Type mix, roughly matching what a real diagram contains.
 *
 * Weighted rather than uniform because the types do not cost the same:
 * freehand strokes are by far the most expensive to draw (perfect-freehand
 * rebuilds an outline polygon) and would dominate a uniform mix, making the
 * benchmark measure one code path rather than the renderer.
 */
const TYPE_WEIGHTS = [
  { type: 'rectangle', weight: 0.34 },
  { type: 'ellipse', weight: 0.2 },
  { type: 'diamond', weight: 0.08 },
  { type: 'arrow', weight: 0.16 },
  { type: 'line', weight: 0.12 },
  { type: 'freedraw', weight: 0.1 },
] as const;

/** Sum of weights, computed once so the picker is a single pass. */
const TOTAL_WEIGHT = TYPE_WEIGHTS.reduce((sum, t) => sum + t.weight, 0);

export interface GeneratedScene {
  elements: Element[];
  /** Everything needed to reproduce this exact scene. Goes in BASELINE.md. */
  descriptor: string;
}

export function generateScene(options: GenerateOptions): GeneratedScene {
  const {
    count,
    spread = 4000,
    cluster = 0.7,
    sizeVariance = 0.6,
    seed = 0x5eed,
    startZ = 1,
  } = options;

  const rnd = makeRandom(seed);
  const elements: Element[] = [];

  // Cluster centres: roughly one per 40 elements, so density is realistic at
  // every count rather than becoming a single blob at 50k.
  const clusterCount = Math.max(1, Math.round(count / 40));
  const centres: Point[] = Array.from({ length: clusterCount }, () => ({
    x: (rnd() - 0.5) * 2 * spread,
    y: (rnd() - 0.5) * 2 * spread,
  }));

  for (let i = 0; i < count; i++) {
    const centre = centres[Math.floor(rnd() * centres.length)]!;

    // Blend between "near a cluster centre" and "anywhere". `cluster = 0` gives
    // pure uniform scatter, `1` gives tight groups.
    const localRadius = spread * 0.06;
    const x =
      centre.x * cluster +
      (rnd() - 0.5) * 2 * spread * (1 - cluster) +
      (rnd() - 0.5) * 2 * localRadius * cluster;
    const y =
      centre.y * cluster +
      (rnd() - 0.5) * 2 * spread * (1 - cluster) +
      (rnd() - 0.5) * 2 * localRadius * cluster;

    // Log-uniform size, so `sizeVariance = 1` spans three orders of magnitude
    // rather than being merely "a bit bigger". Linear interpolation of the
    // *exponent* is what makes small and huge equally likely, which is what a
    // real document looks like — a 6px dot and a 600px frame.
    const magnitude = 10 ** (1 + (rnd() - 0.5) * 3 * sizeVariance);
    const width = magnitude * (0.6 + rnd() * 0.8);
    const height = magnitude * (0.6 + rnd() * 0.8);

    const style: ElementStyle = {
      strokeColor: PALETTE[Math.floor(rnd() * PALETTE.length)]!,
      backgroundColor: rnd() < 0.3 ? FILLS[1 + Math.floor(rnd() * (FILLS.length - 1))]! : TRANSPARENT,
      fillStyle: rnd() < 0.7 ? 'hachure' : 'solid',
      strokeWidth: [1, 2, 4][Math.floor(rnd() * 3)]!,
      strokeStyle: 'solid',
      roughness: rnd() < 0.8 ? 1 : 0,
      opacity: 100,
    };

    const common = {
      x,
      y,
      width,
      height,
      style,
      zIndex: startZ + i,
      // A fifth of elements rotated, because rotation is what makes render
      // bounds diverge from geometry bounds — and that divergence is exactly
      // what Phase 5's dirty rectangles have to cope with.
      angle: rnd() < 0.2 ? rnd() * Math.PI * 2 : 0,
    };

    // The factory mints a CSPRNG seed; overwrite it from our stream so the
    // rough.js wobble — and therefore the segment count, and therefore the draw
    // time — is identical run to run. See the header note on scope.
    const element = makeElement(pickType(rnd()), common, rnd);
    elements.push({ ...element, seed: Math.floor(rnd() * 0x1_0000_0000) });
  }

  return {
    elements,
    descriptor:
      `n=${count} spread=${spread} cluster=${cluster} ` +
      `sizeVariance=${sizeVariance} seed=0x${seed.toString(16)}`,
  };
}

function pickType(r: number): (typeof TYPE_WEIGHTS)[number]['type'] {
  let threshold = r * TOTAL_WEIGHT;
  for (const entry of TYPE_WEIGHTS) {
    threshold -= entry.weight;
    if (threshold <= 0) return entry.type;
  }
  return 'rectangle';
}

type Common = Parameters<typeof newRectangle>[0];

function makeElement(
  type: (typeof TYPE_WEIGHTS)[number]['type'],
  common: Common,
  rnd: () => number,
): Element {
  switch (type) {
    case 'rectangle':
      return newRectangle(common);
    case 'ellipse':
      return newEllipse(common);
    case 'diamond':
      return newDiamond(common);
    case 'line':
    case 'arrow':
      return newLinear({
        ...common,
        type,
        points: [
          { x: 0, y: 0 },
          { x: common.width, y: common.height },
        ],
      });
    case 'freedraw': {
      // A short wobbly stroke — 8–20 points, which is what an RDP-simplified
      // real stroke looks like rather than the 400 raw samples that produced it.
      const n = 8 + Math.floor(rnd() * 12);
      const points: Point[] = Array.from({ length: n }, (_, i) => ({
        x: (common.width * i) / (n - 1),
        y: common.height * (0.5 + Math.sin(i * 0.8) * 0.4) * (0.5 + rnd() * 0.5),
      }));
      return newFreedraw({
        ...common,
        points,
        pressures: points.map(() => 0.4 + rnd() * 0.4),
        simulatePressure: false,
      });
    }
    default:
      return newRectangle(common);
  }
}

/** Preset sizes for the dev panel. */
export const SCENE_PRESETS = [100, 1_000, 10_000, 50_000] as const;
