import { describe, expect, it } from 'vitest';
import { RoughCache } from '@engine/render/roughCache';
import { newEllipse, newRectangle } from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, type Element } from '@engine/scene/element.types';

function rect(overrides: Partial<Element> = {}): Element {
  return {
    ...newRectangle({ x: 0, y: 0, width: 100, height: 60, style: DEFAULT_STYLE, zIndex: 1 }),
    ...overrides,
  } as Element;
}

/** Simulate a mutation the way `Scene.mutate` does: new object, version + 1. */
function bump(el: Element, patch: Partial<Element> = {}): Element {
  return { ...el, ...patch, version: el.version + 1 } as Element;
}

describe('RoughCache', () => {
  it('misses once then hits for the same id and version', () => {
    const cache = new RoughCache();
    const el = rect();

    const first = cache.get(el);
    const second = cache.get(el);

    // Same object reference — the drawable was not regenerated.
    expect(second).toBe(first);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  /**
   * The invariant the whole cache rests on. If a mutation could reuse a
   * drawable, the shape on screen would stop matching the data — a rectangle
   * resized to twice its size would keep drawing at the old size, with nothing
   * to indicate why.
   */
  it('misses after a version bump', () => {
    const cache = new RoughCache();
    const v1 = rect();
    cache.get(v1);

    const v2 = bump(v1, { width: 200 });
    cache.get(v2);

    expect(cache.stats().misses).toBe(2);
  });

  it('produces a different drawable after a geometry change', () => {
    const cache = new RoughCache();
    const v1 = rect();
    const a = cache.get(v1);
    const b = cache.get(bump(v1, { width: 500 }));
    expect(b).not.toBe(a);
  });

  /**
   * Drag one shape for ten seconds and it produces ~600 versions, of which
   * exactly one is live. Without eviction the map grows for the lifetime of the
   * tab. The policy is "drop older versions of the same id on insert", so the
   * cache holds one entry per element regardless of how long you drag it.
   */
  it('holds exactly one entry per element across many versions', () => {
    const cache = new RoughCache();
    let el = rect();
    cache.get(el);

    for (let i = 0; i < 600; i++) {
      el = bump(el, { width: 100 + i });
      cache.get(el);
    }

    expect(cache.stats().size).toBe(1);
  });

  it('keeps entries for different elements independent', () => {
    const cache = new RoughCache();
    const a = rect();
    const b = newEllipse({ x: 0, y: 0, width: 50, height: 50, style: DEFAULT_STYLE, zIndex: 2 });

    cache.get(a);
    cache.get(b);
    expect(cache.stats().size).toBe(2);

    // Churning `a` must not evict `b`.
    let churning = a;
    for (let i = 0; i < 50; i++) {
      churning = bump(churning, { width: 100 + i });
      cache.get(churning);
    }
    expect(cache.stats().size).toBe(2);

    const before = cache.stats().hits;
    cache.get(b);
    expect(cache.stats().hits).toBe(before + 1);
  });

  it('evicts on request, for elements that leave the scene', () => {
    const cache = new RoughCache();
    const a = rect();
    cache.get(a);
    expect(cache.stats().size).toBe(1);

    cache.evict([a.id]);
    expect(cache.stats().size).toBe(0);

    // And re-generates cleanly afterwards.
    cache.get(a);
    expect(cache.stats().size).toBe(1);
  });

  it('ignores eviction of an unknown id', () => {
    const cache = new RoughCache();
    expect(() => cache.evict(['nope'])).not.toThrow();
  });

  it('clears everything', () => {
    const cache = new RoughCache();
    cache.get(rect());
    cache.get(newEllipse({ x: 0, y: 0, width: 9, height: 9, style: DEFAULT_STYLE, zIndex: 1 }));
    cache.clear();
    expect(cache.stats().size).toBe(0);
  });

  /**
   * The reason `seed` is stored on the element rather than generated at draw
   * time. Same seed in, same jitter out — which is what stops shapes shimmering
   * as you pan, and what makes export byte-reproducible in Phase 9.
   */
  it('generates identical geometry for identical seeds', () => {
    const a = new RoughCache();
    const b = new RoughCache();
    const el = rect();

    expect(JSON.stringify(a.get(el).sets)).toBe(JSON.stringify(b.get(el).sets));
  });

  it('generates different geometry for different seeds', () => {
    const cache = new RoughCache();
    const a = rect({ seed: 1234 });
    const b = rect({ seed: 9999 });
    expect(JSON.stringify(cache.get(a).sets)).not.toBe(JSON.stringify(cache.get(b).sets));
  });

  it('reports a hit rate that reaches 100% once warm', () => {
    const cache = new RoughCache();
    const els = Array.from({ length: 20 }, (_, i) =>
      newRectangle({ x: i, y: 0, width: 10, height: 10, style: DEFAULT_STYLE, zIndex: i }),
    );

    for (const el of els) cache.get(el); // cold: 20 misses
    cache.resetStats();
    for (const el of els) cache.get(el); // warm: 20 hits

    const { hits, misses } = cache.stats();
    expect(misses).toBe(0);
    expect(hits).toBe(20);
  });
});
