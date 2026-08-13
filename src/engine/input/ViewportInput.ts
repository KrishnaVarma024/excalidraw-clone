/**
 * Translates raw browser input into viewport operations.
 *
 * Nothing in here draws. Handlers do the minimum work needed to update the
 * viewport and then return — the actual painting happens later, once, in the
 * rAF loop. That separation is the reason a 240 Hz trackpad does not produce
 * 240 renders per second.
 *
 * ── Pointer Events, not mouse events ────────────────────────────────────────
 *
 * `pointerdown/move/up` unify mouse, touch and stylus behind one API, and carry
 * `pressure`, `tiltX/Y` and `pointerType` — all of which Phase 2's freehand
 * tool needs. There is no reason to write `mousedown` in 2026.
 *
 * ── setPointerCapture is not optional ───────────────────────────────────────
 *
 * Without it: start a pan, drag the cursor outside the window, release. The
 * `pointerup` is delivered to whatever is under the cursor — not to us — so the
 * app stays in "panning" forever and the canvas follows the mouse until you
 * click again. Capture routes every subsequent event for that `pointerId` to
 * the capturing element and releases automatically on `pointerup`.
 *
 * The tempting alternative — listening for `pointerup` on `window` — is worse:
 * you have to manage add/remove symmetry, you receive events from unrelated
 * pointers, and it breaks outright with multiple touch points.
 */

import type { Viewport } from '../viewport/Viewport';
import { MAX_ZOOM, MIN_ZOOM } from '../viewport/transform';

/** One notch of keyboard/button zoom. ~1.1 feels right; 1.5 feels violent. */
const ZOOM_BUTTON_FACTOR = 1.1;

/**
 * Rough pixel equivalents for line- and page-mode wheel deltas.
 *
 * `WheelEvent.deltaMode` is 0 (pixels), 1 (lines) or 2 (pages), and which one
 * you get depends on the browser, the OS, and whether the device is a trackpad
 * or a notched mouse wheel. Firefox on Windows reports lines where Chrome
 * reports pixels for the same physical gesture. Normalising here means the rest
 * of the code sees one unit.
 */
const LINE_HEIGHT_PX = 16;
const PAGE_HEIGHT_PX = 800;

function normalizeWheelDelta(delta: number, deltaMode: number): number {
  if (deltaMode === 1) return delta * LINE_HEIGHT_PX;
  if (deltaMode === 2) return delta * PAGE_HEIGHT_PX;
  return delta;
}

export interface ViewportInputCallbacks {
  /** Called whenever the viewport actually changed. */
  onChange: () => void;
  /** Called when the pan-affordance state changes, so the cursor can update. */
  onPanStateChange?: (state: { spaceHeld: boolean; panning: boolean }) => void;
}

export class ViewportInput {
  private spaceHeld = false;
  private panning = false;
  private panPointerId: number | null = null;
  private lastX = 0;
  private lastY = 0;

  private readonly abort = new AbortController();

  constructor(
    private readonly target: HTMLCanvasElement,
    private readonly viewport: Viewport,
    private readonly cb: ViewportInputCallbacks,
  ) {
    const { signal } = this.abort;
    const el = target;

    el.addEventListener('pointerdown', this.onPointerDown, { signal });
    el.addEventListener('pointermove', this.onPointerMove, { signal });
    el.addEventListener('pointerup', this.onPointerUp, { signal });
    el.addEventListener('pointercancel', this.onPointerUp, { signal });

    // `passive: false` is mandatory. Wheel listeners default to passive on the
    // document, and a passive listener may not call preventDefault() — so
    // without this the page scrolls (or the browser zooms) underneath us while
    // we also pan, and everything moves twice.
    el.addEventListener('wheel', this.onWheel, { signal, passive: false });

    // Keyboard on `window`, not the canvas: a <canvas> is not focusable by
    // default, so canvas-scoped key handlers silently never fire. Making it
    // focusable via tabindex would work but would also put it in the tab order
    // ahead of the toolbar, which is worse for keyboard users.
    window.addEventListener('keydown', this.onKeyDown, { signal });
    window.addEventListener('keyup', this.onKeyUp, { signal });

    // If the window loses focus mid-gesture the keyup never arrives, and the
    // app is stuck in "space is held" until you press and release it again.
    window.addEventListener('blur', this.onBlur, { signal });

    // Suppress the context menu so middle/right-drag panning is not interrupted.
    el.addEventListener('contextmenu', (e) => e.preventDefault(), { signal });
  }

  /** Remove every listener. One AbortController instead of ten removeEventListener calls. */
  destroy(): void {
    this.abort.abort();
  }

