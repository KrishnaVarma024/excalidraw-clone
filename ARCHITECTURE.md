# Excalidraw Clone v1 — Architecture

> **Scope of v1:** local-only drawing. Shapes (rectangle, ellipse, line, arrow), freehand,
> text, selection + transform, undo/redo, infinite canvas, export to PNG/SVG.
> **No collaboration, no server, no auth.** Everything lives in the browser.

---

## 0. The one idea this whole project is built on

> **React owns the chrome. A plain-TypeScript engine owns the pixels. They meet at exactly one seam.**

This is not a stylistic choice — it's forced by physics.

A pointer generates `pointermove` events at 120–240 Hz on a modern trackpad. If every one of
those events sets React state, you pay: state update → scheduler → reconciliation → diff →
commit, roughly 60–120 times a second, on every single mouse wiggle. That work has nothing to
do with drawing a rectangle. It is pure overhead, and it is why most canvas-in-React projects
stutter at a few hundred shapes.

So:

- `<canvas>` is mounted **once** by React and then React never touches it again.
- The engine is a plain class. Zero React imports. It can be unit-tested in Node with no DOM.
- The engine runs its own `requestAnimationFrame` loop.
- React re-renders only when *chrome* state changes: which tool is active, current stroke
  colour, how many things are selected. That's maybe 5–20 renders per minute, not per second.
- The bridge is `useSyncExternalStore` — React's official subscribe-to-an-external-thing API.

When a senior dev opens your repo, `src/engine/` containing zero React imports is the first
thing that tells them you understood the problem.

---

## 1. Layer diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  REACT LAYER  (src/react/)                                           │
│  Toolbar · StylePanel · ZoomControls · ContextMenu · StatsOverlay     │
│  Re-renders on app-state change only. Never on pointermove.           │
└───────────────────────────┬──────────────────────────────────────────┘
                            │  useSyncExternalStore(engine.subscribe, engine.getSnapshot)
                            │  engine.dispatch({type:'SET_TOOL', tool:'ellipse'})
┌───────────────────────────┴──────────────────────────────────────────┐
│  ENGINE  (src/engine/) — plain TypeScript, no React, no JSX          │
│                                                                       │
│   ┌─────────────┐   pointer events    ┌──────────────────────────┐   │
│   │   INPUT     │────────────────────▶│   ToolManager (FSM)      │   │
│   │  (Pointer/  │                     │  idle→drawing→committed  │   │
│   │   wheel/kbd)│                     │  idle→dragging→committed │   │
│   └─────────────┘                     └────────────┬─────────────┘   │
│                                                     │ mutations       │
│                                                     ▼                 │
│   ┌────────────┐    ┌───────────────┐    ┌────────────────────┐      │
│   │  Viewport  │    │ SpatialIndex  │◀───│      Scene         │      │
│   │ scrollX/Y  │    │  (QuadTree)   │    │ elements + z-order │      │
│   │   zoom     │    └───────┬───────┘    └─────────┬──────────┘      │
│   └─────┬──────┘            │ query(rect)          │ onChange(rects) │
│         │                   │                      ▼                 │
│         │                   │             ┌────────────────────┐     │
│         │                   │             │   DirtyTracker     │     │
│         │                   │             │  collect + merge   │     │
│         │                   │             └─────────┬──────────┘     │
│         ▼                   ▼                       ▼                 │
│   ┌───────────────────────────────────────────────────────────┐      │
│   │                      RENDERER (rAF loop)                   │      │
│   │  for each dirty rect: clip → clear → query → draw z-sorted │      │
│   └───────────────────────────────────────────────────────────┘      │
│                            │                                          │
│   ┌────────────┐  ┌────────┴───────┐  ┌──────────┐  ┌────────────┐  │
│   │  History   │  │  roughCache    │  │  Export  │  │  Storage   │  │
│   │ undo/redo  │  │ id+version→Drw │  │ PNG/SVG  │  │ localStore │  │
│   └────────────┘  └────────────────┘  └──────────┘  └────────────┘  │
└───────────────────────────┬──────────────────────────────────────────┘
                            ▼
             ┌──────────────────────────────┐
             │  TWO <canvas> ELEMENTS       │
             │  ① static      (dirty-rect)  │
             │  ② interactive (full clear)  │
             └──────────────────────────────┘
```

---

## 2. Why two canvases

This is the single highest-leverage decision in the whole design, and most clones miss it.

| | **staticCanvas** (z-index 0) | **interactiveCanvas** (z-index 1) |
|---|---|---|
| Contains | every committed element | selection outline, 8 resize handles, rotate handle, the shape currently being drawn, marquee box, snap guides |
| Element count | 1 → 100,000 | 0 → ~20 |
| Repaint strategy | **dirty rectangles** | full `clearRect` + redraw, every frame |
| Repaint frequency | only when elements actually change | every frame during interaction, never when idle |
| Background | user's background colour | fully transparent |

The payoff: while you drag a selection box across 50,000 shapes, the static canvas is **not
touched at all**. You are only clearing and redrawing a rectangle outline on a transparent
layer. That is ~0.2 ms per frame regardless of scene size.

Both canvases sit in the same stacking context, same CSS size, same transform. Pointer events
are attached to the top one (`interactiveCanvas`) — the bottom one gets `pointer-events: none`.

---

## 3. The data model

### 3.1 Elements are a discriminated union

```ts
// src/engine/scene/element.types.ts

export type ElementId = string;

/** Every field that exists on every element, no exceptions. */
export interface ElementBase {
  id: ElementId;
  /** Monotonic. Bumped on EVERY mutation. Cache keys and dirty checks read this. */
  version: number;
  /** Scene-space (world) coordinates of the element's top-left, pre-rotation. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Radians, clockwise, about the element's centre. */
  angle: number;

  strokeColor: string;
  backgroundColor: string;
  fillStyle: 'solid' | 'hachure' | 'cross-hatch' | 'none';
  strokeWidth: number;
  strokeStyle: 'solid' | 'dashed' | 'dotted';
  roughness: number;       // 0 = ruler-straight, 1 = artist, 2 = cartoonist
  opacity: number;         // 0..100

  /** Frozen at creation. Makes the hand-drawn jitter deterministic across redraws. */
  seed: number;

  /** SOFT delete. Never splice the array. See §3.3. */
  isDeleted: boolean;

  /** Painter's-algorithm ordering key. See §3.4. */
  zIndex: number;
}

export interface RectangleElement extends ElementBase { type: 'rectangle'; }
export interface DiamondElement   extends ElementBase { type: 'diamond'; }
export interface EllipseElement   extends ElementBase { type: 'ellipse'; }

export interface LinearElement extends ElementBase {
  type: 'line' | 'arrow';
  /** Relative to (x, y). points[0] is always [0, 0]. */
  points: readonly (readonly [number, number])[];
  startArrowhead: 'arrow' | 'dot' | null;
  endArrowhead:   'arrow' | 'dot' | null;
}

export interface FreedrawElement extends ElementBase {
  type: 'freedraw';
  points: readonly (readonly [number, number])[];
  /** Parallel array, 0..1, from PointerEvent.pressure. Empty on mouse input. */
  pressures: readonly number[];
  /** Cached outline polygon from perfect-freehand. Invalidated on version bump. */
  simulatePressure: boolean;
}

export interface TextElement extends ElementBase {
  type: 'text';
  text: string;
  fontSize: number;
  fontFamily: 'hand-drawn' | 'normal' | 'code';
  textAlign: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle';
  /** Derived, cached. width/height come from measureText. */
  lineHeight: number;
  baseline: number;
  /** For text bound inside a shape (label on a rectangle). null for standalone text. */
  containerId: ElementId | null;
}

export type Element =
  | RectangleElement | DiamondElement | EllipseElement
  | LinearElement | FreedrawElement | TextElement;
```

**Why a discriminated union and not a class hierarchy?**

```ts
function draw(ctx: CanvasRenderingContext2D, el: Element) {
  switch (el.type) {
    case 'rectangle': return drawRectangle(ctx, el);  // el is RectangleElement here
    case 'freedraw':  return drawFreedraw(ctx, el);   // el.pressures exists here
    // ...
    default: {
      const _exhaustive: never = el;   // ← compile error if you add a type and forget a case
      throw new Error(`unknown element ${_exhaustive}`);
    }
  }
}
```

The `never` trick means adding `type: 'image'` later produces a **compile error at every place
that needs updating**. With classes and `instanceof` you get a silent runtime miss. This alone
justifies TypeScript for this project.

Elements are also plain JSON-serialisable objects — which is what makes localStorage
persistence, export, clipboard, and (later) CRDT sync trivial. A class with methods is not.

### 3.2 `version` — the cheapest invalidation signal in graphics

Regenerating a Rough.js `Drawable` for a rectangle costs ~0.05–0.3 ms. At 5,000 visible
rectangles × 60 fps that is 15–90 ms per frame of pure garbage generation. Unacceptable.

So we cache. But cache keyed on what?

- Keyed on `id` alone → stale when the element changes.
- Deep-compare the element every frame → O(fields) per element per frame, defeats the purpose.
- Keyed on **`id + ':' + version`** → O(1) string compare, always correct, impossible to get
  subtly wrong.

```ts
// src/engine/render/roughCache.ts
const cache = new Map<string, Drawable>();

