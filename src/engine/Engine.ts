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
import { InteractiveRenderer, type SelectionOverlay } from './render/InteractiveRenderer';
import { DirtyTracker, type DirtyStats } from './render/DirtyTracker';
import { InputRouter, type InputDelegate, type PointerInfo } from './input/InputRouter';
import { Viewport } from './viewport/Viewport';
import { Scene, type HitStats } from './scene/Scene';
import { getRenderBounds, getSceneBounds } from './scene/bounds';
import { DEFAULT_STYLE, type Element, type ElementId, type ElementStyle } from './scene/element.types';
import { TOOL_SHORTCUTS, ToolManager, type ToolType } from './tools/ToolManager';
import { Selection } from './tools/Selection';
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  createCanvasMeasurer,
  type FontFamily,
  type TextAlign,
  type TextMeasurer,
} from './text/measure';
import {
  FrameTimer,
  type FrameStats,
  StageTimer,
  type StageTimings,
  ZERO_STAGES,
  now,
} from './util/perf';
import { type GenerateOptions, generateScene } from './dev/generateScene';
import { boundsIntersect, type Bounds } from './util/geometry';

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
  /** Whether User Timing marks are being emitted. Discrete: a toggle. */
  readonly perfMarks: boolean;
  /** How many elements are selected. Discrete, and drives the whole selection UI. */
  readonly selectedCount: number;
  /**
   * CSS cursor for the canvas, or null for the tool's default.
   *
   * Discrete despite arriving from `pointermove`: it changes when the pointer
   * crosses a handle boundary, which is a handful of times per gesture, not
   * once per frame. That is the test for whether something belongs on this
   * snapshot at all.
   */
  readonly cursor: string | null;
  /**
   * The text element being edited, or null.
   *
   * Discrete — it changes when an editor opens or closes, which is a handful of
   * times per session. *Where* that editor sits on screen is continuous and does
   * not belong here; see `Engine.textEditorLayout`.
   */
  readonly editingTextId: ElementId | null;
  /** Font settings for new text, and for the current text selection. */
  readonly textStyle: Readonly<{ fontSize: number; fontFamily: FontFamily; textAlign: TextAlign }>;
  /** Whether the selection contains at least one text element. */
  readonly hasText: boolean;
}

/**
 * Everything the editing `<textarea>` needs to sit exactly on top of the text.
 *
 * Screen coordinates and a zoom factor rather than pre-multiplied pixel sizes —
 * see `Engine.textEditorLayout` for why that distinction matters at fractional
 * zoom.
 */
export interface TextEditorLayout {
  readonly id: ElementId;
  readonly text: string;
  /** Top-left of the text box, in screen pixels. */
  readonly left: number;
  readonly top: number;
  /** Box width in SCENE units. Scaled by `zoom` via a CSS transform. */
  readonly width: number;
  /** Font size in SCENE units, likewise scaled rather than multiplied. */
  readonly fontSize: number;
  readonly fontFamily: FontFamily;
  readonly lineHeight: number;
  readonly textAlign: TextAlign;
  readonly color: string;
  readonly zoom: number;
  readonly angle: number;
}

/** Per-frame numbers. Delivered outside React. */
export interface FrameInfo {
  readonly stats: FrameStats;
  readonly zoom: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly render: RenderStats;
  /**
   * Where the frame went, split by stage.
   *
   * "The frame takes 40 ms" is not actionable. "The cull takes 38 of the 40"
   * points at one function. This split is the whole reason Phase 3 exists as a
   * phase rather than a footnote.
   */
  readonly stages: StageTimings;
  /** What the dirty-rectangle tracker decided this frame. */
  readonly dirty: DirtyStats;
  /**
   * Work done by the most recent hit test.
   *
   * Not a per-frame value — it changes on pointer events, not on rAF — but it
   * rides the same channel because it is read the same way: a number a human
   * glances at, that must not cost a React render to display.
   */
  readonly hit: HitStats;
  /** Frames skipped because nothing changed. High is good. */
  readonly idleFrames: number;
}

/**
 * Click tolerance in SCREEN pixels.
 *
 * Divided by zoom before it reaches the hit test, so the slop is constant on
 * screen rather than in the document. A fixed scene-space tolerance would make a
 * 1px line nearly unclickable at 10% zoom and give it a fat invisible halo at
 * 3000% — the tolerance exists for the human's aim, and the human is looking at
 * pixels.
 */
const HIT_SLOP_PX = 10;

