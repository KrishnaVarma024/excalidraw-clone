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
        <strong>Phase 5 — dirty-rectangle rendering.</strong>
        <br />
        The screen is already correct; only what changed gets repaired. Load{' '}
        <em>50k</em>, then draw one shape and watch <em>coverage</em> — the fraction
        of the screen actually repainted. It should be a fraction of a percent.
        <br />
        Now pan. <em>full repaints</em> climbs, and its reason says{' '}
        <em>global</em>: every pixel moved, so there is nothing for dirty rectangles
        to save. Knowing when to give up is the whole trick.
      </div>
    </div>
  );
}
