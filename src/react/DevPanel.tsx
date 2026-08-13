import { useCallback, useEffect, useRef, useState } from 'react';
import type { Engine, FrameInfo } from '@engine/Engine';
import { SCENE_PRESETS } from '@engine/dev/generateScene';
import { STAGE_NAMES } from '@engine/util/perf';
import { useEngineState } from './useEngineState';

interface Props {
  engine: Engine;
}

/**
 * The performance lab's control surface.
 *
 * ── Why a load generator is a first-class part of the app ───────────────────
 *
 * Phase 4 replaces the O(n) cull with a quadtree. Phase 5 replaces full repaint
 * with dirty rectangles. Both are the headline claims of this project, and
 * neither is worth making without a *before* number — which means the app has to
 * be able to hurt on demand, reproducibly, on any machine.
 *
 * So this is not a debug toy bolted on the side. It is the instrument the next
 * two phases are graded against, and it ships with the app (behind a toggle)
 * rather than living in a scratch file that rots.
 *
 * ── The one interesting piece of UI engineering here ────────────────────────
 *
 * Generating 50,000 elements takes long enough to be visible, and it happens
 * synchronously on the main thread. Naively:
 *
 *     setBusy(true);
 *     engine.generateScene({ count: 50_000 });   // blocks ~300ms
 *     setBusy(false);
 *
 * …never shows the busy state. React batches the update, and the browser has no
 * opportunity to paint between the two `setBusy` calls — the whole thing is one
 * task. The user sees a frozen window and nothing else.
 *
 * The fix is to yield to the browser and let it paint *before* starting the
 * blocking work. One `requestAnimationFrame` is not enough: rAF callbacks run
 * *before* paint, so work scheduled in the first one still blocks that frame.
 * Two rAFs guarantee at least one frame has actually been presented.
 *
 * `setTimeout(fn, 0)` usually works too, but only by accident — it yields to the
 * task queue without promising a paint has happened. The double-rAF is the
 * version that states what it actually needs.
 */
export function DevPanel({ engine }: Props) {
  const { elementCount, perfMarks } = useEngineState(engine);
  const [descriptor, setDescriptor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  /**
   * The most recent frame report, kept in a ref rather than in state.
   *
   * The copy button needs the latest numbers at the moment it is *clicked*.
   * Putting them in state would re-render this panel eight times a second to
   * service a button that is pressed once a session — and the panel would then
   * be part of what it is measuring. A ref is the honest tool: the value is
   * read imperatively, never rendered.
   */
  const latest = useRef<FrameInfo | null>(null);
  useEffect(() => engine.addFrameListener((info) => (latest.current = info)), [engine]);

  const generate = useCallback(
    (count: number) => {
      setBusy(true);
      setDescriptor(null);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          // Seed derived from the count, not from a clock: pressing "10k" on two
          // different machines must produce the same scene, or the two
          // measurements are not comparable.
          const d = engine.generateScene({ count, seed: 0x5eed + count });
          setDescriptor(d);
          setBusy(false);
        }),
      );
    },
    [engine],
  );

  const copyRow = useCallback(() => {
    const info = latest.current;
    if (info === null) return;
    void navigator.clipboard
      ?.writeText(markdownRow(info, descriptor))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {
        /* Clipboard access needs a secure context and can be blocked. Not worth
           an error dialog for a convenience button — the numbers are on screen. */
      });
  }, [descriptor]);

  return (
    <div className="dev-panel">
      <div className="dev-title">performance lab</div>

      <div className="dev-row">
        {SCENE_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            className="seg"
            disabled={busy}
            onClick={() => generate(n)}
            title={`Replace the scene with ${n.toLocaleString()} generated elements`}
          >
            {formatCount(n)}
          </button>
        ))}
      </div>

      <label className="dev-check">
        <input
          type="checkbox"
          checked={perfMarks}
          onChange={(e) => engine.setPerfMarks(e.target.checked)}
        />
        <span>
          User Timing marks
          <small>
            Names each stage in a DevTools performance trace. Off by default — the
            entries allocate.
          </small>
        </span>
      </label>

      <div className="dev-row">
        <button
          type="button"
          className="seg"
          onClick={copyRow}
          disabled={elementCount === 0}
          title="Copy the current numbers as a Markdown table row for BASELINE.md"
        >
          {copied ? 'copied ✓' : 'copy baseline row'}
        </button>
      </div>

      <div className="dev-note">
        {busy
          ? 'generating…'
          : descriptor !== null
            ? descriptor
            : `${elementCount.toLocaleString()} elements · pick a size to load a scene`}
      </div>
    </div>
  );
}

function formatCount(n: number): string {
  return n >= 1000 ? `${n / 1000}k` : String(n);
}

/**
 * Format one measurement as a Markdown table row.
 *
 * A number that lives only in a screenshot is a number that never gets compared
 * to anything. Making the measurement one click away from the document it
 * belongs in is the difference between a baseline you keep and a baseline you
 * meant to keep.
 */
function markdownRow(info: FrameInfo, descriptor: string | null): string {
  const stages = STAGE_NAMES.map((s) => info.stages[s].toFixed(2)).join(' | ');
  return (
    `| ${descriptor ?? 'hand-drawn'} | ${info.render.total} | ${info.render.drawn} | ` +
    `${info.render.tested} | ${info.stats.p50.toFixed(2)} | ${info.stats.p95.toFixed(2)} | ` +
    `${stages} |`
  );
}
