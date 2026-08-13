import { useCallback, useState } from 'react';
import type { Engine } from '@engine/Engine';
import { CanvasHost } from './CanvasHost';
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
        </>
      )}

      <div className="badge">
        <strong>Phase 2 — shapes and freehand.</strong>
        <br />
        Pick a tool (<kbd>R</kbd> <kbd>D</kbd> <kbd>O</kbd> <kbd>A</kbd> <kbd>L</kbd>{' '}
        <kbd>P</kbd>) and drag · <kbd>shift</kbd> constrains to a square or 15°{' '}
        · <kbd>esc</kbd> cancels mid-draw · <kbd>space</kbd>-drag still pans.
        <br />
        No selection or undo yet — those are Phases 4 and 8. Watch{' '}
        <em>drawn/total</em> as you pan: only what is on screen is ever drawn.
      </div>
    </div>
  );
}
