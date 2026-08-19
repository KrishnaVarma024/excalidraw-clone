/**
 * Text measurement, wrapping and layout.
 *
 * ── Why these run in Node with no canvas ───────────────────────────────────
 *
 * Because measurement is an *input*. `createFixedMeasurer()` is a real,
 * self-consistent monospace font that happens not to exist: every character is
 * `charRatio × fontSize` wide. Wrapping, alignment and box sizing are exercised
 * for real against it, and the assertions come out as exact integers rather than
 * `toBeCloseTo`.
 *
 * What this deliberately does not cover: kerning, ligatures, shaping, bidi, and
 * the actual metrics of any real font. Those are the browser's, and pretending a
 * Node test covers them would be worse than knowing it does not — the browser
 * smoke test is where they get checked.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FONT_FAMILY,
  LINE_HEIGHT_RATIO,
  createFixedMeasurer,
  fontString,
  type FontSpec,
} from '@engine/text/measure';
import { alignOffset, layoutText, wrapText } from '@engine/text/wrap';
import { newText, relayoutText } from '@engine/scene/elementFactory';
import { DEFAULT_STYLE, type TextElement } from '@engine/scene/element.types';
import { getGeometryBounds, getRenderBounds } from '@engine/scene/bounds';
import { hitTestElement } from '@engine/scene/hitTest';

/** 10 units per character at size 20. Every number below is derived from that. */
const M = createFixedMeasurer(0.5);
const FONT: FontSpec = { fontSize: 20, fontFamily: DEFAULT_FONT_FAMILY };
const CH = 10;

const wrap = (text: string, maxWidth: number | null) => wrapText(text, maxWidth, FONT, M);

function text(value: string, over: Partial<Parameters<typeof newText>[0]> = {}): TextElement {
  return newText(
    { x: 0, y: 0, text: value, style: DEFAULT_STYLE, zIndex: 1, ...over },
    M,
  );
}

/* ── measurement ──────────────────────────────────────────────────────────── */

describe('the measurer seam', () => {
  it('scales with the font size, because a word is not a fixed number of units', () => {
    expect(M.measureLine('hello', FONT)).toBe(5 * CH);
    expect(M.measureLine('hello', { ...FONT, fontSize: 40 })).toBe(5 * CH * 2);
  });

  it('builds a CSS font shorthand that always ends in a generic family', () => {
    /* `ctx.font` fails SILENTLY when a family is unavailable — no throw, no
       warning, just different metrics. A stack ending in a concrete name is a
       layout that differs by machine with nothing in the code to explain it. */
    const f = fontString(FONT);
    expect(f.startsWith('20px ')).toBe(true);
    expect(/(?:cursive|sans-serif|monospace)$/u.test(f)).toBe(true);
  });

  it('gives a line box that does not change with the content', () => {
    /* Deriving line height from the glyphs actually present would make a line
       reading "ooo" shorter than one reading "Ogg". Lines that change height
       with their content are not a text editor, they are a ransom note. */
    const a = M.metrics(FONT);
    expect(a.lineHeight).toBe(20 * LINE_HEIGHT_RATIO);
    expect(a.ascent + a.descent).toBe(a.lineHeight);
  });
});

/* ── wrapping ─────────────────────────────────────────────────────────────── */

