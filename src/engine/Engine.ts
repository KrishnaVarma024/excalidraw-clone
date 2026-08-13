/**
 * The engine. Owns the render loop and everything below it.
 *
 * This is the seam. React constructs one of these, hands it a canvas, and from
 * that point talks to it only through:
 *
 *   subscribe(fn) / getSnapshot()   ← discrete state, via useSyncExternalStore
 *   addFrameListener(fn)            ← per-frame numbers, written straight to DOM
 *   dispatch-style methods          ← zoomIn(), resetZoom(), …
 *
 * ── Why two notification channels ───────────────────────────────────────────
 *
 * This is the design decision in this file, and it is not obvious.
 *
 * `useSyncExternalStore` is React's correct answer for external state, and we
 * use it — but it re-renders on every notification. That is right for state
 * that changes *discretely*: the active tool, the stroke colour, whether undo
 * is available. A few dozen renders a minute.
 *
 * It is wrong for state that changes *continuously*: fps, frame time, and the
 * zoom percentage during a pinch gesture. Those change every frame. Routing
 * them through the store means 60 React renders per second — precisely the cost
 * this entire architecture exists to avoid.
 *
 * So there are two channels, chosen by how the value behaves rather than by
 * what it is:
 *
 *   discrete  → subscribe/getSnapshot → React re-renders → JSX
 *   continuous → addFrameListener     → component writes textContent via a ref
 *
 * The second one looks like cheating. It is not: it is the same technique
 * React's own docs describe for "values that change too fast to render", and it
 * is why the stats overlay can update 4× a second and the zoom readout can
 * track a pinch smoothly while React's profiler shows a flat zero.
 *
 * Zoom appears in *both*, deliberately. The snapshot carries the rounded
 * integer percentage and only notifies when that integer changes, so a smooth
 * pinch from 100% to 103% produces three renders rather than ninety.
 */

import { Renderer, type RenderStats, type Theme, DARK_THEME, LIGHT_THEME } from './render/Renderer';
import { ViewportInput } from './input/ViewportInput';
import { Viewport } from './viewport/Viewport';
import { FrameTimer, type FrameStats, now } from './util/perf';
import type { Bounds } from './util/geometry';

/** Discrete state React renders from. Changes rarely. */
export interface EngineSnapshot {
  /** Zoom as a whole-number percentage. 1.0 → 100. */
  readonly zoomPercent: number;
  readonly canZoomIn: boolean;
  readonly canZoomOut: boolean;
  /** True while space is held or a pan drag is in progress — drives the cursor. */
  readonly panAffordance: boolean;
}

/** Per-frame numbers. Delivered outside React. */
export interface FrameInfo {
  readonly stats: FrameStats;
  readonly zoom: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly gridLines: number;
  /** Frames skipped because nothing changed. High is good. */
  readonly idleFrames: number;
}

export class Engine {
  readonly viewport = new Viewport();

  private readonly renderer: Renderer;
  private readonly input: ViewportInput;
  private readonly timer = new FrameTimer();

  private rafId: number | null = null;
  private running = false;

  /**
   * Set when something has changed that requires a repaint.
   *
   * Starts true so the first frame draws. An idle canvas sets this false and
   * the loop then does nothing per frame but re-schedule itself — no clear, no
   * draw, no allocation. On a laptop that is the difference between an idle tab
   * costing ~0% CPU and ~8%, which is the difference between a tool people
   * leave open and one they close.
   */
  private needsRender = true;
  private idleFrames = 0;

  /**
   * Stats from the most recent frame that actually drew.
   *
   * Held rather than recomputed because `emitFrameInfo` runs on idle frames
   * too — and reporting zero on those made the overlay read "grid lines: 0"
   * permanently, since idle frames vastly outnumber rendered ones. The first
   * version of this file had exactly that bug, and it looked like a rendering
   * failure rather than a reporting one.
   */
  private lastRenderStats: RenderStats = { gridLines: 0 };

  private readonly listeners = new Set<() => void>();
  private readonly frameListeners = new Set<(info: FrameInfo) => void>();

  /**
   * The snapshot object handed to React.
   *
   * MUST be referentially stable between notifications. `useSyncExternalStore`
   * compares successive `getSnapshot()` results with `Object.is`; returning a
   * fresh object literal each call means "changed" is always true, React
   * re-renders, calls getSnapshot again, sees another new object, and the app
   * locks up in an infinite render loop. This field is the cached result and it
   * is replaced only inside `refreshSnapshot()`.
   */
  private snapshot: EngineSnapshot = {
    zoomPercent: 100,
    canZoomIn: true,
    canZoomOut: true,
    panAffordance: false,
  };

