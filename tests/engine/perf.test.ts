import { describe, expect, it } from 'vitest';
import { FrameTimer, percentileOfSorted } from '@engine/util/perf';

describe('percentileOfSorted', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1); // 1…100

  it('computes nearest-rank percentiles', () => {
    expect(percentileOfSorted(sorted, 0.5)).toBe(50);
    expect(percentileOfSorted(sorted, 0.95)).toBe(95);
    expect(percentileOfSorted(sorted, 1)).toBe(100);
  });

  it('returns a value that actually occurred', () => {
    // Nearest-rank rather than interpolated, deliberately: every number this
    // reports is a frame that really happened, which matters when the number
    // is about to be quoted in a README.
    const odd = [3, 7, 11];
    expect(odd).toContain(percentileOfSorted(odd, 0.5));
    expect(odd).toContain(percentileOfSorted(odd, 0.9));
  });

  it('handles the empty and single-element cases', () => {
    expect(percentileOfSorted([], 0.5)).toBe(0);
    expect(percentileOfSorted([42], 0.95)).toBe(42);
  });

  it('clamps q outside [0, 1] instead of reading out of bounds', () => {
    expect(percentileOfSorted(sorted, 0)).toBe(1);
    expect(percentileOfSorted(sorted, 2)).toBe(100);
  });
});

describe('FrameTimer', () => {
  it('reports zeroes before any samples', () => {
    expect(new FrameTimer().stats()).toEqual({ fps: 0, p50: 0, p95: 0, max: 0, samples: 0 });
  });

  it('measures duration and interval separately', () => {
    const t = new FrameTimer();
    // Frames start every 16ms and each takes 4ms of work.
    for (let i = 0; i < 60; i++) t.record(i * 16, i * 16 + 4);

    const s = t.stats();
    expect(s.p50).toBeCloseTo(4, 6);
    expect(s.fps).toBeCloseTo(1000 / 16, 3);
  });

  it('separates "how long we worked" from "how often we ran"', () => {
    // A throttled background tab: tiny durations, enormous intervals. Reporting
    // 60fps here because the work was fast would be actively misleading.
    const t = new FrameTimer();
    for (let i = 0; i < 30; i++) t.record(i * 1000, i * 1000 + 2);

    const s = t.stats();
    expect(s.p50).toBeCloseTo(2, 6);
    expect(s.fps).toBeCloseTo(1, 3);
  });

  it('shows why the mean is the wrong statistic', () => {
    const t = new FrameTimer();
    for (let i = 0; i < 99; i++) t.record(i * 16, i * 16 + 4); // 99 good frames
    t.record(99 * 16, 99 * 16 + 300); // one 300ms stall

    const s = t.stats();
    const mean = (99 * 4 + 300) / 100; // ≈ 6.96ms — looks fine

    expect(mean).toBeLessThan(8);
    expect(s.p50).toBeCloseTo(4, 6);
    expect(s.max).toBeCloseTo(300, 6);
    // p95 catches nothing here (1 bad frame in 100), but max does — which is
    // exactly why the overlay shows p50, p95 AND max rather than picking one.
    expect(s.p95).toBeCloseTo(4, 6);
  });

  it('surfaces sustained jank in p95', () => {
    const t = new FrameTimer();
    for (let i = 0; i < 90; i++) t.record(i * 16, i * 16 + 4);
    for (let i = 90; i < 100; i++) t.record(i * 16, i * 16 + 40); // 10% bad

    expect(t.stats().p95).toBeCloseTo(40, 6);
  });

  it('evicts oldest samples once the ring buffer wraps', () => {
    const t = new FrameTimer(10);
    for (let i = 0; i < 10; i++) t.record(i * 16, i * 16 + 100); // slow window
    expect(t.stats().p50).toBeCloseTo(100, 6);

    for (let i = 10; i < 20; i++) t.record(i * 16, i * 16 + 2); // fast window
    const s = t.stats();
    expect(s.samples).toBe(10);
    expect(s.p50).toBeCloseTo(2, 6);
    expect(s.max).toBeCloseTo(2, 6); // the slow frames are genuinely gone
  });

  it('does not report a bogus interval after a pause', () => {
    const t = new FrameTimer();
    t.record(0, 4);
    t.resetInterval(); // the loop stopped; the tab was hidden for a minute
    t.record(60_000, 60_004);
    // The 60-second gap must not be recorded as a frame interval, or fps
    // collapses to ~0 for the next four seconds of perfectly good frames.
    expect(t.stats().fps).toBe(0);
  });

  it('resets cleanly', () => {
    const t = new FrameTimer();
    for (let i = 0; i < 50; i++) t.record(i * 16, i * 16 + 9);
    t.reset();
    expect(t.stats().samples).toBe(0);
  });
});
