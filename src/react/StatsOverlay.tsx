import { useEffect, useRef } from 'react';
import type { Engine, FrameInfo } from '@engine/Engine';
import { STAGE_NAMES, type StageName } from '@engine/util/perf';

interface Props {
  engine: Engine;
}

/**
 * Live frame-timing readout.
 *
 * ── Why this does not use useSyncExternalStore ──────────────────────────────
 *
 * Every value here changes every frame. Routing them through React state would
 * mean a render pass 60 times a second — for a debug overlay. The instrument
 * would then be a significant fraction of what it is measuring, which is worse
 * than useless: it lies.
 *
 * So this component renders **once**, captures refs to its own text nodes, and
 * a frame listener writes `textContent` directly. React never re-renders it.
 * The engine throttles the callback to ~8 Hz, because faster than that is
 * unreadable to a human anyway.
 *
 * This is not a hack around React — it is the documented approach for values
 * that change faster than they can usefully be rendered, and the same reason
 * browser devtools draw their FPS meter on a canvas rather than in the DOM.
 * The rule of thumb: if a human cannot read it at the rate it changes, it does
 * not belong in the render tree.
 *
 * ── What Phase 3 adds, and why it is the point of the phase ─────────────────
 *
 * A single frame time is not actionable. "The frame takes 40 ms" tells you there
 * is a problem; it does not tell you which of four things caused it. The stage
 * breakdown does, and the two stages below scale differently on purpose:
 *
 *     cull  is O(total)   — grows with everything that exists
 *     draw  is O(visible) — grows with what fits on the screen
 *
 * Zoom into a corner of a 50,000-element scene and `draw` goes to nearly zero
 * while `cull` does not move at all. That divergence is the entire argument for
 * Phase 4's quadtree, and you cannot see it from one number.
 *
 * `tested` is the same argument without a clock attached: the count of elements
 * the cull examined. It is deterministic and reads identically on a fast laptop
 * and a throttled CI box.
 *
 * Phase 4 added `index nodes` and `cull path` beside it. Load 50k and watch all
 * three as you zoom: `tested` collapses, `index nodes` barely moves, and `cull
 * path` flips between `all`, `scan` and `index` as the viewport changes what the
 * cheapest strategy is. Those three rows together are the whole phase.
 */
export function StatsOverlay({ engine }: Props) {
  const fps = useRef<HTMLSpanElement>(null);
  const p50 = useRef<HTMLSpanElement>(null);
  const p95 = useRef<HTMLSpanElement>(null);
  const zoom = useRef<HTMLSpanElement>(null);
  const drawn = useRef<HTMLSpanElement>(null);
  const tested = useRef<HTMLSpanElement>(null);
  const nodes = useRef<HTMLSpanElement>(null);
  const path = useRef<HTMLSpanElement>(null);
  const hit = useRef<HTMLSpanElement>(null);
  const cache = useRef<HTMLSpanElement>(null);
  const grid = useRef<HTMLSpanElement>(null);
  const idle = useRef<HTMLSpanElement>(null);

  // One ref per stage, created once. `Record<StageName, …>` rather than an
  // index signature, so adding a stage to the union is a compile error here
  // rather than a silently missing row.
  const stageRefs = useRef<Record<StageName, HTMLSpanElement | null>>({
    cull: null,
    grid: null,
    draw: null,
    interactive: null,
  });

  useEffect(() => {
    const write = (el: HTMLSpanElement | null, text: string) => {
      // Compare before assigning: an identical string should not invalidate
      // layout. Keeps the overlay off the paint profile entirely.
      if (el !== null && el.textContent !== text) el.textContent = text;
    };

    const onFrame = (info: FrameInfo) => {
      write(fps.current, info.stats.fps.toFixed(0));
      write(p50.current, `${info.stats.p50.toFixed(2)} ms`);
      write(p95.current, `${info.stats.p95.toFixed(2)} ms`);
      write(zoom.current, `${(info.zoom * 100).toFixed(1)}%`);
      // drawn / total is the culling ratio — what the viewport saved you.
      write(
        drawn.current,
        `${info.render.drawn.toLocaleString()} / ${info.render.total.toLocaleString()}`,
      );
      // tested is what the cull cost you. Equal to total under a linear scan;
      // Phase 4 is finished when this stops growing with the scene.
      write(tested.current, info.render.tested.toLocaleString());
      write(nodes.current, info.render.nodes.toLocaleString());
      write(path.current, info.render.path);
      // The broad/narrow ratio of the last click: how many candidates the index
      // handed to the exact geometry test, and how many of those it had to run.
      write(hit.current, `${info.hit.broad} / ${info.hit.narrow}`);
      write(cache.current, `${(info.render.cacheHitRate * 100).toFixed(0)}%`);
      write(grid.current, String(info.render.gridLines));
      write(idle.current, String(info.idleFrames));

      // No unit suffix here — the section header carries it, which keeps four
      // numbers vertically aligned and the panel narrow.
      for (const stage of STAGE_NAMES) {
        write(stageRefs.current[stage], info.stages[stage].toFixed(2));
      }
    };

    return engine.addFrameListener(onFrame);
  }, [engine]);

  return (
    <div className="stats" aria-hidden="true">
      <div className="stats-section">frame</div>
      <Row label="renders/s" spanRef={fps} />
      <Row label="p50" spanRef={p50} />
      <Row label="p95" spanRef={p95} />
      <Row label="zoom" spanRef={zoom} />

      <div className="stats-section">scene</div>
      <Row label="drawn/total" spanRef={drawn} />
      <Row label="tested" spanRef={tested} />
      <Row label="index nodes" spanRef={nodes} />
      <Row label="cull path" spanRef={path} />
      <Row label="hit broad/narrow" spanRef={hit} />
      <Row label="cache hit" spanRef={cache} />
      <Row label="grid lines" spanRef={grid} />
      <Row label="idle frames" spanRef={idle} />

      {/* Grouped under a header carrying the unit, so the four numbers line up
          and the labels stay distinct from the counters above — `draw` the
          stage is not `drawn/total` the ratio, and confusing them is how you
          end up optimising the wrong half of the frame. */}
      <div className="stats-section">stages · ms</div>
      {STAGE_NAMES.map((stage) => (
        <div className="stats-row" key={stage}>
          <span className="stats-label">{stage}</span>
          <span
            className="stats-value"
            ref={(el) => {
              stageRefs.current[stage] = el;
            }}
          >
            –
          </span>
        </div>
      ))}
    </div>
  );
}

function Row({
  label,
  spanRef,
}: {
  label: string;
  spanRef: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <div className="stats-row">
      <span className="stats-label">{label}</span>
      <span className="stats-value" ref={spanRef}>
        –
      </span>
    </div>
  );
}
