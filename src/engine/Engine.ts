/**
 * The engine. Owns the render loop and everything below it.
 *
 * React constructs one of these, hands it two canvases, and from that point
 * talks to it only through:
 *
 *   subscribe(fn) / getSnapshot()   ← discrete state, via useSyncExternalStore
 *   addFrameListener(fn)            ← per-frame numbers, written straight to DOM
 *   command methods                 ← setTool(), setStyle(), zoomIn(), …
 *
 * ── Why two notification channels ───────────────────────────────────────────
 *
 * `useSyncExternalStore` is React's correct answer for external state, and we
 * use it — but it re-renders on every notification. That is right for state
 * that changes *discretely*: the active tool, the stroke colour, the element
 * count. A few dozen renders a minute.
 *
 * It is wrong for state that changes *continuously*: frame time, the raw zoom
 * float during a pinch. Routing those through the store means 60 React renders
 * a second — precisely the cost this architecture exists to avoid.
 *
 * So the channel is chosen by how a value *behaves*, not by what it is:
 *
 *   discrete   → subscribe/getSnapshot → React re-renders → JSX
 *   continuous → addFrameListener      → component writes textContent via a ref
 *
 * The rule of thumb: **if a human cannot read it at the rate it changes, it does
 * not belong in the render tree.**
 *
 * ── Why two dirty flags ─────────────────────────────────────────────────────
 *
 * New in Phase 2, and the reason the two-canvas split pays off. Drawing a shape
 * dirties the *interactive* layer 60 times a second while the *static* layer
 * stays untouched — so the cost of dragging out a rectangle is independent of
 * how many thousand shapes are already on the canvas.
 *
 * Both start true so the first frame paints. When neither is set the loop does
 * nothing at all: no clear, no draw, no allocation.
 */

import { DARK_THEME, LIGHT_THEME, Renderer, type RenderStats, type Theme } from './render/Renderer';
import { InteractiveRenderer } from './render/InteractiveRenderer';
import { InputRouter, type InputDelegate, type PointerInfo } from './input/InputRouter';
import { Viewport } from './viewport/Viewport';
import { Scene } from './scene/Scene';
import { getSceneBounds } from './scene/bounds';
import { DEFAULT_STYLE, type Element, type ElementStyle } from './scene/element.types';
import { TOOL_SHORTCUTS, ToolManager, type ToolType } from './tools/ToolManager';
import { FrameTimer, type FrameStats, now } from './util/perf';
import type { Bounds } from './util/geometry';

/** Discrete state React renders from. Changes rarely. */
export interface EngineSnapshot {
  readonly activeTool: ToolType;
  readonly style: Readonly<ElementStyle>;
  readonly elementCount: number;
  /** Zoom as a whole-number percentage. 1.0 → 100. */
  readonly zoomPercent: number;
  readonly canZoomIn: boolean;
  readonly canZoomOut: boolean;
  /** Space held or a pan drag in progress — drives the cursor. */
  readonly panAffordance: boolean;
}

/** Per-frame numbers. Delivered outside React. */
export interface FrameInfo {
  readonly stats: FrameStats;
  readonly zoom: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly render: RenderStats;
  /** Frames skipped because nothing changed. High is good. */
  readonly idleFrames: number;
}

export class Engine {
  readonly viewport = new Viewport();
  readonly scene = new Scene();

  private readonly renderer: Renderer;
  private readonly interactive: InteractiveRenderer;
  private readonly tools: ToolManager;
  private readonly input: InputRouter;
  private readonly timer = new FrameTimer();

  private rafId: number | null = null;
  private running = false;

  private needsStaticRender = true;
  private needsInteractiveRender = true;
  private idleFrames = 0;

  /**
   * Stats from the most recent frame that actually drew.
   *
   * Held rather than recomputed, because `emitFrameInfo` also runs on idle
   * frames — and reporting zeroes on those made the overlay read "grid lines: 0"
   * permanently in Phase 1, since idle frames vastly outnumber rendered ones.
   * A broken instrument is more dangerous than a broken feature: it sends you
   * debugging the wrong thing.
   */
  private lastRenderStats: RenderStats = {
    gridLines: 0,
    drawn: 0,
    total: 0,
    cacheHitRate: 1,
  };

  private readonly listeners = new Set<() => void>();
  private readonly frameListeners = new Set<(info: FrameInfo) => void>();

