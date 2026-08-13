import type { Engine } from '@engine/Engine';
import { useEngineState } from './useEngineState';

interface Props {
  engine: Engine;
}

/**
 * Zoom out / reset / zoom in, plus zoom-to-fit.
 *
 * A textbook use of `useSyncExternalStore`: every value read here is discrete.
 * A pan re-renders this zero times. A smooth pinch from 100% to 103% re-renders
 * it three times — once per whole percent — rather than once per frame, because
 * the engine compares the *rounded* value before notifying.
 *
 * Contrast with StatsOverlay, which needs per-frame numbers and therefore
 * deliberately does not use this hook.
 */
export function ZoomControls({ engine }: Props) {
  const { zoomPercent, canZoomIn, canZoomOut, elementCount } = useEngineState(engine);

  return (
    <div className="zoom-controls" role="group" aria-label="Zoom">
      <button
        type="button"
        onClick={() => engine.zoomOut()}
        disabled={!canZoomOut}
        aria-label="Zoom out"
        title="Zoom out (⌘−)"
      >
        −
      </button>

      <button
        type="button"
        className="zoom-reset"
        onClick={() => engine.resetZoom()}
        // aria-live so a screen reader announces the new level after a pinch,
        // which is otherwise a completely silent change.
        aria-live="polite"
        title="Reset zoom to 100% (⌘0)"
      >
        {zoomPercent}%
      </button>

      <button
        type="button"
        onClick={() => engine.zoomIn()}
        disabled={!canZoomIn}
        aria-label="Zoom in"
        title="Zoom in (⌘+)"
      >
        +
      </button>

      <button
        type="button"
        className="zoom-fit"
        onClick={() => engine.zoomToFit()}
        // Disabled rather than hidden: a control that appears and disappears as
        // you draw makes the toolbar jump under the cursor.
        disabled={elementCount === 0}
        aria-label="Zoom to fit drawing"
        title="Zoom to fit"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
          </g>
        </svg>
      </button>
    </div>
  );
}
