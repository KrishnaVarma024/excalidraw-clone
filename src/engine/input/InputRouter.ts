/**
 * The single input layer. Replaces Phase 1's `ViewportInput`.
 *
 * Phase 1 had one consumer of pointer events — panning. Phase 2 has two, and
 * they compete for the same left-button drag: the active tool wants to draw,
 * the viewport wants to pan. Two independent listener sets on the same element
 * would make the resolution depend on registration order, which is exactly the
 * kind of implicit coupling that becomes unfixable by Phase 6 when selection,
 * resize and rotate all want the same gesture.
 *
 * So there is one listener set and an explicit priority chain:
 *
 *   1. **Pan gestures win outright** — middle button, or space held. These are
 *      navigation, and navigation must work no matter what tool is active.
 *   2. **The tool gets first refusal** on a plain left-button press. A shape
 *      tool consumes it; the selection tool declines (Phase 4 will make it
 *      consume).
 *   3. **Nothing else claims it**, so the event falls through.
 *
 * Writing that order down as a chain, rather than leaving it to be discovered,
 * is the point of this file.
 *
 * ── Pointer Events, and why capture is mandatory ────────────────────────────
 *
 * `pointerdown/move/up` unify mouse, touch and stylus, and carry `pressure`,
 * `tiltX/Y` and `pointerType` — all of which the freehand tool needs.
 *
 * Without `setPointerCapture`: start a stroke, drag outside the window, release.
 * The `pointerup` is delivered to whatever is under the cursor, not to us, so
 * the app stays in "drawing" forever and the shape follows the mouse until you
 * click again. Capture routes every subsequent event for that `pointerId` to
 * the capturing element and releases automatically.
 *
 * The tempting alternative — listening for `pointerup` on `window` — is worse:
 * you must manage add/remove symmetry, you receive events from unrelated
 * pointers, and it breaks with multiple touch points.
 */

import type { Viewport } from '../viewport/Viewport';
import type { Point } from '../util/geometry';
import { MAX_ZOOM, MIN_ZOOM } from '../viewport/transform';

const ZOOM_BUTTON_FACTOR = 1.1;

/**
 * Rough pixel equivalents for line- and page-mode wheel deltas.
 *
 * `WheelEvent.deltaMode` is 0 (pixels), 1 (lines) or 2 (pages), and which one
 * you get depends on browser, OS, and whether the device is a trackpad or a
 * notched wheel. Firefox on Windows reports lines where Chrome reports pixels
 * for the same physical gesture. Normalising here means nothing downstream
 * sees more than one unit.
 *
 * These constants are a guess. There is no runtime way to calibrate them, which
 * is a genuine platform wart every canvas app carries.
 */
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;

function normalizeWheelDelta(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * LINE_HEIGHT_PX;
  if (deltaMode === 2) return delta * PAGE_HEIGHT_PX;
  return delta;
}

export interface PointerInfo {
  /** Position in SCENE space — the router does the conversion once. */
  scene: Point;
  /** Position in SCREEN space, canvas-relative. */
  screen: Point;
  shiftKey: boolean;
  altKey: boolean;
  pressure: number;
  pointerType: string;
}

/**
 * What the active tool implements. The router knows nothing about drawing.
 *
 * `onPointerDown` returns whether the tool consumed the event — the one piece
 * of protocol in the priority chain above.
 */
export interface InputDelegate {
  onPointerDown(info: PointerInfo): boolean;
  onPointerMove(info: PointerInfo): void;
  /**
   * The pointer moved with no button down.
   *
   * Separate from `onPointerMove` on purpose. A drag and a hover are different
   * questions — "what should this gesture do next" versus "what would happen if
   * I pressed here" — and merging them means every tool has to re-derive which
   * one it is from state the router already knows.
   */
  onPointerHover(info: PointerInfo): void;
  onPointerUp(info: PointerInfo): void;
  onCancel(): void;
  /**
   * A double click. Return true if consumed.
   *
   * A separate channel rather than counting `PointerEvent.detail` in the tool.
   * The browser already knows what a double click is — it accounts for the
   * platform's interval, the movement slop between the two clicks, and the OS
   * accessibility setting that changes both. Reimplementing that with a
   * timestamp comparison gets it wrong for the users who most need it right.
   */
  onDoubleClick(info: PointerInfo): boolean;
  /** Unhandled keydown, for tool shortcuts. Return true if consumed. */
  onKeyDown(e: KeyboardEvent): boolean;
}

export interface InputCallbacks {
  /** The viewport changed. */
  onViewportChange: () => void;
  /** Space held or a pan drag is running — drives the cursor. */
  onPanStateChange?: (state: { spaceHeld: boolean; panning: boolean }) => void;
}

type Gesture = 'none' | 'pan' | 'tool';

export class InputRouter {
  private spaceHeld = false;
  private gesture: Gesture = 'none';
  private activePointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;

