/**
 * Get the user's document back when everything else has failed.
 *
 * ── Why this is in the engine and not in ErrorBoundary.tsx ──────────────────
 *
 * It started there, as a private method on the component. That put the one piece
 * of logic whose entire purpose is *running after a crash* inside the thing that
 * only exists because of the crash — and made it untestable, because testing it
 * meant mounting React, which meant jsdom, which ARCHITECTURE 12 calls a smell
 * for exactly this reason.
 *
 * Here it is a function over a loader. `ErrorBoundary` becomes a shell that
 * renders a panel and calls this; every decision worth getting right — what
 * counts as "nothing saved", what happens when the store throws, what the file
 * is named — is unit-tested in Node.
 *
 * The loader is a **parameter**, which is the same move as Phase 7's
 * `TextMeasurer` and Phase 9's export bounds: push the part that needs a browser
 * to the edge until what is left is arithmetic and branching. Here it buys
 * something extra — the caller decides where the bytes come from, so a future
 * "restore from a file the user picked" path reuses this untouched.
 */

/** Loads the raw stored document, or null/undefined when there is none. */
export type DocumentLoader = () => Promise<unknown>;

export type RescueOutcome =
  /** Bytes ready to hand to the user. */
  | { readonly kind: 'saved'; readonly json: string; readonly filename: string }
  /** The store opened and held nothing. A new drawing, not a failure. */
  | { readonly kind: 'empty' }
  /** The store could not be read. The reason is diagnostic only. */
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * A filename with the timestamp in it, and no colons.
 *
 * Colons are legal on Linux, illegal on Windows, and mangled by macOS Finder
 * into slashes. `toISOString()` is full of them. A recovery file the user cannot
 * save is not a recovery.
 */
export function rescueFilename(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).replaceAll(':', '-');
  return `drawing-recovered-${stamp}.json`;
}

/**
 * Read the last autosave and turn it into a file the user can keep.
 *
 * ── Every failure is caught, on purpose ─────────────────────────────────────
 *
 * This runs on a screen that exists because something already threw. A rejected
 * promise here produces an unhandled rejection and a button that spins forever,
 * which is a worse outcome than any message. So the contract is total: it always
 * resolves, and always to one of three states the UI can render.
 *
 * ── Why it does not validate the document ───────────────────────────────────
 *
 * Tempting to run Phase 8's `restore()` over it first and hand back only clean
 * elements. Wrong here: `restore` *drops* what it cannot parse, and a corrupt
 * document is one of the likelier reasons the app crashed. Silently deleting the
 * damaged part of the file the user is trying to salvage is the one thing a
 * rescue must never do.
 *
 * So it serialises whatever is in the store, verbatim. The file is for the user
 * to keep, not for this app to reload — and a partially-readable file they still
 * have beats a clean one they do not.
 */
export async function rescueDocument(
  load: DocumentLoader,
  now = new Date(),
): Promise<RescueOutcome> {
  let raw: unknown;
  try {
    raw = await load();
  } catch (error) {
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }

  if (raw === null || raw === undefined) return { kind: 'empty' };

  let json: string;
  try {
    // Pretty-printed: this file is going to a human who may need to read it, or
    // paste part of it into a bug report. The extra bytes are irrelevant next to
    // the chance that someone can actually work with it.
    json = JSON.stringify(raw, null, 2);
  } catch (error) {
    /* Reachable. A cyclic structure throws here, and if the crash was caused by
       something writing a cycle into the document, this is exactly where it
       surfaces. Reporting it beats an unhandled rejection behind a spinner. */
    return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
  }

  // `undefined` at the top level stringifies to the literal `undefined`, not to
  // JSON. Guarded because a store that returns a bare `undefined` inside an
  // object wrapper is not obviously distinguishable from an empty one upstream.
  if (json === undefined) return { kind: 'empty' };

  return { kind: 'saved', json, filename: rescueFilename(now) };
}
