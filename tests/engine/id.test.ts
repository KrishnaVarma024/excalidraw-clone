import { describe, expect, it } from 'vitest';
import { newId, newSeed } from '@engine/util/id';

/**
 * Regression tests for a bug that survived nine phases because nothing broke.
 *
 * The alphabet was 63 characters, so `ALPHABET[63]` was `undefined` and
 * `id += undefined` appended the literal string `"undefined"`. Roughly 28% of
 * ids were affected. Every existing test passed throughout, because an id is
 * opaque: a longer one is still unique, still a valid key, still JSON-safe.
 *
 * The lesson these tests encode: **assert the properties the code's own comments
 * claim.** The comment said 64 characters and gave the reason. Nothing checked.
 */

const SAMPLE = 20_000;

describe('newId', () => {
  it('is always exactly 21 characters', () => {
    const lengths = new Set<number>();
    for (let i = 0; i < SAMPLE; i++) lengths.add(newId().length);
    expect([...lengths]).toEqual([21]);
  });

  it('never contains the string "undefined"', () => {
    /* The specific shape of the old bug. Cheap, and it names the failure
       directly in the test output rather than as "expected 29 to be 21". */
    for (let i = 0; i < SAMPLE; i++) {
      expect(newId()).not.toContain('undefined');
    }
  });

  it('uses all 64 symbols, so the masking is unbiased', () => {
    /* The property that actually matters, and the one the length check alone
       would miss: an alphabet of 64 distinct characters where one is never
       produced still yields 21-character ids, and still loses entropy. Over
       20,000 × 21 draws, every symbol appearing is overwhelmingly likely if the
       mapping is total, and impossible if it is not. */
    const seen = new Set<string>();
    for (let i = 0; i < SAMPLE; i++) for (const c of newId()) seen.add(c);
    expect(seen.size).toBe(64);
  });

  it('is URL-safe', () => {
    for (let i = 0; i < 1_000; i++) {
      expect(newId()).toMatch(/^[A-Za-z0-9_-]{21}$/u);
    }
  });

  it('does not collide over a large sample', () => {
    const ids = new Set<string>();
    for (let i = 0; i < SAMPLE; i++) ids.add(newId());
    expect(ids.size).toBe(SAMPLE);
  });
});

describe('newSeed', () => {
  it('produces 32-bit unsigned integers', () => {
    for (let i = 0; i < 1_000; i++) {
      const seed = newSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(0xffff_ffff);
    }
  });
});
