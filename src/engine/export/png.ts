/**
 * PNG export.
 *
 * ── The claim this file exists to test ─────────────────────────────────────
 *
 * `drawElement.ts` has carried this comment since Phase 2:
 *
 *   > It is also what will let Phase 9 reuse this exact code to render an export
 *   > at a different scale to an offscreen canvas, with no changes. If export
 *   > ever needs to modify this file, that is a signal something in here is
 *   > reading screen state it should not be.
 *
 * It did not need to be modified. Not one line. The whole of this exporter is:
 * make a canvas, install a different matrix, call `drawElement` in z-order.
 *
 * That is worth being precise about, because it is the only kind of proof an
 * architectural rule ever gets. `drawElement` was never allowed to read `zoom`,
 * `scroll` or `devicePixelRatio` — it reads six numbers off a 2D context and
 * does not care where they came from. Seven phases later, a caller with a
 * completely different idea of what those six numbers mean gets the same
 * drawing for free.
 *
 * ── Export is not a screenshot ─────────────────────────────────────────────
 *
 * `canvas.toBlob()` on the live canvas gives you the current viewport, at the
 * current zoom, with the selection handles in it. This renders the *content*,
 * at the requested scale, with nothing on top and no dirty-rect machinery
 * anywhere near it.
 */

import { createRoughCanvas, drawElement } from '../render/drawElement';
import { RoughCache } from '../render/roughCache';
import type { Element } from '../scene/element.types';
import { EXPORT_PADDING, type ExportSize, exportBounds, exportMatrix, fitExportSize } from './bounds';

export interface PngOptions {
  /** Background colour, or null for transparency. */
  readonly background: string | null;
  /** 1, 2 or 3. Reduced automatically if the canvas would exceed browser caps. */
  readonly scale: number;
  readonly padding?: number;
}

export interface PngResult {
  readonly blob: Blob;
  readonly size: ExportSize;
}

/**
 * Render elements to a PNG blob.
 *
 * Returns null for an empty scene. Throws only if the browser refuses a 2D
 * context, which is not a condition any caller can recover from.
 */
export async function toPng(
  elements: readonly Element[],
  options: PngOptions,
): Promise<PngResult | null> {
  const live = elements.filter((el) => !el.isDeleted);
  const bounds = exportBounds(live, options.padding ?? EXPORT_PADDING);
  if (bounds === null) return null;

  const size = fitExportSize(bounds, options.scale);

  /* ── Wait for fonts before drawing, not after ────────────────────────────
   *
   * `ctx.font` falls back silently while a webfont is loading (§7.4.1). On
   * screen that is a transient wrong-looking frame; in an export it is baked
   * into a file the user sends to someone. This is one `await` and it removes
   * an entire class of "the export doesn't match what I saw".
   *
   * Guarded because `document.fonts` does not exist in every environment this
   * module might be imported into. */
  await globalThis.document?.fonts?.ready;

  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;

  /* `alpha: true` even when a background is requested. The static renderer uses
     `alpha: false` because it repaints an opaque background every frame and the
     compositor can skip blending; here, a transparent export is a supported
     option and an opaque context cannot produce one. */
  const ctx = canvas.getContext('2d', { alpha: true });
  if (ctx === null) throw new Error('2D context unavailable for export');

  if (options.background !== null) {
    /* Filled in DEVICE space, before the scene transform is installed. Fill it
       afterwards and the rectangle is in scene coordinates, which is a different
       rectangle — one that misses the padding and lands short on two edges. */
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, size.width, size.height);
  }

  // A FRESH transform. Export has its own viewport, unrelated to the screen's.
  ctx.setTransform(...exportMatrix(bounds, size.scale));

  const rc = createRoughCanvas(canvas);
  const cache = new RoughCache();

  /* Painter's order, explicitly — see the same note in `svg.ts`. An export that
     depended on the caller having sorted would be right in the app and wrong
     everywhere else. */
  for (const el of [...live].sort((a, b) => a.zIndex - b.zIndex)) {
    drawElement(ctx, rc, cache, el);
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    /* `toBlob`, not `toDataURL`.
     *
     * `toDataURL` builds a base64 string on the main thread and returns it
     * synchronously. At export sizes that string is tens of megabytes, it is
     * ~33% larger than the binary, and in several browsers it silently returns
     * `"data:,"` past an internal limit rather than throwing. `toBlob` hands
     * back binary, off-thread, and reports failure as null. */
    canvas.toBlob((b) => resolve(b), 'image/png');
  });

  /* Null here almost always means the canvas exceeded a browser limit that
     `fitExportSize` did not predict — a device-specific cap, usually mobile
     Safari. Saying so beats "export failed", because it tells the user the one
     thing that might help: try a smaller scale. */
  if (blob === null) {
    throw new Error(
      `the browser refused to encode a ${size.width}×${size.height} image — try a smaller scale`,
    );
  }

  return { blob, size };
}

/**
 * Hand a blob to the user as a file.
 *
 * The object URL is revoked on the next macrotask rather than immediately: the
 * click is dispatched synchronously but the browser reads the URL when it starts
 * the download, and revoking in the same tick cancels it in some browsers. It is
 * a one-line detail with a symptom — "the download button does nothing,
 * sometimes" — that is close to unfindable.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * A filename with a sortable timestamp.
 *
 * `YYYY-MM-DD-HHMM` rather than a locale string, so a folder of exports sorts
 * chronologically by name and a colon never reaches a filesystem that forbids
 * one.
 */
export function exportFilename(extension: string, now = new Date()): string {
  const p = (v: number): string => String(v).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}`;
  return `drawing-${stamp}.${extension}`;
}
