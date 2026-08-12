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

**Phase 0 of 11 — project scaffold.** There is nothing to draw with yet. What's here is the
build, the type system, the test harness, CI, and the geometry primitives everything else sits on.

<!-- Updated at each phase. Benchmarks land in Phase 3 (baseline) and Phase 5 (result). -->

| Phase | | Status |
|---:|---|---|
| 0 | Scaffold, tooling, geometry primitives | ✅ |
| 1 | Viewport: pan, zoom, DPR-correct rendering | — |
| 2 | Element model, shape and freehand tools | — |
| 3 | Performance instrumentation and baseline | — |
| 4 | Quadtree spatial index, hit detection, selection | — |
| 5 | Dirty-rectangle renderer | — |
| 6 | Move, resize, rotate, multi-select | — |
| 7 | Text | — |
| 8 | Undo/redo, persistence | — |
| 9 | PNG and SVG export | — |
| 10 | Hardening, benchmarks in CI, deploy | — |

Each phase is a pull request with the design reasoning in its description.

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
  engine/          plain TypeScript. no React, no JSX, no DOM assumptions.
    util/          scalar maths, 2D geometry, id generation
  react/           the UI chrome. mounts the canvas, then gets out of the way.
tests/engine/      runs in Node. fast enough to keep in watch mode.
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
