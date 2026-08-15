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
        <strong>Phase 4b — hit detection and selection.</strong>
        <br />
        <kbd>V</kbd> for the selection tool · click a shape · <kbd>shift</kbd>-click to
        add · drag on empty canvas for a rubber band · <kbd>⌘A</kbd> selects all ·{' '}
        <kbd>⌫</kbd> deletes · <kbd>esc</kbd> deselects.
        <br />
        Load <em>50k</em> and click around: <em>hit broad/narrow</em> shows how many
        candidates the index handed to the exact geometry test. It is usually under
        ten, out of fifty thousand.
      </div>
    </div>
  );
}
