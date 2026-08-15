import type { Engine } from '@engine/Engine';
import { useEngineState } from './useEngineState';

interface Props {
  engine: Engine;
}

/**
 * The "n selected" pill.
 *
 * ── Why this is a separate component ────────────────────────────────────────
 *
 * It could live in the toolbar. Keeping it apart means the toolbar does not
 * re-render when the selection changes — and during a marquee drag the
 * selection changes on every frame, because the rubber band updates the
 * selection live rather than only on release.
 *
 * So this component re-renders many times a second while a marquee is open, and
 * the toolbar, style panel and zoom controls do not. That is the whole reason
 * `useSyncExternalStore` reads a *snapshot* rather than individual values:
 * React re-renders whoever subscribed to something that changed, and component
 * boundaries decide how much that costs.
 *
 * `selectedCount` is still a discrete value — an integer a human can read — so
 * it belongs in the store rather than in the per-frame channel. It changes
 * maybe forty times during a drag, not sixty times a second.
 */
export function SelectionBar({ engine }: Props) {
  const { selectedCount } = useEngineState(engine);

  // Rendering nothing is the correct empty state here. A pill reading
  // "0 selected" is noise that never goes away.
  if (selectedCount === 0) return null;

  return (
    <div className="selection-bar" role="status" aria-live="polite">
      <span className="selection-count">
        {selectedCount} selected
      </span>
      <button
        type="button"
        className="selection-delete"
        onClick={() => engine.deleteSelected()}
        title="Delete selection (⌫)"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
          </g>
        </svg>
        Delete
      </button>
    </div>
  );
}