  /**
   * Cached canvas rect.
   *
   * `getBoundingClientRect()` forces a layout flush, and Phase 2 needs the rect
   * on *every* `pointermove` rather than only on wheel events. At 240 Hz that
   * is 240 forced layouts a second, which shows up as a solid bar in a profile.
   * Cached here and invalidated from the ResizeObserver via `invalidateRect()`.
   *
   * Phase 1's PR flagged this as the thing that would need fixing once pointer
   * moves needed the rect. This is that fix.
   */
  private rect: DOMRect | null = null;

  private readonly abort = new AbortController();

  constructor(
    private readonly target: HTMLCanvasElement,
    private readonly viewport: Viewport,
    private readonly delegate: InputDelegate,
    private readonly cb: InputCallbacks,
  ) {
    const { signal } = this.abort;
    const el = target;

    el.addEventListener('pointerdown', this.onPointerDown, { signal });
    el.addEventListener('dblclick', this.onDoubleClick, { signal });
    el.addEventListener('pointermove', this.onPointerMove, { signal });
    el.addEventListener('pointerup', this.onPointerUp, { signal });
    el.addEventListener('pointercancel', this.onPointerUp, { signal });

    // `passive: false` is mandatory: wheel listeners default to passive, and a
    // passive listener may not call preventDefault() — so without it the page
    // scrolls underneath while we also pan, and everything moves twice.
    el.addEventListener('wheel', this.onWheel, { signal, passive: false });

    // Keyboard on `window`: a <canvas> is not focusable, so canvas-scoped key
    // handlers silently never fire. `tabindex` would work but would put the
    // canvas ahead of the toolbar in the tab order, which is worse.
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('keyup', this.onKeyUp, { signal });
    window.addEventListener('blur', this.onBlur, { signal });

    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  }

  destroy(): void {
    this.abort.abort();
  }

  /** Called by the ResizeObserver — the cached rect is now stale. */
  invalidateRect(): void {
    this.rect = null;
  }

  get isPanning(): boolean {
    return this.gesture === 'pan';
  }

  get isSpaceHeld(): boolean {
    return this.spaceHeld;
  }

  /* ── pointer ────────────────────────────────────────────────────────────── */

  private onPointerDown = (e: PointerEvent): void => {
    if (this.gesture !== 'none') return;

    // 1. Navigation wins outright, whatever tool is active.
    const wantsPan = e.button === 1 || (e.button === 0 && this.spaceHeld);
    if (wantsPan) {
      e.preventDefault();
      this.beginGesture('pan', e);
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      return;
    }

    if (e.button !== 0) return;

    // 2. The tool gets first refusal.
    if (this.delegate.onPointerDown(this.info(e))) {
      e.preventDefault();
      this.beginGesture('tool', e);
    }
    // 3. Otherwise the event falls through unclaimed.
  };

  private onDoubleClick = (e: MouseEvent): void => {
    /* `dblclick` arrives after the second `pointerup`, so any gesture the second
       click started has already ended. Nothing to cancel; just ask the tool. */
    if (this.delegate.onDoubleClick(this.info(e))) e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;

    if (this.gesture === 'pan') {
      // Deltas from clientX/Y rather than movementX/Y: `movement*` is reported
      // in physical pixels on some platforms and CSS pixels on others, and is
      // affected by pointer acceleration.
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.viewport.panBy(dx, dy)) this.cb.onViewportChange();
      return;
    }

    if (this.gesture === 'tool') {
      /* getCoalescedEvents() returns the samples the browser throttled away
         between frames. Freehand needs them: a 120 Hz trackpad against a 60 Hz
         display drops every other sample, and a fast stroke comes out as a
         visible polygon rather than a curve.

         The optional chaining is not defensive padding — Safari shipped it
         later than the others, and the fallback of using the event itself is
         exactly right. */
      const samples = e.getCoalescedEvents?.() ?? [e];
      for (const sample of samples) this.delegate.onPointerMove(this.info(sample));
      return;
    }

