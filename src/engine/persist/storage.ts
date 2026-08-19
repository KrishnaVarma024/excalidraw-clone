/**
 * Where the document lives between sessions.
 *
 * ── Why not localStorage ────────────────────────────────────────────────────
 *
 * Measured, on this project's own generated scenes:
 *
 *     1,000 elements    0.50 MB
 *    10,000 elements    4.94 MB
 *    50,000 elements   24.69 MB      (~494 bytes per element)
 *
 * localStorage's quota is about 5 MB in every browser, so a document is too big
 * for it somewhere around **ten thousand elements** — which this project treats
 * as a mid-sized scene, not an extreme one. And it fails by *throwing on write*,
 * at the moment the user has done the most work, with the previous save already
 * overwritten in some implementations.
 *
 * It is also **synchronous**. A 24 MB write blocks the main thread for the whole
 * write, on top of the serialisation cost below.
 *
 * ── The serialisation cost, and what is done about it ──────────────────────
 *
 * At 50,000 elements:
 *
 *     JSON.stringify     492.9 ms
 *     structuredClone    389.0 ms      ← what IndexedDB does internally
 *
 * Roughly thirty dropped frames either way, and note the second row: storing the
 * object graph directly instead of a JSON string does **not** escape the cost.
 * The structured clone happens on the calling thread when you call `put`.
 *
 * Two things follow, and the second is the interesting one:
 *
 *   1. **Debounce.** Saving on every change would run that cost per keystroke.
 *   2. **Save when the user is not looking.** `requestIdleCallback` moves the
 *      hitch out of the middle of an interaction and into the gap after it. It
 *      does not make the work cheaper; it makes it invisible, which is the part
 *      the user experiences. The deadline is ignored deliberately — a partial
 *      save is not a thing, so once started it runs to completion.
 *
 * A worker would make it genuinely free, and is scoped out for v1 with the number
 * above attached rather than as an oversight: the transferable-object dance to
 * get 50,000 elements into a worker is most of the cost again unless the scene is
 * kept in a SharedArrayBuffer from the start, which is a different data model.
 *
 * ── Failing honestly ───────────────────────────────────────────────────────
 *
 * IndexedDB is unavailable in some private-browsing modes and can be disabled
 * outright. The tempting fallback is localStorage; the measurement above says
 * that fallback silently fails for any real document. So there is no fallback:
 * `available` goes false, the reason is reported, and the UI can say
 * "not saving" — which is a bad situation the user can respond to, rather than a
 * worse one they discover later.
 */

const DB_NAME = 'excalidraw-clone';
const DB_VERSION = 1;
const STORE = 'documents';
const KEY = 'current';

/** Idle time before an autosave fires. */
export const SAVE_DEBOUNCE_MS = 1200;

export interface StorageStats {
  readonly available: boolean;
  readonly reason: string | null;
  readonly saves: number;
  /** Milliseconds the last save spent blocking the main thread. */
  readonly lastSaveMs: number;
  readonly lastSaveAt: number | null;
  readonly pending: boolean;
}

type IdleHandle = number;

/**
 * A single-document store, debounced.
 *
 * Deliberately not generic over "documents": there is one canvas, and a keyed
 * multi-document store would be an API with exactly one caller and one key. The
 * object store is keyed anyway, so multi-document is a parameter away when
 * something actually needs it.
 */
export class DocumentStore {
  private db: IDBDatabase | null = null;
  private available = false;
  private reason: string | null = 'not opened yet';

  private timer: ReturnType<typeof setTimeout> | null = null;
  private idle: IdleHandle | null = null;
  private queued: unknown = null;

  private saves = 0;
  private lastSaveMs = 0;
  private lastSaveAt: number | null = null;

