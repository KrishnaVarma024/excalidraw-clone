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

---

## 8. History (undo / redo)

Two viable designs:

| | **Snapshot** | **Command / inverse-patch** |
|---|---|---|
| Store | the changed elements, before + after | an operation + its inverse |
| Undo | write the "before" objects back | apply the inverse |
| Memory | O(changed elements) per entry | O(1)-ish per entry |
| Complexity | low | high — every op needs a correct inverse |
| Merging typing into one entry | easy | easy |

**v1 uses snapshots of only the touched elements**, capped at 100 entries.

```ts
interface HistoryEntry {
  before: Map<ElementId, Element | null>;  // null = did not exist
  after:  Map<ElementId, Element | null>;
  viewportBefore?: Viewport;               // undo should restore where you were looking
}
```

Elements are immutable-on-write within an entry (structural sharing), so the memory cost is the
handful of objects a gesture actually touched, not the whole scene.

The interview-grade point: **undo must dirty both the before-bounds and the after-bounds of
every element it touches, and must repair the spatial index.** Undo is just another mutation
and must go through the same `Scene.mutate()` path. If you write a special-case undo that
bypasses it, the quadtree silently desynchronises and clicks start missing shapes. That is a
real bug you will hit.

---

## 9. Export

Export is **not** a screenshot of the canvas. `canvas.toBlob()` on the live canvas captures the
current viewport at current zoom, with selection handles in it. Wrong on three counts.

Correct pipeline:

```ts
async function exportToPng(scene, opts: { scale: 1|2|3; padding: number; background: boolean }) {
  const visible = scene.all().filter(e => !e.isDeleted);
  const bbox = padBounds(unionBounds(visible.map(getRenderBounds)), opts.padding);

  const c = new OffscreenCanvas(
    Math.ceil(bbox.width  * opts.scale),
    Math.ceil(bbox.height * opts.scale),
  );
  const ctx = c.getContext('2d')!;

  await document.fonts.ready;              // ← or text renders in the fallback font

  if (opts.background) { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }

  // A FRESH transform — export has its own viewport, unrelated to the screen's.
  ctx.setTransform(opts.scale, 0, 0, opts.scale, -bbox.minX * opts.scale, -bbox.minY * opts.scale);

  for (const el of visible.sort(byZAsc)) drawElement(ctx, el);  // no dirty rects, no handles

  return c.convertToBlob({ type: 'image/png' });
}
```

Gotchas: `document.fonts.ready` (text silently falls back otherwise); `toBlob` is async and
`toDataURL` will blow the string length limit on big exports; browsers cap canvas dimensions
(~16,384 px on Safari, ~65,535 on Chrome) so clamp `scale` against `bbox`.

SVG export reuses the same geometry code but emits `<path>` elements — Rough.js exposes the same
`Drawable` ops for both, which is exactly why we keep drawing logic separate from the 2D context.

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
