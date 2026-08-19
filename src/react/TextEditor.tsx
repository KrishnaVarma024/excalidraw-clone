import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Engine } from '@engine/Engine';
import { FONT_STACKS } from '@engine/text/measure';
import { useEngineState } from './useEngineState';

interface Props {
  engine: Engine;
}

/**
 * A real `<textarea>`, positioned on top of the canvas.
 *
 * ── Why not implement a caret ──────────────────────────────────────────────
 *
 * Because the list of things you would have to reimplement is not a list of
 * features, it is a list of ways to exclude people:
 *
 *   **IME.** Typing Japanese, Chinese or Korean goes through an input method
 *   editor: the OS shows a candidate window, composition state lives *inside*
 *   the input element, and `compositionstart`/`update`/`end` are the only way to
 *   see it. A canvas-drawn caret cannot host a composition, so a hand-rolled
 *   editor is unusable for a large fraction of the world's writers — and it
 *   looks fine in every test written by someone who types Latin.
 *
 *   **Accessibility.** A screen reader can read a focused textarea. It cannot
 *   read pixels. So can dictation software, and switch access, and braille
 *   displays.
 *
 *   **The mobile keyboard.** It appears because a form control has focus. There
 *   is no API to say "please open the keyboard"; focus *is* the API.
 *
 *   **Everything else the platform already did.** Selection by drag,
 *   double-click-to-select-word, ⌥←/→ by word, ⌘↑/↓, undo *inside the field*,
 *   spellcheck, autocorrect, right-click → paste, drag-and-drop of text, and the
 *   OS text-replacement rules a user configured years ago.
 *
 * The cost of the trick is that the textarea has to be made invisible and lined
 * up with the canvas text to the pixel, which is the fiddly part below.
 * Excalidraw, tldraw and Figma all pay it. Google Docs famously did not — it
 * renders its own caret — and the reason it can afford that is a document model
 * and a test matrix this project does not have.
 *
 * ── Two channels, again ────────────────────────────────────────────────────
 *
 * *Whether* an editor exists is discrete: it goes on the engine snapshot and
 * this component re-renders when it changes. *Where* it sits is continuous — it
 * moves on every pan and zoom step — so it is written to the DOM through a frame
 * listener and a ref, and panning with the editor open costs zero React renders.
 * The same split the stats overlay has used since Phase 3.
 */
