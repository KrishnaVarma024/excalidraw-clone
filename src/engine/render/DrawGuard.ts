/**
 * One bad element must not blank the canvas.
 *
 * ── The failure this exists for ─────────────────────────────────────────────
 *
 * The static renderer draws elements in a loop. If `drawElement` throws on the
 * seventeenth of four hundred, the loop unwinds, the frame is abandoned
 * half-painted, and — because the loop runs again next frame — it throws again.
 * Forever. The user sees a canvas that is blank, or worse, frozen with a partial
 * drawing on it, and every one of their other 399 elements is fine.
 *
 * Phase 8's `restore()` hardens the *entry* to the system: it drops elements
 * that fail validation on load. This hardens the *exit*, and the two are not
 * redundant. `restore` catches what it can name — a missing `width`, an
 * out-of-range opacity. It cannot catch what it has no rule for: a NaN that
 * survives validation and makes Rough.js throw deep inside a path builder, a
 * font stack that upsets a text metric, a freehand element whose point array is
 * technically well-formed and geometrically degenerate.
 *
 * **Validate what you can name; contain what you cannot.** Neither alone is
 * enough, and a system that only does the first is one unexpected input away
 * from a blank screen.
 *
 * ── Why quarantine at the FIRST failure ─────────────────────────────────────
 *
 * The tempting design is a threshold: allow two failures, then give up. It is
 * wrong here, because this loop runs sixty times a second. "Two strikes" means
 * a hundred and twenty exceptions per second, each one allocating a stack trace,
 * while the user watches the frame rate collapse. There is no transient to ride
 * out — the same element with the same data will fail the same way on the next
 * frame, deterministically.
 *
 * So: fail once, quarantine. The element vanishes; everything else keeps
 * drawing.
 *
 * ── How an element gets a second chance ─────────────────────────────────────
 *
 * Keyed by `id:version`, exactly like `RoughCache`. That is not a coincidence —
 * it is the Phase 2 invariant paying out a third time. `Scene.mutate` never
 * edits in place; it produces a new object with a bumped `version`. So when the
 * user drags the broken element, or changes its colour, or undoes whatever
 * created it, the key changes and it is tried again automatically.
 *
 * The alternative — quarantine by `id` with a manual "retry" button — needs UI,
 * needs the user to know what a quarantine is, and would still be wrong after an
 * undo. Reusing the version key means the retry policy is *"whenever the element
 * changes"*, which is exactly right and costs one string concatenation.
 */

import type { Element, ElementId } from '../scene/element.types';

export interface QuarantineEntry {
  readonly id: ElementId;
  /** `id:version` — the exact revision that failed. */
  readonly key: string;
  /** The thrown message, trimmed. Diagnostic only; never parsed. */
  readonly message: string;
}

export class DrawGuard {
  /** Keyed by `id:version`, so an edit is an automatic retry. */
  private readonly failed = new Map<string, QuarantineEntry>();

  private static key(el: Element): string {
    return `${el.id}:${el.version}`;
  }

  /**
   * Draw `el` through `draw`, or skip it if this exact revision failed before.
   *
   * Returns true if it drew. The renderer counts the falses; nothing branches on
   * the return value, because there is no useful recovery beyond "leave a hole
   * and carry on".
   */
  run(el: Element, draw: () => void): boolean {
    const key = DrawGuard.key(el);
    if (this.failed.has(key)) return false;

    try {
      draw();
      return true;
    } catch (error) {
      /* Swallowed on purpose, and reported two ways: counted into RenderStats so
         the stats overlay shows it, and logged once — *once*, because this is
         inside a 60 Hz loop and a console line per frame is its own outage. The
         Map insert is what makes it once: the next frame takes the early return
         above. */
      const message = error instanceof Error ? error.message : String(error);
      this.failed.set(key, { id: el.id, key, message: message.slice(0, 200) });
      console.error(
        `[render] element ${el.id} (${el.type}) failed to draw and was quarantined until it changes:`,
        error,
      );
      return false;
    }
  }

  /** How many distinct revisions are quarantined. Surfaced in RenderStats. */
  get size(): number {
    return this.failed.size;
  }

  /** For the stats overlay and for tests. Insertion-ordered. */
  entries(): readonly QuarantineEntry[] {
    return [...this.failed.values()];
  }

  /**
   * Forget everything.
   *
   * Called when the document is replaced — a load, an import, a clear. Without
   * it the map is a slow leak across sessions in a long-lived tab, and worse, a
   * newly loaded document could inherit a quarantine from the previous one if
   * ids collide.
   */
  clear(): void {
    this.failed.clear();
  }
}
