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

**Phase 10 of 11 — every claim is a gate.**

Nine phases made load-bearing claims. *Culling is sublinear. The dirty-rect merge is bounded. The
broad phase does the work, not the narrow phase. The engine does not depend on React.* Each one was
defended by a paragraph in a document and by whoever remembered writing it — a defence with a
half-life of about one quarter.

This phase turns each claim into a number that fails the build when it moves.

### The gate is a count, not a clock

`tests/budget/budget.json` holds 45 numbers: elements the cull examined, quadtree nodes descended,
broad- and narrow-phase hit candidates, dirty rectangles collected and merged, bytes of serialised
document, bytes of exported SVG. **43 of them are integer counts of operations** — pure functions of
the code and a seed, reading identically on a laptop and on a loaded CI runner.

The other two are not, and finding that out is the most useful thing that happened in this phase.
`bytes.document.*` is the byte size of *serialised floating-point data*, and it drifted by 21 bytes
in 461 kB between an x86-64 Linux container and an arm64 macOS laptop — the last digits of a
double-to-string conversion are not stable across V8 builds. They had been asserted exactly anyway,
because they lived in the same file as the counts and looked like them.

So the rule this phase already states about *files* — match the assertion to how deterministic the
quantity is — turned out to apply **within** one file. Those two keys now carry a ±0.1% tolerance
with the reason recorded next to it, and the tolerance is defensible because both numbers can be
stated: observed noise is 0.005%, and the schema growth this counter exists to catch (one extra
field on the element model) is 3.2%. A factor of ~600 between noise and signal. Verified by adding
a field: both keys fail, everything else passes.

`bytes.svg.*` stayed exact — because Phase 9 rounds path coordinates to two decimals before
serialising. The rounding that halved the export file also made it machine-independent, which
nobody planned.

That is why the assertion is **exact equality** rather than a ceiling. A ceiling is silent about
improvements and drifts upward until it constrains nothing; an exact count turns every change to the
work this engine does into a line in a diff somebody has to justify:

```diff
- "cull.zoomed-in.10000.tested": 505,
+ "cull.zoomed-in.10000.tested": 10000,
```

Verified by breaking things on purpose. Raising the quadtree's node capacity from 8 to 64 moves
**7 of the 45** counters and leaves 38 alone — and the failure names each one, so the diff *is* the
diagnosis.

The bundle budget uses a ceiling instead, deliberately: bytes move when a dependency ships a patch
release, and an exact assertion there would fail for reasons that are not about this code. **Match
the assertion to how deterministic the quantity actually is.**

### Visual regression with no browser and no pixel diff

The standard approach is screenshot-and-compare, and it is the reason people hate e2e suites: a font
hinted differently on the runner, a GPU antialiasing a curve one grey level off, and the fix is a
tolerance wide enough to hide the regressions you wanted to catch.

This project can skip all of it, because of two decisions made earlier for unrelated reasons —
Phase 2 stored the Rough.js `seed` instead of regenerating it, and Phase 9's SVG exporter runs with
no DOM. Together they give a **deterministic textual rendering of the scene**, so the golden file is
the SVG itself: text, byte-identical everywhere, reviewable in a pull request, no tolerance, no
flake, 24 ms inside the normal unit-test run.

Changing one `stroke-linecap` in the serialiser fails three of the four golden files — and leaves
the text one alone, because text has no line caps.

The goldens are stored one element per line. `toSvg` emits a single line, which is right for a file
a user downloads and wrong for a file a human reviews: on one line, changing a stroke width rewrites
the whole 24 kB line and git reports "1 insertion, 1 deletion". **A golden file whose diff nobody can
read gets regenerated instead of read**, and at that point it is a slow way of asserting nothing.

### Two kinds of containment, because there are two boundaries

A React error boundary catches throws during render, in lifecycle methods, and in constructors. It
does **not** catch them in event handlers, in promises, or in `requestAnimationFrame` callbacks —
and this engine's entire render loop is a rAF callback running sixty times a second. A throw in
`drawElement` reaches React never.

So there are two mechanisms:

- **`ErrorBoundary`** for the React tree. When it fires, the one thing that matters is the user's
  document, so it opens IndexedDB *itself* — a recovery path must not depend on the thing that
  failed — and offers the last autosave as a file. It never offers to clear storage, because that
  is one click between the user and the work they came back for.
- **`DrawGuard`** for the render loop. One element that throws is quarantined and the other 399
  keep drawing, instead of the loop unwinding and blanking the canvas on every frame forever.

The quarantine is keyed by `id:version` — the same key `RoughCache` uses. That is Phase 2's "never
mutate in place" invariant paying out a third time: when the user drags the broken element, or
recolours it, or undoes whatever created it, the key changes and it is retried automatically. The
retry policy is *"whenever the element changes"*, and it costs one string concatenation.

Measured, because a `try`/`catch` around a hot loop deserves a number rather than an assurance.
Continuous pan at 10,000 elements — a full repaint every frame, the worst case there is:

| | p50 frame | |
|---|---:|---|
| no guard | 61.0 ms | n=8 |
| guard | 63.2 ms | n=8 |

**+2.2 ms, about 3.6%, with a 95% confidence interval of ±2.1 ms** — barely distinguishable from
zero at this sample size, and stated that way rather than rounded to "free". The obvious hypothesis
was the closure allocated per element per frame; a closure-free variant measured 63.7 ms, i.e. no
better, so the hypothesis was wrong and the generic, testable API stays. In the normal dirty-rect
path the loop wraps tens of calls rather than ten thousand.

