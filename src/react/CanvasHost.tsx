import { useEffect, useRef, useState } from 'react';
import { DARK_THEME, Engine, LIGHT_THEME } from '@engine/Engine';

interface Props {
  onEngineReady: (engine: Engine | null) => void;
}

/**
 * Mounts the two drawing surfaces and hands them to the engine.
 *
 * This component renders once per mount and then only when the cursor changes.
 * Add a `console.log` to its body, draw and pan for thirty seconds: it must
 * print nothing. That property is the architecture in one observable fact.
 *
 * Its real responsibilities are the three things only the DOM can tell us: how
 * big the canvases should be, what the device pixel ratio is, and whether the
 * user prefers a dark theme.
 *
 * ── Why two stacked canvases ────────────────────────────────────────────────
 *
 * The static canvas holds committed elements and is repainted only when the
 * scene or viewport changes. The interactive canvas holds the shape currently
 * being drawn and is cleared and redrawn every frame during a gesture. Because
 * it holds at most a couple of things, that costs a fraction of a millisecond
 * regardless of how many thousand elements exist below it.
 *
 * The interactive canvas is on top and owns all pointer events — it is what the
 * user is actually pointing at. The static canvas gets `pointer-events: none`
 * so it never intercepts anything.
 *
 * ── Why the wrapper div ─────────────────────────────────────────────────────
 *
 * `<canvas>` is a *replaced element*, like `<img>`: `width: auto` resolves to
 * its intrinsic size from the width/height attributes rather than stretching, so
 * `inset: 0` does not fill the parent. A ResizeObserver watching a canvas whose
 * `width` attribute you set from the callback is a feedback loop — in Phase 1 it
 * doubled the canvas every cycle until it reached 38,400 pixels. Measuring a
 * plain div breaks the loop.
 */
export function CanvasHost({ onEngineReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const interactiveRef = useRef<HTMLCanvasElement>(null);
  const [panAffordance, setPanAffordance] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const staticCanvas = staticRef.current;
    const interactiveCanvas = interactiveRef.current;
    if (container === null || staticCanvas === null || interactiveCanvas === null) return;

    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
    const engine = new Engine(
      staticCanvas,
      interactiveCanvas,
      prefersDark.matches ? DARK_THEME : LIGHT_THEME,
    );

    /* ── size ──────────────────────────────────────────────────────────────
       ResizeObserver, not window.onresize: `resize` fires only for the window,
       so it misses a collapsing sidebar, a split-pane drag, a CSS change, or the
       element moving into a differently-sized container. */
    const measure = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      // CSS size set explicitly, so it never derives from the width attribute.
      for (const canvas of [staticCanvas, interactiveCanvas]) {
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }

      engine.resize(rect.width, rect.height, dpr);
    };

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    measure();

    /* ── device pixel ratio ────────────────────────────────────────────────
       DPR is not constant. Drag the window from a Retina display to an external
       1080p monitor and it changes mid-session with nothing to announce it — the
       CSS size is identical, so ResizeObserver stays quiet and the canvas
       silently renders at half resolution.

       The idiom is a media query matching the *current* ratio: it stops matching
       the moment the ratio changes, which fires `change`. Each new ratio needs a
       new query, hence the re-arm. */
    let dprQuery: MediaQueryList | null = null;
    const onDprChange = () => {
      measure();
      watchDpr();
    };
    function watchDpr() {
      dprQuery?.removeEventListener('change', onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener('change', onDprChange);
    }
    watchDpr();

    /* ── theme ─────────────────────────────────────────────────────────────
       A canvas cannot inherit CSS colours, so the OS theme has to be read
       explicitly and pushed into the renderer. */
    const onThemeChange = (e: MediaQueryListEvent) => {
      engine.setTheme(e.matches ? DARK_THEME : LIGHT_THEME);
    };
    prefersDark.addEventListener('change', onThemeChange);

    /* ── cursor ────────────────────────────────────────────────────────────
       The one piece of engine state this component re-renders for, and it is
       genuinely discrete: it flips when space goes down or up, not per frame. */
    const unsubscribe = engine.subscribe(() => {
      const snap = engine.getSnapshot();
      setPanAffordance(snap.panAffordance);
      setCursor(snap.cursor);
    });

    /* ── fonts ─────────────────────────────────────────────────────────────
       The nastiest staleness bug in this phase, and it is silent.

       Text is measured when it changes and the result is cached on the element.
       If a webfont is still loading at that moment, `ctx.font` falls back to a
       different family with different metrics — no error, no warning — and every
       string is laid out against the wrong face. `document.fonts.ready` resolves
       once the initial set has settled; `loadingdone` fires for any that arrive
       later, which is what happens when a font is only requested once a glyph
       needing it is drawn.

       Re-measuring when nothing changed is free: `Scene.mutate` reports no
       change and the engine does not repaint. */
    const remeasure = () => {
      engine.remeasureText();
    };
    void document.fonts?.ready.then(remeasure);
    document.fonts?.addEventListener('loadingdone', remeasure);

    /* ── the document ──────────────────────────────────────────────────────
       Opened after `start()` so the canvas is already painting: a slow IndexedDB
       open would otherwise leave a blank screen with no grid and no explanation.
       The load lands a frame or two later and forces a full repaint. */
    engine.start();
    onEngineReady(engine);

    void engine.openDocument().then(({ loaded, dropped, error }) => {
      if (error !== null) console.warn(`[document] ${error}`);
      else if (dropped > 0) console.warn(`[document] restored ${loaded}, dropped ${dropped}`);
    });

    /* `pagehide` and `visibilitychange`, and both are needed.

       The debounce means the last 1.2 seconds of work is still in memory when a
       tab closes — which is exactly when a user closes a tab, because they have
       just finished. `pagehide` rather than `beforeunload`: on mobile a tab is
       far more often *discarded* than closed, and `beforeunload` does not fire
       for that. `visibilitychange` catches switching apps, which on iOS is the
       last event you are guaranteed to get. */
    const flush = () => {
      void engine.flushDocument();
    };
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHidden);

    return () => {
      unsubscribe();
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHidden);
      prefersDark.removeEventListener('change', onThemeChange);
      document.fonts?.removeEventListener('loadingdone', remeasure);
      dprQuery?.removeEventListener('change', onDprChange);
      ro.disconnect();
      engine.destroy();
      onEngineReady(null);
    };
    // Mount/unmount only. `onEngineReady` is memoised by the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={containerRef} className="canvas-host">
      <canvas ref={staticRef} className="layer layer-static" aria-hidden="true" />
      <canvas
        ref={interactiveRef}
        className="layer layer-interactive"
        /* Panning wins over everything — space-drag is modal. Otherwise the
           tool's own answer, which is a handle cursor when one is under the
           pointer and null the rest of the time. */
        style={{ cursor: panAffordance ? 'grabbing' : (cursor ?? 'crosshair') }}
        aria-label="Drawing canvas. Pick a tool from the toolbar, then drag to draw."
        role="img"
      />
    </div>
  );
}
