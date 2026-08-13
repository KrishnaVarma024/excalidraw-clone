import { describe, expect, it } from 'vitest';
import { SCENE_PRESETS, generateScene } from '@engine/dev/generateScene';
import type { Element } from '@engine/scene/element.types';
import { getRenderBounds } from '@engine/scene/bounds';

/**
 * Everything about an element that affects what it costs to cull, draw or
 * index — which is everything except its identity.
 *
 * `id` is deliberately excluded: it comes from `crypto` in the factory and is
 * not reproducible, by design (see the header note in generateScene.ts). If this
 * fingerprint ever needs `id` to be stable, the design has changed and this test
 * should be the thing that says so.
 */
function fingerprint(elements: readonly Element[]): string {
  return JSON.stringify(
    elements.map(({ id: _id, ...rest }) => rest),
    (_key, value: unknown) => (typeof value === 'number' ? Number(value.toFixed(9)) : value),
  );
}

describe('generateScene', () => {
  describe('determinism', () => {
    /**
     * The load-bearing property of the whole phase. A before/after measurement
     * across two different scenes measures the scenes, not the change.
     */
    it('produces the same scene from the same seed', () => {
      const a = generateScene({ count: 300, seed: 1234 });
      const b = generateScene({ count: 300, seed: 1234 });
      expect(fingerprint(a.elements)).toBe(fingerprint(b.elements));
    });

    it('produces a different scene from a different seed', () => {
      const a = generateScene({ count: 300, seed: 1234 });
      const b = generateScene({ count: 300, seed: 1235 });
      expect(fingerprint(a.elements)).not.toBe(fingerprint(b.elements));
    });

    it('reproduces the rough.js seed, because it changes what a frame costs', () => {
      // `seed` decides the hand-drawn wobble, which decides how many path
      // segments rough.js emits, which lands in the `draw` stage. Left random it
      // would be noise inside the number being measured.
      const a = generateScene({ count: 50, seed: 7 });
      const b = generateScene({ count: 50, seed: 7 });
      expect(a.elements.map((e) => e.seed)).toEqual(b.elements.map((e) => e.seed));
    });

    it('does NOT reproduce ids, and that is the intended scope', () => {
      const a = generateScene({ count: 50, seed: 7 });
      const b = generateScene({ count: 50, seed: 7 });
      expect(a.elements.map((e) => e.id)).not.toEqual(b.elements.map((e) => e.id));
    });

    it('carries every parameter needed to reproduce it in the descriptor', () => {
      // A number in a README with no scene description attached cannot be
      // checked by anyone, including its author six weeks later.
      const { descriptor } = generateScene({
        count: 1000,
        spread: 2500,
        cluster: 0.3,
        sizeVariance: 0.9,
        seed: 0xabc,
      });
      expect(descriptor).toContain('n=1000');
      expect(descriptor).toContain('spread=2500');
      expect(descriptor).toContain('cluster=0.3');
      expect(descriptor).toContain('sizeVariance=0.9');
      expect(descriptor).toContain('seed=0xabc');
    });
  });

  describe('shape of the output', () => {
    it('creates exactly `count` elements', () => {
      for (const n of [0, 1, 37, 1000]) {
        expect(generateScene({ count: n }).elements).toHaveLength(n);
      }
    });

    it('assigns strictly increasing z-index from startZ', () => {
      const { elements } = generateScene({ count: 200, startZ: 41 });
      expect(elements[0]!.zIndex).toBe(41);
      for (let i = 1; i < elements.length; i++) {
        expect(elements[i]!.zIndex).toBe(elements[i - 1]!.zIndex + 1);
      }
    });

    it('never emits NaN, Infinity or a negative size', () => {
      // A single NaN coordinate poisons every bounds union it touches and turns
      // the whole scene invisible — with no error anywhere. Cheap to assert,
      // extremely annoying to debug.
      const { elements } = generateScene({ count: 2000, sizeVariance: 1 });
      for (const el of elements) {
        for (const v of [el.x, el.y, el.width, el.height, el.angle]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(el.width).toBeGreaterThan(0);
        expect(el.height).toBeGreaterThan(0);

        const b = getRenderBounds(el);
        expect(Number.isFinite(b.minX)).toBe(true);
        expect(b.maxX).toBeGreaterThanOrEqual(b.minX);
      }
    });

    it('produces every element type in a large enough sample', () => {
      // A benchmark that silently only exercises rectangles measures one code
      // path and calls it a renderer.
      const { elements } = generateScene({ count: 3000 });
      const types = new Set(elements.map((e) => e.type));
      expect([...types].sort()).toEqual([
        'arrow',
        'diamond',
        'ellipse',
        'freedraw',
        'line',
        'rectangle',
      ]);
    });

    it('keeps freehand points and pressures in lockstep', () => {
      const { elements } = generateScene({ count: 1500 });
      const strokes = elements.filter((e) => e.type === 'freedraw');
      expect(strokes.length).toBeGreaterThan(0);
      for (const s of strokes) {
        expect(s.pressures).toHaveLength(s.points.length);
        expect(s.points.length).toBeGreaterThanOrEqual(8);
      }
    });

    it('rotates roughly a fifth of elements', () => {
      // Rotation is what makes render bounds diverge from geometry bounds, and
      // that divergence is exactly what Phase 5's dirty rectangles must cope
      // with. A benchmark with no rotated elements would hide the hard case.
      const { elements } = generateScene({ count: 4000 });
      const rotated = elements.filter((e) => e.angle !== 0).length;
      expect(rotated / elements.length).toBeGreaterThan(0.12);
      expect(rotated / elements.length).toBeLessThan(0.28);
    });
  });

  describe('the knobs actually do something', () => {
    /** Number of distinct 200×200 cells the scene occupies — a density proxy. */
    function occupiedCells(elements: readonly Element[]): number {
      const cells = new Set<string>();
      for (const el of elements) {
        cells.add(`${Math.floor(el.x / 200)},${Math.floor(el.y / 200)}`);
      }
      return cells.size;
    }

    it('cluster=1 concentrates elements; cluster=0 scatters them', () => {
      // This is the parameter that matters for Phase 4. A uniform scatter makes
      // every spatial index look equally good; clustering is where a quadtree's
      // adaptive subdivision beats a uniform grid — and where its worst case
      // lives.
      const uniform = generateScene({ count: 2000, cluster: 0, seed: 9 });
      const clustered = generateScene({ count: 2000, cluster: 1, seed: 9 });

      expect(occupiedCells(clustered.elements)).toBeLessThan(
        occupiedCells(uniform.elements) * 0.6,
      );
    });

    it('sizeVariance=0 gives near-uniform sizes; =1 spans orders of magnitude', () => {
      const flat = generateScene({ count: 1500, sizeVariance: 0, seed: 5 });
      const wild = generateScene({ count: 1500, sizeVariance: 1, seed: 5 });

      const ratio = (els: readonly Element[]) => {
        const w = els.map((e) => e.width);
        return Math.max(...w) / Math.min(...w);
      };

      expect(ratio(flat.elements)).toBeLessThan(4);
      // Large elements straddling node boundaries are the quadtree's documented
      // worst case (ARCHITECTURE §5.2). Phase 4's adversarial exercise turns
      // this knob up until the structure loses, so it has to bite.
      expect(ratio(wild.elements)).toBeGreaterThan(100);
    });
  });

  it('exposes presets in ascending order, ending at a size that hurts', () => {
    expect([...SCENE_PRESETS]).toEqual([...SCENE_PRESETS].sort((a, b) => a - b));
    expect(SCENE_PRESETS.at(-1)).toBe(50_000);
  });
});
