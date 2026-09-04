import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@react/App';
import { ErrorBoundary } from '@react/ErrorBoundary';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root not found — index.html and main.tsx have disagreed about something.');
}

createRoot(container).render(
  /* Outside App, because a boundary catches its CHILDREN and never itself:
     put it inside App and App's own render is unprotected, which is most of the
     tree. Its position relative to StrictMode makes no difference — errors
     propagate up through it either way.

     What this arrangement does NOT cover is worth knowing precisely, because it
     is most of the app: an error boundary catches errors thrown during render,
     in lifecycle methods, and in constructors. It does not catch them in event
     handlers, in promises, or in `requestAnimationFrame` callbacks. The engine's
     entire render loop is a rAF callback. **Nothing React offers can catch a
     throw inside it** — which is exactly why `DrawGuard` exists as a separate
     mechanism rather than being folded into this one. */
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
