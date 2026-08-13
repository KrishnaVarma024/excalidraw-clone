import type { Engine } from '@engine/Engine';
import { useEngineState } from './useEngineState';

interface Props {
  engine: Engine;
}

/**
 * Zoom out / reset / zoom in.
 *
 * This is what `useSyncExternalStore` is *for*: the values it reads
 * (`zoomPercent`, and whether each button should be disabled) are discrete.
 * A pan changes none of them and re-renders this zero times. A smooth pinch
 * from 100% to 103% re-renders it three times — once per whole percent — rather
 * than once per frame, because the engine compares the rounded value before
 * notifying.
 *
 * Contrast with StatsOverlay, which needs per-frame numbers and therefore
 * deliberately does not use this hook.
 */
export function ZoomControls({ engine }: Props) {
  const { zoomPercent, canZoomIn, canZoomOut } = useEngineState(engine);

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
    </div>
  );
}
