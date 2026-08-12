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

const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';
const ID_LENGTH = 21;

/** Generate a URL-safe, collision-resistant element id. */
export function newId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);

  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    // 63 = 0b111111, so this maps each byte onto the 64-char alphabet with no
    // modulo bias (the alphabet length is a power of two, which is the whole
    // reason it is 64 characters and not, say, 62).
    id += ALPHABET[bytes[i]! & 63];
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
