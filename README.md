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

**Phase 8 of 11 — undo, redo and persistence.** Two features with one shared idea: **the element
model was already the right shape for both, because of a rule set in Phase 2.**

`Scene.mutate` never edits an element in place — it builds a new object and bumps `version`. So a
history entry can hold *references* to the old and new objects rather than copies. A 400-point
freehand stroke dragged for three seconds produces about 180 objects; history keeps exactly two of
them and the other 178 are collected. Structural sharing with no copy-on-write machinery.

The rule that makes an entry a gesture rather than a frame is **first `before`, last `after`**. Get
it wrong and reversing one drag takes 180 undos, which users report as "undo doesn't work".

### What autosave costs during a drag

50,000 elements, one shape dragged in a 150-step circle. Identical build, one line changed:

| | debounced + idle | saved on every change | |
|---|---:|---:|---:|
| frame **p50** | **5.10 ms** | 123.10 ms | **24×** |
| frame **p95** | **7.10 ms** | 165.20 ms | 23× |
| wall clock, one drag | **7.5 s** | 28.2 s | 3.8× |

The save itself is not cheap and is not made cheap — it is moved. Serialising the document is
~300 ms at 50,000 elements, and `requestIdleCallback` puts that in the gap *after* the gesture
instead of inside it.

### Why not localStorage

Measured on this project's own generated scenes:

| elements | document | `JSON.stringify` | `structuredClone` |
|---:|---:|---:|---:|
| 1,000 | 0.50 MB | 3.2 ms | 3.8 ms |
| 10,000 | 4.94 MB | 34.7 ms | 44.2 ms |
| 50,000 | **24.69 MB** | 492.9 ms | 389.0 ms |

localStorage's quota is about 5 MB, so a document outgrows it around **ten thousand elements** —
and it fails by throwing on write, at the moment the user has done the most work. It is also
synchronous. Note the last column too: storing the object graph in IndexedDB instead of a JSON
string does not escape the serialisation cost, because the structured clone happens on the calling
thread.

A bug the browser test found and no unit test could have: **a pan or zoom scheduled no save.** The
viewport is part of the saved document, but the only thing calling `scheduleSave` was the scene
change feed — which fires when an *element* changes. Reopening a document dropped you back at 100%
at the origin unless you happened to edit something afterwards.

<!-- Updated at each phase. Baseline lands in Phase 3, results in Phases 4 and 5. -->

| Phase | | Status |
|---:|---|---|
| 0 | Scaffold, tooling, geometry primitives | ✅ |
| 1 | Viewport: pan, zoom, DPR-correct rendering | ✅ |
| 2 | Element model, shape and freehand tools | ✅ |
| 3 | Performance instrumentation and baseline | ✅ |
| 4a | Quadtree spatial index | ✅ |
| 4b | Hit detection and selection | ✅ |
| 5 | Dirty-rectangle renderer | ✅ |
| 6 | Move, resize, rotate, multi-select | ✅ |
| 7 | Text | ✅ |
| 8 | Undo/redo, persistence | ✅ |
| 9 | PNG and SVG export | — |
| 10 | Hardening, benchmarks in CI, deploy | — |

Each phase is a pull request with the design reasoning in its description.

### What the index is really for

The render cull was the visible win. Hit testing is the one that decides whether the app is usable,
because it runs per pointer event rather than per frame. `npm run bench`, 50,000 elements:

| | linear scan | through the index | |
|---|---:|---:|---:|
| click in a busy area | 6.73 ms | **0.061 ms** | 111× |
| move over empty canvas | 13.28 ms | **0.0002 ms** | ~66,000× |

The second row is the one people forget to measure, because "nothing happened". It is also the
worst case: with nothing to hit, the scan cannot exit early and must test all 50,000 shapes
exactly. Through the index it is *flat* — 0.0002 ms at 100 elements and at 50,000 — because the
first node rejects everything.

In the running app at 50,000 elements, a click hands the exact geometry test **3 candidates**.

### What the index actually bought

Phase 3's cull was a linear scan whose cost was **unrelated to the viewport** — culling 50,000
elements took the same time whether forty were on screen or all of them. That, not the growth
curve, was the defect.

One fixed scene, one pinhole viewport, counted rather than timed — so these numbers are identical
on every machine and are what [`tests/engine/culling.test.ts`](tests/engine/culling.test.ts)
asserts:

| Elements | Examined per frame, before | after | Nodes descended into |
|---:|---:|---:|---:|
| 500 | 500 | 36 | 17 |
| 2,000 | 2,000 | 123 | 21 |
| 10,000 | 10,000 | 568 | 26 |
| 50,000 | 50,000 | **2,497** | **31** |

Two honest readings of that table.

**The node count is near-constant.** 100× the elements for 1.8× the nodes descended into. That is
the tree doing exactly what a tree is for.

