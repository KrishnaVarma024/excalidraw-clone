import { describe, expect, it } from 'vitest';
import {
  TAU,
  approxEq,
  clamp,
  degToRad,
  inverseLerp,
  lerp,
  makeRandom,
  normalizeAngle,
  radToDeg,
  roundTo,
  snapTo,
} from '@engine/util/math';

describe('clamp', () => {
  it('passes values inside the range through unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('clamps on both sides, inclusive of the bounds', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });
});

describe('lerp / inverseLerp', () => {
  it('hits both endpoints exactly', () => {
    // The naive `a + (b - a) * t` form fails this for some inputs. Ours does
    // not, which is the entire reason for the unusual implementation.
    expect(lerp(0.1, 0.3, 0)).toBe(0.1);
    expect(lerp(0.1, 0.3, 1)).toBe(0.3);
    expect(lerp(1e16, 1e16 + 2, 1)).toBe(1e16 + 2);
  });

  it('interpolates the midpoint', () => {
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it('round-trips through inverseLerp', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(approxEq(inverseLerp(3, 17, lerp(3, 17, t)), t)).toBe(true);
    }
  });

  it('returns 0 from inverseLerp on a degenerate range instead of NaN', () => {
    expect(inverseLerp(5, 5, 5)).toBe(0);
  });
});

describe('angles', () => {
  it('converts between degrees and radians', () => {
    expect(approxEq(degToRad(180), Math.PI)).toBe(true);
    expect(approxEq(radToDeg(Math.PI / 2), 90)).toBe(true);
  });

  it('normalises into [0, TAU)', () => {
    expect(approxEq(normalizeAngle(0), 0)).toBe(true);
    expect(approxEq(normalizeAngle(TAU), 0)).toBe(true);
    expect(approxEq(normalizeAngle(-Math.PI / 2), (3 * Math.PI) / 2)).toBe(true);
    expect(approxEq(normalizeAngle(5 * TAU + 1), 1)).toBe(true);
  });

  it('never returns a negative angle, for any input sign or magnitude', () => {
    for (const a of [-100, -TAU, -0.0001, 0, 0.0001, 100, 1e6]) {
      const n = normalizeAngle(a);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(TAU);
    }
  });
});

describe('approxEq', () => {
  it('accepts the classic floating-point failure case', () => {
    expect(0.1 + 0.2 === 0.3).toBe(false); // documents *why* this helper exists
    expect(approxEq(0.1 + 0.2, 0.3)).toBe(true);
  });

  it('still rejects genuinely different numbers', () => {
    expect(approxEq(1, 1.0001)).toBe(false);
  });
});

describe('roundTo / snapTo', () => {
  it('rounds to the nearest multiple', () => {
    expect(roundTo(7, 5)).toBe(5);
    expect(roundTo(8, 5)).toBe(10);
    expect(roundTo(-7, 5)).toBe(-5);
  });

  it('returns the input unchanged when step is 0 rather than producing NaN', () => {
    expect(roundTo(7, 0)).toBe(7);
  });

  it('snaps only within tolerance — magnetism, not a cage', () => {
    expect(snapTo(10.4, 10, 1)).toBe(10); // inside the pull
    expect(snapTo(14, 10, 1)).toBe(14); // outside it, left alone
  });
});

describe('makeRandom', () => {
  it('is deterministic for a given seed', () => {
    const a = makeRandom(12345);
    const b = makeRandom(12345);
    const seqA = Array.from({ length: 16 }, () => a());
    const seqB = Array.from({ length: 16 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces different streams for different seeds', () => {
    expect(makeRandom(1)()).not.toBe(makeRandom(2)());
  });

  it('stays in [0, 1)', () => {
    const rnd = makeRandom(0xdecaf);
    for (let i = 0; i < 10_000; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform — a weak but real distribution check', () => {
    // Not a serious statistical test. It is here to catch the specific bug
    // where a bit-twiddling mistake collapses the output into a narrow band,
    // which would show up as visibly repetitive rough.js jitter.
    const rnd = makeRandom(7);
    const buckets = new Array<number>(10).fill(0);
    const n = 100_000;
    for (let i = 0; i < n; i++) buckets[Math.floor(rnd() * 10)]! += 1;
    for (const count of buckets) {
      expect(count).toBeGreaterThan(n / 10 - n / 50);
      expect(count).toBeLessThan(n / 10 + n / 50);
    }
  });
});
