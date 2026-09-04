import { useCallback, useState } from 'react';
import type { Engine } from '@engine/Engine';
import { CanvasHost } from './CanvasHost';
import { DevPanel } from './DevPanel';
import { ExportPanel } from './ExportPanel';
import { HistoryControls } from './HistoryControls';
import { TextEditor } from './TextEditor';
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
          <HistoryControls engine={engine} />
          <ExportPanel engine={engine} />
          <TextEditor engine={engine} />
        </>
      )}

      <div className="badge">
        <strong>Phase 10 — every claim is a gate.</strong>
        <br />
        Nine phases made load-bearing claims. Each one is now an integer in{' '}
        <em>tests/budget/budget.json</em> that fails the build when it moves —
        counts, never timings, so a busy CI runner cannot make it red.
        <br />
        Visual regression with <strong>no browser and no pixel diff</strong>: the
        SVG export is deterministic (Phase 2's stored seed, Phase 9's DOM-free
        serialiser), so the golden file is text you can read in a diff.
        <br />
        And containment, in two places, because a React error boundary cannot
        catch a throw inside <em>requestAnimationFrame</em> — where the whole
        render loop lives.
      </div>
    </div>
  );
}
