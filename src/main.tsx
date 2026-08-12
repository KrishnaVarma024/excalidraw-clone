import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@react/App';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root not found — index.html and main.tsx have disagreed about something.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