  /**
   * The snapshot handed to React.
   *
   * MUST be referentially stable between notifications. `useSyncExternalStore`
   * compares consecutive `getSnapshot()` results with `Object.is`; returning a
   * fresh object literal each call means "changed" is always true, so React
   * re-renders, calls getSnapshot again, gets another new object, and does not
   * terminate. React's own docs name the error: *"The result of getSnapshot
   * should be cached."* This field is the cache, replaced only in
   * `refreshSnapshot()`.
   */
  private snapshot: EngineSnapshot = {
    activeTool: 'selection',
    style: DEFAULT_STYLE,
    elementCount: 0,
    zoomPercent: 100,
    canZoomIn: true,
    canZoomOut: true,
    panAffordance: false,
  };

  private panAffordance = false;
  private lastFrameEmit = 0;

  constructor(
    private readonly staticCanvas: HTMLCanvasElement,
    private readonly interactiveCanvas: HTMLCanvasElement,
    theme: Theme = LIGHT_THEME,
  ) {
    // The static canvas paints an opaque background every frame, so tell the
    // compositor it never has to blend — measurably cheaper on large surfaces.
    // The interactive canvas MUST be transparent or it would hide everything
    // underneath it.
    const staticCtx = get2d(staticCanvas, { alpha: false });
    const interactiveCtx = get2d(interactiveCanvas, { alpha: true });

    this.renderer = new Renderer(staticCtx, staticCanvas, this.scene);
    this.renderer.setTheme(theme);
    this.interactive = new InteractiveRenderer(interactiveCtx, interactiveCanvas);

    this.tools = new ToolManager(this.scene, DEFAULT_STYLE, {
      onDraftChange: () => {
        this.needsInteractiveRender = true;
      },
      onCommit: () => {
        this.needsStaticRender = true;
        this.refreshSnapshot();
      },
      onToolChange: () => this.refreshSnapshot(),
    });

    // Any scene change dirties the static layer. In Phase 5 this callback grows
    // teeth: `change.before` and `change.after` become the dirty rectangles, and
    // a moved element contributes both — where it was and where it is.
    this.scene.subscribe(() => {
      this.needsStaticRender = true;
    });

    // Pointer events go on the *interactive* canvas: it is on top, so it is what
    // the user is actually pointing at. The static canvas below it has
    // `pointer-events: none`.
    this.input = new InputRouter(interactiveCanvas, this.viewport, this.delegate(), {
      onViewportChange: () => {
        // A viewport change moves every element and every grid line, so both
        // layers are invalid. This is the case where full repaint is not just
        // acceptable but optimal.
        this.needsStaticRender = true;
        this.needsInteractiveRender = true;
        this.refreshSnapshot();
      },
      onPanStateChange: ({ spaceHeld, panning }) => {
        const next = spaceHeld || panning;
        if (next === this.panAffordance) return;
        this.panAffordance = next;
        this.refreshSnapshot();
      },
    });
  }

  /** Bridge between the input router's protocol and the tool manager's. */
  private delegate(): InputDelegate {
    return {
      onPointerDown: (info: PointerInfo) => this.tools.onPointerDown(info.scene, info),
      onPointerMove: (info: PointerInfo) => this.tools.onPointerMove(info.scene, info),
      onPointerUp: () => {
        this.tools.onPointerUp();
      },
      onCancel: () => this.tools.cancel(),
      onKeyDown: (e: KeyboardEvent) => {
        const tool = TOOL_SHORTCUTS[e.key.toLowerCase()];
        if (tool === undefined) return false;
        this.setTool(tool);
        return true;
      },
    };
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

    if (!this.needsStaticRender && !this.needsInteractiveRender) {
      this.idleFrames++;
      this.emitFrameInfo(frameStart);
      return;
    }

    if (this.needsStaticRender) {
      this.needsStaticRender = false;
      this.lastRenderStats = this.renderer.render(this.viewport);
    }

    if (this.needsInteractiveRender) {
      this.needsInteractiveRender = false;
      this.interactive.render(this.viewport, this.tools.draftElement);
    }

    this.timer.record(frameStart, now());
    this.emitFrameInfo(frameStart);
  };

  /**
   * Request a repaint of both layers on the next frame.
   *
   * Note what this does *not* do: draw. A gesture emitting 200 `pointermove`
   * events between two frames marks dirty 200 times and paints once. Coalescing
   * input into frames is what rAF is for, and doing the work inside the event
   * handler instead is the single most common reason canvas apps feel worse
   * than they should.
   */
  markDirty(): void {
    this.needsStaticRender = true;
    this.needsInteractiveRender = true;
  }

