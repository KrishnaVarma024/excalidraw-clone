import { useEffect, useRef, useState } from 'react';
import { DARK_THEME, Engine, LIGHT_THEME } from '@engine/Engine';

interface Props {
  onEngineReady: (engine: Engine | null) => void;
}

/**
 * Mounts the drawing surface and hands it to the engine.
 *
 * This component renders once per mount and then only when the pan cursor
 * changes. Add a `console.log` to its body and pan around for thirty seconds:
 * it must print nothing. That property is the whole architecture in one
 * observable fact — see ARCHITECTURE §1.
 *
 * Its real responsibilities are the three things only the DOM can tell us: how
 * big the canvas should be, what the device pixel ratio is, and whether the
 * user prefers a dark theme.
 *
 * ── Why the canvas is wrapped in a div ──────────────────────────────────────
 *
 * This looks like a redundant element. It is load-bearing, and leaving it out
 * produces a genuinely nasty bug.
 *
 * `<canvas>` is a *replaced element*, like `<img>`. Its intrinsic size comes
 * from the `width`/`height` **attributes**, and `width: auto` resolves to that
 * intrinsic size rather than stretching — so `position: absolute; inset: 0`
 * does *not* make a canvas fill its parent the way it would a div.
 *
 * Which sets up a feedback loop:
 *
 *     ResizeObserver fires → we measure the canvas → we set canvas.width =
 *     measured × dpr → the attribute change grows the element's CSS size →
 *     ResizeObserver fires again → …
 *
 * At dpr 2 the canvas doubles every cycle. A 1200px canvas reached 38,400px in
 * under a second, memory ballooned, and the grid silently stopped drawing
 * because its own line-count guard tripped.
 *
 * The fix is to break the loop: measure a plain `<div>` (which stretches
 * normally and is unaffected by anything we do to the canvas), and set the
 * canvas's CSS size *explicitly* so it never derives from its attributes.
 */
export function CanvasHost({ onEngineReady }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [panAffordance, setPanAffordance] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (container === null || canvas === null) return;

    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
    const engine = new Engine(canvas, prefersDark.matches ? DARK_THEME : LIGHT_THEME);

    /* ── size ──────────────────────────────────────────────────────────────
       ResizeObserver rather than window.onresize: `resize` fires only for the
       *window*, so it misses a collapsing sidebar, a split-pane drag, a CSS
       change, or the element moving into a differently-sized container — all of
       which change our canvas and none of which resize the window. */
    const measure = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      // CSS size: what the page lays out. Set explicitly — see the note above.
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;

      // Backing store: physical pixels. Assigned inside Engine.resize, which
      // guards against redundant writes because assigning canvas.width clears
      // the surface even when the value is unchanged.
      engine.resize(rect.width, rect.height, dpr);
    };

    const ro = new ResizeObserver(measure);
    ro.observe(container);
    measure();

    /* ── device pixel ratio ────────────────────────────────────────────────
       DPR is not constant. Drag the window from a Retina display to an external
       1080p monitor and it changes mid-session, with nothing to announce it —
       the CSS size is identical, so ResizeObserver stays quiet and the canvas
       silently renders at half resolution.

       The idiom is a media query matching the *current* ratio: it stops
       matching the moment the ratio changes, which fires `change`. Each new
       ratio needs a new query, hence the re-arm. */
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
       The one piece of engine state this component does re-render for, and it
       is genuinely discrete: it flips when space goes down or up, not per frame. */
    const unsubscribe = engine.subscribe(() => {
      setPanAffordance(engine.getSnapshot().panAffordance);
    });

    engine.start();
    onEngineReady(engine);

    return () => {
      unsubscribe();
      prefersDark.removeEventListener('change', onThemeChange);
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
      <canvas
        ref={canvasRef}
        style={{ cursor: panAffordance ? 'grabbing' : 'default' }}
        aria-label="Infinite drawing canvas. Use the zoom controls to navigate."
        role="img"
      />
    </div>
  );
}
