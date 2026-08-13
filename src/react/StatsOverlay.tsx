import { useEffect, useRef } from 'react';
import type { Engine, FrameInfo } from '@engine/Engine';

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
 * From Phase 3 this becomes the primary instrument for the whole project. The
 * before/after numbers that justify the quadtree and the dirty-rectangle
 * renderer are read off exactly these fields — so `drawn / total` and
 * `cache hit` matter as much as the timings.
 */
export function StatsOverlay({ engine }: Props) {
  const fps = useRef<HTMLSpanElement>(null);
  const p50 = useRef<HTMLSpanElement>(null);
  const p95 = useRef<HTMLSpanElement>(null);
  const zoom = useRef<HTMLSpanElement>(null);
  const drawn = useRef<HTMLSpanElement>(null);
  const cache = useRef<HTMLSpanElement>(null);
  const grid = useRef<HTMLSpanElement>(null);
  const idle = useRef<HTMLSpanElement>(null);

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
      // drawn / total is the culling ratio — the number Phase 4 improves.
      write(drawn.current, `${info.render.drawn} / ${info.render.total}`);
      write(cache.current, `${(info.render.cacheHitRate * 100).toFixed(0)}%`);
      write(grid.current, String(info.render.gridLines));
      write(idle.current, String(info.idleFrames));
    };

    return engine.addFrameListener(onFrame);
  }, [engine]);

  return (
    <div className="stats" aria-hidden="true">
      <Row label="renders/s" spanRef={fps} />
      <Row label="frame p50" spanRef={p50} />
      <Row label="frame p95" spanRef={p95} />
      <Row label="zoom" spanRef={zoom} />
      <Row label="drawn/total" spanRef={drawn} />
      <Row label="cache hit" spanRef={cache} />
      <Row label="grid lines" spanRef={grid} />
      <Row label="idle frames" spanRef={idle} />
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
