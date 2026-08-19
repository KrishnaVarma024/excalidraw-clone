import type { Engine } from '@engine/Engine';
import type { ToolType } from '@engine/tools/ToolManager';
import { useEngineState } from './useEngineState';

interface Props {
  engine: Engine;
}

interface ToolDef {
  tool: ToolType;
  label: string;
  shortcut: string;
  icon: React.ReactNode;
}

/**
 * Icons as inline SVG paths rather than an icon library.
 *
 * Seven icons is not worth a dependency, a bundle-size conversation, and a
 * tree-shaking configuration. `currentColor` means they inherit the button's
 * colour, so the active and hover states are pure CSS.
 */
const TOOLS: readonly ToolDef[] = [
  {
    tool: 'selection',
    label: 'Select',
    shortcut: 'V',
    icon: <path d="M4 3 L4 17 L8 13 L11 19 L13 18 L10 12 L15 12 Z" />,
  },
  {
    tool: 'rectangle',
    label: 'Rectangle',
    shortcut: 'R',
    icon: <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />,
  },
  {
    tool: 'diamond',
    label: 'Diamond',
    shortcut: 'D',
    icon: <path d="M12 3.5 L20.5 12 L12 20.5 L3.5 12 Z" />,
  },
  {
    tool: 'ellipse',
    label: 'Ellipse',
    shortcut: 'O',
    icon: <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />,
  },
  {
    tool: 'arrow',
    label: 'Arrow',
    shortcut: 'A',
    icon: <path d="M3 18 L20 6 M20 6 L13.5 7 M20 6 L19 12.5" />,
  },
  {
    tool: 'line',
    label: 'Line',
    shortcut: 'L',
    icon: <path d="M3.5 18.5 L20.5 5.5" />,
  },
  {
    tool: 'freedraw',
    label: 'Draw',
    shortcut: 'P',
    icon: <path d="M3 17c3-1 4-9 7-9s2 8 5 8 4-5 6-6" />,
  },
  {
    tool: 'text',
    label: 'Text',
    shortcut: 'T',
    icon: (
      <>
        <path d="M5 6h14" />
        <path d="M12 6v13" />
      </>
    ),
  },
];

/**
 * Tool picker.
 *
 * A textbook use of `useSyncExternalStore`: `activeTool` changes when a human
 * clicks a button or presses a key — a few dozen times a minute, not per frame.
 * Drawing a shape re-renders this zero times.
 *
 * Rendered as a `radiogroup` because that is what it is: one of N mutually
 * exclusive options. Screen readers then announce "Rectangle, selected, 2 of 7"
 * rather than reading seven unrelated buttons.
 */
export function Toolbar({ engine }: Props) {
  const { activeTool, elementCount } = useEngineState(engine);

  return (
    <div className="toolbar" role="radiogroup" aria-label="Drawing tools">
      {TOOLS.map(({ tool, label, shortcut, icon }) => (
        <button
          key={tool}
          type="button"
          role="radio"
          aria-checked={activeTool === tool}
          className={activeTool === tool ? 'tool tool-active' : 'tool'}
          onClick={() => engine.setTool(tool)}
          title={`${label} — ${shortcut}`}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <g
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {icon}
            </g>
          </svg>
          <span className="tool-shortcut" aria-hidden="true">
            {shortcut}
          </span>
          <span className="sr-only">{label}</span>
        </button>
      ))}

      <div className="toolbar-divider" role="none" />

      <button
        type="button"
        className="tool tool-danger"
        onClick={() => engine.clearScene()}
        disabled={elementCount === 0}
        title="Clear canvas"
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 7h14M10 7V5h4v2M6.5 7l1 12h9l1-12" />
          </g>
        </svg>
        <span className="sr-only">Clear canvas</span>
      </button>
    </div>
  );
}
