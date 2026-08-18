import { useCallback, useState } from 'react';
import type { Engine } from '@engine/Engine';
import { CanvasHost } from './CanvasHost';
import { DevPanel } from './DevPanel';
import { SelectionBar } from './SelectionBar';
import { StatsOverlay } from './StatsOverlay';
import { StylePanel } from './StylePanel';
import { Toolbar } from './Toolbar';
import { ZoomControls } from './ZoomControls';

export function App() {
  // The engine is created by CanvasHost, because it needs real <canvas>
  // elements to exist first. It is reported back up so the chrome can talk to
  // it. `useState` rather than a ref: the chrome genuinely does need to render
  // once when the engine appears.
  const [engine, setEngine] = useState<Engine | null>(null);
  const handleEngineReady = useCallback((e: Engine | null) => setEngine(e), []);

  return (
    <div className="app">
      <CanvasHost onEngineReady={handleEngineReady} />

      {engine !== null && (
        <>
          <Toolbar engine={engine} />
          <StylePanel engine={engine} />
          <ZoomControls engine={engine} />
          <StatsOverlay engine={engine} />
          <DevPanel engine={engine} />
          <SelectionBar engine={engine} />
        </>
      )}

      <div className="badge">
        <strong>Phase 6 — move, resize, rotate.</strong>
        <br />
        Every gesture transforms from the <em>snapshot</em> taken when the pointer
        landed, never from the shape&rsquo;s current state. Press Shift mid-resize:
        the ratio locks to what you originally drew, not to whatever the shape
        happens to be at that instant. Incremental code cannot do that.
        <br />
        Load <em>50k</em>, select a shape and drag it. <em>coverage</em> stays
        around a percent — this is where Phase 5 gets spent, because a committed
        element moving mutates the scene on every frame. Select twenty and drag:
        it flips to <em>full</em>, which is the fallback working.
      </div>
    </div>
  );
}