  /* ── sizing ─────────────────────────────────────────────────────────────── */

  /**
   * Resize both backing stores. Called by the ResizeObserver in CanvasHost.
   *
   * Two sizes, and conflating them is *the* reason canvas apps look blurry on a
   * HiDPI display: `canvas.width/height` is the backing store in PHYSICAL
   * pixels, `canvas.style.*` is the layout box in CSS pixels. At dpr 2 a canvas
   * laid out at 800 CSS px needs a 1600 px backing store.
   *
   * Assigning `canvas.width` also **clears the canvas and resets the transform**,
   * even when assigning the same value — hence the guard, and hence a resize
   * always forcing a full repaint. That constraint shapes the whole
   * dirty-rectangle design in Phase 5.
   */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr));
    const h = Math.max(1, Math.round(cssHeight * dpr));

    for (const canvas of [this.staticCanvas, this.interactiveCanvas]) {
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
    }

    this.viewport.setSize(cssWidth, cssHeight, dpr);
    this.input.invalidateRect();
    this.markDirty();
  }

  setTheme(theme: Theme): void {
    this.renderer.setTheme(theme);
    this.needsStaticRender = true;
  }

  /* ── commands (called from React) ───────────────────────────────────────── */

  setTool(tool: ToolType): void {
    this.tools.setTool(tool);
  }

  setStyle(patch: Partial<ElementStyle>): void {
    this.tools.setStyle(patch);
    this.refreshSnapshot();
  }

  clearScene(): void {
    if (this.scene.visibleCount === 0) return;
    this.scene.clear();
    this.renderer.cache.clear();
    this.refreshSnapshot();
  }

  zoomIn(): void {
    if (this.viewport.zoomByFactor(1.1)) this.onViewportCommand();
  }

  zoomOut(): void {
    if (this.viewport.zoomByFactor(1 / 1.1)) this.onViewportCommand();
  }

  resetZoom(): void {
    if (this.viewport.resetZoom()) this.onViewportCommand();
  }

  /** Frame the whole drawing. No-op on an empty scene rather than zooming to nothing. */
  zoomToFit(padding = 0.15): void {
    const bounds = getSceneBounds(this.scene.sorted());
    if (bounds === null) return;
    if (this.viewport.fit(bounds, padding)) this.onViewportCommand();
  }

  fitToBounds(bounds: Bounds, padding?: number): void {
    if (this.viewport.fit(bounds, padding)) this.onViewportCommand();
  }

  private onViewportCommand(): void {
    this.markDirty();
    this.refreshSnapshot();
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
   * ~90 notifications into ~30 — and a pan, which does not change zoom at all,
   * produces exactly zero React renders.
   */
  private refreshSnapshot(): void {
    const zoom = this.viewport.zoom;
    const next: EngineSnapshot = {
      activeTool: this.tools.activeTool,
      style: this.tools.getStyle(),
      elementCount: this.scene.visibleCount,
      zoomPercent: Math.round(zoom * 100),
      canZoomIn: zoom < 30 - 1e-9,
      canZoomOut: zoom > 0.1 + 1e-9,
      panAffordance: this.panAffordance,
    };

    const prev = this.snapshot;
    if (
      prev.activeTool === next.activeTool &&
      prev.style === next.style &&
      prev.elementCount === next.elementCount &&
      prev.zoomPercent === next.zoomPercent &&
      prev.canZoomIn === next.canZoomIn &&
      prev.canZoomOut === next.canZoomOut &&
      prev.panAffordance === next.panAffordance
    ) {
      return; // nothing React can observe changed — do not touch the reference
    }

    this.snapshot = next;
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
      render: this.lastRenderStats,
      idleFrames: this.idleFrames,
    };
    for (const l of this.frameListeners) l(info);
  }
}

function get2d(
  canvas: HTMLCanvasElement,
  options: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', options);
  if (ctx === null) {
    throw new Error(
      'Could not acquire a 2D canvas context. This can happen in hardened ' +
        'browser configurations or headless environments without a GPU.',
    );
  }
  return ctx;
}

export { DARK_THEME, LIGHT_THEME, type Element, type ElementStyle, type Theme, type ToolType };