  get isPanning(): boolean {
    return this.panning;
  }

  get isSpaceHeld(): boolean {
    return this.spaceHeld;
  }

  /* ── pointer ────────────────────────────────────────────────────────────── */

  private onPointerDown = (e: PointerEvent): void => {
    // Middle button, or space-held left button. Both are the conventional pan
    // gestures; supporting only one annoys half your users.
    const wantsPan = e.button === 1 || (e.button === 0 && this.spaceHeld);
    if (!wantsPan) return;

    e.preventDefault();
    this.target.setPointerCapture(e.pointerId);
    this.panning = true;
    this.panPointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.emitPanState();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.panning || e.pointerId !== this.panPointerId) return;

    // Deltas from clientX/Y rather than movementX/Y: `movement*` is reported in
    // physical pixels on some platforms and CSS pixels on others, and is
    // affected by pointer acceleration. Differencing client coordinates is
    // boring, portable, and exactly what we want.
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.viewport.panBy(dx, dy)) this.cb.onChange();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.panPointerId) return;
    if (this.target.hasPointerCapture(e.pointerId)) {
      this.target.releasePointerCapture(e.pointerId);
    }
    this.panning = false;
    this.panPointerId = null;
    this.emitPanState();
  };

  /* ── wheel ──────────────────────────────────────────────────────────────── */

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();

    const dx = normalizeWheelDelta(e.deltaX, e.deltaMode);
    const dy = normalizeWheelDelta(e.deltaY, e.deltaMode);

    // A trackpad pinch arrives as a wheel event with ctrlKey synthesised true —
    // there is no separate "pinch" event on desktop. This is not a documented
    // API so much as a convention every browser follows, and it is also why
    // Ctrl+wheel on a mouse zooms: to the page they are indistinguishable.
    if (e.ctrlKey || e.metaKey) {
      const anchor = this.pointerToCanvas(e);
      if (this.viewport.zoomByDelta(dy, anchor)) this.cb.onChange();
      return;
    }

    // Plain two-finger scroll pans. Shift+wheel maps vertical to horizontal,
    // which is the platform convention for horizontal scrolling on a device
    // with only one wheel axis.
    const panX = e.shiftKey && dx === 0 ? -dy : -dx;
    const panY = e.shiftKey && dx === 0 ? 0 : -dy;
    if (this.viewport.panBy(panX, panY)) this.cb.onChange();
  };

  /* ── keyboard ───────────────────────────────────────────────────────────── */

  private onKeyDown = (e: KeyboardEvent): void => {
    // Never steal keys from a text field. Phase 7 adds a real <textarea>
    // overlay for text editing and this guard is what keeps space from panning
    // the canvas while someone is typing a word.
    if (isEditableTarget(e.target)) return;

    if (e.code === 'Space' && !e.repeat) {
      this.spaceHeld = true;
      e.preventDefault(); // otherwise space scrolls the page
      this.emitPanState();
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    // e.key rather than e.code: on a US layout zoom-in is Shift+'=' but the key
    // that arrives is '+', and on other layouts it is somewhere else entirely.
    // Matching the produced character handles all of them.
    switch (e.key) {
      case '=':
      case '+':
        e.preventDefault();
        if (this.viewport.zoomByFactor(ZOOM_BUTTON_FACTOR)) this.cb.onChange();
        break;
      case '-':
      case '_':
        e.preventDefault();
        if (this.viewport.zoomByFactor(1 / ZOOM_BUTTON_FACTOR)) this.cb.onChange();
        break;
      case '0':
        e.preventDefault();
        if (this.viewport.resetZoom()) this.cb.onChange();
        break;
      default:
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === 'Space') {
      this.spaceHeld = false;
      this.emitPanState();
    }
  };

  private onBlur = (): void => {
    if (!this.spaceHeld && !this.panning) return;
    this.spaceHeld = false;
    this.panning = false;
    this.panPointerId = null;
    this.emitPanState();
  };

  /* ── helpers ────────────────────────────────────────────────────────────── */

  /**
   * Convert a client-space event position to canvas-relative screen space.
   *
   * `getBoundingClientRect()` forces a layout flush, so calling it on every
   * `pointermove` would be a real cost. It is called only on wheel events here;
   * Phase 2 caches the rect and invalidates it from the ResizeObserver, which
   * is the right fix once pointer moves start needing it.
   */
  private pointerToCanvas(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.target.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private emitPanState(): void {
    this.cb.onPanStateChange?.({ spaceHeld: this.spaceHeld, panning: this.panning });
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export { MAX_ZOOM, MIN_ZOOM, ZOOM_BUTTON_FACTOR };