export function getDrawable(el: Element, rc: RoughCanvas): Drawable {
  const key = `${el.id}:${el.version}`;
  let d = cache.get(key);
  if (!d) {
    d = generate(el, rc);
    cache.set(key, d);
    evictOldVersions(el.id, el.version);  // keep the map from growing forever
  }
  return d;
}
```

Every mutation goes through `Scene.mutate()` which bumps `version`. Nothing else may write to
an element. That single invariant makes the cache provably correct.

### 3.3 Soft delete (`isDeleted`) — not an optimisation, a correctness decision

Hard-deleting from an array creates three separate problems:

1. **Undo becomes hard.** You must remember not just the element but its exact index and every
   reference to it. With a soft delete, undo is `el.isDeleted = false`.
2. **Ids get reused / references dangle.** A text element bound to a rectangle
   (`containerId`) points at an id. If that id vanishes, you need cascade logic everywhere.
3. **The spatial index desynchronises.** The quadtree holds ids; a hard delete requires an
   immediate, correct, exception-safe removal from the tree.

Cost: the array grows. Mitigation: `Scene.compact()` runs on save/export and physically drops
deleted elements once no history entry references them. Excalidraw uses exactly this pattern.

### 3.4 Z-order

`zIndex` is a `number`, not an array position, so reordering doesn't invalidate the quadtree.

- New element → `zIndex = maxZ + 1`
- "Bring to front" → `zIndex = maxZ + 1`
- "Send backward" → swap with the neighbour below

`Scene` keeps a `sortedIds: ElementId[]` cache, rebuilt lazily only when `zDirty` is set. The
renderer needs elements in z-order *within a dirty rect*, so it sorts the (small) query result,
not the whole scene.

> **Fractional indexing** is the grown-up version: `zIndex` becomes a string like `"a0"`,
> `"a1"`, and inserting between two items produces `"a0V"` with no renumbering and no
> coordination. That's what you need for collaborative reordering. Note it in the README as
> "v2 work" — mentioning it in an interview is a strong signal.

---

## 4. Coordinate systems — the thing that breaks everyone

There are **three** coordinate spaces. Confusing any two of them is the #1 source of bugs in
canvas apps.

| Space | Origin | Unit | Where it comes from | Where it's used |
|---|---|---|---|---|
| **Screen** (a.k.a. viewport / client) | canvas top-left | CSS px | `e.clientX - rect.left` | pointer events, DOM overlays, cursor |
| **Scene** (a.k.a. world) | arbitrary, fixed forever | scene units | computed | **everything stored in `Element`**, quadtree, hit tests |
| **Device** | canvas backing-store top-left | physical px | screen × `devicePixelRatio` | `canvas.width/height`, `clearRect`, clip rects |

### 4.1 The transform

Convention (same as Excalidraw's):

```
screenX = (sceneX + scrollX) * zoom
screenY = (sceneY + scrollY) * zoom

sceneX  = screenX / zoom - scrollX
sceneY  = screenY / zoom - scrollY
```

`scrollX/scrollY` are stored in **scene units**, `zoom` is a scalar (0.1 … 30).

As a matrix, applied once per frame before drawing anything:

```ts
// includes DPR so we never think about it again inside draw code
ctx.setTransform(
  zoom * dpr, 0,
  0,          zoom * dpr,
  scrollX * zoom * dpr,
  scrollY * zoom * dpr,
);
// from here on, draw in SCENE coordinates. ctx.fillRect(el.x, el.y, el.width, el.height)
```

`setTransform(a, b, c, d, e, f)` maps `(x, y) → (ax + cy + e, bx + dy + f)`. With `b = c = 0`
that's `(ax + e, dy + f)` — pure scale-then-translate. ([MDN][mdn-settransform])

*(These four formulas are verified round-trip in `tests/transform.test.ts` — including the
zoom-at-cursor invariant below.)*

### 4.2 Pan

Dragging with space held, middle-mouse, or two-finger scroll:

```ts
scrollX += deltaScreenX / zoom;   // divide by zoom — panning 10 screen px at 4× zoom
scrollY += deltaScreenY / zoom;   // moves only 2.5 scene units
```

### 4.3 Zoom at cursor — derive it, don't guess it

Requirement: **the scene point under the cursor must not move.**

```
Let P = cursor position in screen space (fixed).
Let S = toScene(P, scroll, zoomOld)        ← the point we must pin.

We need:  toScene(P, scrollNew, zoomNew) === S
          P / zoomNew - scrollNew === S
          scrollNew = P / zoomNew - S
