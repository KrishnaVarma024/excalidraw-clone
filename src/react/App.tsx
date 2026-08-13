import { useCallback, useState } from 'react';
import type { Engine } from '@engine/Engine';
import { CanvasHost } from './CanvasHost';
import { StatsOverlay } from './StatsOverlay';
import { ZoomControls } from './ZoomControls';

export function App() {
  // The engine is created by CanvasHost, because it needs a real <canvas>
  // element to exist first. It is reported back up so the chrome components
  // can talk to it. `useState` rather than a ref: the chrome genuinely does
  // need to render once when the engine appears.
  const [engine, setEngine] = useState<Engine | null>(null);
  const handleEngineReady = useCallback((e: Engine | null) => setEngine(e), []);

  return (
    <div className="app">
      <CanvasHost onEngineReady={handleEngineReady} />

      {engine !== null && (
        <>
          <ZoomControls engine={engine} />
          <StatsOverlay engine={engine} />
        </>
      )}

      <div className="badge">
        <strong>Phase 1 — infinite viewport.</strong>
        <br />
        Two-finger scroll or <kbd>space</kbd>-drag to pan · pinch or <kbd>⌘</kbd>-scroll to zoom
        at the cursor · <kbd>⌘</kbd>
        <kbd>0</kbd> to reset.
        <br />
        The grid picks its own spacing as you zoom, and the frame counter should sit at zero
        work while you are not touching anything.
      </div>
    </div>
  );
}
