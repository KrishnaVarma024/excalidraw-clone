import { CanvasHost } from './CanvasHost';

export function App() {
  return (
    <div className="app">
      <CanvasHost />
      <div className="badge">
        <strong>Phase 0 — scaffold.</strong> One square, drawn once, with no viewport transform.
        <br />
        On a HiDPI display it is blurry. That is deliberate: Phase 1 fixes it, and the
        before/after is the point.
      </div>
    </div>
  );
}