```

```ts
function zoomAtPoint(vp: Viewport, screenX: number, screenY: number, nextZoom: number) {
  const sceneX = screenX / vp.zoom - vp.scrollX;
  const sceneY = screenY / vp.zoom - vp.scrollY;
  vp.zoom = clamp(nextZoom, 0.1, 30);
  vp.scrollX = screenX / vp.zoom - sceneX;
  vp.scrollY = screenY / vp.zoom - sceneY;
}
```

Zoom should be **multiplicative**, not additive: `nextZoom = zoom * Math.exp(-deltaY * 0.01)`.
Additive zoom feels wrong because perceived zoom is logarithmic — going 1.0 → 1.1 is a big
visual jump, 10.0 → 10.1 is invisible.

### 4.4 Device pixel ratio

On a MacBook, `devicePixelRatio` is 2. Get this wrong and everything looks blurry — the single
most common "my canvas app looks bad" bug.

```ts
function resize(canvas: HTMLCanvasElement, cssW: number, cssH: number) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = Math.round(cssW * dpr);   // backing store, physical px
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width  = `${cssW}px`;        // layout size, CSS px
  canvas.style.height = `${cssH}px`;
}
```

Driven by a `ResizeObserver`, not a `window.resize` listener — `resize` misses sidebar
collapses, split-pane drags, and DPR changes from dragging a window between monitors. Also
listen to `matchMedia(\`(resolution: ${dpr}dppx)\`)` for the monitor-switch case.

**Resizing a canvas clears it and resets the transform.** So a resize always forces a full
repaint. Handle that explicitly.

---

## 5. Spatial index — the quadtree

### 5.1 The problem

Hit-testing a click means "which element is under this point?" The naive version:

```ts
for (let i = elements.length - 1; i >= 0; i--)   // reverse = topmost first
  if (hitTest(elements[i], point)) return elements[i];
```

O(n). At 50,000 elements with a real geometry test per element, a click takes 30–80 ms. Worse:
**the same query runs on every `pointermove`** for hover highlighting, so you drop to 12 fps
just by moving the mouse.

The renderer has the same problem in a different shape: "which elements intersect this dirty
rectangle?" Also O(n) naively, but this one runs 60 times a second.

Both are **range queries over 2D rectangles**. That's what a quadtree is for.

### 5.2 Structure

```ts
// src/engine/spatial/QuadTree.ts

interface Entry { id: ElementId; bounds: Bounds; }   // Bounds = {minX,minY,maxX,maxY}

class QuadTree {
  private items: Entry[] = [];
  private children: [QuadTree, QuadTree, QuadTree, QuadTree] | null = null;

  constructor(
    readonly bounds: Bounds,
    private readonly capacity = 8,
    private readonly maxDepth = 8,
    private readonly depth = 0,
  ) {}

  insert(e: Entry): void
  remove(id: ElementId, bounds: Bounds): boolean   // pass bounds to avoid a full scan
  query(range: Bounds, out: Entry[]): Entry[]
}
```

Split rule: when `items.length > capacity` **and** `depth < maxDepth`, subdivide into NW / NE /
SW / SE and push each item down into the single child that **fully contains** it. Items that
straddle a boundary stay at this node.

That last clause is the crux, and the trade-off is a great interview answer:

| Strategy | Insert | Query | Notes |
|---|---|---|---|
| **Straddlers stay in parent** *(our choice)* | O(depth) | O(depth + k) | No duplicates → `remove` is unambiguous. Pathological case: many large elements pile up in the root. |
| Straddlers duplicated into every overlapping child | O(depth · 4) | O(depth + k), needs dedupe | Deeper trees, more memory, `remove` must visit every copy. |
| **Loose quadtree** (child bounds expanded 2×) | O(depth) | O(depth + k), more false positives | Straddling is much rarer. Used in game engines. |

`maxDepth = 8` bounds the tree at 4⁸ = 65,536 leaves and — critically — stops infinite recursion
when 100 elements share the exact same coordinates (which `capacity` alone can never resolve).

#### 5.2.1 What the straddler rule actually cost — measured in Phase 4a

The pathology above is not hypothetical, and it is not mainly about *large* elements.

Subdivision stops paying once a node is only a few times an element's size: below that, most
elements straddle whichever line you cut with, so they stay in the parent and the node stops
thinning. The result at 50,000 elements is that a pinhole query descends into **31 nodes** — the
tree working perfectly — but those 31 nodes hold about 80 entries each, against a capacity of 8.

So `tested` fell from 100% of the scene to ~5%, and then stayed at ~5% as the scene grew:

| Elements | tested | % of scene | nodes descended into |
|---:|---:|---:|---:|
| 500 | 36 | 7.2% | 17 |
| 2,000 | 123 | 6.2% | 21 |
| 10,000 | 568 | 5.7% | 26 |
| 50,000 | 2,497 | 5.0% | 31 |

**That is a ~16× smaller constant, not a better complexity class.** Raising `maxDepth` from 8 to 14
changes it by under 1% — measured, because "increase the depth limit" is the obvious guess and it is
wrong. The remedy is the loose quadtree in the table above. It is not implemented, because what
remains is 0.3 ms of a 16.67 ms frame, and the counters to revisit the decision are already in the
code.

### 5.3 An infinite canvas has no bounds. A quadtree needs bounds.

This is the genuinely interesting problem, and the part most tutorials never mention.

A quadtree is constructed with a fixed root rectangle. Our canvas is infinite. Three options:

1. **Pick a huge root** (±10⁷ scene units). Simple; wastes depth on a mostly-empty world and
   still breaks if someone pans far enough.
2. **Spatial hash grid** — `Map<"cx,cy", Set<id>>` with a fixed cell size. Genuinely unbounded,
   O(1) insert, dead simple. Weakness: a fixed cell size performs badly when element sizes vary
   by orders of magnitude (a 5px dot and a 50,000px rectangle in the same grid).
3. **Re-rooting quadtree** *(our choice)*. Start with a modest root. When an element falls
   outside it, allocate a **new root twice the size** positioned so the old root becomes one of
   its four children, then insert. Each re-root is O(1) — you never rebuild.

```
insert(e):
  while (!root.bounds.contains(e.bounds)):
     grow()          // O(1) — allocate parent, old root becomes one quadrant
  root.insert(e)

grow():
  // pick which quadrant the old root should occupy so we expand TOWARD the new element
  const q = quadrantToward(e.bounds, root.bounds);
  const newRoot = new QuadTree(expand(root.bounds, q), ...);
  newRoot.children = makeSiblings(root, q);
  root = newRoot;
```

Doubling means reaching any coordinate takes O(log) re-roots. Panning to 10⁹ costs ~30
allocations, once, ever.

### 5.4 Keeping the index in sync

The index is a **derived cache**. It must never be the source of truth — `Scene` is. The
invariant:

> Every mutation to an element's geometry goes through `Scene.mutate()`, which calls
> `index.update(id, oldBounds, newBounds)` before returning.

`update` = `remove(id, oldBounds)` then `insert({id, newBounds})`. For dragging 500 selected
elements at 60 fps, that's 30,000 remove+insert per second — measurable but fine. If it ever
isn't, the fix is to **suspend the index during a drag**: pull the dragged set out of the tree
on `pointerdown`, keep it in a plain array (it's small, O(k) is fine), and re-insert on
`pointerup`. Real editors do this.

### 5.5 Hit detection is two phases

> **Note added in Phase 4a.** The render cull does *not* use the index unconditionally — see
> `Scene.visible`, which chooses per query between returning the cached sorted array, a linear
> scan, and an index query. The tree returns entries in tree order, so re-sorting them into z-order
> costs O(k log k), and at 50,000 elements with everything on screen that sort alone is ~18 ms.
> Hit detection below has no such problem: it wants the topmost hit, `k` is 1–5, and there is
> nothing to sort.

**Broad phase** — quadtree, AABB only, cheap, over-inclusive:

```ts
const candidates = index.query({ minX: p.x - t, minY: p.y - t, maxX: p.x + t, maxY: p.y + t });
```

**Narrow phase** — exact geometry, expensive, only on the ~1–5 survivors, in reverse z-order:

```ts
candidates.sort(byZDesc);
for (const c of candidates) if (hitTestPrecise(scene.get(c.id), p, threshold)) return c.id;
```

Narrow-phase rules per type (`threshold ≈ 10 / zoom` scene units, so it feels constant on screen):

| Type | Filled (`backgroundColor !== 'transparent'`) | Unfilled |
|---|---|---|
| rectangle | point inside AABB | within `threshold` of any of the 4 edges |
| ellipse | `(dx/rx)² + (dy/ry)² ≤ 1` | `\|√((dx/rx)² + (dy/ry)²) − 1\| · min(rx,ry) ≤ threshold` |
| diamond | point-in-polygon (ray casting) | distance to each of 4 edges |
| line / arrow | — | `min` distance to any segment ≤ threshold |
| freedraw | point-in-outline-polygon | distance to any segment ≤ threshold |
| text | point inside AABB | same |

**Rotation is handled once, generically, not per shape:**

```ts
// Transform the query point into the element's LOCAL, un-rotated frame.
// Then every hit test above works as if angle were 0.
function toLocal(p: Point, el: Element): Point {
  const cx = el.x + el.width / 2, cy = el.y + el.height / 2;
  const cos = Math.cos(-el.angle), sin = Math.sin(-el.angle);
  const dx = p.x - cx, dy = p.y - cy;
  return { x: dx * cos - dy * sin + cx, y: dx * sin + dy * cos + cy };
}
```

This is the trick worth remembering: **never write rotated-shape intersection maths. Rotate the
point instead.** One 6-line function replaces a dozen special cases.

> **Built in Phase 4b, with two deviations from the table above, both deliberate.**
>
> **Freehand is tested against its polyline, not its outline polygon.** The rendered outline does
> not exist until perfect-freehand builds it, and building it on every `pointermove` is the most
> expensive operation in the renderer run 240 times a second. Distance to the recorded polyline
> with the tolerance widened by half the stroke width differs from the exact answer by less than
> the stroke's own thickness, and errs toward being easier to click.
>
> **The ellipse outline distance is approximate.** `|d − 1| · min(rx, ry)` is exact for a circle
> and generous for an eccentric ellipse. The exact answer needs a quartic solve or an iteration,
> which is real work per pointer event, and being generous means an extra pixel of tolerance
> rather than a shape you cannot click.
>
> Measured result at 50,000 elements: a click hands **3 candidates** to the narrow phase. The
> linear scan it replaces costs 6.7 ms in a busy area and 13.3 ms over blank canvas — where it
> cannot exit early — against ~4 ms of total event budget at 240 Hz.

Note the consequence for the broad phase: an element's **quadtree bounds must be the AABB of the
rotated shape**, which is larger than `{x, y, width, height}`. Compute it by rotating the four
corners and taking min/max, then pad by `strokeWidth / 2 + roughnessJitter`.

---

## 6. Dirty-rectangle rendering

### 6.1 The idea

Naive render loop:

```ts
function frame() {
  ctx.clearRect(0, 0, W, H);
  for (const el of scene.all()) draw(ctx, el);   // ← O(n) every frame, forever
  requestAnimationFrame(frame);
}
```

At 5,000 rough-rendered shapes this is ~40 ms/frame → 25 fps *while completely idle*.

Dirty-rect rendering inverts it: **the screen is already correct. Only repair what changed.**

### 6.2 The pipeline

```
    mutation(s) during this frame
              │
              ▼
   ① COLLECT   DirtyTracker.add(rect)     ← in SCENE space
              │
              ▼
   ② MERGE     union overlapping/nearby rects
              │
              ▼
   ③ TRANSFORM scene → screen → device px
              │
              ▼
   ④ SNAP      floor/ceil to integers, pad for AA + stroke bleed
              │
              ▼
   ⑤ For each rect:
                ctx.save()
                ctx.beginPath(); ctx.rect(r); ctx.clip()
                ctx.clearRect(r)                     ← or fill bg colour
                index.query(sceneRect) → sort by z
                for each: drawElement()
                ctx.restore()
```

### 6.3 The five things that will bite you

**① A moved element dirties TWO rectangles.** The place it left (needs erasing) and the place it
arrived (needs painting). Forget the first and you get smearing — the classic dirty-rect bug.

```ts
mutate(id, patch) {
  const before = getRenderBounds(el);
  Object.assign(el, patch);
  el.version++;
  const after = getRenderBounds(el);
  dirty.add(before);
  dirty.add(after);
  index.update(id, before, after);
}
```

**② Bounds ≠ geometry.** The pixels an element actually touches are bigger than `{x,y,w,h}`:

```
renderBounds = rotatedAABB(x, y, w, h, angle)
  padded by  strokeWidth / 2          ← stroke straddles the path
           + roughness * 2            ← Rough.js jitters outside the path
           + (shadowBlur + |shadowOffset|)
           + 1                        ← antialiasing
```

Under-pad by one pixel and you leave a faint ghost line. This is the bug you'll spend an
evening on. Write a debug mode that strokes every dirty rect in red — you'll find it in a minute.

**③ Merging needs a heuristic, not a rule.** Two dirty rects at opposite corners of the screen
should stay separate. Two overlapping ones should merge — clipping twice costs more than the
extra pixels. The rule:

```ts
const shouldMerge = (a: Bounds, b: Bounds) => area(union(a, b)) <= (area(a) + area(b)) * 1.4;
```

Then: keep merging pairwise until no pair merges (a few passes over a small list — the list is
small because you also cap it). And:

```ts
// Above some count, or above some coverage fraction, stop being clever.
if (rects.length > 24 || totalArea > 0.6 * screenArea) return FULL_REPAINT;
```

Knowing *when to give up and full-repaint* is what separates a working implementation from a
demo. Track this ratio in the stats overlay.

**④ Fractional pixels cause seams.** Clipping to `x = 12.3` leaves a hairline of stale pixels
at `x = 12`. Always `Math.floor` the min, `Math.ceil` the max, **after** converting to device
pixels.

**⑤ Some changes are not local and must force a full repaint:**

- viewport pan or zoom (everything moved)
- canvas resize (backing store cleared)
- theme / background colour change
- z-order change spanning a large region
- more than N elements changed at once (see ③)

### 6.4 Two-level caching

For very large scenes, add a **tile cache**: divide scene space into e.g. 512×512 scene-unit
tiles, each backed by an `OffscreenCanvas`. A dirty rect invalidates only the tiles it touches;
the frame composite becomes `drawImage` per visible tile. This is how map renderers work.

**Deliberately out of scope for v1.** Ship dirty rects first, measure, and only add tiles if the
numbers demand it. Write the note in the README — "measured X, so did not add tiles" is a much
stronger answer than an unmeasured optimisation.

> **Measured in Phase 5, and the numbers do not demand it.** One shape changing in a
> 50,000-element scene repaints **0.8%** of the screen. There is no headroom left to reclaim in
> that case, and the case tiles would actually help — panning — forces a full repaint by
> definition, which no amount of tile caching changes without also caching the *composite*.
>
> Revisit when a workload keeps `coverage` above ~30% while `full repaints` stays low. That is the
> shape of a scene where per-region repainting is doing real work and still losing, and it is the
> only reading that would justify the memory.

### 6.5 What Phase 5 measured

Full repaint versus dirty rectangles on a static-layer-only workload — 50,000 elements, twenty
select-and-delete operations, identical build with one line changed:

| | full repaint | dirty rects | |
|---|---:|---:|---:|
| frame p50 | 14.70 ms | 12.10 ms | 1.2× |
| frame p95 | 1074.80 ms | 82.20 ms | **13×** |
| screen repainted | 100% | 0.8% | |
| full repaints | 43 | 3 | |
| wall clock | 21.4 s | 3.3 s | 6.5× |

Two results worth carrying forward.

**p50 moved 1.2× and p95 moved 13×.** §10's insistence on percentiles rather than a mean was not
theoretical: a mean would have reported this change as barely worth making.

**Whole-frame time while *drawing* barely moved at all** (11.20 → 9.70 ms), because §2's two-canvas
split already removed the static layer from the drag hot path. The split and dirty rectangles solve
the same problem — cost that grows with the document — at two different moments: the split covers
*drawing a new shape*, dirty rects cover *changing an existing one*. They stop overlapping in
Phase 6, where dragging a committed element mutates the scene every frame.

### 6.6 What Phase 6 measured — the same technique, on the workload it was built for

50,000 elements, one shape selected, dragged in a 120-step circle. Identical build, one line
changed to force a full repaint:

| | full repaint | dirty rects | |
|---|---:|---:|---:|
| frame p50 | 858.70 ms | 7.70 ms | **112×** |
| frame p95 | 1236.10 ms | 21.20 ms | 58× |
| elements redrawn per frame | 49,819 | 7 | |
| screen repainted | 100% | < 0.1% | |
| wall clock, one drag | 122.8 s | 8.3 s | 15× |

§6.5's caveat — *"whole-frame time while drawing barely moved"* — is why this workload exists. The
two-canvas split covers drawing; only a committed element moving exercises the static layer every
frame, and this is the number that pays for the phase.

**A bug this measurement found, which had been shipping since Phase 4b.** The selection overlay
computed its outlines like this:

```ts
scene.elementsInBox(viewport.visibleSceneBounds()).filter((el) => selection.has(el.id))
```

Correct, and backwards. It costs O(elements on screen) to produce a result capped at 200 outlines.
Zoomed out over 50,000 elements the interactive stage read **84.9 ms per frame** while `cull` and
`draw` — both optimised in earlier phases — read 0.00 ms. Iterating the selection and culling each
member against the viewport is bounded by the cap instead: **0.10 ms**.

Two things made it invisible for two phases. Selection outlines only render while something is
selected, and before Phase 6 nothing held a gesture open for three seconds. And the code *looked*
right: it used the index Phase 4a built, which is exactly the reflex the index encourages.

> **An index makes a query cheap. It does not make it free.** Asking a cheap question about a large
> set is still worse than asking a direct question about a small one, and the direction of the join
> is a decision, not a detail.

---

## 7. Input and the tool state machine

### 7.1 Pointer Events, not mouse events

`pointerdown/move/up` unify mouse, touch, and stylus, and give you `pressure`, `tiltX/Y`,
`pointerType`, and `isPrimary` for free. `pressure` is what makes freehand strokes look good.

**`setPointerCapture` is mandatory.** Without it, dragging a shape and releasing the mouse
outside the window leaves the app stuck in `dragging` forever.

```ts
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);   // all subsequent events route here, guaranteed
  tools.onPointerDown(toScene(e), e);
});
```

**`getCoalescedEvents()`** — the browser throttles `pointermove` to one per frame but keeps the
skipped samples. For freehand drawing you want all of them, or fast strokes come out as
polygons:

```ts
canvas.addEventListener('pointermove', (e) => {
  for (const ev of e.getCoalescedEvents?.() ?? [e]) tools.onPointerMove(toScene(ev), ev);
});
```

### 7.2 The FSM

Input never mutates the scene directly. It produces *intents*; the active tool interprets them.

```
                      ┌──────────────────────────────────────┐
                      │               IDLE                    │
                      └───┬──────────────┬──────────────┬─────┘
        tool=shape,       │              │ tool=select, │ tool=select,
        pointerdown       │              │ hit element  │ hit empty
                          ▼              ▼              ▼
                    ┌──────────┐   ┌──────────┐   ┌───────────┐
                    │ DRAWING  │   │ DRAGGING │   │ MARQUEE   │
                    └────┬─────┘   └────┬─────┘   └─────┬─────┘
                         │              │               │
        pointerdown on   │              │               │
        a resize handle  ▼              ▼               ▼
                    ┌──────────┐   ┌──────────┐    (pointerup)
                    │ RESIZING │   │ ROTATING │         │
                    └────┬─────┘   └────┬─────┘         │
                         └──────┬───────┴───────────────┘
                                ▼
                     COMMIT → history.push() → IDLE
```

Two rules that keep this clean:

1. **In-progress geometry lives on the interactive canvas only.** The element is not added to
   `Scene` until `pointerup`. So a half-drawn rectangle never enters the quadtree, never enters
   history, and can be cancelled with `Escape` by simply throwing it away.
2. **One history entry per gesture**, pushed on commit — not per `pointermove`. Otherwise one
   drag produces 400 undo steps.

### 7.3 Transforms: from a snapshot, never incrementally

Every transform function takes the element **as it was when the pointer went down**, plus where the
pointer is now, and returns what the element should be. Nothing reads the element's current state;
nothing accumulates.

```ts
resizeGeometry(original: GeometryPatch, handle, pointer, modifiers): GeometryPatch
```

The incremental alternative — apply this frame's delta to whatever the shape is now — is the
obvious implementation and it is wrong in three separate ways:

| | Incremental | Snapshot |
|---|---|---|
| **Drift** | 60 float operations per second; a shape returned to its starting pixel is thousandths off, and a rotation of 360° leaves a square un-square | pointer back at its origin ⇒ *bit-exact* original |
| **Modifiers** | Shift pressed mid-gesture locks to the shape's accidental current ratio | locks to the ratio the user actually drew, and releasing it resumes following the cursor exactly |
| **Undo (§8)** | a diff of a diff | "was X, now Y" for free |

Measured: dragging a resize handle out 100 units and back, one frame at a time, leaves an
incremental implementation ~2×10⁻¹³ narrower than it started. Invisible once. Not invisible after
ten minutes of fiddling with two shapes that were supposed to line up.

**Rotation is handled by moving the pointer, not the shape.** Resizing a rotated rectangle by
computing rotated corner positions is a page of trigonometry with a sign error hiding in it.
Instead:

1. Rotate the pointer *into* the element's local, un-rotated frame.
2. Resize there, where the maths is `width = |pointer.x − anchor.x|` and nothing else.
3. Rotate the resulting **centre** back out to world space.

Step 3 is the one people miss. Resizing in local space moves the local centre, and the anchor has
to stay fixed in *world* space — so the new world centre is the old one plus the local centre
delta, rotated. Skip it and a rotated shape crawls sideways as you resize it, which looks like a
physics bug and is a missing rotation. This is the same trick as §5.5's hit test (rotate the point,
not the shape) and the mirror of `drawElement` (rotate the canvas, not the shape).

**Group resize has a documented limitation.** For a *rotated* child under a *non-uniform* scale the
mathematically correct result is a sheared shape, and shear is not representable in
`{x, y, width, height, angle}`. The options are a full 2×3 matrix per element, baking the shear into
the geometry, or accepting the approximation. v1 accepts it: exact when `sx === sy` (which
Shift-drag guarantees), visibly wrong only for rotated children under strong non-uniform scaling.
Refusing to resize such groups is worse, because the user cannot tell why nothing happens.

**Handles are a constant size on screen**, so every handle dimension is divided by zoom before use.
A handle that scaled with the document is a speck at 10% and covers the shape at 3000%. The same
applies to the cursor: the handle called `nw` on a shape rotated a quarter turn is visually in the
top-*right*, so the resize cursor is derived from the handle direction **plus** the element's angle.

### 7.4 Text — the element this codebase does not own the geometry of

Every variant up to `TextElement` is *told* how big it is. Text is *asked*. How wide `"Hello"` is
depends on the font file, the size, the platform's rasteriser and hinting, and whether a webfont has
finished loading. There is no computing it from first principles; the browser is the only source of
truth, via `CanvasRenderingContext2D.measureText`.

#### 7.4.1 Measurement is an input, not a computation

Nothing under `src/engine/scene/` calls `measureText`. A `TextMeasurer` is passed in wherever a
measurement is needed, and the element **stores** the result — its wrapped `lines`, `width`,
`height`, `ascent`, `lineHeight`.

Two reasons, and the second matters more:

1. **`getGeometryBounds` must not need a canvas.** The whole `src/engine/` layer unit-tests in Node
   in about nine seconds with no jsdom, and §5.4's index stores bounds at insert time while §6's
   dirty tracker memoises them per object — both already assume bounds are cheap to read. A
   synchronous shaping call behind `el.width` would sit inside the cull.
2. **It makes the staleness explicit.** Cached measurements go stale: when the font size changes,
   when the family changes, and — the awkward one — when a webfont finishes loading *after* the text
   was laid out. Storing the measurement forces you to name every one of those moments. Computing it
   on demand hides them, right up until the text jumps half a second after the page loads.

The discipline that pays for it: **every write to `text`, `fontSize`, `fontFamily` or `wrapWidth`
goes through `relayoutText`, in the same `Scene.mutate` call.** That is §3.2's "one mutator, always a
new object" carrying one more invariant.

`relayoutText` reuses the previous `lines` array when the contents come out identical. `Scene.mutate`
compares per key with `Object.is`, so a freshly allocated array of the same strings reads as a
change — and `remeasureText()` runs over *every* text element on `document.fonts.ready`. Without the
reuse, one font event bumps `version` on all of them, invalidating the Rough cache and the memoised
bounds and forcing a full repaint, from a code path whose only job is to check whether anything
moved.

#### 7.4.2 Line breaking is greedy, and that is a decision

Fill each line until the next word does not fit, then break: O(words), one measurement per word.

The alternative is **Knuth–Plass**, TeX's algorithm, which treats the paragraph as one optimisation
and minimises total squared badness by dynamic programming, so a slightly worse early line can buy a
much better later one. Visibly better rag; O(n²) in the general case with a far larger constant.

Greedy wins here for a reason unrelated to complexity: **this wraps on every keystroke.**
Paragraph-optimal breaking means the line *above* the one you are typing on can re-break as you
type, and text reflowing behind the cursor is disorienting in a way slightly worse rag never is.
Word processors that do use Knuth–Plass mostly apply it at render time, not during editing.

The case that is easy to miss: a single word longer than the wrap width. Greedy word wrap gives it a
line of its own and moves on, and it still overflows the box, silently, over whatever is beside it.
One pasted URL breaks the layout with no error anywhere. So an over-long word is broken by **code
point** — not by UTF-16 unit, or an emoji comes out as two replacement glyphs.

Two different width rules, and conflating them makes the box creep:

| | width of the block |
|---|---|
| auto-width (`wrapWidth === null`) | the widest line |
| wrapped | the wrap width itself |

Measure a wrapped block by its widest line and deleting a long word shrinks the box, which changes
the wrap width the next keystroke is measured against, so retyping the word does not restore the
original layout.

#### 7.4.3 Editing is a real `<textarea>`, not a drawn caret

The list of things a hand-rolled caret would have to reimplement is not a list of features, it is a
list of ways to exclude people:

- **IME.** Typing Japanese, Chinese or Korean goes through an input method editor; composition state
  lives *inside* the input element and is only observable through `compositionstart`/`update`/`end`.
  A canvas caret cannot host a composition — and it looks fine in every test written by someone who
  types Latin.
- **Accessibility.** A screen reader can read a focused textarea. It cannot read pixels. Nor can
  dictation software, switch access or a braille display.
- **The mobile keyboard.** It appears because a form control has focus. Focus *is* the API.
- **Everything the platform already did.** Word-wise motion, double-click-to-select-word, undo
  *inside* the field, spellcheck, autocorrect, drag-and-drop of text, OS text replacements.

Excalidraw, tldraw and Figma all pay the alignment cost. Google Docs famously does not, and what
buys it that freedom is a document model and a test matrix this project does not have.

Two rules make it line up:

- **The element is hidden from the static layer while its editor is open** (`Renderer.setHidden`).
  Painting it as well as showing the textarea gives two copies a fraction of a pixel apart, which
  does not read as "drawn twice" — it reads as *blurry*, and gets filed as a font-rendering bug.
- **The textarea carries a scene-unit font size and a CSS transform does the zoom.** Measured
  against the canvas: 0.0 px apart at 100% and at 271%.

An honest correction, because the first version of this section claimed otherwise. I expected the
alternative — `fontSize × zoom` in screen pixels — to drift as browsers quantised font sizes, and
A/B'd the two builds from 100% to 3000%. **Pixel-identical at every level.** The reason that survives
measurement is duller: the element needs a transform for its rotation anyway, so scaling keeps one
affine map in one place instead of splitting it across two.

#### 7.4.4 The accessibility setting that breaks the overlay

Chrome and Firefox both let a user set a **minimum font size**, and it is not a suggestion — the
browser silently raises anything smaller. Ask for 20px under a 24px minimum and `getComputedStyle`
reports 24px, with nothing thrown and nothing logged. The editor's glyphs are then 20% larger than
the canvas's, at every zoom, and wrap in the wrong places. The only symptom is text that visibly
resizes the moment you stop editing.

It fails for exactly the users least able to work around it, and it never shows up in development,
because a developer's browser has the minimum at its default of zero.

The correction: read the size the browser actually used and divide the inflation back out of the
transform. Rendered size is `used × scale`, so `scale = zoom / inflation` renders at `asked × zoom`.
Everything else set in element-local pixels is **multiplied** by the same ratio — local lengths are
about to be shrunk by the transform, so they must start proportionally larger. (Getting that
backwards makes the editor wrap at 1/1.44 of the right width, and the symptom looks like a wrapping
bug rather than a scaling one.)

Measured with a 24px minimum, editor against canvas:

| | before | after |
|---|---|---|
| editor block | 90 × 31.5 | **138.5 × 18** |
| canvas block | 138.5 × 18 | 138.5 × 18 |

`getComputedStyle` forces a style recalculation, so it is read only when the requested size changes,
not on every frame.

#### 7.4.5 Resize means something different for text

Height is *derived* — however many lines the content wraps to, times the line height. So the eight
handles cannot all mean what they mean for a rectangle; accepting a height would leave an element
whose stored box disagrees with its content, which the spatial index and the dirty tracker both
believe.

| handle | what it does | why |
|---|---|---|
| corner | scales the **font** | "make this bigger" means bigger type, not 20px type stretched into a taller box |
| e / w | sets the **wrap width** and reflows | also how an auto-width run becomes a wrapped paragraph — no mode switch, you just drag a side |
| n / s | nothing | there is no height to set; accepting the drag and springing back on the next keystroke is worse |

The corner scale factor comes from the *width* even though a corner drag moves both axes, because
the height the pointer implies is not a height the element can adopt.

---

## 8. History (undo / redo) and persistence

### 8.1 Snapshots of the touched elements

Three designs are viable and the middle one wins:

| | Store | Memory per entry | Cost |
|---|---|---|---|
| whole-scene snapshot | everything | O(scene) | unusable at 50,000 × 100 entries |
| **element snapshots** | the objects a gesture touched, before and after | **O(touched)** | none worth naming |
| command + inverse | an operation and its inverse | O(1)-ish | every op needs a correct inverse, and they drift silently |

```ts
interface HistoryEntry {
  before: ReadonlyMap<ElementId, Element | null>;  // null = did not exist
  after:  ReadonlyMap<ElementId, Element | null>;
  selectionBefore: readonly ElementId[];           // undo should put you back
  selectionAfter:  readonly ElementId[];
}
```

An entry holds **references**, not copies, and it can because `Scene.mutate` never edits in place
(§3.2). The old object is still there and still effectively immutable. A 400-point freehand stroke
dragged for three seconds produces ~180 objects; history keeps two of them.

That is the fourth feature paid for by one rule — *one mutator, always a new object* — after the
Rough drawable cache, the memoised render bounds, and the WeakMap in §6.4.

### 8.2 One gesture is one entry: first `before`, last `after`

A three-second drag calls `mutate` about 180 times. The entry must hold the geometry from before the
drag started and the geometry after it ended, and nothing in between. So the first time an id is
touched inside a batch its "before" is kept forever; its "after" is overwritten every time.

Batches are **counted, not boolean**, because a command can legitimately run inside a gesture. Text
editing depends on it: the editor opens a nested batch inside the pointer gesture, `onPointerUp`
closes the outer one, and everything typed afterwards still lands in the same entry — so creating a
text run and typing a sentence into it is one undo, not forty.

**Recording is on by default; batching is the optimisation.** The alternative — ignore anything
outside an explicit batch — looks safer and fails worse: forget to open a batch and the operation is
*silently not undoable*, which nobody notices until a user loses work. Recording by default means
forgetting a batch gives an action that takes more undos than ideal. Changes that are genuinely not
user actions (loading, re-measuring text when a webfont arrives) go through `history.suppress`.

### 8.3 Two invariants that are easy to break

**Undo is a mutation, not a special case.** Applying an entry goes through `Scene.mutate` and
`Scene.add` like everything else, because those maintain the quadtree, the content bounds and the
dirty rectangles. An undo path that wrote into the element map directly leaves the spatial index
describing where shapes *used to be*, and the symptom — clicks missing shapes — surfaces minutes
later, somewhere else, with nothing connecting it back.

**`version` must never go backwards.** The obvious undo puts the old object back, which restores its
old `version` — and `version` is the cache key §3.2 exists to maintain. Concretely: an element goes
v5 → v6 → v7; undo restores the v5 object; the user edits once more and it is v6 again with
*different* geometry, while the drawable cached under `id:6` is the old shape. The canvas draws a
shape that no longer exists.

So an entry is applied as a **patch** and `Scene.mutate` bumps the version as it always does.

**Undo must not itself be undoable.** The mutations it performs come back through the same change
feed history is listening to. Without a re-entrancy guard the stack oscillates between two states
and the user can never reach the third.

---

### 8.4 Persistence: why IndexedDB

Measured on this project's generated scenes:

| elements | document | `JSON.stringify` | `structuredClone` |
|---:|---:|---:|---:|
| 1,000 | 0.50 MB | 3.2 ms | 3.8 ms |
| 10,000 | 4.94 MB | 34.7 ms | 44.2 ms |
| 50,000 | **24.69 MB** | 492.9 ms | 389.0 ms |

localStorage's quota is ~5 MB, so a document outgrows it around **ten thousand elements** — a
mid-sized scene here, not an extreme one. It fails by throwing on write, at the moment the user has
done the most work, and it is synchronous on top of that.

The last column is the one worth carrying: storing the object graph directly in IndexedDB rather
than a JSON string does **not** escape the serialisation cost. The structured clone happens on the
calling thread when `put` is called.

So the cost is not made cheap, it is **moved**:

1. **Debounce** — 1.2 s of quiet before a save, so a hundred keystrokes produce one write of the
   final state rather than a hundred writes nobody will read.
2. **`requestIdleCallback`** — the hitch lands in the gap after the gesture instead of inside it.

| 50k elements, one 150-step drag | debounced + idle | saved on every change |
|---|---:|---:|
| frame p50 | **5.10 ms** | 123.10 ms |
| frame p95 | **7.10 ms** | 165.20 ms |
| wall clock | **7.5 s** | 28.2 s |

A worker would make it genuinely free and is scoped out with the number attached: getting 50,000
elements across the boundary costs most of the clone again unless the scene lives in a
SharedArrayBuffer from the start, which is a different data model.

**There is no localStorage fallback.** When IndexedDB is unavailable — some private-browsing modes,
or switched off — the table above says a fallback would silently fail for any real document. So
`available` goes false, the reason is reported, and the UI says *"not saving"*. A bad situation the
user can respond to beats a worse one they discover later.

### 8.5 `restore` is the whole of the file format

`serialize` is two lines. Everything that matters is on the way back in, because **the file being
loaded was written by a different version of this program than the one reading it** — true from the
second release onwards, and true right now for anything saved before the last change.

| Decision | Failure it prevents |
|---|---|
| Check a `type` discriminator first | Any JSON with an `elements` array looks close enough to load, and fails as an unrecognisable drawing rather than "not one of ours" |
| **Refuse a newer schema; repair an older one** | Fields you do not know about may change how the ones you do know about should be read. Guessing produces a document that looks plausible and is wrong — then the user saves over it |
| Drop unknown element types, keep their neighbours | A build that adds `image` writes one; this build must still open the rest of the document |
| Replace NaN and Infinity | A NaN width makes bounds NaN, makes every quadtree comparison false, and makes the element permanently unclickable *and* invisible to the cull, with nothing in the UI to explain it |
| Re-align `pressures` to `points` | perfect-freehand indexes positionally; a length mismatch silently tapers the wrong part of the stroke |
| Never throw | A corrupt document must give an empty canvas and a message. The user's other documents are fine and the app has to stay usable enough to say so |
| **Re-measure every text element** | §7.4.1: the derived fields were measured on the machine that saved the file. Trusting them gives text whose stored box disagrees with its own glyphs, and a spatial index that says the text is somewhere it visibly is not |

Soft-deleted elements are not written. They exist so undo and the selection can reference them
(§3.3); once the document is on disk nothing references them, and keeping them means a file that
grows forever as the user deletes things.

---

## 9. Export

Export is **not** a screenshot. `canvas.toBlob()` on the live canvas captures the current viewport,
at the current zoom, with the selection handles in it. Wrong on three counts, and the third is the
one that ships: nobody notices the handles until a user puts the image in a slide deck.

An export has its own viewport, unrelated to the screen's — it frames the *content*, at a scale the
caller chose, with nothing on top. Measured: a drawing on a 1200×760 screen exports as 396×251.

### 9.1 The claim from Phase 2, cashed

`drawElement.ts` has carried this since it was written:

> It is also what will let Phase 9 reuse this exact code to render an export at a different scale to
> an offscreen canvas, with no changes. If export ever needs to modify this file, that is a signal
> something in here is reading screen state it should not be.

**It did not need to be modified.** `git diff` on `drawElement.ts` and `roughCache.ts` across the
export PR is empty. The whole PNG exporter is:

```ts
ctx.setTransform(...exportMatrix(bounds, scale));   // a FRESH transform
for (const el of sorted) drawElement(ctx, rc, cache, el);
```

`drawElement` was never allowed to read `zoom`, `scroll` or `devicePixelRatio`. It reads six numbers
off a 2D context and does not care where they came from. Seven phases later a caller with a
completely different idea of what those numbers mean gets the same drawing for free.

### 9.2 What is pure, and why that is most of the phase

| module | needs a canvas? | tested where |
|---|---|---|
| `export/bounds.ts` — framing, browser caps | no | Node |
| `export/svg.ts` — the whole serialiser | no (`rough.generator()` needs no DOM) | Node |
| `export/png.ts` | yes | browser |

Same move as §7.4.1's `TextMeasurer`: push the untestable thing to the edge until what is left is
arithmetic. What remains in `png.ts` is a loop.

### 9.3 The browser's canvas caps

Browsers cap canvas dimensions and **do not tell you**. `getContext` succeeds, drawing succeeds, and
`toBlob` hands back a blank image or null. No exception, no console warning.

Two limits, and both must be applied:

| | value used | why |
|---|---|---|
| per side | 16,384 px | covers desktop Chrome, Firefox and Safari. It does **not** cover iOS, documented at 4,096 |
| total area | 268,435,456 px | the one people miss — 20,000 × 15,000 is legal on both axes and still refused |

Sides first, then area, because the area fix is a square root and applying it first can still leave a
side over the cap on a long thin drawing. Then ceil, then re-clamp: rounding up can push a dimension
one pixel past the cap when the scale lands exactly on it, and a one-pixel overflow still produces a
blank image.

The per-side number is a compromise, stated rather than hidden: clamping everyone
to iOS's 4,096 would cripple desktop exports to fix one platform, so `toPng`
catches the null from `toBlob` and says *"try a smaller scale"* instead. Detecting
the real limit means binary-searching canvas allocations at startup — which is
what the `canvas-size` library does, and is more machinery than this earns.

**Clamp, do not refuse.** The user asked for a picture of their drawing; a slightly smaller picture is
almost always what they wanted, and an error leaves them guessing which number to change. The UI
shows the resulting dimensions *before* the button is pressed, so `3× → 16384 × 16205 (capped)` is an
informed choice rather than a surprise.

### 9.4 SVG needs a second renderer, and does not duplicate one

There is no 2D context to install a transform on, so SVG cannot reuse `drawElement`. That would mean
two renderers drifting apart — a drawing that looks different depending on which button you pressed —
except that **Rough.js hands out the geometry, not just the drawing**.

`generator.toPaths(drawable)` returns the same sketchy path data the canvas renderer strokes, as SVG
`d` strings. Both exporters consume the *same* `Drawable`, generated from the *same* stored `seed`.
The duplication that remains is confined to "how do I put a path on the page", which is the part that
genuinely differs between the formats.

This is why `roughCache.ts` was built to hand out `Drawable`s rather than to draw. At the time it
looked like an over-abstraction with one caller.

### 9.5 Byte-reproducibility, and what it cost to get

Exporting the same scene twice produces the same bytes, because `seed` is stored on the element
(§3.1) rather than regenerated. That is what makes Phase 10's visual-regression testing possible, and
it is the reason the seed became a stored field three phases before anything used it.

It needed one more thing that was not obvious: **rounding the path coordinates.** `toPaths` emits full
float precision, seventeen characters per number, and two runs differing in the sixteenth decimal
place would produce different bytes. Two decimals is well below a device pixel at any export scale —
and more than halves the file:

| elements | unrounded | rounded | |
|---:|---:|---:|---:|
| 100 | 124.7 kB | 60.2 kB | 2.07× |
| 1,000 | 1,461.3 kB | 676.2 kB | 2.16× |

### 9.6 Text in SVG: the trade, stated

| | `<text>` | outlined paths |
|---|---|---|
| size | small | an order of magnitude larger |
| selectable, searchable, editable | yes | no |
| identical everywhere | **no** — renders in whatever font the viewer has | yes |

v1 emits `<text>`, for a reason about this codebase rather than about SVG: converting glyphs to paths
needs font outlines, and the Canvas 2D API does not expose them. Doing it properly means shipping a
font parser and the font file — a dependency and a licensing question, in exchange for a fidelity
nobody has asked for. The mitigation is §7.4.1's: emit the whole stack, ending in a generic family.

The lines emitted are the ones already stored on the element. Re-wrapping here would need a measurer
and could produce different breaks from the ones on screen — an export that does not match what the
user was looking at.

### 9.7 What it costs

| elements | PNG 1× | PNG 2× | SVG |
|---:|---|---|---|
| 1,000 | 1.4 s · 2.13 MB | 5.7 s · 6.69 MB | 5.1 s · 0.66 MB |
| 10,000 | 1.8 s · 9.46 MB | 6.6 s · 23.69 MB | 6.9 s · 6.68 MB |
| 50,000 | 5.1 s · 34.50 MB | 14.1 s · 80.45 MB | 8.1 s · 33.53 MB |

Export blocks the main thread for seconds, and unlike §8.4's autosave that cannot be moved into idle
time — the user is waiting for it. v1 disables the button and shows a spinner; the real fix is an
`OffscreenCanvas` in a worker, scoped out with the numbers attached.

Note the shapes: **PNG scales with area, SVG with element count.** SVG is ten times smaller at a
thousand elements and roughly level by fifty thousand.

Two API details that are not stylistic:

- **`toBlob`, not `toDataURL`.** `toDataURL` builds a base64 string on the main thread, ~33% larger
  than the binary, and several browsers silently return `"data:,"` past an internal limit rather than
  throwing.
- **`await document.fonts.ready` before drawing.** On screen a wrong-font frame is transient; in an
  export it is baked into a file the user sends to someone.

---

## 10. Performance budget

60 fps = **16.67 ms per frame**. Target during an active drag with 10,000 elements:

| Stage | Budget | Where it goes if you blow it |
|---|---|---|
| Input handling + coalesced events | 0.5 ms | too many listeners, work in the handler instead of the loop |
| Hit test (broad + narrow) | 0.5 ms | O(n) scan — no quadtree |
| Dirty-rect collect + merge | 0.5 ms | O(n²) merge over an uncapped list |
| Static canvas repaint | 6 ms | full repaint instead of dirty rects; Rough regen instead of cache |
| Interactive canvas repaint | 1 ms | drawing committed elements on the wrong layer |
| React | **0 ms** | state updates on `pointermove` |
| Browser compositing | ~2 ms | too many stacked canvases, CSS filters |
| **Headroom** | ~6 ms | |

Instrument this from Phase 3 onward. `StatsOverlay` shows: fps, frame ms (p50/p95), element
count, visible count, dirty rect count, dirty area %, full-repaint count, cache hit rate.

**Measure before you optimise, and write the numbers in the README.** A repo that says
"full repaint: 41 ms @ 10k elements → dirty rects: 3.2 ms, 12.8× faster" is worth ten repos
that say "uses dirty rectangle rendering for performance."

### 10.1 How this project measures — and why a clock is the wrong instrument for CI

Built in Phase 3. Four decisions, each avoiding a specific failure.

**Split the frame before timing it.** `StageTimer` accumulates `cull`, `grid`, `draw` and
`interactive` separately. One number tells you a frame was slow; it cannot tell you which of four
things did it — and the two that matter scale differently on purpose:

```
cull  is O(total)    grows with everything that exists
draw  is O(visible)  grows with what fits on the screen
```

Zoom into a corner of a large drawing and `draw` collapses while `cull` does not move at all. That
divergence *is* the argument for §5's quadtree, and it is invisible in an aggregate. Reported as a
single figure, you could halve the cull, watch the total barely move, and have no idea why.

**Count work; don't time it, when the claim is about complexity.** `Scene.queryStats.tested` is the
number of elements the cull examined. A timing assertion is flaky on a shared CI runner, and it
cannot distinguish a constant-factor win from an algorithmic one — both move a stopwatch, only one
still works at 500,000 elements. A count is exactly reproducible, identical on every machine, and
measures the complexity class directly. So CI asserts the count; the stopwatch lives in
`npm run bench`, where a human reads it and knows what machine produced it.

**Generate the load deterministically, and be precise about how far that goes.** The scene
generator seeds position, size, type, rotation, style, z-order and the Rough.js `seed` — every
input that changes what a frame costs. It does *not* seed element `id`, which is pure identity and
changes nothing measurable. The rule: make it deterministic exactly where non-determinism would
move the measurement, and no further. A benchmark you cannot reproduce is an anecdote.

**Instrument the instrument.** The stats overlay writes `textContent` through refs rather than
re-rendering React, and User Timing marks are opt-in — `performance.mark` allocates an entry per
call and retains it until cleared. A profiler that allocates every frame manufactures the GC pause
it is trying to detect. Phase 1 produced the cheaper version of this lesson: the overlay read
`grid lines: 0` forever, because stats were emitted on idle frames and idle frames vastly outnumber
rendered ones. **A broken instrument is more dangerous than a broken feature** — it sends you to
debug the wrong thing.

---

## 11. End-to-end trace: what happens when you drag a rectangle

This is the walkthrough to have ready when a senior dev asks "so how does it work?"

```
 1. pointerdown at screen (420, 310)
 2. canvas.setPointerCapture(pointerId)
 3. Viewport.toScene(420,310)  →  scene (183.75, 92.5)
 4. ToolManager: active tool is 'select', state is IDLE
 5. SpatialIndex.query(±10/zoom around the point)  →  3 candidate ids   [BROAD, O(log n)]
 6. sort candidates by zIndex desc; hitTestPrecise each                 [NARROW, O(1..3)]
       → for each: toLocal(point, el) un-rotates, then exact geometry
    → hits element "r7"
 7. Scene.setSelection(["r7"]); state IDLE → DRAGGING; store dragOrigin
 8. DirtyTracker.add(oldSelectionBounds) + add(newSelectionBounds)
       ↳ selection outline lives on the INTERACTIVE canvas, so this costs nothing on static
 9. React is notified once ("selection changed: 1") via useSyncExternalStore
       → StylePanel re-renders. ONE React render for the whole gesture.

10. pointermove ×200 over the next 3 seconds. For each:
      a. toScene() the delta, divide by zoom
      b. Scene.mutate("r7", {x: origX + dx, y: origY + dy})
           → captures beforeBounds
           → applies patch, version++
           → captures afterBounds
           → DirtyTracker.add(before); DirtyTracker.add(after)
           → SpatialIndex.update("r7", before, after)
      c. NO drawing here. The handler returns in <0.1 ms.
      d. NO React state update.

11. requestAnimationFrame fires (≤ once per 16.67 ms, coalescing all moves since last frame):
      a. dirty.flush() → 2 rects → merge test → they overlap → 1 merged rect
      b. area check: 1 rect, 3% of screen → dirty path, not full repaint
      c. scene rect → screen → device px → floor/ceil
      d. staticCtx.save(); clip(rect); clearRect(rect); fillRect(bg)
      e. SpatialIndex.query(sceneRect) → 4 elements overlap this region
      f. sort those 4 by zIndex asc; for each: roughCache.get(`id:version`) → draw
      g. staticCtx.restore()
      h. interactiveCtx.clearRect(0,0,W,H)   ← full clear, it's nearly empty
      i. draw selection outline + 8 handles + rotate handle for "r7"
      → total ≈ 1.1 ms, INDEPENDENT of whether the scene has 10 or 100,000 elements

12. pointerup
      a. releasePointerCapture
      b. History.push({before:{r7: snapshotAtPointerdown}, after:{r7: snapshotNow}})
           ← ONE entry for the whole 200-move gesture
      c. state DRAGGING → IDLE
      d. schedule debounced localStorage save (500 ms trailing)
```

The line to internalise: **step 11's cost does not depend on scene size.** That is the entire
point of the architecture, and it's the sentence to say out loud in an interview.

---

## 12. File tree

```
excalidraw-clone/
├─ index.html
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ vitest.config.ts
├─ README.md                        ← benchmarks + design decisions. Recruiters read this.
├─ ARCHITECTURE.md                  ← this file
│
├─ src/
│  ├─ main.tsx
│  ├─ App.tsx
│  │
│  ├─ engine/                       ★ ZERO React imports. Runs in Node. This is the project.
│  │  ├─ Engine.ts                  ← orchestrator; owns the rAF loop; the only public API
│  │  │
│  │  ├─ scene/
│  │  │  ├─ element.types.ts        ← the discriminated union
│  │  │  ├─ elementFactory.ts       ← newRectangle(), newFreedraw(), ... + seed generation
│  │  │  ├─ Scene.ts                ← store, mutate(), z-order, selection, soft delete
│  │  │  └─ bounds.ts               ← getGeometryBounds / getRenderBounds / rotatedAABB
│  │  │
│  │  ├─ spatial/
│  │  │  ├─ QuadTree.ts             ← insert / remove / query / subdivide
│  │  │  ├─ SpatialIndex.ts         ← facade + re-rooting for the infinite canvas
│  │  │  └─ hitTest.ts              ← narrow phase, per element type
│  │  │
│  │  ├─ viewport/
│  │  │  ├─ Viewport.ts             ← scrollX/scrollY/zoom, pan, zoomAtPoint, fitToContent
│  │  │  └─ transform.ts            ← pure fns: toScene, toScreen, toDevice, matrix build
│  │  │
│  │  ├─ render/
│  │  │  ├─ Renderer.ts             ← the dirty-rect frame loop
│  │  │  ├─ DirtyTracker.ts         ← add / merge / flush / shouldFullRepaint
│  │  │  ├─ drawElement.ts          ← switch on el.type
│  │  │  ├─ roughCache.ts           ← Map<`${id}:${version}`, Drawable> + eviction
│  │  │  └─ interactiveLayer.ts     ← selection box, handles, marquee, in-progress shape
│  │  │
│  │  ├─ tools/
│  │  │  ├─ ToolManager.ts          ← the FSM
│  │  │  ├─ SelectionTool.ts        ├─ ShapeTool.ts
│  │  │  ├─ FreedrawTool.ts         └─ TextTool.ts
│  │  │
│  │  ├─ history/History.ts
│  │  ├─ export/{exportToPng.ts,exportToSvg.ts}
│  │  ├─ storage/localStore.ts
│  │  └─ util/{math.ts,geometry.ts,perf.ts,id.ts}
│  │
│  ├─ react/                        ★ chrome only. Knows nothing about rendering.
│  │  ├─ CanvasHost.tsx             ← mounts both canvases, creates Engine, wires ResizeObserver
│  │  ├─ useEngineState.ts          ← useSyncExternalStore bridge — THE seam
│  │  ├─ Toolbar.tsx  StylePanel.tsx  ZoomControls.tsx  StatsOverlay.tsx
│  │  └─ TextEditorOverlay.tsx      ← a real <textarea> positioned over the canvas
│  │
│  └─ styles/
│
├─ tests/                           ← engine is pure TS, so these run in Node, fast
│  ├─ transform.test.ts             quadtree.test.ts    reroot.test.ts
│  ├─ dirtyTracker.test.ts          hitTest.test.ts     history.test.ts
│  └─ bench/scene.bench.ts          ← generate 10k/50k elements, assert frame budget
│
└─ .gitignore                       ← ignores _learning/ (your notes never hit GitHub)
```

---

## 13. Key trade-offs, stated explicitly

Have an answer ready for each of these. "I chose X over Y because Z, and the cost is W" is what
seniority sounds like.

| Decision | Chosen | Rejected | Because |
|---|---|---|---|
| React ↔ canvas | engine outside React, `useSyncExternalStore` seam | elements in React state | 60 Hz reconciliation is unaffordable |
| Element model | discriminated union of plain objects | class hierarchy | exhaustiveness checking + JSON-serialisable |
| Cache invalidation | `id:version` key | deep compare / dirty flags | O(1), provably correct given one mutation path |
| Delete | soft (`isDeleted`) | splice from array | undo, stable references, index consistency |
| Spatial index | re-rooting quadtree | R-tree / hash grid / none | handles unbounded space; simpler than R-tree; adapts to density unlike a grid |
| Straddling items | stored in parent | duplicated into children | unambiguous removal, no dedupe on query |
| Repaint | dirty rects + full-repaint escape hatch | always full / always dirty | dirty wins for local edits, full wins for pan-zoom |
| Layers | 2 canvases | 1 canvas / N canvases | selection UI churns every frame, elements don't |
| Undo | per-element snapshots | full-scene snapshots / command pattern | bounded memory without inverse-op complexity |
| Z-order | numeric `zIndex` | array position | reorder doesn't invalidate the index (fractional indexing noted as v2) |
| Tile cache | **not** in v1 | offscreen tile pyramid | unmeasured; ship dirty rects, then decide with data |

---

## 14. Deliberately out of scope for v1

Say these out loud before someone asks — knowing where the line is *is* the skill.

Collaboration / CRDT · server persistence · images · frames & containers · element binding &
routing arrows · groups · library/templates · laser pointer · mobile gestures beyond
pinch-zoom · WebGL renderer · tile cache · fractional indexing · virtualised element store.

Each of these has a one-line note in the README explaining what it would take. That reads as
judgement, not as gaps.

---

## References

- [MDN — Canvas API](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)
- [MDN — `CanvasRenderingContext2D.setTransform()`][mdn-settransform]
- [MDN — Canvas transformations](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Transformations)
- [MDN — Pointer events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)
- [MDN — `PointerEvent.getCoalescedEvents()`](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/getCoalescedEvents)
- [MDN — `devicePixelRatio`](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio)
- [MDN — `OffscreenCanvas`](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
- [React — `useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
- [TypeScript — narrowing & discriminated unions](https://www.typescriptlang.org/docs/handbook/2/narrowing.html)
- [Rough.js](https://roughjs.com/) · [perfect-freehand](https://github.com/steveruizok/perfect-freehand)
- [pvigier — Quadtree and collision detection](https://pvigier.github.io/2019/08/04/quadtree-collision-detection.html)
- [Excalidraw source](https://github.com/excalidraw/excalidraw) · [tldraw source](https://github.com/tldraw/tldraw)

[mdn-settransform]: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/setTransform