### A bug the budget found that no test was looking for

The serialised-document byte count would not sit still between runs. Nothing else in the suite cared
about ids; this cared about their total length.

`newId()`'s alphabet was **63 characters, not 64**. nanoid's `_` had been lost. `ALPHABET[63]` was
therefore `undefined`, and `id += undefined` appends the *string* `"undefined"` rather than throwing
— so **28% of all element ids contained the literal text `undefined`**, and were 29, 37 or 45
characters instead of 21.

Nothing broke. Ids are opaque: a longer one is still unique, still a valid `Map` key, still
round-trips through JSON. `noUncheckedIndexedAccess` typed the read as `string | undefined`, which is
correct and cannot object to `string += string | undefined`. Every test passed for nine phases. The
comment directly above the alphabet said it is 64 characters "which is the whole reason it is 64 and
not, say, 62" — the code had disagreed with its own documentation the entire time.

Fixed, and the invariant is executable now rather than a claim in a comment. It also made every
saved document smaller:

| elements | document before | after | |
|---:|---:|---:|---:|
| 1,000 | 464,425 B | **461,569 B** | −0.6% |
| 10,000 | 4,969,013 B | **4,942,445 B** | −0.5% |

**A measurement finds bugs that no assertion was aimed at.** That is most of the argument for
measuring at all.

### What ships, and what is honestly not covered

CI runs two jobs in parallel: `verify` (typecheck, lint, 590 tests, build, bundle size) and `e2e`
(five Playwright specs against the **production build**, not the dev server). `main` deploys to
GitHub Pages only after CI is green — `workflow_run` fires on failure too, so that gate is an
explicit `if`, and the deploy concurrency group deliberately does *not* cancel in progress, because
cancelling mid-upload can leave the site serving a half-published build.

`retries: 0` on the e2e suite, and it earned its keep immediately: two of the five specs were racing
the render loop, failing in a *different* place on each full run while passing in isolation. Retries
would have hidden that. Both were bugs in the tests — reading canvas pixels before the next animation
frame, and inferring "the save landed" from a UI label that reads `0.0 ms (pending)`. The fix for the
second one is the general lesson: **assert the condition, not a rendering of it** — the test now reads
IndexedDB directly.

Not covered: the `ErrorBoundary` render path has no automated test. Verifying it needs a component
that throws, which needs either jsdom (which ARCHITECTURE §12 calls a smell for this codebase) or a
`?crash=1` backdoor shipped in the production bundle. Neither is worth it, so the risky half — the
document rescue — was extracted into `src/engine/persist/rescue.ts` and unit-tested against a fake
loader, and the boundary itself was verified by hand: a temporary throw injected into a real build
rendered the panel and downloaded a file containing the drawing. Closing the gap properly means a
build-time flag and a second CI build.

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
| 9 | PNG and SVG export | ✅ |
| 10 | Hardening, gates, CI and deploy | ✅ |

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
| Lines changed in `drawElement.ts` to support export | **0** |
| Export framing: 1200×760 window, same drawing | **396 × 251** — content, not viewport |
| SVG size, path coordinates unrounded → rounded | **1,461 kB → 676 kB** (2.16×) |
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
npm run verify      # typecheck + lint + test. ~15 s. run this before you push
npm run verify:full # the above, plus build, bundle size and the browser suite
npm run test        # vitest, Node environment, no jsdom
npm run test:e2e    # playwright. builds dist/ and drives the real bundle
npm run size        # bundle budget. needs a build first
npm run bench       # the cull benchmark. seconds, not milliseconds — not in verify
npm run build       # typecheck, then production bundle
```

Two gates hold checked-in expectations, and both are updated by one command each. Do it
deliberately, and say why in the commit message — that diff is the review:

```bash
UPDATE_BUDGET=1 npm test -- tests/budget    # the work counts moved, on purpose
UPDATE_GOLDEN=1 npm test -- tests/visual    # the renderer output changed, on purpose
node scripts/checkBundle.mjs --update       # re-record the size ceiling (+10% headroom)
```

Then **read the diff**. A golden file regenerated without reading it costs the same as one that was
read, and certifies nothing.

If your environment supplies its own Chromium — an air-gapped runner, a Nix or Docker image, a proxy
that blocks Playwright's CDN — point at it instead of downloading one:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium npm run test:e2e
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
    export/        PNG and SVG. the geometry is pure, so most of it tests in Node.
    spatial/       the quadtree. knows about rectangles and ids, nothing else.
    util/          scalar maths, 2D geometry, ids, frame timing, simplification
  react/           the UI chrome. mounts the canvases, then gets out of the way.
tests/engine/      unit tests, all in Node. no jsdom.
tests/budget/      the performance gate. exact counts, checked into budget.json.
tests/visual/      golden SVG snapshots. visual regression with no browser.
e2e/               five Playwright specs against the production build.
scripts/           bundle-size budget.
tests/bench/       vitest bench. run on demand, never in CI.
```

Directories arrive with the phase that fills them, rather than as empty placeholders. The annotated
tree — the real one, not a plan — is [ARCHITECTURE.md §12](ARCHITECTURE.md).

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
