/**
 * Frame timing.
 *
 * ── Why percentiles and not an average ──────────────────────────────────────
 *
 * Mean frame time is close to useless for judging whether something feels
 * smooth. Sixty frames at 4 ms and one at 300 ms averages to 8.8 ms — which
 * reads as "comfortably inside budget" while the user saw an obvious hitch.
 * Jank lives entirely in the tail, so the tail is what we measure: p50 for
 * "what it usually costs", p95 for "what it costs when it goes wrong", and max
 * because a single 300 ms frame is a bug report waiting to happen.
 *
 * ── Why a ring buffer ───────────────────────────────────────────────────────
 *
 * This runs every frame, forever. A growing array would allocate and eventually
 * trigger GC — and a GC pause lands *inside* the thing being measured, so a
 * naive profiler manufactures the jank it is trying to detect. A fixed
 * Float64Array allocated once has zero steady-state allocation.
 *
 * Percentiles need a sort, which is O(n log n) — so it is computed on demand
 * (four times a second, for the overlay) rather than per frame.
 */

const DEFAULT_CAPACITY = 240; // ~4 seconds at 60fps

export interface FrameStats {
  /**
   * Renders per second, from the mean interval between *recorded* frames.
   *
   * Not "frames per second": the loop skips frames entirely when nothing is
   * dirty, and those are never recorded. So an idle canvas reports a number
   * near zero, which is the correct and useful reading — it means no work is
   * being done, not that the app is stuttering. The overlay labels it
   * `renders/s` for exactly this reason.
   */
  readonly fps: number;
  /** Median frame duration, ms. */
  readonly p50: number;
  /** 95th-percentile frame duration, ms. */
  readonly p95: number;
  /** Worst frame in the window, ms. */
  readonly max: number;
  /** Number of samples currently in the window. */
  readonly samples: number;
}

const EMPTY: FrameStats = { fps: 0, p50: 0, p95: 0, max: 0, samples: 0 };

export class FrameTimer {
  private readonly durations: Float64Array;
  private readonly intervals: Float64Array;
  private readonly capacity: number;

  private cursor = 0;
  private filled = 0;
  private lastFrameStart = 0;

  /** Scratch buffer for percentile sorting — allocated once, reused. */
  private readonly scratch: Float64Array;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = capacity;
    this.durations = new Float64Array(capacity);
    this.intervals = new Float64Array(capacity);
    this.scratch = new Float64Array(capacity);
  }

  /**
   * Record one frame.
   *
   * @param frameStart timestamp at the top of the frame (the rAF argument)
   * @param frameEnd   timestamp after all drawing for this frame is done
   */
  record(frameStart: number, frameEnd: number): void {
    this.durations[this.cursor] = frameEnd - frameStart;

    // Interval between frame starts, which is what fps actually measures.
    // Duration measures how long we spent working; interval measures how often
    // we got to work. They differ whenever the browser throttles us — a
    // background tab has tiny durations and 1000 ms intervals.
    this.intervals[this.cursor] = this.lastFrameStart === 0 ? 0 : frameStart - this.lastFrameStart;
    this.lastFrameStart = frameStart;

    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.filled < this.capacity) this.filled++;
  }

  /** Call when rendering pauses, so the next frame does not log a huge interval. */
  resetInterval(): void {
    this.lastFrameStart = 0;
  }

  stats(): FrameStats {
    const n = this.filled;
    if (n === 0) return EMPTY;

    // Copy into the scratch buffer and sort — `durations` must stay in
    // insertion order because it is a ring buffer.
    const view = this.scratch.subarray(0, n);
    view.set(this.durations.subarray(0, n));
    view.sort();

    let intervalSum = 0;
    let intervalCount = 0;
    for (let i = 0; i < n; i++) {
      const iv = this.intervals[i]!;
      if (iv > 0) {
        intervalSum += iv;
        intervalCount++;
      }
    }

    return {
      fps: intervalCount === 0 ? 0 : 1000 / (intervalSum / intervalCount),
      p50: percentileOfSorted(view, 0.5),
      p95: percentileOfSorted(view, 0.95),
      max: view[n - 1]!,
      samples: n,
    };
  }

  reset(): void {
    this.cursor = 0;
    this.filled = 0;
    this.lastFrameStart = 0;
  }
}

