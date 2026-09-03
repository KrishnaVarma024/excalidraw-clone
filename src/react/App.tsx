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
        <strong>Phase 9 — PNG and SVG export.</strong>
        <br />
        Export is not a screenshot: it frames the <em>content</em>, at a scale you
        choose, with no handles and no grid. The PNG path reuses{' '}
        <em>drawElement</em> with <strong>zero changes</strong> — a claim written
        into that file in Phase 2 and only now cashed. It just installs a different
        matrix.
        <br />
        SVG cannot reuse it, so it emits paths — from the <em>same</em> Rough.js
        drawable, generated from the <em>same</em> stored seed. Export twice and
        the bytes are identical, which is what makes Phase 10 possible.
      </div>
    </div>
  );
}
