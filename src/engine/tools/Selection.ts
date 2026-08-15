/**
 * What is currently selected.
 *
 * ── Why a `Set<ElementId>` and not `Element[]` ──────────────────────────────
 *
 * Selection holds **ids**, never element objects.
 *
 * `Scene.mutate` replaces the element object on every change rather than editing
 * it, so any array of elements held across a mutation is an array of stale
 * copies. That exact bug shipped in Phase 2 and survived two phases inside
 * `Scene.sortedCache` — see the note there. A selection is held across *every*
 * mutation by definition (you select a thing, then you change it), so storing
 * objects here would not be a latent bug, it would be an immediate one.
 *
 * A `Set` rather than an array for the other obvious reason: `has()` is the
 * question the renderer asks once per visible element per frame, and at 2,000
 * visible elements an `indexOf` scan per element is 2,000 × selection-size
 * comparisons for something a hash lookup answers in one.
 *
 * ── Why every mutator returns a boolean ─────────────────────────────────────
 *
 * Same contract as `Scene.mutate`: "did anything actually change?" Clicking an
 * already-selected element, or clearing an empty selection, must not schedule a
 * repaint. A component that repaints on no-ops is a component that repaints
 * forever at 60 fps while the user does nothing, and the symptom — a warm laptop
 * on an idle canvas — is remarkably hard to trace back to its cause.
 */

import type { ElementId } from '../scene/element.types';

export class Selection {
  private readonly selected = new Set<ElementId>();

  get size(): number {
    return this.selected.size;
  }

  get isEmpty(): boolean {
    return this.selected.size === 0;
  }

  has(id: ElementId): boolean {
    return this.selected.has(id);
  }

  /** Iterating order is insertion order, which no caller should rely on. */
  ids(): ReadonlySet<ElementId> {
    return this.selected;
  }

  /** Replace the selection wholesale. Returns whether it changed. */
  set(ids: Iterable<ElementId>): boolean {
    const next = ids instanceof Set ? ids : new Set(ids);
    if (next.size === this.selected.size) {
      let same = true;
      for (const id of next) {
        if (!this.selected.has(id)) {
          same = false;
          break;
        }
      }
      if (same) return false;
    }

    this.selected.clear();
    for (const id of next) this.selected.add(id);
    return true;
  }

  add(ids: Iterable<ElementId>): boolean {
    let changed = false;
    for (const id of ids) {
      if (!this.selected.has(id)) {
        this.selected.add(id);
        changed = true;
      }
    }
    return changed;
  }

  /** Add if absent, remove if present. Shift-click. */
  toggle(id: ElementId): boolean {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    return true;
  }

  remove(ids: Iterable<ElementId>): boolean {
    let changed = false;
    for (const id of ids) changed = this.selected.delete(id) || changed;
    return changed;
  }

  clear(): boolean {
    if (this.selected.size === 0) return false;
    this.selected.clear();
    return true;
  }

  /**
   * Drop every id that no longer satisfies `keep`.
   *
   * Deleting a selected element must not leave its id in here. A stale id is
   * invisible — the count in the UI is wrong, and the next operation on "the
   * selection" silently does nothing for that entry rather than failing. Cheap
   * to prevent, genuinely confusing to debug.
   */
  retain(keep: (id: ElementId) => boolean): boolean {
    let changed = false;
    for (const id of [...this.selected]) {
      if (!keep(id)) {
        this.selected.delete(id);
        changed = true;
      }
    }
    return changed;
  }
}
