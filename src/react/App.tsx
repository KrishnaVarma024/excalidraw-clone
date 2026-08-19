import { useCallback, useState } from 'react';
import type { Engine } from '@engine/Engine';
import { CanvasHost } from './CanvasHost';
import { DevPanel } from './DevPanel';
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
          <TextEditor engine={engine} />
        </>
      )}

      <div className="badge">
        <strong>Phase 7 — text.</strong>
        <br />
        Press <em>T</em> and click, then type. This is the first element whose
        size this codebase does not decide — the browser does, via{' '}
        <em>measureText</em> — so the measurement is passed in and the result is
        cached on the element. That is what keeps the engine unit-testable in Node
        with no canvas at all.
        <br />
        The caret is a real <em>&lt;textarea&gt;</em> lined up on top of the
        canvas. Not a shortcut: it is what makes IME, spellcheck, the mobile
        keyboard and every screen reader work. Type, then press Escape — the
        glyphs land in exactly the same pixels, at any zoom.
        <br />
        Drag a <em>side</em> handle to wrap the text; drag a <em>corner</em> to
        scale the type. Text has a width but not a height — the height is however
        many lines it wrapped to.
      </div>
    </div>
  );
}