describe('wrapText', () => {
  it('does not wrap at all when the width is null', () => {
    // null is auto-width, a different element behaviour — not "a very large
    // number", which is what a caller passing Infinity would be relying on.
    expect(wrap('one two three four five six', null)).toEqual(['one two three four five six']);
  });

  it('always breaks on an explicit newline, whatever the width', () => {
    expect(wrap('a\nb', null)).toEqual(['a', 'b']);
    expect(wrap('a\nb', 10_000)).toEqual(['a', 'b']);
  });

  it('keeps a blank line, because a blank line occupies vertical space', () => {
    expect(wrap('a\n\nb', null)).toEqual(['a', '', 'b']);
  });

  it('normalises CRLF and bare CR', () => {
    // A paste from Windows carries \r\n; a paste from a classic Mac document
    // carries a bare \r. Neither should produce a phantom empty line.
    expect(wrap('a\r\nb\rc', null)).toEqual(['a', 'b', 'c']);
  });

  it('fills each line greedily and breaks at the last word that fits', () => {
    // 'aaa bbb ccc' at 10 units/char: each word is 30, a space is 10.
    // At width 70: "aaa bbb" is 70 (the trailing space does not count) — fits.
    expect(wrap('aaa bbb ccc', 70)).toEqual(['aaa bbb', 'ccc']);
    expect(wrap('aaa bbb ccc', 60)).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('does not count a trailing space towards the fit', () => {
    /* 'aa ' is 30 units of which 10 is the space. A box 20 wide holds it,
       because a line ending in a space is not "too long" because of that space —
       which is what browsers do, and what makes the last word of a paragraph
       fit instead of falling to its own line.

       My first version of this test asserted `wrap('aa bb', 40) === ['aa bb']`,
       which is simply wrong arithmetic: 'aa bb' is five characters, 50 units,
       and does not fit in 40. The rule is about the *trailing* space, not about
       spaces between words. */
    expect(wrap('aa ', 20)).toEqual(['aa']);
    expect(wrap('aa bb', 50)).toEqual(['aa bb']);
    expect(wrap('aa bb', 45)).toEqual(['aa', 'bb']);
  });

  it('breaks a word that is longer than the line, instead of overflowing', () => {
    /* THE case people forget. Greedy word wrap puts an over-long word on a line
       of its own and moves on — and it still runs off the edge of the box, over
       whatever is beside it, silently. One pasted URL and the layout is broken
       with no error anywhere. */
    expect(wrap('aaaaaaaa', 30)).toEqual(['aaa', 'aaa', 'aa']);
  });

  it('breaks a long word by code point, not by UTF-16 unit', () => {
    // Slicing by index would cut an astral character in half and render a pair
    // of replacement glyphs. Every emoji is a surrogate pair.
    const emoji = '😀😀😀';
    const lines = wrap(emoji, 20);
    expect(lines.every((l) => !l.includes('�'))).toBe(true);
    expect(lines.join('')).toBe(emoji);
  });

  it('puts a long word on its own line rather than jamming it onto the last one', () => {
    expect(wrap('hi aaaaaaaa', 30)).toEqual(['hi', 'aaa', 'aaa', 'aa']);
  });

  it('never loses a character', () => {
    /* The invariant that matters most, and the one a subtle off-by-one in the
       whitespace handling breaks: wrapping is a *presentation* of the text, not
       an edit of it. The raw string in the textarea and the wrapped lines on the
       canvas have to stay the same document.

       Two assertions, because the right one depends on the width. Above the
       longest word, every break is at a space that was already there, so
       re-joining with a space reconstructs the source exactly. Below it, words
       get broken mid-word and no join can reconstruct the spacing — but every
       non-whitespace character must still be present, in order.

       My first version asserted only the first form, at every width, and failed
       for the right reason: it was testing the wrong invariant, not finding a
       bug. */
    const source = 'the quick brown fox jumps over the lazy dog';
    const ink = (s: string) => s.replace(/\s+/gu, '');

    for (const width of [60, 100, 250]) {
      expect(wrap(source, width).join(' ')).toBe(source);
    }
    for (const width of [15, 20, 35, 60, 100, 250]) {
      expect(ink(wrap(source, width).join(''))).toBe(ink(source));
    }
  });
});

/* ── layout ───────────────────────────────────────────────────────────────── */

describe('layoutText', () => {
  it('takes an auto-width block’s width from its widest line', () => {
    const l = layoutText('ab\nabcd\nabc', null, FONT, M);
    expect(l.width).toBe(4 * CH);
    expect(l.lines).toHaveLength(3);
  });

  it('takes a wrapped block’s width from the WRAP WIDTH, not its widest line', () => {
    /* Two different rules for two different behaviours, and conflating them
       gives you a box that creeps: measure a wrapped block by its widest line
       and deleting a long word shrinks the box, which changes the wrap width the
       next keystroke is measured against, so retyping the word does not restore
       the original layout. */
    const l = layoutText('aaa bbb ccc', 70, FONT, M);
    expect(l.width).toBe(70);
    expect(l.lines).toEqual(['aaa bbb', 'ccc']);
  });

  it('is one line box tall when empty', () => {
    // A zero-height text element is unselectable and shows a zero-height caret.
    const l = layoutText('', null, FONT, M);
    expect(l.height).toBe(20 * LINE_HEIGHT_RATIO);
  });

  it('grows by exactly one line box per line', () => {
    const one = layoutText('a', null, FONT, M).height;
    const three = layoutText('a\nb\nc', null, FONT, M).height;
    expect(three).toBe(one * 3);
  });
});

describe('alignOffset', () => {
  it('is zero for left, and pushes the remainder for centre and right', () => {
    expect(alignOffset(40, 100, 'left')).toBe(0);
    expect(alignOffset(40, 100, 'center')).toBe(30);
    expect(alignOffset(40, 100, 'right')).toBe(60);
  });

  it('handles a line wider than its box without inverting', () => {
    // Can happen for one frame between a font change and a re-layout.
    expect(alignOffset(120, 100, 'right')).toBe(-20);
  });
});

/* ── the element ──────────────────────────────────────────────────────────── */

describe('the text element', () => {
  it('is born already laid out', () => {
    const el = text('hello');
    expect(el.width).toBe(5 * CH);
    expect(el.height).toBe(20 * LINE_HEIGHT_RATIO);
    expect(el.lines).toEqual(['hello']);
  });

  it('is hit as a solid box even though the glyphs are mostly whitespace', () => {
    /* Per-glyph hit testing is implementable and it is the wrong answer:
       clicking the counter of an 'o', or the space between two words, would
       miss. Text would feel broken in a way no user could describe precisely
       enough to file. */
    const el = text('hello world');
    const b = getGeometryBounds(el);
    const middle = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    expect(hitTestElement(el, middle, 1)).toBe(true);
  });

  it('pads its render bounds for ascenders and descenders', () => {
    // Under-pad by a pixel and a descender leaves a permanent ghost on the
    // canvas after the element moves.
    const el = text('gjpq');
    const geometry = getGeometryBounds(el);
    const render = getRenderBounds(el);
    expect(render.maxY).toBeGreaterThan(geometry.maxY);
    expect(render.minY).toBeLessThan(geometry.minY);
  });

  it('does not inherit the Rough.js jitter padding', () => {
    // Text is not drawn by Rough.js, so `roughness` must not widen its dirty
    // rectangle. Scaling padding with an irrelevant property is how a text-heavy
    // document ends up repainting more of the screen than it needs to.
    const plain = text('x', { style: { ...DEFAULT_STYLE, roughness: 0 } });
    const rough = text('x', { style: { ...DEFAULT_STYLE, roughness: 2 } });
    expect(getRenderBounds(rough)).toEqual(getRenderBounds(plain));
  });
});

describe('relayoutText — the invariant that makes cached measurements safe', () => {
  it('recomputes the derived fields when the text changes', () => {
    const el = text('hi');
    const patch = relayoutText(el, { text: 'hello there' }, M);

    expect(patch.text).toBe('hello there');
    expect(patch.width).toBe(11 * CH);
    expect(patch.lines).toEqual(['hello there']);
  });

  it('recomputes them when only the FONT SIZE changes', () => {
    /* The subtle one. `text` did not change, so a naive "re-wrap when the string
       changes" rule would leave a 40px element carrying a 20px element's width —
       and the spatial index believes that number. Clicks near the text would
       miss, and nothing would look wrong on screen. */
    const el = text('hello');
    const patch = relayoutText(el, { fontSize: 40 }, M);
    expect(patch.width).toBe(5 * CH * 2);
    expect(patch.height).toBe(40 * LINE_HEIGHT_RATIO);
  });

  it('recomputes them when only the WRAP WIDTH changes', () => {
    const el = text('aaa bbb ccc');
    expect(el.lines).toHaveLength(1);

    const patch = relayoutText(el, { wrapWidth: 70 }, M);
    expect(patch.lines).toEqual(['aaa bbb', 'ccc']);
    expect(patch.height).toBe(2 * 20 * LINE_HEIGHT_RATIO);
  });

  it('re-lays-out against a DIFFERENT measurer with no patch at all', () => {
    /* This is the webfont case, and it is the nastiest staleness bug in the
       phase because nothing throws.

       While a webfont is loading, `ctx.font` falls back to another family with
       different metrics. Every string laid out in that window was measured
       against the wrong face. `document.fonts.ready` is the signal; re-laying-out
       with an unchanged patch against the now-correct measurer is the response,
       and it is exactly what `Engine.remeasureText` does. */
    const el = text('hello'); // measured at 10 units/char
    const wider = createFixedMeasurer(0.9); // the real font turns out to be wider

    const patch = relayoutText(el, {}, wider);
    expect(el.width).toBe(50);
    expect(patch.width).toBe(5 * 20 * 0.9);
  });

  it('is a no-op that reports no change when nothing actually moved', () => {
    // `Scene.mutate` compares before writing, so a re-measure that finds the
    // same numbers must not bump `version` — otherwise every font event
    // invalidates the whole Rough cache and forces a full repaint.
    const el = text('hello');
    const patch = relayoutText(el, {}, M);
    expect(patch.width).toBe(el.width);
    expect(patch.lines).toEqual(el.lines);
  });
});
