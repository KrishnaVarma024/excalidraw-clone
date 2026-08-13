# Excalidraw Clone

An infinite-canvas drawing tool, built from scratch on HTML Canvas — no Konva, no Fabric, no PixiJS.

The point isn't to reproduce Excalidraw. It's to build the part those libraries hide: the render
loop. Specifically, three techniques that determine whether a canvas app is usable at ten thousand
elements or at two hundred.

| | Naive approach | What this does |
|---|---|---|
| **Repainting** | clear the canvas, redraw everything, 60×/second | repaint only the rectangles that actually changed |
| **Hit detection** | loop over every element on every click and every mouse move — O(n) | query a quadtree — O(log n) |
| **Infinite canvas** | scroll a very large fixed canvas | a pan/zoom transform matrix over unbounded scene space |

The interesting problem is the third row's interaction with the first two: a quadtree needs finite
bounds, and the canvas is infinite. The index re-roots itself — when an element lands outside the
current root, it allocates a new root twice the size with the old one as a child. O(1) per growth,
O(log) growths to reach any coordinate.

---

## Status

**Phase 2 of 11 — shapes and freehand.** It draws. Rectangles, diamonds, ellipses, lines,
arrows and pressure-sensitive freehand, with a hand-drawn look via Rough.js.

Pick a tool (<kbd>R</kbd> <kbd>D</kbd> <kbd>O</kbd> <kbd>A</kbd> <kbd>L</kbd> <kbd>P</kbd>) and
drag · <kbd>shift</kbd> constrains to a square or 15° · <kbd>esc</kbd> cancels mid-draw ·
<kbd>space</kbd>-drag pans. No selection or undo yet — Phases 4 and 8.

<!-- Updated at each phase. Benchmarks land in Phase 3 (baseline) and Phase 5 (result). -->

| Phase | | Status |
|---:|---|---|
| 0 | Scaffold, tooling, geometry primitives | ✅ |
| 1 | Viewport: pan, zoom, DPR-correct rendering | ✅ |
| 2 | Element model, shape and freehand tools | ✅ |
| 3 | Performance instrumentation and baseline | — |
| 4 | Quadtree spatial index, hit detection, selection | — |
| 5 | Dirty-rectangle renderer | — |
| 6 | Move, resize, rotate, multi-select | — |
| 7 | Text | — |
| 8 | Undo/redo, persistence | — |
| 9 | PNG and SVG export | — |
| 10 | Hardening, benchmarks in CI, deploy | — |

Each phase is a pull request with the design reasoning in its description.

### Measured so far

| | |
|---|---|
| Frame cost while drawing | **9.4 ms** p50 (1280×800 at dpr 2, 7 elements) |
| Frames skipped while idle | **~59/sec** — the loop does no work at all when nothing changed |
| React renders during a pan or draw gesture | **0** |
| Rough.js drawable cache hit rate, warm | **100%** |
| Culling: elements drawn after panning away | **1 of 7** — frame cost tracks what's visible |
| Grid lines drawn, 10% zoom → 3000% zoom | 116 → 196 — near-constant across a 300× range |
| Zoom-at-cursor drift over a 20× zoom | < 0.1 scene units |

Real numbers start mattering in Phase 3, which exists specifically to measure a slow scene
before the quadtree and dirty-rectangle work make it fast.

---

## Architecture in one paragraph

React mounts a `<canvas>` and then leaves. Everything after that is a plain TypeScript engine
running its own `requestAnimationFrame` loop, with no React in it at all. This isn't stylistic — a
trackpad emits `pointermove` at 120–240 Hz, and routing that through React's reconciler means
paying for a full render pass a hundred-plus times a second to move one rectangle. React re-renders
only when *chrome* state changes (active tool, stroke colour, selection count), and the two sides
meet at exactly one seam: `useSyncExternalStore`.

The useful side effect is that `src/engine/` has no DOM dependency, so the whole geometry and
data-structure layer unit-tests in Node in about a second. There is a
[test that fails the build](tests/engine/boundary.test.ts) if anyone imports React into it.

Full design document: **[ARCHITECTURE.md](ARCHITECTURE.md)** — data model, the three coordinate
spaces, quadtree design and its worst case, the dirty-rect pipeline, and an end-to-end trace of
what happens when you drag a shape.

---

## Running it

Requires Node 20.19+.

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm run verify     # typecheck + lint + test — the same gate CI runs
npm run test       # vitest, Node environment, no jsdom
npm run build      # typecheck, then production bundle
```

---

## Layout

```
src/
  engine/          plain TypeScript. no React, no JSX.
    scene/         the element model, the store, and bounds
    viewport/      the three coordinate spaces, and the transform between them
    render/        the two renderers, the LOD grid, the drawable cache
    tools/         the drawing state machine
    input/         pointer, wheel and keyboard → tool or viewport
    util/          scalar maths, 2D geometry, ids, frame timing, simplification
  react/           the UI chrome. mounts the canvases, then gets out of the way.
tests/engine/      194 tests, all in Node. ~3.7s, no jsdom.
```

Directories arrive with the phase that fills them, rather than as empty placeholders. The target
structure is in [ARCHITECTURE.md §12](ARCHITECTURE.md).

---

## Type-checking choices worth flagging

Two non-default flags are on, and both cost something:

- **`noUncheckedIndexedAccess`** — `points[i]` is typed `Point | undefined`. This project is heavily
  array-indexed (point lists, quadtree children, dirty-rect lists), which is exactly where
  off-by-one errors live, so the friction is buying something real.
- **`exactOptionalPropertyTypes`** — `{ angle?: number }` and `{ angle: number | undefined }` stop
  being the same type. This matters once element patches exist: `{ angle: undefined }` should not be
  a legal way to say "leave the angle alone."

---

## Non-goals

No collaboration, no server, no accounts, no images, no groups. Those are the parts that make a
whiteboard a *product*; this repository is about the parts that make it a *renderer*. Where a
non-goal has a known design answer — fractional indexing for collaborative z-ordering, CRDTs for
concurrent edits, tile caching beyond dirty rects — it's written down in ARCHITECTURE.md rather
than half-built.

---

MIT licensed. Built by [@KrishnaVarma024](https://github.com/KrishnaVarma024).
