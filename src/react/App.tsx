import { useCallback, useState } from 'react';
import type { Engine } from '@engine/Engine';
import { CanvasHost } from './CanvasHost';
import { DevPanel } from './DevPanel';
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
        </>
      )}

      <div className="badge">
        <strong>Phase 3 — the performance lab.</strong>
        <br />
        Load <em>50k</em> from the panel on the right, then zoom into a corner.{' '}
        <em>draw</em> collapses to almost nothing while <em>cull</em> does not move —
        because the cull examines every element that exists, not every element you
        can see.
        <br />
        That gap is the case for a quadtree, and Phase 4 is finished when{' '}
        <em>tested</em> stops tracking <em>total</em>.
      </div>
    </div>
  );
}
