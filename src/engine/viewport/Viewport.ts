/**
 * Mutable holder for the viewport state, plus the canvas's measured size.
 *
 * The maths lives next door in `transform.ts` as pure functions. This class is
 * the thin stateful shell around it: it owns the current {@link ViewportState},
 * applies operations, and reports whether anything actually changed.
 *
 * That split is deliberate and it is the reason `transform.test.ts` can
 * property-test the transform over ten thousand random inputs without
 * constructing anything.
 */

import type { Bounds, Point } from '../util/geometry';
import {
  DEFAULT_VIEWPORT,
  type Matrix2D,
  type ViewportState,
  buildDeviceMatrix,
  fitToBounds,
  getVisibleSceneBounds,
  panByScreenDelta,
  screenToScene,
  sceneToScreen,
  viewportEquals,
  zoomAtPoint,
  zoomStep,
} from './transform';

export class Viewport {
  private state: ViewportState = DEFAULT_VIEWPORT;

  /** Canvas size in CSS pixels. Updated by the ResizeObserver in CanvasHost. */
  private cssWidth = 0;
  private cssHeight = 0;

  /** Device pixel ratio at last measure. Can change mid-session — see CanvasHost. */
  private dpr = 1;

  get(): ViewportState {
    return this.state;
  }

  get zoom(): number {
    return this.state.zoom;
  }

  get width(): number {
    return this.cssWidth;
  }

  get height(): number {
    return this.cssHeight;
  }

  get devicePixelRatio(): number {
    return this.dpr;
  }

  /** Centre of the canvas in screen space. The default zoom anchor. */
  get center(): Point {
    return { x: this.cssWidth / 2, y: this.cssHeight / 2 };
  }

  /**
   * Apply a new state. Returns `true` if it differs from the current one.
   *
   * Every mutator funnels through here so that "did the view change?" has
   * exactly one answer, computed one way. The renderer uses that boolean to
   * decide whether to draw at all — see `Engine.markDirty`.
   */
  private set(next: ViewportState): boolean {
    if (viewportEquals(this.state, next)) return false;
    this.state = next;
    return true;
  }

  setSize(cssWidth: number, cssHeight: number, dpr: number): boolean {
    if (this.cssWidth === cssWidth && this.cssHeight === cssHeight && this.dpr === dpr) {
      return false;
    }
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    return true;
  }

  /** Pan by a delta measured in screen pixels. */
  panBy(dxScreen: number, dyScreen: number): boolean {
    return this.set(panByScreenDelta(this.state, dxScreen, dyScreen));
  }

  /** Set zoom to an absolute value, keeping `anchor` (screen space) fixed. */
  zoomTo(nextZoom: number, anchor: Point = this.center): boolean {
    return this.set(zoomAtPoint(this.state, anchor, nextZoom));
  }

  /**
   * Zoom by a wheel-style delta, keeping `anchor` fixed.
   * Negative delta zooms in, matching `WheelEvent.deltaY` sign conventions.
   */
  zoomByDelta(delta: number, anchor: Point = this.center, sensitivity?: number): boolean {
    return this.zoomTo(zoomStep(this.state.zoom, delta, sensitivity), anchor);
  }

  /** Multiply zoom by a factor (1.1 = in one notch, 1/1.1 = out). */
  zoomByFactor(factor: number, anchor: Point = this.center): boolean {
    return this.zoomTo(this.state.zoom * factor, anchor);
  }

  reset(): boolean {
    return this.set(DEFAULT_VIEWPORT);
  }

  /** Zoom to 100% about the canvas centre, preserving what is under the centre. */
  resetZoom(): boolean {
    return this.zoomTo(1, this.center);
  }

  fit(bounds: Bounds, padding?: number): boolean {
    return this.set(fitToBounds(bounds, this.cssWidth, this.cssHeight, padding));
  }

  /* ── conversions, bound to the current state ────────────────────────────── */

  toScene(screenPoint: Point): Point {
    return screenToScene(screenPoint, this.state);
  }

  toScreen(scenePoint: Point): Point {
    return sceneToScreen(scenePoint, this.state);
  }

  visibleSceneBounds(): Bounds {
    return getVisibleSceneBounds(this.state, this.cssWidth, this.cssHeight);
  }

  deviceMatrix(): Matrix2D {
    return buildDeviceMatrix(this.state, this.dpr);
  }
}
