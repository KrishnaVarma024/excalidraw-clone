import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DrawGuard } from '@engine/render/DrawGuard';
import { newRectangle } from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, type Element } from '@engine/scene/element.types';

const el = (over: Partial<Element> = {}): Element =>
  ({
    ...newRectangle({ x: 0, y: 0, width: 10, height: 10, style: DEFAULT_STYLE, zIndex: 1 }),
    ...over,
  }) as Element;

/* DrawGuard logs on the first failure by design. Silencing it here keeps the
   test output readable — and asserting on the spy is how the "logs once, not
   sixty times a second" claim gets checked rather than assumed. */
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  error.mockRestore();
});

describe('DrawGuard', () => {
  it('draws normally and reports success', () => {
    const guard = new DrawGuard();
    const draw = vi.fn();
    expect(guard.run(el(), draw)).toBe(true);
    expect(draw).toHaveBeenCalledOnce();
    expect(guard.size).toBe(0);
  });

  it('contains a throw rather than letting it unwind the frame', () => {
    const guard = new DrawGuard();
    expect(() =>
      guard.run(el(), () => {
        throw new Error('rough exploded');
      }),
    ).not.toThrow();
    expect(guard.size).toBe(1);
  });

  it('does not call draw again for the same revision', () => {
    const guard = new DrawGuard();
    const subject = el();
    const draw = vi.fn(() => {
      throw new Error('boom');
    });

    for (let frame = 0; frame < 60; frame++) guard.run(subject, draw);

    // One attempt, not sixty. This is the assertion that matters: without it the
    // guard "works" while still throwing — and allocating a stack trace — on
    // every frame, which is a performance bug wearing a resilience costume.
    expect(draw).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });

  it('retries automatically when the element changes', () => {
    const guard = new DrawGuard();
    const v1 = el({ version: 1 });
    let failing = true;
    const draw = vi.fn(() => {
      if (failing) throw new Error('boom');
    });

    expect(guard.run(v1, draw)).toBe(false);
    expect(guard.run(v1, draw)).toBe(false);

    // Whatever the user did — dragged it, recoloured it, undid it — Scene.mutate
    // produced a new version. The quarantine key changes with it.
    failing = false;
    const v2 = { ...v1, version: 2 };
    expect(guard.run(v2, draw)).toBe(true);
  });

  it('keeps quarantining a revision it has already seen fail, even after a retry', () => {
    const guard = new DrawGuard();
    const v1 = el({ version: 1 });
    const v2 = { ...v1, version: 2 };
    const draw = () => {
      throw new Error('boom');
    };

    guard.run(v1, draw);
    guard.run(v2, draw);
    expect(guard.size).toBe(2);

    // An undo puts version 1 back on screen. It is still broken; do not retry it.
    const calls = (error as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(guard.run(v1, draw)).toBe(false);
    expect((error as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
  });

  it('isolates the failure to one element', () => {
    const guard = new DrawGuard();
    const good = el({ id: 'a' as Element['id'] });
    const bad = el({ id: 'b' as Element['id'] });
    let painted = 0;

    for (const subject of [good, bad, good]) {
      guard.run(subject, () => {
        if (subject.id === 'b') throw new Error('boom');
        painted++;
      });
    }

    expect(painted).toBe(2);
    expect(guard.size).toBe(1);
  });

  it('records the id and a trimmed message for the overlay', () => {
    const guard = new DrawGuard();
    const subject = el();
    guard.run(subject, () => {
      throw new Error('x'.repeat(500));
    });

    const [entry] = guard.entries();
    expect(entry!.id).toBe(subject.id);
    expect(entry!.key).toBe(`${subject.id}:${subject.version}`);
    // Trimmed: this string ends up in a DOM node and a console line, and a
    // half-megabyte message from a library that stringified a whole scene into
    // its error is a real thing that happens.
    expect(entry!.message).toHaveLength(200);
  });

  it('survives a thrown non-Error', () => {
    const guard = new DrawGuard();
    guard.run(el(), () => {
      throw 'a string, because someone will';
    });
    expect(guard.entries()[0]!.message).toBe('a string, because someone will');
  });

  it('forgets everything on clear, so a new document starts fresh', () => {
    const guard = new DrawGuard();
    guard.run(el(), () => {
      throw new Error('boom');
    });
    expect(guard.size).toBe(1);
    guard.clear();
    expect(guard.size).toBe(0);
    expect(guard.entries()).toEqual([]);
  });
});
