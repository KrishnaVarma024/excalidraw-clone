/**
 * Scalar maths primitives.
 *
 * Everything here is a pure function of numbers. No DOM, no canvas, no state.
 * That is why `tests/engine/math.test.ts` runs in plain Node in ~5 ms.
 */

/** Clamp `v` into `[min, max]`. Assumes `min <= max`. */
export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** Linear interpolation. `t = 0` returns `a`, `t = 1` returns `b`. Not clamped. */
export function lerp(a: number, b: number, t: number): number {
  // `a + (b - a) * t` is the textbook form but it is not monotonic near t = 1
  // and does not guarantee lerp(a, b, 1) === b in floating point. This form does.
  return a * (1 - t) + b * t;
}

/** Inverse of {@link lerp}: where does `v` sit between `a` and `b`? */
export function inverseLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export const TAU = Math.PI * 2;

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/**
 * Fold an angle into `[0, 2π)`.
 *
 * Rotation gestures accumulate deltas, so after enough spinning `angle` drifts
 * to values like `-47.12` or `133.7`. Those still *render* correctly (sin and
 * cos are periodic), but they serialise badly, compare badly, and make
 * "is this element rotated?" checks awkward. Normalise on commit.
 */
export function normalizeAngle(rad: number): number {
  const m = rad % TAU;
  return m < 0 ? m + TAU : m;
}

/**
 * Floating-point equality with an absolute tolerance.
 *
 * Never write `a === b` for coordinates. `0.1 + 0.2 !== 0.3`, and every
 * screen↔scene round-trip does a multiply and a divide.
 *
 * Absolute (not relative) epsilon is the right call here because our numbers
 * live in a bounded, known range — scene coordinates measured in pixels-ish
 * units. A relative epsilon would be correct for a general numerics library
 * and overkill for this one.
 */
export function approxEq(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) <= epsilon;
}

/** Round `v` to the nearest multiple of `step`. `roundTo(7, 5) === 5`. */
export function roundTo(v: number, step: number): number {
  if (step === 0) return v;
  return Math.round(v / step) * step;
}

/**
 * Snap `v` to the nearest multiple of `step`, but only if it is already within
 * `tolerance` of one. Otherwise leave it alone.
 *
 * This is the shape every good snapping feature has: snapping should feel like
 * magnetism near a target, not like a grid you cannot escape.
 */
export function snapTo(v: number, step: number, tolerance: number): number {
  const snapped = roundTo(v, step);
  return Math.abs(v - snapped) <= tolerance ? snapped : v;
}

/**
 * Deterministic pseudo-random number generator (mulberry32).
 *
 * `Math.random()` cannot be seeded, which makes it unusable for us: Rough.js
 * needs the *same* jitter every time it redraws an element, or shapes shimmer
 * as you pan. Each element stores a `seed`; this turns that seed into a
 * repeatable stream.
 *
 * The same property is what makes deterministic export possible (Phase 9) and
 * therefore what makes visual-regression testing possible (Phase 10). One
 * 8-line function, three downstream capabilities.
 *
 * @returns a function producing values in `[0, 1)`
 */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