**The examined count is not logarithmic.** It fell to ~6% of the scene and then *stayed* at ~6% as
the scene grew — a ~16× smaller constant, not a better complexity class. Elements stop separating
once a node is only a few times their size, so subdivision stops thinning the nodes. Raising the
depth limit from 8 to 14 changes it by under 1%; that was measured, not assumed. The remedy is a
loose quadtree, and it is not implemented because what remains is 0.3 ms of a 16.67 ms frame.

There is also a result that has nothing to do with the tree. Roughly **90% of the old cull was
recomputing bounds, not testing them** — `getRenderBounds` walks the point list for freehand
strokes and rotates four corners for anything with an angle, once per element per frame. The index
stores the rectangle at insert time. A one-line cache would have delivered much of the same win,
and saying so is more useful than letting the data structure take the credit.

### Not one strategy — three

```
scan    c₁·n                     ordering is free — the array is already sorted
index   c₁·tested + c₂·k·log k   ordering is NOT free — the tree returns tree order
```

At 50,000 elements with everything on screen, that sort alone is ~18 ms. So `Scene.visible` picks
per call: return the cached sorted array when the view contains everything, scan when most of the
scene is visible, query the index otherwise. `cull path` in the stats overlay reports which one ran.

The benchmark that forced this was written in Phase 3, before the quadtree existed, with the
comment *"benchmarking only the flattering case is how people ship an optimisation that is a
pessimisation in the common path."* It then caught exactly that.

### Measured so far

| | |
|---|---|
| Frame cost while drawing | **9.4 ms** p50 (1280×800 at dpr 2, 7 elements) |
| Frames skipped while idle | **~59/sec** — the loop does no work at all when nothing changed |
| React renders during a pan or draw gesture | **0** |
| Rough.js drawable cache hit rate, warm | **100%** |
| Cull at 50k, framed vs zoomed in | **45.6 ms → 0.30 ms** — same scene, 152× |
| Elements examined at 50k, zoomed in | **2,497 of 50,000** (was 50,000) |
| Index nodes descended into at 50k | **31** — 1.8× the count at 500 elements |
| Cull at 50k with everything on screen | **O(1)** — containment proved once, cached array returned |
| Share of the old cull that was bounds recomputation | **~90%** (17.7 ms vs 1.8 ms per 50k) |
| Hit test at 50k, busy area | **6.73 ms → 0.061 ms** (111×) |
| Hit test at 50k, empty canvas | **13.28 ms → 0.0002 ms**, and flat in scene size |
| Broad-phase candidates per click at 50k | **3** |
| Screen repainted when one shape changes at 50k | **0.8%** |
| Frame p95 across 20 deletions at 50k | **1074.8 ms → 82.2 ms** (13×) |
| Full repaints across that workload | **43 → 3** |
| Frame p50 while dragging one shape at 50k | **858.7 ms → 7.7 ms** (112×) |
| Elements redrawn per frame during that drag | **49,819 → 7** |
| Selection-overlay cost per frame, zoomed out at 50k | **84.9 ms → 0.10 ms** |
| Text editor vs canvas glyph position, at 100% and 271% zoom | **0.0 px** |
| …under a 24px browser minimum font size, before → after | **90×31.5 → 138.5×18** (canvas: 138.5×18) |
| Frame p50 while dragging at 50k, autosave debounced vs eager | **5.10 ms vs 123.10 ms** (24×) |
| Undo entries produced by a 180-mutation drag | **1** |
| Document size at 50k elements | **24.69 MB** — past localStorage's quota by ~5× |
| Grid lines drawn, 10% zoom → 3000% zoom | 116 → 196 — near-constant across a 300× range |
| Zoom-at-cursor drift over a 20× zoom | < 0.1 scene units |

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
npm run bench      # the cull benchmark. seconds, not milliseconds — not part of verify
npm run build      # typecheck, then production bundle
```

`bench` is deliberately outside `verify`. Its output is a property of the machine as much as of
the code, and gating a build on a stopwatch is how you get a red CI run because a shared runner
was busy. What CI *does* gate on is the deterministic element-examination count, which measures
the same thing without a clock.

To reproduce the baseline in the browser: `npm run dev`, then use the **performance lab** panel in
the bottom-right to load 50k elements and watch the `cull` and `draw` rows diverge as you zoom.

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
    dev/           the seeded scene generator — load-bearing for Phases 4 and 5
    text/          measurement and line breaking. takes a measurer, owns no canvas.
    history/       undo/redo. holds element references, never copies.
    persist/       the document format, and the IndexedDB store behind it.
    spatial/       the quadtree. knows about rectangles and ids, nothing else.
    util/          scalar maths, 2D geometry, ids, frame timing, simplification
  react/           the UI chrome. mounts the canvases, then gets out of the way.
tests/engine/      484 tests, all in Node. ~9s, no jsdom.
tests/bench/       vitest bench. run on demand, never in CI.
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
