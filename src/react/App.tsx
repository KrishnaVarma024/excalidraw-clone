import { useCallback, useState } from 'react';
import type { Engine } from '@engine/Engine';
import { CanvasHost } from './CanvasHost';
import { DevPanel } from './DevPanel';
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
          <TextEditor engine={engine} />
        </>
      )}

      <div className="badge">
        <strong>Phase 8 — undo, redo and persistence.</strong>
        <br />
        Draw something, drag it for three seconds, then press <em>⌘Z</em> once.
        One gesture is one undo step, not one per frame — a three-second drag is
        about 180 mutations and exactly one entry.
        <br />
        Reload the page. It is still there: the document autosaves to IndexedDB
        after 1.2&nbsp;s of quiet, and flushes when the tab hides. Not
        localStorage — a 50,000-element document is <em>24.7&nbsp;MB</em>, and the
        quota is about five.
      </div>
    </div>
  );
}
