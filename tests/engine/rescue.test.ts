import { describe, expect, it } from 'vitest';
import { rescueDocument, rescueFilename } from '@engine/persist/rescue';

/**
 * The recovery path, tested — which is the whole reason it was pulled out of the
 * React component.
 *
 * These read like paranoia until you notice what they all have in common: every
 * one of them is a state this code can only reach *after* something else has
 * already gone wrong. That is the population it serves. Being total here is not
 * defensive programming, it is the specification.
 */

describe('rescueDocument', () => {
  it('serialises whatever the store holds', async () => {
    const doc = { type: 'excalidraw-clone', elements: [{ id: 'a' }] };
    const out = await rescueDocument(async () => doc);

    expect(out.kind).toBe('saved');
    if (out.kind !== 'saved') return;
    expect(JSON.parse(out.json)).toEqual(doc);
    // Pretty-printed, because a human is going to open it.
    expect(out.json).toContain('\n');
  });

  it('reports an empty store as empty, not as a failure', async () => {
    // The difference matters to the user: "nothing was saved yet" is reassuring,
    // "could not read your drawing" is alarming, and showing the alarming one
    // for a brand-new document is a bug in the UI's honesty.
    expect((await rescueDocument(async () => null)).kind).toBe('empty');
    expect((await rescueDocument(async () => undefined)).kind).toBe('empty');
  });

  it('catches a rejected loader instead of leaving a spinner running', async () => {
    const out = await rescueDocument(async () => {
      throw new Error('QuotaExceededError');
    });
    expect(out).toEqual({ kind: 'failed', reason: 'QuotaExceededError' });
  });

  it('catches a thrown non-Error', async () => {
    const out = await rescueDocument(() => Promise.reject('a bare string'));
    expect(out).toEqual({ kind: 'failed', reason: 'a bare string' });
  });

  it('survives a document containing a cycle', async () => {
    /* Not hypothetical. If whatever crashed the app wrote a reference back into
       the document, JSON.stringify throws — on the recovery screen, behind a
       button the user has just pressed in some distress. */
    const cyclic: Record<string, unknown> = { elements: [] };
    cyclic['self'] = cyclic;

    const out = await rescueDocument(async () => cyclic);
    expect(out.kind).toBe('failed');
    if (out.kind !== 'failed') return;
    expect(out.reason).toMatch(/circular|cyclic|convert/iu);
  });

  it('preserves damaged elements rather than dropping them', async () => {
    /* The single most important assertion in this file.

       Phase 8's `restore()` drops elements that fail validation, which is right
       on load and catastrophic here: a corrupt document is one of the likelier
       reasons the app crashed, so the damaged part is exactly what the user is
       trying to salvage. A rescue that silently deletes it has destroyed the
       evidence and the work in one step. */
    const damaged = {
      elements: [{ id: 'ok', type: 'rectangle' }, { id: 'broken', width: Number.NaN }, null],
    };
    const out = await rescueDocument(async () => damaged);

    expect(out.kind).toBe('saved');
    if (out.kind !== 'saved') return;
    const parsed = JSON.parse(out.json) as typeof damaged;
    expect(parsed.elements).toHaveLength(3);
    expect(parsed.elements[2]).toBeNull();
  });
});

describe('rescueFilename', () => {
  it('contains no characters Windows or Finder will reject', () => {
    const name = rescueFilename(new Date('2026-09-03T22:44:05.123Z'));
    expect(name).toBe('drawing-recovered-2026-09-03T22-44-05.json');
    // The specific trap: toISOString() is full of colons, which are illegal in
    // Windows filenames and turned into slashes by macOS Finder.
    expect(name).not.toContain(':');
    expect(name).not.toMatch(/[<>"/\\|?*]/u);
  });

  it('is unique enough that two rescues a second apart do not collide', () => {
    const a = rescueFilename(new Date('2026-09-03T22:44:05Z'));
    const b = rescueFilename(new Date('2026-09-03T22:44:06Z'));
    expect(a).not.toBe(b);
  });
});
