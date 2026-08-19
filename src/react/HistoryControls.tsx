import type { Engine } from '@engine/Engine';
import { useEngineState } from './useEngineState';

interface Props {
  engine: Engine;
}

/**
 * Undo, redo, and the one piece of bad news this app is willing to interrupt for.
 *
 * ── Why buttons at all, when ⌘Z exists ─────────────────────────────────────
 *
 * Because a disabled undo button is the only thing that tells you the stack is
 * empty. Press ⌘Z on an empty stack and nothing happens, which is
 * indistinguishable from ⌘Z being broken — and the second interpretation is the
 * one people reach for, because it is the one that has been true before.
 *
 * ── The storage warning ────────────────────────────────────────────────────
 *
 * IndexedDB is unavailable in some private-browsing modes and can be switched
 * off. When it is, this says so. The alternative is a canvas that quietly forgets
 * everything when the tab closes, which the user finds out about in the worst
 * possible way. Everything else in this UI is out of the way on purpose; this one
 * is not, because it is about losing work.
 */
export function HistoryControls({ engine }: Props) {
  const { canUndo, canRedo, storageError } = useEngineState(engine);

  return (
    <div className="history-controls">
      {storageError !== null && (
        <div className="history-warning" role="status">
          Not saving — {storageError}
        </div>
      )}

      <div className="history-buttons" role="group" aria-label="History">
        <button
          type="button"
          onClick={() => engine.undo()}
          disabled={!canUndo}
          aria-label="Undo"
          title="Undo (⌘Z)"
        >
          {/* Arrows rather than the words: the icon is understood before it is
              read, and at this size a word would not fit anyway. */}
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M9 14 4 9l5-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M4 9h9a6 6 0 0 1 0 12h-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          type="button"
          onClick={() => engine.redo()}
          disabled={!canRedo}
          aria-label="Redo"
          title="Redo (⌘⇧Z)"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="m15 14 5-5-5-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M20 9h-9a6 6 0 0 0 0 12h3"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