/**
 * Nearest-rank percentile over an already-sorted array.
 *
 * No interpolation between neighbours. With 240 samples the difference is
 * noise, and nearest-rank has the property that every value it returns is a
 * frame that actually happened — which matters when you are about to quote the
 * number in a README.
 */
export function percentileOfSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = Math.ceil(q * n);
  const index = Math.min(Math.max(rank - 1, 0), n - 1);
  return sorted[index]!;
}

/**
 * Monotonic clock.
 *
 * `performance.now()` is monotonic and sub-millisecond; `Date.now()` is neither
 * and can jump backwards when the system clock is adjusted, producing negative
 * frame durations. Falls back only where `performance` is genuinely absent.
 */
export const now: () => number =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/* ── Stage timing ─────────────────────────────────────────────────────────── */

/**
 * The regions of a frame worth measuring separately.
 *
 * "The frame takes 40 ms" is not actionable. "The cull takes 38 ms of the 40"
 * points at exactly one function. Splitting the frame is the difference between
 * knowing you have a problem and knowing where it is.
 */
export type StageName = 'cull' | 'grid' | 'draw' | 'interactive';

export const STAGE_NAMES: readonly StageName[] = ['cull', 'grid', 'draw', 'interactive'];

export type StageTimings = Readonly<Record<StageName, number>>;

export const ZERO_STAGES: StageTimings = { cull: 0, grid: 0, draw: 0, interactive: 0 };

/**
 * Per-stage frame timing, with optional User Timing marks.
 *
 * ── Why begin/end rather than `time(stage, fn)` ─────────────────────────────
 *
 * The closure form reads better:
 *
 *     timer.time('cull', () => scene.visible(view))
 *
 * …but it allocates a closure per stage per frame — four allocations every
 * 16 ms, forever. Small, and also exactly the kind of steady garbage that turns
 * into a GC pause landing *inside* the measurement. An instrument should not
 * manufacture the thing it is measuring.
 *
 * ── Why User Timing marks are opt-in ────────────────────────────────────────
 *
 * `performance.mark`/`measure` put named regions in the Chrome DevTools
 * performance flamegraph, which is the fastest way to see where a frame went.
 * They also allocate a `PerformanceEntry` per call and are retained until
 * cleared, so leaving them on permanently costs more than the stages do. Off by
 * default; the dev panel turns them on for the length of a trace.
 */
export class StageTimer {
  private readonly accum: Record<StageName, number> = { ...ZERO_STAGES };
  private readonly startedAt: Record<StageName, number> = { ...ZERO_STAGES };
  private marksEnabled = false;

  /** Enable `performance.mark`/`measure`. Only while actively recording a trace. */
  setMarksEnabled(enabled: boolean): void {
    this.marksEnabled = enabled;
    if (!enabled && supportsUserTiming()) {
      // Entries accumulate in the performance buffer until cleared, and a long
      // session with marks left on eventually evicts its own earlier entries —
      // silently, so the part of the trace you wanted is the part that is gone.
      performance.clearMarks();
      performance.clearMeasures();
    }
  }

  get isMarking(): boolean {
    return this.marksEnabled;
  }

  /** Zero the accumulators. Called at the top of each frame. */
  reset(): void {
    for (const stage of STAGE_NAMES) this.accum[stage] = 0;
  }

  begin(stage: StageName): void {
    this.startedAt[stage] = now();
    if (this.marksEnabled && supportsUserTiming()) performance.mark(`${stage}:start`);
  }

  end(stage: StageName): void {
    // `+=` rather than `=`: a stage can legitimately run more than once in a
    // frame, and the total is what matters, not the last occurrence.
    this.accum[stage] += now() - this.startedAt[stage];

    if (this.marksEnabled && supportsUserTiming()) {
      performance.mark(`${stage}:end`);
      try {
        performance.measure(stage, `${stage}:start`, `${stage}:end`);
      } catch {
        // A missing start mark throws. Not worth failing a frame over — the
        // measurement is diagnostic; the rendering is not.
      }
    }
  }

  read(): StageTimings {
    return { ...this.accum };
  }
}

function supportsUserTiming(): boolean {
  return typeof performance !== 'undefined' && typeof performance.mark === 'function';
}
