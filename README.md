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

**Phase 3 of 11 — the performance lab.** The app can now make itself slow on demand and say
precisely where the time went. There is a seeded scene generator (100 / 1k / 10k / 50k), a
per-stage frame breakdown, and a benchmark suite.

Nothing got faster in this phase. That's the point: the next two phases are optimisations, and
an optimisation with no *before* number is a story rather than a result.

<!-- Updated at each phase. Baseline lands in Phase 3, results in Phases 4 and 5. -->

| Phase | | Status |
|---:|---|---|
| 0 | Scaffold, tooling, geometry primitives | ✅ |
| 1 | Viewport: pan, zoom, DPR-correct rendering | ✅ |
| 2 | Element model, shape and freehand tools | ✅ |
| 3 | Performance instrumentation and baseline | ✅ |
| 4 | Quadtree spatial index, hit detection, selection | — |
| 5 | Dirty-rectangle renderer | — |
| 6 | Move, resize, rotate, multi-select | — |
| 7 | Text | — |
| 8 | Undo/redo, persistence | — |
| 9 | PNG and SVG export | — |
| 10 | Hardening, benchmarks in CI, deploy | — |

Each phase is a pull request with the design reasoning in its description.

### The baseline, in one table

The cull — the loop that decides which elements are on screen — is a linear scan today. From
`npm run bench` on a MacBook Pro, Node 22:

| Elements | Cull, mean | Relative | ms **per element** | Examined per frame |
|---:|---:|---:|---:|---:|
| 100 | 0.010 ms | 1× | 0.000099 | 100 |
| 1,000 | 0.095 ms | 9.6× | 0.000095 | 1,000 |
| 10,000 | 0.98 ms | 99× | 0.000098 | 10,000 |
| 50,000 | 5.09 ms | **513×** | 0.000102 | 50,000 |

**≈100 nanoseconds per element, per frame — flat across a 500× range.** That fourth column is what
O(n) actually looks like when you measure it rather than assert it: a constant cost per item,
holding to within 7% over two and a half orders of magnitude.

At 50,000 elements the worst 1% of frames spend **15.7 ms** in the cull alone — 94% of a 60 fps
budget, before a single pixel is rasterised.

**But the growth curve isn't the real finding.** Here is the same 50,000-element scene culled at
three different zoom levels:

| Viewport | Elements visible | Cull, mean |
|---|---:|---:|
| zoomed in | a few dozen | 4.56 ms |
| typical | a few hundred | 5.09 ms |
| zoomed out | all 50,000 | 4.78 ms |

Those are the same number. Culling 50,000 elements costs the same whether you can see forty of them
or all of them — **the work is entirely unrelated to what you are looking at.** A structure that
answers *"what is inside this rectangle?"* by examining objects nowhere near the rectangle is doing
the wrong thing, however fast it does it. That is the defect Phase 4 fixes.

And it is asserted, not eyeballed: [`tests/engine/culling.test.ts`](tests/engine/culling.test.ts)
fails the build if the examined-count ever stops matching the element count — which is precisely
what the quadtree is supposed to make happen.

### Measured so far

| | |
|---|---|
| Frame cost while drawing | **9.4 ms** p50 (1280×800 at dpr 2, 7 elements) |
| Frames skipped while idle | **~59/sec** — the loop does no work at all when nothing changed |
| React renders during a pan or draw gesture | **0** |
| Rough.js drawable cache hit rate, warm | **100%** |
| Culling ratio at 10k, zoomed in | **403 drawn / 10,001 tested** |
| Cull cost per element | **~100 ns**, constant from 100 to 50,000 elements |
| Cull growth, 100 → 50,000 elements | **513×** — linear, as designed, for now |
| Cull cost at 50k, zoomed in vs out | **4.56 ms vs 4.78 ms** — the viewport doesn't matter yet |
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
    util/          scalar maths, 2D geometry, ids, frame timing, simplification
  react/           the UI chrome. mounts the canvases, then gets out of the way.
tests/engine/      231 tests, all in Node. ~5s, no jsdom.
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
