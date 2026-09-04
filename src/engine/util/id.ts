/**
 * Element id generation.
 *
 * Requirements, in priority order:
 *   1. Collision-free within a document. Ids are referenced by `containerId`,
 *      by the spatial index, and by history entries. A collision is silent
 *      data corruption, not a crash.
 *   2. Generated client-side with no coordination. There is no server in v1,
 *      and in v2 there will be several clients minting ids concurrently — so
 *      an incrementing counter is out from the start.
 *   3. Short. Ids are the single most repeated string in the serialised file.
 *
 * 21 characters from a 64-symbol alphabet is 126 bits of entropy. Generating
 * one id per second, it would take ~10^13 years to reach a 1% chance of a
 * single collision — comfortably more than "never" for a drawing app, and the
 * same parameters `nanoid` uses.
 *
 * We use `crypto.getRandomValues` rather than `Math.random()`. Not for
 * security — nobody is attacking a whiteboard — but because `Math.random()`'s
 * output quality is unspecified per engine, and the birthday-bound argument
 * above only holds for a uniform source.
 */

const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
const ID_LENGTH = 21;

/**
 * The alphabet must be exactly 64 characters, and this checks it at import.
 *
 * ── Why an assertion and not a comment ──────────────────────────────────────
 *
 * It was 63 for nine phases. The `_` between `WOLF` and `GQZ` was lost at some
 * point, and the consequence was invisible in every way a bug can be:
 *
 *   - `ALPHABET[63]` is `undefined`, and `id += undefined` appends the *string*
 *     `"undefined"` rather than throwing. JavaScript's implicit conversion turns
 *     an out-of-bounds read into a nine-character token.
 *   - So ~28% of ids contained the literal text `undefined`, and were 29, 37 or
 *     45 characters instead of 21.
 *   - Nothing broke. Ids are opaque; a longer id is still unique, still a valid
 *     Map key, still round-trips through JSON. Every test passed.
 *   - `noUncheckedIndexedAccess` is on, and typed the read as `string |
 *     undefined` — correctly. It cannot object to `string += string | undefined`,
 *     because that is legal TypeScript.
 *
 * Found in Phase 10, by a *byte budget* on the serialised document: the number
 * would not sit still between runs. Nothing was looking at ids; something was
 * looking at their total length. **A measurement finds bugs that no assertion
 * was aimed at**, which is most of the argument for measuring at all.
 *
 * The comment eight lines above already said the alphabet is 64 characters
 * "which is the whole reason it is 64 and not, say, 62". The code disagreed with
 * its own documentation for nine phases and neither noticed. So the invariant is
 * executable now.
 */
if (ALPHABET.length !== 64) {
  throw new Error(
    `id alphabet must be exactly 64 characters for the &63 mask to be total; got ${ALPHABET.length}`,
  );
}

/** Generate a URL-safe, collision-resistant element id. */
export function newId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);

  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    /* 63 = 0b111111, so this maps each byte onto the 64-char alphabet with no
       modulo bias — the alphabet length being a power of two is the whole reason
       it is 64 and not, say, 62. The mask is only *total* if the alphabet really
       has 64 entries, which is why that is asserted at import above rather than
       left as a claim in this comment. */
    id += ALPHABET[bytes[i]! & 63]!;
  }
  return id;
}

/**
 * Generate the `seed` stored on every element.
 *
 * Frozen at creation and never changed. Rough.js turns it into the specific
 * wobble of that shape's hand-drawn strokes; because it is stored rather than
 * regenerated, the wobble survives redraws, pans, reloads, and exports.
 * See `makeRandom` in `./math.ts`.
 */
export function newSeed(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!;
}
