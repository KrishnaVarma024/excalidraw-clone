/**
 * Line breaking.
 *
 * ── Greedy, and that is a decision ──────────────────────────────────────────
 *
 * Fill each line until the next word does not fit, then break. It is O(words),
 * one measurement per word, and it is what every browser does for normal text.
 *
 * The alternative is worth knowing because it is the standard interview
 * follow-up. **Knuth–Plass** — TeX's algorithm — treats the whole paragraph as
 * one optimisation, minimising the sum of squared "badness" over all lines via
 * dynamic programming, so a slightly worse early line can buy a much better
 * later one. It produces visibly better rag, and it costs O(n²) in the general
 * case with a much larger constant.
 *
 * Greedy is right here for a reason that has nothing to do with the complexity:
 * **this wraps on every keystroke.** Paragraph-optimal breaking means the line
 * *above* the one you are typing on can re-break as you type, and text that
 * reflows behind the cursor is disorienting in a way that slightly worse rag
 * never is. Word processors that do use Knuth–Plass mostly apply it at render
 * time, not during editing.
 *
 * ── The case people forget ─────────────────────────────────────────────────
 *
 * A single word longer than the wrap width. Greedy word wrap puts it on a line
 * of its own and moves on — and it still overflows, silently, past the edge of
 * the box, over whatever is next to it. One pasted URL and the layout is broken
 * with no error anywhere. So an over-long word is broken by character, which is
 * `overflow-wrap: anywhere` and is what a browser does when you ask it to.
 */

import type { FontSpec, TextMeasurer } from './measure';

/**
 * Break `text` into display lines.
 *
 * @param maxWidth `null` means auto-width: never wrap, only break on explicit
 *   newlines. That is a different element behaviour, not a large number — a
 *   caller passing `Infinity` would work by accident and break the moment
 *   somebody multiplies it.
 */
export function wrapText(
  text: string,
  maxWidth: number | null,
  font: FontSpec,
  measurer: TextMeasurer,
): string[] {
  /* Normalise line endings first. A paste from Windows carries \r\n and a paste
     from a classic Mac document carries a bare \r; neither should produce a
     phantom empty line or a stray glyph. */
  const source = text.replace(/\r\n?/gu, '\n');

  // Explicit newlines always break, whatever the width. They are the user's
  // instruction, not a hint.
  const paragraphs = source.split('\n');

  if (maxWidth === null) return paragraphs;

  const out: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      out.push(''); // a blank line is a line, and must occupy vertical space
      continue;
    }
    wrapParagraph(paragraph, maxWidth, font, measurer, out);
  }
  return out;
}

function wrapParagraph(
  paragraph: string,
  maxWidth: number,
  font: FontSpec,
  measurer: TextMeasurer,
  out: string[],
): void {
  /* Split keeping the whitespace attached to the *preceding* word, so a break
     never loses the space and a re-join reconstructs the original exactly. That
     matters more than it sounds: the editing textarea holds the raw string, and
     round-tripping through a wrap that eats spaces would corrupt the user's
     text on every reflow. */
  const words = paragraph.match(/\S+\s*/gu) ?? [];

  let line = '';
  let lineWidth = 0;

  for (const word of words) {
    // Trailing whitespace does not count towards the fit. A line ending in a
    // space is not "too long" because of that space, and browsers agree.
    const trimmed = word.trimEnd();
    const wordWidth = measurer.measureLine(trimmed, font);

    if (line !== '' && lineWidth + wordWidth > maxWidth) {
      out.push(line.trimEnd());
      line = '';
      lineWidth = 0;
    }

    if (wordWidth > maxWidth) {
      // The over-long word. Break it by character rather than let it overflow.
      const pieces = breakWord(trimmed, maxWidth, font, measurer);
      for (let i = 0; i < pieces.length - 1; i++) out.push(pieces[i]!);

      const tail = pieces[pieces.length - 1] ?? '';
      line = tail + word.slice(trimmed.length); // put the trailing space back
      lineWidth = measurer.measureLine(tail, font);
      continue;
    }

    line += word;
    lineWidth += measurer.measureLine(word, font);
  }

  out.push(line.trimEnd());
}

/**
 * Split one word into chunks that each fit.
 *
 * Linear rather than binary search on purpose: the common case is a word that
 * only just overflows, so the fit is found in a few steps. Binary search would
 * be asymptotically better and would measure a *longer* prefix on its first
 * probe, which for a 2,000-character pasted token is the more expensive call.
 */
function breakWord(
  word: string,
  maxWidth: number,
  font: FontSpec,
  measurer: TextMeasurer,
): string[] {
  const chars = [...word]; // code points, so an emoji is not cut in half
  const pieces: string[] = [];
  let current = '';

  for (const ch of chars) {
    const next = current + ch;
    if (current !== '' && measurer.measureLine(next, font) > maxWidth) {
      pieces.push(current);
      current = ch;
    } else {
      current = next;
    }
  }
  if (current !== '') pieces.push(current);
  return pieces.length === 0 ? [''] : pieces;
}

export interface TextLayout {
  readonly lines: readonly string[];
  readonly width: number;
  readonly height: number;
  /** Baseline of the first line, measured from the top of the box. */
  readonly ascent: number;
  readonly lineHeight: number;
}

/**
 * Wrap and measure in one call. What every caller actually wants.
 *
 * The width of an auto-width block is the width of its widest line. The width of
 * a wrapped block is the wrap width — **not** the widest line, even though that
 * is usually narrower. Using the widest line would make the box shrink as you
 * delete a long word and then fail to grow back when you retype it, because the
 * wrap width it was measured against has already changed. Two different rules
 * for two different element behaviours, and conflating them produces a box that
 * creeps.
 */
export function layoutText(
  text: string,
  wrapWidth: number | null,
  font: FontSpec,
  measurer: TextMeasurer,
): TextLayout {
  const lines = wrapText(text, wrapWidth, font, measurer);
  const { ascent, lineHeight } = measurer.metrics(font);

  let widest = 0;
  for (const line of lines) {
    const w = measurer.measureLine(line, font);
    if (w > widest) widest = w;
  }

  return {
    lines,
    width: wrapWidth ?? widest,
    // Always at least one line box tall, so an empty text element is still
    // selectable and still shows a caret of the right height.
    height: Math.max(lines.length, 1) * lineHeight,
    ascent,
    lineHeight,
  };
}

/** Horizontal offset of a line inside the box, for the given alignment. */
export function alignOffset(
  lineWidth: number,
  boxWidth: number,
  align: 'left' | 'center' | 'right',
): number {
  switch (align) {
    case 'left':
      return 0;
    case 'center':
      return (boxWidth - lineWidth) / 2;
    case 'right':
      return boxWidth - lineWidth;
  }
}