    /* Idle: no button down, no pan. This is the hover channel, and it exists so
       the cursor can tell you a handle is grabbable before you find out by
       missing it. Coalesced samples are deliberately NOT unpacked here — hover
       only cares where the pointer is now, and replaying the throttled samples
       would be work whose result is overwritten microseconds later. */
    if (this.gesture === 'none') this.delegate.onPointerHover(this.info(e));
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.activePointerId) return;

    if (this.gesture === 'tool') this.delegate.onPointerUp(this.info(e));

    if (this.target.hasPointerCapture(e.pointerId)) {
      this.target.releasePointerCapture(e.pointerId);
    }
    this.gesture = 'none';
    this.activePointerId = null;
    this.emitPanState();
  };

  private beginGesture(kind: Gesture, e: PointerEvent): void {
    this.target.setPointerCapture(e.pointerId);
    this.gesture = kind;
    this.activePointerId = e.pointerId;
    this.emitPanState();
  }

  /* ── wheel ──────────────────────────────────────────────────────────────── */

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();

    const dx = normalizeWheelDelta(e.deltaX, e.deltaMode);
    const dy = normalizeWheelDelta(e.deltaY, e.deltaMode);

    // A trackpad pinch arrives as a wheel event with ctrlKey synthesised true.
    // There is no separate pinch event on desktop — a convention every browser
    // follows rather than a spec, and also why Ctrl+wheel on a mouse zooms.
    if (e.ctrlKey || e.metaKey) {
      if (this.viewport.zoomByDelta(dy, this.toCanvas(e))) this.cb.onViewportChange();
      return;
    }

    // Shift+wheel maps vertical to horizontal — the platform convention for
    // horizontal scrolling on a device with one wheel axis.
    const panX = e.shiftKey && dx === 0 ? -dy : -dx;
    const panY = e.shiftKey && dx === 0 ? 0 : -dy;
    if (this.viewport.panBy(panX, panY)) this.cb.onViewportChange();
  };

  /* ── keyboard ───────────────────────────────────────────────────────────── */

  private onKeyDown = (e: KeyboardEvent): void => {
    // Never steal keys from a text field. Phase 7 adds a real <textarea> overlay
    // for text editing, and this guard is what stops space from panning the
    // canvas while someone is typing a word.
    if (isEditableTarget(e.target)) return;

    if (e.key === 'Escape') {
      this.delegate.onCancel();
      return;
    }

    if (e.code === 'Space' && !e.repeat) {
      this.spaceHeld = true;
      e.preventDefault(); // otherwise space scrolls the page
      this.emitPanState();
      return;
    }

    const mod = e.metaKey || e.ctrlKey;

    if (mod) {
      // e.key rather than e.code: on a US layout zoom-in is Shift+'=' but the
      // key that arrives is '+', and on other layouts it is elsewhere entirely.
      switch (e.key) {
        case '=':
        case '+':
          e.preventDefault();
          if (this.viewport.zoomByFactor(ZOOM_BUTTON_FACTOR)) this.cb.onViewportChange();
          return;
        case '-':
        case '_':
          e.preventDefault();
          if (this.viewport.zoomByFactor(1 / ZOOM_BUTTON_FACTOR)) this.cb.onViewportChange();
          return;
        case '0':
          e.preventDefault();
          if (this.viewport.resetZoom()) this.cb.onViewportChange();
          return;
        default:
          /* Give the tool first refusal, then leave it to the browser.
           *
           * This used to `return` unconditionally, which was fine until Phase 4b
           * added ⌘A / Ctrl+A for select-all — the handler existed, was wired up,
           * and could never fire, because the event never got here. Offering the
           * delegate the event and only calling `preventDefault` when it says it
           * consumed the key keeps the original intent (unclaimed combos belong
           * to the browser) without the dead branch. */
          if (this.delegate.onKeyDown(e)) e.preventDefault();
          return;
      }
    }

    if (this.delegate.onKeyDown(e)) e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') {
      this.spaceHeld = false;
      this.emitPanState();
    }
  };

  /**
   * Window blur: keyup never arrives, so without this the app is stuck
   * believing space is held until you press and release it again. Also cancels
   * any in-progress shape — alt-tabbing away mid-drag and coming back to a
   * rubber-banding rectangle is worse than losing the shape.
   */
  private onBlur = (): void => {
    if (this.gesture === 'tool') this.delegate.onCancel();
    this.spaceHeld = false;
    this.gesture = 'none';
    this.activePointerId = null;
    this.emitPanState();
  };

  /* ── helpers ────────────────────────────────────────────────────────────── */

  private toCanvas(e: { clientX: number; clientY: number }): Point {
    this.rect ??= this.target.getBoundingClientRect();
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }

  /**
   * `MouseEvent` as well as `PointerEvent`, because `dblclick` is a MouseEvent.
   *
   * The two fields a mouse event lacks get the values a mouse would report
   * anyway — a constant 0.5 pressure and `'mouse'` — rather than being made
   * optional. Optional fields here would push a `?? 0.5` into every consumer,
   * and one of them would eventually forget.
   */
  private info(e: PointerEvent | MouseEvent): PointerInfo {
    const screen = this.toCanvas(e);
    return {
      screen,
      scene: this.viewport.toScene(screen),
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      pressure: 'pressure' in e ? e.pressure : 0.5,
      pointerType: 'pointerType' in e ? e.pointerType : 'mouse',
    };
  }

  private emitPanState(): void {
    this.cb.onPanStateChange?.({
      spaceHeld: this.spaceHeld,
      panning: this.gesture === 'pan',
    });
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export { MAX_ZOOM, MIN_ZOOM, ZOOM_BUTTON_FACTOR };
