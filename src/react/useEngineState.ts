import { useSyncExternalStore } from 'react';
import type { Engine, EngineSnapshot } from '@engine/Engine';

/**
 * The React ↔ engine seam.
 *
 * `useSyncExternalStore` is React's supported way to read state that lives
 * outside React. It takes a `subscribe` function and a `getSnapshot` function
 * and handles tearing, concurrent rendering and StrictMode double-invocation
 * correctly — all of which a hand-rolled `useState` + `useEffect` subscription
 * gets subtly wrong.
 *
 * ── The contract that bites everyone once ───────────────────────────────────
 *
 * `getSnapshot` must return a **referentially stable** value while the state is
 * unchanged. React compares consecutive results with `Object.is`. Return a
 * fresh object literal each call —
 *
 *     getSnapshot={() => ({ zoom: engine.zoom })}   // ← infinite loop
 *
 * — and every comparison says "changed", so React re-renders, calls
 * `getSnapshot` again, gets another new object, and loops until it throws
 * *"The result of getSnapshot should be cached to avoid an infinite loop"*.
 *
 * `Engine.getSnapshot` therefore returns a cached field that is only replaced
 * when a value React can actually observe has changed. See `refreshSnapshot`.
 *
 * ── What belongs here and what does not ─────────────────────────────────────
 *
 * Only state that changes *discretely*. Anything that changes per frame — fps,
 * frame time, the raw zoom float — goes through `engine.addFrameListener` and
 * is written straight to the DOM, because re-rendering React 60 times a second
 * is the exact cost this project is built to avoid.
 */
export function useEngineState(engine: Engine): EngineSnapshot {
  return useSyncExternalStore(engine.subscribe, engine.getSnapshot, engine.getSnapshot);
}