  async open(): Promise<boolean> {
    if (typeof indexedDB === 'undefined') {
      this.reason = 'IndexedDB is not available in this browser';
      return false;
    }

    try {
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        /* The only place the schema is created or migrated. Bumping DB_VERSION
           re-runs this with the old version in `event.oldVersion`, which is where
           an index or a second store would be added later. */
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('open failed'));
        /* Fires when another tab holds an older version open. Not fatal here —
           there is one version — but leaving it unhandled means a promise that
           never settles, and the caller waits forever with no error. */
        request.onblocked = () => reject(new Error('blocked by another tab'));
      });

      this.available = true;
      this.reason = null;
      return true;
    } catch (error) {
      this.available = false;
      this.reason = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  /**
   * Queue a save. Replaces any save already queued.
   *
   * Keeping only the newest is the whole point: a hundred keystrokes queue one
   * write of the final state, not a hundred writes of intermediate states nobody
   * will ever read.
   */
  schedule(document: unknown): void {
    if (!this.available) return;
    this.queued = document;

    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runWhenIdle();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Write immediately, skipping the debounce.
   *
   * Wired to `pagehide` and to `visibilitychange`, and both are needed. A
   * debounce alone loses the last edit whenever the tab is closed inside the
   * debounce window — which is exactly when a user closes a tab, because they
   * just finished.
   *
   * `pagehide` rather than `beforeunload`: `beforeunload` is unreliable on
   * mobile, where a tab is more often discarded than closed.
   */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.idle !== null) {
      cancelIdle(this.idle);
      this.idle = null;
    }
    await this.write();
  }

  async load(): Promise<unknown> {
    if (!this.available || this.db === null) return null;
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const tx = this.db!.transaction(STORE, 'readonly');
        const request = tx.objectStore(STORE).get(KEY);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => reject(request.error ?? new Error('read failed'));
      });
    } catch {
      /* A read failure is recoverable — start from an empty canvas — and must not
         take the app down with it. Returning null is indistinguishable from
         "nothing saved yet", which is the correct behaviour for both. */
      return null;
    }
  }

  stats(): StorageStats {
    return {
      available: this.available,
      reason: this.reason,
      saves: this.saves,
      lastSaveMs: this.lastSaveMs,
      lastSaveAt: this.lastSaveAt,
      pending: this.timer !== null || this.idle !== null || this.queued !== null,
    };
  }

  close(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.idle !== null) cancelIdle(this.idle);
    this.db?.close();
    this.db = null;
    this.available = false;
  }

  /* ── internals ──────────────────────────────────────────────────────────── */

  private runWhenIdle(): void {
    if (this.idle !== null) return;
    this.idle = requestIdle(() => {
      this.idle = null;
      void this.write();
    });
  }

  private async write(): Promise<void> {
    const document = this.queued;
    if (document === null || !this.available || this.db === null) return;
    this.queued = null;

    const start = performance.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = this.db!.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(document, KEY);
        /* Resolve on the TRANSACTION completing, not on the request succeeding.
           A request can succeed inside a transaction that then aborts — quota
           exceeded is the usual reason — and resolving early reports a save that
           never reached disk. */
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('write failed'));
        tx.onabort = () => reject(tx.error ?? new Error('write aborted'));
      });

      this.saves++;
      this.lastSaveMs = performance.now() - start;
      this.lastSaveAt = Date.now();
    } catch (error) {
      this.reason = error instanceof Error ? error.message : String(error);
      /* Do NOT set available = false. A single failed write is usually transient
         (quota pressure, a tab closing mid-transaction); giving up on persistence
         for the rest of the session because of one is a much larger loss than
         retrying on the next change. */
    }
  }
}

/* ── idle scheduling ──────────────────────────────────────────────────────── */

interface IdleWindow {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
}

/**
 * `requestIdleCallback` where it exists, a short timeout where it does not.
 *
 * Safari shipped it late, and the fallback matters: without it the save simply
 * never runs there. The `timeout` option is the important argument — without it,
 * a page that is never idle never saves, which is precisely the page where the
 * user is doing the most work.
 */
function requestIdle(fn: () => void): IdleHandle {
  const w = globalThis as unknown as IdleWindow;
  if (typeof w.requestIdleCallback === 'function') {
    return w.requestIdleCallback(fn, { timeout: 2000 });
  }
  return setTimeout(fn, 1) as unknown as IdleHandle;
}

function cancelIdle(handle: IdleHandle): void {
  const w = globalThis as unknown as IdleWindow;
  if (typeof w.cancelIdleCallback === 'function') {
    w.cancelIdleCallback(handle);
    return;
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}
