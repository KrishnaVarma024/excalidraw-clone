import { useEffect, useRef } from 'react';

/**
 * Mounts the drawing surface.
 *
 * This component is the *only* place React and the canvas meet, and it is
 * deliberately almost empty. React's job here is to put a `<canvas>` node in
 * the document and then get out of the way. Everything that happens on that
 * canvas from Phase 1 onward is driven by the engine, outside React's render
 * cycle — see ARCHITECTURE §1 for why.
 *
 * The tell that this is working: from Phase 1, you will be able to pan and zoom
 * for thirty seconds and this component will not re-render once.
 *
 * ── What is intentionally missing in Phase 0 ─────────────────────────────────
 * There is no `devicePixelRatio` handling, so on a Retina display this square
 * is rendered at half resolution and looks soft. That is not an oversight; the
 * roadmap wants a real "before" to compare against. Phase 1 introduces
 * `Viewport` and a DPR-aware resize path, and the difference is visible in a
 * screenshot.
 */
export function CanvasHost() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      // Genuinely possible: some hardened browser configurations and headless
      // environments refuse a 2D context. Failing loudly beats a blank page.
      throw new Error('2D canvas context unavailable in this browser.');
    }

    const draw = () => {
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);

      ctx.fillStyle = '#5b57d1';
      ctx.fillRect(width / 2 - 60, height / 2 - 60, 120, 120);

      // A 1px hairline, to make the DPR problem obvious. On a 2× display this
      // renders as a soft 2-physical-pixel smudge rather than a crisp line.
      ctx.strokeStyle = '#1b1b1f';
      ctx.lineWidth = 1;
      ctx.strokeRect(width / 2 - 100.5, height / 2 - 100.5, 201, 201);
    };

    // ResizeObserver, not window.onresize: it fires for any layout change that
    // affects this element — a collapsing sidebar, a split-pane drag — not just
    // window resizes. Phase 1 builds the DPR-aware version on top of this.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;

      // Assigning to canvas.width/height resets the backing store AND the
      // current transform, and clears the surface. Any resize therefore forces
      // a full repaint — a constraint that shapes the whole dirty-rect design
      // in Phase 5.
      canvas.width = Math.round(width);
      canvas.height = Math.round(height);
      draw();
    });

    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  return <canvas ref={canvasRef} className="canvas-host" />;
}