  private panAffordance = false;
  private lastFrameEmit = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    theme: Theme = LIGHT_THEME,
  ) {
    const ctx = canvas.getContext('2d', {
      // We paint an opaque background every frame, so tell the compositor it
      // never has to blend this canvas with what is behind it. Measurably
      // cheaper on large surfaces, and it also disables subpixel-antialiasing
      // surprises on text later.
      alpha: false,
    });
    if (ctx === null) {
      throw new Error(
        'Could not acquire a 2D canvas context. This can happen in hardened ' +
          'browser configurations or headless environments without a GPU.',
      );
    }

    this.renderer = new Renderer(ctx);
    this.renderer.setTheme(theme);

    this.input = new ViewportInput(canvas, this.viewport, {
      onChange: () => this.markDirty(),
      onPanStateChange: ({ spaceHeld, panning }) => {
        const next = spaceHeld || panning;
        if (next === this.panAffordance) return;
        this.panAffordance = next;
        this.refreshSnapshot();
      },
    });
  }

  /* ── lifecycle ──────────────────────────────────────────────────────────── */

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.resetInterval();
    this.rafId = requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  destroy(): void {
    this.stop();
    this.input.destroy();
    this.listeners.clear();
    this.frameListeners.clear();
  }

  /* ── the loop ───────────────────────────────────────────────────────────── */

  private loop = (frameStart: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    if (!this.needsRender) {
      this.idleFrames++;
      // Still emit occasionally so the overlay does not look frozen — but do no
      // drawing work at all, and report the *last* render's stats rather than
      // zeroes, which would otherwise be all anyone ever saw.
      this.emitFrameInfo(frameStart);
      return;
    }

    this.needsRender = false;
    this.lastRenderStats = this.renderer.render(this.viewport);
    const frameEnd = now();
    this.timer.record(frameStart, frameEnd);
    this.emitFrameInfo(frameStart);
  };

  /**
   * Request a repaint on the next frame.
   *
   * Note what this does *not* do: draw. A pan gesture emitting 200
   * `pointermove` events between two frames calls this 200 times; the canvas is
   * painted once. Coalescing input into frames is what rAF is for, and doing
   * the work inside the event handler instead is the single most common reason
   * canvas apps feel worse than they should.
   */
  markDirty(): void {
    this.needsRender = true;
    this.refreshSnapshot();
  }

  /* ── sizing ─────────────────────────────────────────────────────────────── */

  /**
   * Resize the backing store. Called by the ResizeObserver in CanvasHost.
   *
   * Two sizes, and conflating them is *the* reason canvas apps look blurry on
   * a Retina display:
   *
   *   canvas.width/height  — the backing store, in PHYSICAL pixels
   *   canvas.style.*       — the layout box, in CSS pixels
   *
   * With `dpr = 2`, a canvas laid out at 800 CSS px needs a 1600 px backing
   * store. Set only the CSS size and the browser stretches an 800 px bitmap
   * across 1600 physical pixels — every edge softened by interpolation.
   *
   * Assigning to `canvas.width` also **clears the canvas and resets the
   * transform**, even when assigning the same value. Hence the guard, and
   * hence a resize always forcing a full repaint — a constraint that shapes
   * the dirty-rectangle design in Phase 5.
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));

    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;

    this.viewport.setSize(cssWidth, cssHeight, dpr);
    this.markDirty();
  }

  setTheme(theme: Theme): void {
    this.renderer.setTheme(theme);
    this.markDirty();
  }

  /* ── commands (called from React) ───────────────────────────────────────── */

  zoomIn(): void {
    if (this.viewport.zoomByFactor(1.1)) this.markDirty();
  }

  zoomOut(): void {
    if (this.viewport.zoomByFactor(1 / 1.1)) this.markDirty();
  }

  resetZoom(): void {
    if (this.viewport.resetZoom()) this.markDirty();
  }

  resetView(): void {
    if (this.viewport.reset()) this.markDirty();
  }

  fitToBounds(bounds: Bounds, padding?: number): void {
    if (this.viewport.fit(bounds, padding)) this.markDirty();
  }

  /* ── channel 1: discrete state, for useSyncExternalStore ────────────────── */

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EngineSnapshot => this.snapshot;

  /**
   * Rebuild the snapshot, and notify React **only if it semantically changed**.
   *
   * The rounding is load-bearing. Zoom is a float that moves every frame during
   * a pinch; the *displayed* value is an integer percentage that changes maybe
   * thirty times across the same gesture. Comparing the rounded value collapses
   * ~90 notifications into ~30 — and, more importantly, means a pan (which does
   * not change zoom at all) produces exactly zero React renders.
   */
  private refreshSnapshot(): void {
    const zoom = this.viewport.zoom;
    const zoomPercent = Math.round(zoom * 100);
    const canZoomIn = zoom < 30 - 1e-9;
    const canZoomOut = zoom > 0.1 + 1e-9;

    const prev = this.snapshot;
    if (
      prev.zoomPercent === zoomPercent &&
      prev.canZoomIn === canZoomIn &&
      prev.canZoomOut === canZoomOut &&
      prev.panAffordance === this.panAffordance
    ) {
      return; // nothing React can see has changed — do not touch the reference
    }

    this.snapshot = {
      zoomPercent,
      canZoomIn,
      canZoomOut,
      panAffordance: this.panAffordance,
    };
    for (const l of this.listeners) l();
  }

  /* ── channel 2: per-frame numbers, bypassing React ──────────────────────── */

  addFrameListener(listener: (info: FrameInfo) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Throttled to ~8 Hz. Faster than that is unreadable to a human anyway. */
  private emitFrameInfo(frameStart: number): void {
    if (this.frameListeners.size === 0) return;
    if (frameStart - this.lastFrameEmit < 125) return;
    this.lastFrameEmit = frameStart;

    const vp = this.viewport.get();
    const info: FrameInfo = {
      stats: this.timer.stats(),
      zoom: vp.zoom,
      scrollX: vp.scrollX,
      scrollY: vp.scrollY,
      gridLines: this.lastRenderStats.gridLines,
      idleFrames: this.idleFrames,
    };
    for (const l of this.frameListeners) l(info);
  }
}

export { DARK_THEME, LIGHT_THEME, type Theme };