export function TextEditor({ engine }: Props) {
  const { editingTextId } = useEngineState(engine);
  const ref = useRef<HTMLTextAreaElement>(null);

  /**
   * How much the browser inflated our font size, and the size we asked for.
   *
   * See `measureClamp` below. Cached because reading it means a forced style
   * recalculation, and this runs on every frame.
   */
  const clamp = useRef({ asked: 0, used: 0 });

  /* Position and font, written straight to the DOM every frame.
     `useLayoutEffect` rather than `useEffect` so the first placement happens
     before the browser paints — otherwise the editor appears at (0, 0) for one
     frame and visibly jumps into place. */
  useLayoutEffect(() => {
    if (editingTextId === null) return;

    const apply = () => {
      const el = ref.current;
      const layout = engine.textEditorLayout();
      if (el === null || layout === null) return;

      /* ── Scale, do not multiply ──────────────────────────────────────────

         The textarea carries a font size in SCENE units and a CSS transform
         does the zoom, rather than a font size of `fontSize * zoom` in screen
         pixels.

         An honest note, because the original version of this comment claimed
         something I had not checked. I expected the multiply form to drift —
         browsers quantising font sizes, glyph stems snapping to the pixel grid —
         and I A/B'd the two builds from 100% to 3000% zoom. **They were
         pixel-identical at every level.** Chromium lays out fractional font
         sizes exactly.

         The reason that survives measurement is duller and still decisive: the
         element has to carry the rotation anyway, so it needs a transform
         regardless. Scaling puts the zoom in the mechanism that is already
         there, instead of splitting one affine map across two places. */
      el.style.left = `${layout.left}px`;
      el.style.top = `${layout.top}px`;
      el.style.fontFamily = FONT_STACKS[layout.fontFamily];
      el.style.textAlign = layout.textAlign;
      el.style.color = layout.color;

      /* ── The accessibility setting that breaks this, and the correction ────

         Chrome and Firefox both let a user set a **minimum font size**. It is
         not a suggestion: the browser silently raises any smaller font to it.
         Set 20px with a 24px minimum and `getComputedStyle` reports 24px, with
         nothing thrown and nothing logged — the editor's glyphs are 20% larger
         than the ones the canvas draws underneath, at every zoom level, and the
         only symptom is that text visibly resizes the moment you stop editing.

         This is worth dwelling on because it fails for the users least able to
         work around it, and it never shows up in testing: a developer's browser
         has the minimum at its default of zero.

         The fix: ask what size the browser actually used, then divide it back
         out of the transform. Rendered size is `used × scale`, so a scale of
         `zoom / inflation` renders at `asked × zoom` — which is what the canvas
         draws.

         Everything else set in element-local pixels is then **multiplied** by
         the same ratio, not divided: local lengths are about to be shrunk by the
         transform, so they have to start proportionally larger. Getting that
         backwards — which I did first — makes the editor wrap its text at 1/1.44
         of the right width, and the symptom looks like a wrapping bug rather
         than a scaling one.

         `getComputedStyle` forces a style recalculation, so it is read only when
         the requested size changes rather than on every frame. */
      if (clamp.current.asked !== layout.fontSize) {
        el.style.fontSize = `${layout.fontSize}px`;
        const used = parseFloat(getComputedStyle(el).fontSize);
        clamp.current = {
          asked: layout.fontSize,
          used: Number.isFinite(used) && used > 0 ? used : layout.fontSize,
        };
      }

      const inflation = clamp.current.used / layout.fontSize;
      el.style.width = `${layout.width * inflation}px`;
      el.style.lineHeight = `${layout.lineHeight * inflation}px`;
      el.style.transform = `scale(${layout.zoom / inflation}) rotate(${layout.angle}rad)`;
      // Grow with the content so the caret never scrolls out of a fixed box.
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };

    apply();
    return engine.addFrameListener(apply);
  }, [engine, editingTextId]);

  /* Focus once, when the editor opens. Inside its own effect rather than the one
     above, because that one runs on every frame and re-focusing 60 times a
     second would fight the user's own selection. */
  useEffect(() => {
    if (editingTextId === null) return;
    const el = ref.current;
    if (el === null) return;

    // Force a re-read of the clamp for this editor instance.
    clamp.current = { asked: 0, used: 0 };
    el.focus();
    // Caret to the end. Selecting all would mean the next keystroke wipes the
    // text you double-clicked in to amend, which is a mistake you make once and
    // then distrust the tool.
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [editingTextId]);

  if (editingTextId === null) return null;

  const layout = engine.textEditorLayout();

  return (
    <textarea
      ref={ref}
      className="text-editor"
      // Uncontrolled: React must not own this value. A controlled textarea
      // re-renders on every keystroke and, more importantly, breaks IME
      // composition — the candidate text gets overwritten mid-composition by
      // the value React last knew about.
      defaultValue={layout?.text ?? ''}
      onChange={(e) => engine.setEditingText(e.target.value)}
      onBlur={() => engine.endTextEditing()}
      onKeyDown={(e) => {
        // Escape commits and closes. It does NOT discard: the text is already in
        // the scene, keystroke by keystroke, and "Escape throws away everything
        // you typed" is a data-loss gesture people trigger by reflex.
        if (e.key === 'Escape') {
          e.preventDefault();
          engine.endTextEditing();
          return;
        }
        /* Everything else stays in the textarea. Without this, the engine's
           global keydown handler is still listening: typing "r" while editing
           would switch to the rectangle tool, and Backspace would delete the
           selected element rather than a character. */
        e.stopPropagation();
      }}
      spellCheck={false}
      autoComplete="off"
      aria-label="Edit text"
    />
  );
}