/**
 * Above this many selected elements, draw only the group box, not per-element
 * outlines.
 *
 * Select-all on a 50,000-element scene would otherwise stroke 50,000 dashed
 * rectangles on the interactive layer every frame — which is exactly the
 * "cost grows with the document" problem the two-canvas split exists to
 * prevent, reintroduced through the back door.
 */
const MAX_SELECTION_OUTLINES = 200;

export class Engine {
  readonly viewport = new Viewport();
  readonly scene = new Scene();
  readonly selection = new Selection();

  private readonly renderer: Renderer;
  private readonly interactive: InteractiveRenderer;
  private readonly tools: ToolManager;
  private readonly input: InputRouter;
  private readonly timer = new FrameTimer();
  private readonly stages = new StageTimer();

  /**
   * What needs repainting on the static layer.
   *
   * The dirty flag `needsStaticRender` answers "is there anything to do"; this
   * answers "what, exactly". Both are needed: the flag lets the loop skip a
   * frame with no work at all, and skipping is what keeps an idle canvas at zero
   * cost.
   */
  private readonly dirty = new DirtyTracker();

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
    tested: 0,
    nodes: 0,
    path: 'all',
    cacheHitRate: 1,
    dirtyRects: 0,
    dirtyCoverage: 1,
    fullRepaint: true,
  };

  private lastStages: StageTimings = ZERO_STAGES;

  /**
   * Bounding box of the selection, cached.
   *
   * Recomputed when the selection or the scene changes, not per frame. With
   * everything selected in a 50,000-element scene, computing it every frame is
   * 50,000 rotated-bounds calculations for a rectangle that has not moved.
   */
  private selectionBounds: Bounds | null = null;
  private selectionBoundsDirty = true;

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
    perfMarks: false,
    selectedCount: 0,
    cursor: null,
    editingTextId: null,
    textStyle: { fontSize: DEFAULT_FONT_SIZE, fontFamily: DEFAULT_FONT_FAMILY, textAlign: 'left' },
    hasText: false,
  };

  private panAffordance = false;
  private lastFrameEmit = 0;

  /**
   * The browser, wrapped.
   *
   * Created here because this is the one class that is allowed to know it is in
   * a browser — it already takes two `HTMLCanvasElement`s. Everything below it
   * receives a `TextMeasurer` and cannot tell the difference between this and
   * the deterministic one the tests use.
   */
  private readonly measurer: TextMeasurer = createCanvasMeasurer();

  /** The text element whose editor is open. Hidden from the static layer. */
  private editingText: ElementId | null = null;

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

    this.tools = new ToolManager(this.scene, this.selection, DEFAULT_STYLE, {
      onDraftChange: () => {
        this.needsInteractiveRender = true;
      },
      onSelectionChange: () => {
        this.needsInteractiveRender = true;
        this.selectionBoundsDirty = true;
      this.hasTextDirty = true;
        this.refreshSnapshot();
      },
      onCommit: () => {
        this.needsStaticRender = true;
        this.refreshSnapshot();
      },
      onToolChange: () => {
        /* Leaving the selection tool closes any open editor. The alternative —
           a textarea still focused while the rectangle tool is active — means
           the next keystroke goes into the text instead of switching tools, and
           the user has no way to tell why. */
        if (this.tools.editingId !== null) this.tools.endTextEdit();
        this.refreshSnapshot();
      },
      onEditText: (id) => {
        this.editingText = id;
        this.renderer.setHidden(id);
        /* Force a full repaint on both edges of editing. The element is hidden
           from the static layer while its editor is open (otherwise you see the
           text twice — once painted, once in the textarea, a pixel apart and
           subtly different), so both opening and closing change what should be
           on screen in a way no dirty rectangle was collected for. */
        this.dirty.force('global');
        this.needsStaticRender = true;
        this.needsInteractiveRender = true;
        this.refreshSnapshot();
      },
    }, this.measurer);

    // Any scene change dirties the static layer. In Phase 5 this callback grows
    // teeth: `change.before` and `change.after` become the dirty rectangles, and
    // a moved element contributes both — where it was and where it is.
    /* Every scene change contributes its rectangles.
     *
     * `change.before` and `change.after` are what Phase 2 put on `SceneChange`
     * for exactly this moment, three phases before there was anything to use
     * them for. A moved element supplies both — the place it left, which needs
     * erasing, and the place it arrived, which needs painting — and forgetting
     * the first is the classic smear bug. */
    this.scene.subscribe((change) => {
      this.needsStaticRender = true;
      this.dirty.addChange(change.before, change.after);

      // `load()` and `clear()` report a null/null change: not a region, a new
      // scene. Nothing local about that.
      if (change.before === null && change.after === null) this.dirty.force('global');

      // A moved or deleted element changes where the selection outline goes.
      this.selectionBoundsDirty = true;
      this.hasTextDirty = true;
      this.needsInteractiveRender = true;
    });

    // Pointer events go on the *interactive* canvas: it is on top, so it is what
    // the user is actually pointing at. The static canvas below it has
    // `pointer-events: none`.
    this.input = new InputRouter(interactiveCanvas, this.viewport, this.delegate(), {
      onViewportChange: () => {
        // A viewport change moves every element and every grid line, so both
        // layers are invalid. This is the case where full repaint is not just
        // acceptable but optimal — there is no subset of the screen that is
        // still correct, so there is nothing for dirty rectangles to save.
        this.dirty.force('global');
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
      onPointerDown: (info: PointerInfo) =>
        this.tools.onPointerDown(info.scene, { ...info, hitThreshold: this.hitThreshold(), zoom: this.viewport.zoom }),
      onPointerMove: (info: PointerInfo) =>
        this.tools.onPointerMove(info.scene, { ...info, hitThreshold: this.hitThreshold(), zoom: this.viewport.zoom }),
      onPointerHover: (info: PointerInfo) => {
        // Only notifies when the answer CHANGED. A hover handler that pushed a
        // snapshot on every mouse move would re-render React 60 times a second
        // to set the same string.
        if (this.tools.onPointerHover(info.scene, { ...info, hitThreshold: this.hitThreshold(), zoom: this.viewport.zoom })) {
          this.refreshSnapshot();
        }
      },
      onPointerUp: () => {
        this.tools.onPointerUp();
      },
      onDoubleClick: (info: PointerInfo) =>
        this.tools.editTextAt(info.scene, {
          ...info,
          hitThreshold: this.hitThreshold(),
          zoom: this.viewport.zoom,
        }),
      onCancel: () => this.tools.cancel(),
      onKeyDown: (e: KeyboardEvent) => {
        // Selection commands first: they are modal, and a bare `a` must select
        // all rather than being swallowed by a tool shortcut it does not match.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
          this.tools.selectAll();
          return true;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          this.tools.deleteSelected();
          // Consumed even when nothing was selected: an unhandled Backspace is
          // a browser navigation gesture in some configurations, and losing the
          // canvas to a history-back is not a recoverable mistake.
          return true;
        }

        // A modifier held with a letter is a browser or OS shortcut, not ours.
        if (e.metaKey || e.ctrlKey || e.altKey) return false;

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

    this.stages.reset();

    if (this.needsStaticRender) {
      this.needsStaticRender = false;
      const plan = this.dirty.plan(this.viewport.visibleSceneBounds());
      // `none` means every collected rectangle was off screen — real work that
      // correctly resolved to no pixels. Skipping the paint here is not an
      // optimisation, it is the answer.
      if (plan.kind !== 'none') {
        this.lastRenderStats = this.renderer.render(this.viewport, this.stages, plan);
      }
    }

    if (this.needsInteractiveRender) {
      this.needsInteractiveRender = false;
      this.stages.begin('interactive');
      this.interactive.render(this.viewport, this.tools.draftElement, this.overlay());
      this.stages.end('interactive');
    }

    this.lastStages = this.stages.read();
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
  /** Click tolerance in scene units: constant on screen, whatever the zoom. */
  private hitThreshold(): number {
    return HIT_SLOP_PX / this.viewport.zoom;
  }

  /**
   * What the interactive layer draws on top of the draft.
   *
   * Called on every interactive frame, which since Phase 6 means every frame of
   * a drag. See `visibleSelection` for why that mattered.
   */
  /**
   * The selected elements that are actually on screen.
   *
   * ── Why this is not an index query ─────────────────────────────────────────
   *
   * The obvious version — and the version this shipped with from Phase 4b until
   * Phase 6 measured it — asks the spatial index for everything in the viewport
   * and filters that down to the selection:
   *
   *     scene.elementsInBox(viewport).filter((el) => selection.has(el.id))
   *
   * That reads well and it is quadratically wrong in the wrong direction. It
   * costs O(elements on screen) to produce a result bounded by
   * MAX_SELECTION_OUTLINES. Zoomed out over 50,000 elements it builds a
   * 50,000-entry array and throws away 49,999 of them — 85 ms, every frame,
   * inside a gesture, while the cull and the draw it was competing with had both
   * been optimised down to 0.00 ms.
   *
   * The right way round is to iterate the *smaller* set. The selection is at
   * most MAX_SELECTION_OUTLINES here, so this is bounded by a constant and it
   * does the viewport cull as well.
   *
   * The lesson generalises: **an index makes a query cheap, it does not make it
   * free, and asking a cheap question about a large set is still worse than
   * asking a direct question about a small one.** Phase 4a built the index and
   * this is the first place it was reached for reflexively rather than because
   * the shape of the problem asked for it.
   */
  private visibleSelection(): Element[] {
    const view = this.viewport.visibleSceneBounds();
    const out: Element[] = [];
    for (const id of this.selection.ids()) {
      const el = this.scene.get(id);
      if (el === undefined || el.isDeleted) continue;
      if (boundsIntersect(getRenderBounds(el), view)) out.push(el);
    }
    return out;
  }

  private overlay(): SelectionOverlay {
    if (this.selectionBoundsDirty) {
      this.selectionBounds = this.scene.boundsOf(this.selection.ids());
      this.selectionBoundsDirty = false;
    }

    const count = this.selection.size;
    const outlines = count === 0 || count > MAX_SELECTION_OUTLINES ? [] : this.visibleSelection();

    return {
      outlines,
      // One box round a single element is the same rectangle twice. Only show
      // the group box when it is actually grouping something.
      groupBounds: count > 1 ? this.selectionBounds : null,
      marquee: this.tools.marqueeBox,
      // Handles only while the selection tool is active: they are that tool's
      // affordance, and leaving them up under the rectangle tool invites clicks
      // that will not do what they look like they will.
      transform: this.tools.activeTool === 'selection' ? this.tools.transformBox : null,
    };
  }

  markDirty(): void {
    this.dirty.force('global');
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
    // Assigning `canvas.width` clears the backing store and resets the
    // transform, even when assigning the same value. There is no stale content
    // to preserve because there is no content at all.
    this.dirty.force('global');
    this.markDirty();
  }

  setTheme(theme: Theme): void {
    this.renderer.setTheme(theme);
    // The background under every element changes. Nothing on screen survives.
    this.dirty.force('global');
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
    this.scene.compact();
    this.renderer.cache.clear();
    this.selection.clear();
    this.selectionBoundsDirty = true;
    this.refreshSnapshot();
  }

  /** Delete the selection. Exposed for the toolbar; the keyboard path is above. */
  deleteSelected(): number {
    return this.tools.deleteSelected();
  }

  selectAll(): boolean {
    return this.tools.selectAll();
  }

  /* ── the performance lab (Phase 3) ──────────────────────────────────────── */

  /**
   * Replace the scene with `count` generated elements and frame them.
   *
   * This is a development affordance, not a feature — but it is the affordance
   * the next two phases are built on. Neither the quadtree nor the
   * dirty-rectangle renderer is worth claiming without a before number, and you
   * cannot get a before number without a scene big enough to hurt.
   *
   * `load()` rather than repeated `add()`: 50,000 individual adds would emit
   * 50,000 change notifications and rebuild the z-sort cache 50,000 times,
   * which takes long enough to look like a hang.
   */
  generateScene(options: GenerateOptions): string {
    const { elements, descriptor } = generateScene(options);
    this.scene.load(elements);
    this.renderer.cache.clear();
    this.zoomToFit();
    this.markDirty();
    this.refreshSnapshot();
    return descriptor;
  }

  /**
   * Turn on `performance.mark`/`measure` so a DevTools trace shows named
   * regions instead of an undifferentiated block of `render`.
   *
   * Opt-in because the entries allocate and are retained until cleared — left
   * on permanently they cost more than the stages they measure.
   */
  setPerfMarks(enabled: boolean): void {
    this.stages.setMarksEnabled(enabled);
    this.refreshSnapshot();
  }

  get perfMarksEnabled(): boolean {
    return this.stages.isMarking;
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
      perfMarks: this.stages.isMarking,
      selectedCount: this.selection.size,
      cursor: this.tools.cursor,
      editingTextId: this.editingText,
      textStyle: this.tools.getTextStyle(),
      hasText: this.hasTextSelected(),
    };

    const prev = this.snapshot;
    if (
      prev.activeTool === next.activeTool &&
      prev.style === next.style &&
      prev.elementCount === next.elementCount &&
      prev.zoomPercent === next.zoomPercent &&
      prev.canZoomIn === next.canZoomIn &&
      prev.canZoomOut === next.canZoomOut &&
      prev.panAffordance === next.panAffordance &&
      prev.perfMarks === next.perfMarks &&
      prev.selectedCount === next.selectedCount &&
      /* Phase 5's lesson, applied without having to relearn it: a field added to
         the snapshot and not to this comparison is a field React never observes
         changing. The perfMarks checkbox shipped dead for exactly one build. */
      prev.cursor === next.cursor &&
      prev.editingTextId === next.editingTextId &&
      prev.textStyle === next.textStyle &&
      prev.hasText === next.hasText
    ) {
      return; // nothing React can observe changed — do not touch the reference
    }

    this.snapshot = next;
    for (const l of this.listeners) l();
  }

  /* ── text editing ───────────────────────────────────────────────────────── */

  /**
   * Where to put the editing `<textarea>`, this frame.
   *
   * Returns SCREEN coordinates, and is therefore **continuous state**: it
   * changes on every pan and every zoom step, which is the same reason frame
   * timings do not go on the React snapshot. The editor component reads this
   * through `addFrameListener` and writes it straight to a ref, so panning with
   * an editor open costs zero React renders — the same two-channel split the
   * stats overlay has used since Phase 3.
   *
   * What *is* discrete, and does go on the snapshot, is whether an editor should
   * exist at all.
   */
  textEditorLayout(): TextEditorLayout | null {
    if (this.editingText === null) return null;

    const el = this.scene.get(this.editingText);
    if (el === undefined || el.type !== 'text') return null;

    const { zoom } = this.viewport;
    const topLeft = this.viewport.toScreen({ x: el.x, y: el.y });

    return {
      id: el.id,
      text: el.text,
      left: topLeft.x,
      top: topLeft.y,
      /* Sized in SCENE units and scaled with a CSS transform, rather than sized
         in screen pixels directly. Two reasons, and the second is the one that
         bites: a CSS transform can carry the element's rotation for free, and
         browsers quantise `font-size` (and snap glyphs to hinted stems), so a
         textarea sized at `20 * zoom` px drifts out of alignment with the canvas
         text at fractional zooms. Scaling a fixed size keeps them identical. */
      width: el.wrapWidth ?? el.width,
      fontSize: el.fontSize,
      fontFamily: el.fontFamily,
      lineHeight: el.lineHeight,
      textAlign: el.textAlign,
      color: el.strokeColor,
      zoom,
      angle: el.angle,
    };
  }

  /**
   * Does the selection contain any text? Drives whether the font controls show.
   *
   * ── Memoised, and Phase 6 is why ───────────────────────────────────────────
   *
   * `refreshSnapshot` calls this, and `refreshSnapshot` runs on every hover
   * change — which is several times a second while the mouse is moving. Scanning
   * the selection each time makes an O(selection) walk part of mouse movement,
   * and with everything selected that is 50,000 map lookups per wiggle.
   *
   * That is the *exact* shape of the bug Phase 6 found in the selection overlay,
   * one phase later and in a different function. Recognising it the second time
   * cost nothing; not recognising it the first time cost 84.9 ms a frame.
   *
   * The flag is cleared by the same two events that dirty the selection bounds:
   * the selection changed, or the scene did.
   */
  hasTextSelected(): boolean {
    if (!this.hasTextDirty) return this.hasTextCache;

    let found = false;
    for (const id of this.selection.ids()) {
      const el = this.scene.get(id);
      if (el !== undefined && el.type === 'text' && !el.isDeleted) {
        found = true;
        break;
      }
    }
    this.hasTextCache = found;
    this.hasTextDirty = false;
    return found;
  }

  private hasTextCache = false;
  private hasTextDirty = true;

  /** Called by the editor on every keystroke. */
  setEditingText(value: string): void {
    if (this.tools.applyTextEdit(value)) {
      this.needsStaticRender = true;
      this.needsInteractiveRender = true;
      this.refreshSnapshot();
    }
  }

  endTextEditing(): void {
    this.tools.endTextEdit();
  }

  setTextStyle(patch: Partial<{ fontSize: number; fontFamily: FontFamily; textAlign: TextAlign }>): void {
    this.tools.setTextStyle(patch);
    this.needsStaticRender = true;
    this.refreshSnapshot();
  }

  /**
   * Re-lay-out every text element, because the fonts changed under us.
   *
   * Wired to `document.fonts.ready` and to `loadingdone` in `CanvasHost`. Until
   * a webfont arrives, `ctx.font` falls back silently to a different family with
   * different metrics — nothing throws, and every string was measured against
   * the wrong face. The symptom is text that visibly re-flows a beat after the
   * page loads, or, worse, does not re-flow and stays wrapped in the wrong
   * places for the rest of the session.
   */
  remeasureText(): number {
    const changed = this.tools.remeasureText();
    if (changed > 0) {
      this.dirty.force('global');
      this.needsStaticRender = true;
      this.refreshSnapshot();
    }
    return changed;
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
      stages: this.lastStages,
      dirty: this.dirty.stats(),
      hit: this.scene.hitStats,
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
