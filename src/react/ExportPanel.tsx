import { useCallback, useEffect, useRef, useState } from 'react';
import type { Engine } from '@engine/Engine';
import { EXPORT_SCALES, type ExportScale } from '@engine/export/bounds';
import { useEngineState } from './useEngineState';

interface Props {
  engine: Engine;
}

/**
 * Export controls.
 *
 * ── Show the output size before committing ─────────────────────────────────
 *
 * The panel reads back the dimensions an export *would* have, and says so. Two
 * reasons, and the second is the one that matters:
 *
 *   1. "3×" means nothing on its own. "4,806 × 3,120" is a decision the user can
 *      make.
 *   2. It is where the **clamp** becomes visible. Browsers cap canvas size, so a
 *      3× export of a large drawing silently comes back smaller. Telling the
 *      user *before* they press the button — "3× → 1.4×, capped by the browser"
 *      — turns a confusing result into an informed choice.
 *
 * ── Disabled, not hidden ───────────────────────────────────────────────────
 *
 * "Selection only" is disabled with nothing selected, and the export buttons are
 * disabled on an empty canvas. A control that vanishes leaves the user
 * wondering whether the feature exists; a greyed-out one says the feature exists
 * and this is not the moment.
 */
export function ExportPanel({ engine }: Props) {
  const { elementCount, selectedCount } = useEngineState(engine);

  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState<ExportScale>(2);
  const [background, setBackground] = useState(true);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /* Selection-only cannot survive the selection going away — it would silently
     export nothing and look like a broken button. */
  const scoped = selectionOnly && selectedCount > 0;

  const preview = open ? engine.exportPreview({ selectionOnly: scoped, scale }) : null;

  /* Cleared on a timer, and the timer is cleaned up. A stray `setState` after
     unmount is a React warning nobody reads and, in a longer-lived component, a
     real leak. */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((text: string) => {
    setMessage(text);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 4000);
  }, []);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const png = async () => {
    setBusy(true);
    try {
      const size = await engine.exportPng({ scale, background, selectionOnly: scoped });
      if (size === null) say('Nothing to export.');
      else if (size.clamped) {
        say(`Exported at ${size.scale.toFixed(2)}× — ${scale}× exceeds the browser's canvas limit.`);
      } else say(`Exported ${size.width} × ${size.height}.`);
    } catch (error) {
      // Surfaced, not swallowed. The message from `toPng` names the one thing
      // that might help: try a smaller scale.
      say(error instanceof Error ? error.message : 'Export failed.');
    } finally {
      setBusy(false);
    }
  };

  const svg = () => {
    if (engine.exportSvg({ background, selectionOnly: scoped })) say('Exported SVG.');
    else say('Nothing to export.');
  };

  if (!open) {
    return (
      <div className="export-panel">
        <button type="button" className="export-toggle" onClick={() => setOpen(true)}>
          Export
        </button>
      </div>
    );
  }

  return (
    <div className="export-panel export-open" aria-label="Export">
      <div className="export-header">
        <span>Export</span>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close export panel">
          ×
        </button>
      </div>

      <label className="export-check">
        <input type="checkbox" checked={background} onChange={(e) => setBackground(e.target.checked)} />
        <span>Background</span>
      </label>

      <label className="export-check">
        <input
          type="checkbox"
          checked={scoped}
          disabled={selectedCount === 0}
          onChange={(e) => setSelectionOnly(e.target.checked)}
        />
        <span>Selection only{selectedCount > 0 ? ` (${selectedCount})` : ''}</span>
      </label>

      <div className="export-row" role="group" aria-label="Scale">
        {EXPORT_SCALES.map((s) => (
          <button
            key={s}
            type="button"
            className={s === scale ? 'seg seg-active' : 'seg'}
            onClick={() => setScale(s)}
            aria-pressed={s === scale}
          >
            {s}×
          </button>
        ))}
      </div>

      <div className="export-size">
        {preview === null
          ? 'Nothing to export'
          : `${preview.width} × ${preview.height} px${preview.clamped ? ' (capped)' : ''}`}
      </div>

      <div className="export-row">
        <button type="button" className="seg" onClick={() => void png()} disabled={busy || elementCount === 0}>
          {busy ? '…' : 'PNG'}
        </button>
        <button type="button" className="seg" onClick={svg} disabled={busy || elementCount === 0}>
          SVG
        </button>
      </div>

      {message !== null && (
        <div className="export-message" role="status">
          {message}
        </div>
      )}
    </div>
  );
}
