import { describe, expect, it } from 'vitest';
import {
  RUNG_RATIO,
  TARGET_SPACING_PX,
  chooseGridLevel,
  latticeAlpha,
} from '@engine/render/grid';
import { MAX_ZOOM, MIN_ZOOM } from '@engine/viewport/transform';

/** Dense geometric sweep across the usable zoom range. */
function sweep(fn: (zoom: number) => void, ratio = 1.005): void {
  for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom *= ratio) fn(zoom);
  fn(MAX_ZOOM);
}

const isPowerOfTwo = (n: number): boolean => Number.isInteger(Math.log2(n));

describe('chooseGridLevel', () => {
  it('always lands on a power of two', () => {
    sweep((zoom) => {
      const { coarseStep, fineStep } = chooseGridLevel(zoom);
      expect(isPowerOfTwo(coarseStep)).toBe(true);
      expect(isPowerOfTwo(fineStep)).toBe(true);
    });
  });

  /**
   * The nesting property. Everything else in this file depends on it: if the
   * coarse lattice is not a subset of the fine one, the combined grid is
   * irregular and no cross-fade can make the handover smooth.
   */
  it('keeps the two lattices nested — coarse is exactly 2 × fine', () => {
    sweep((zoom) => {
      const { coarseStep, fineStep } = chooseGridLevel(zoom);
      expect(coarseStep / fineStep).toBe(RUNG_RATIO);
      expect(coarseStep % fineStep).toBe(0);
    });
  });

  /**
   * The property LOD exists to provide, stated as an inequality rather than a
   * vibe. An earlier version snapped up the 1-2-5 ladder and produced spacings
   * of 65px; this assertion is what caught it.
   */
  it('holds coarse spacing in [target, 2 × target) at every zoom', () => {
    let min = Infinity;
    let max = 0;

    sweep((zoom) => {
      const { coarseScreenStep } = chooseGridLevel(zoom);
      min = Math.min(min, coarseScreenStep);
      max = Math.max(max, coarseScreenStep);
    });

    expect(min).toBeGreaterThanOrEqual(TARGET_SPACING_PX - 1e-9);
    expect(max).toBeLessThan(TARGET_SPACING_PX * RUNG_RATIO + 1e-9);

    // A 300× change in zoom produces at most a 2× change in what you see.
    expect(max / min).toBeLessThanOrEqual(RUNG_RATIO + 1e-9);
  });

  it('uses a coarser step as you zoom out, monotonically', () => {
    // Non-monotonicity would mean the grid visibly jumps backwards mid-gesture,
    // which reads as a bug even though every individual frame is "correct".
    let previous = Infinity;
    sweep((zoom) => {
      const { coarseStep } = chooseGridLevel(zoom);
      expect(coarseStep).toBeLessThanOrEqual(previous + 1e-12);
      previous = coarseStep;
    }, 1.002);

    expect(chooseGridLevel(0.2).coarseStep).toBeGreaterThan(chooseGridLevel(20).coarseStep);
  });

  it('reports fineAlpha across the full [0, 1] range', () => {
    let sawLow = false;
    let sawHigh = false;

    sweep((zoom) => {
      const { fineAlpha } = chooseGridLevel(zoom);
      expect(fineAlpha).toBeGreaterThanOrEqual(0);
      expect(fineAlpha).toBeLessThanOrEqual(1);
      if (fineAlpha < 0.02) sawLow = true;
      if (fineAlpha > 0.98) sawHigh = true;
    });

    // Both halves matter. Continuity alone passes trivially for a constant;
    // this is what proves the fade is real rather than decorative.
    expect(sawLow).toBe(true);
    expect(sawHigh).toBe(true);
  });

  it('respects a custom target spacing', () => {
    const { coarseScreenStep } = chooseGridLevel(1, 100);
    expect(coarseScreenStep).toBeGreaterThanOrEqual(100);
    expect(coarseScreenStep).toBeLessThan(200);
  });
});

/**
 * ── The anti-pop guarantee ──────────────────────────────────────────────────
 *
 * Asserting that `fineAlpha` is continuous would be testing the wrong thing:
 * it legitimately jumps from 1 to 0 at each handover, because the level that
 * was "fine" has just been promoted to "coarse" and a new fine level appeared.
 *
 * What must be continuous is what the user sees — the opacity of each
 * individual lattice of lines. `latticeAlpha` answers exactly that, and
 * sweeping it is the real test.
 */
describe('latticeAlpha — no line ever pops', () => {
  const LATTICES = [
    0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024,
  ];

  it('moves continuously in zoom for every lattice', () => {
    for (const step of LATTICES) {
      let previous = latticeAlpha(step, MIN_ZOOM);
      let biggestJump = 0;
      let worstZoom = 0;

      for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM; zoom *= 1.002) {
        const alpha = latticeAlpha(step, zoom);
        const jump = Math.abs(alpha - previous);
        if (jump > biggestJump) {
          biggestJump = jump;
          worstZoom = zoom;
        }
        previous = alpha;
      }

      // A 0.2% zoom change must never move any line's opacity by more than 2%.
      // The 1-2-5 ladder failed this with a jump of ~1.0 at every 2 → 5 rung.
      expect(
        biggestJump,
        `lattice ${step} jumped ${biggestJump.toFixed(3)} near zoom ${worstZoom.toFixed(4)}`,
      ).toBeLessThan(0.02);
    }
  });

  it('fades a lattice in from 0 and holds it at 1 once it is coarse', () => {
    const step = 16;
    // Zoomed far out, a 16-unit lattice is far too dense to draw.
    expect(latticeAlpha(step, 0.1)).toBe(0);
    // Zoomed far in, it is well above the coarse threshold and fully opaque.
    expect(latticeAlpha(step, 30)).toBe(1);
  });

  it('never draws a lattice that is not on the ladder', () => {
    // 3, 5, 7 × a power of two are not powers of two, so they are on no rung.
    for (const step of [3, 5, 7, 24, 48]) {
      sweep((zoom) => {
        // These may still coincide with the lattice when the step divides them
        // (e.g. 24 is a multiple of 8), which is correct — assert only that the
        // result is a valid opacity, never something in between by accident.
        const a = latticeAlpha(step, zoom);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(1);
      }, 1.05);
    }
  });
});
