/**
 * The performance gate.
 *
 * ── Why exact equality, and not a ceiling ───────────────────────────────────
 *
 * Every number in `budget.json` is a *count*, and counts here are exactly
 * reproducible — same seed, same code, same integer, on any machine (§10.1).
 * When a quantity is deterministic, `toEqual` is strictly more informative than
 * `toBeLessThan`:
 *
 *   - a ceiling is silent about improvements, so a 40% win is never recorded
 *     and the budget drifts upward until it stops constraining anything;
 *   - a ceiling has to be *chosen*, and the honest choice is "current + some
 *     slack", which is a number nobody can defend in review;
 *   - a ceiling cannot fail on a change that makes a scene *smaller* — and
 *     "the cull now returns 200 elements instead of 4,000" is a bug, not a win.
 *
 * The cost is real and worth naming: this file fails on intentional changes
 * too. That is the trade — **every change to the work this engine does becomes
 * a line in a diff somebody has to justify**, which is the entire point. The
 * escape hatch is one command, and using it is meant to feel like a decision:
 *
 *     UPDATE_BUDGET=1 npm test -- tests/budget
 *
 * Contrast `scripts/checkBundle.mjs`, which uses a ceiling — bundle bytes move
 * with a dependency patch release, so an exact assertion there would fail for
 * reasons that are not about this code. **Match the assertion to how
 * deterministic the quantity actually is**; using one style everywhere is how
 * you get a suite that is either too loose to catch anything or too tight to
 * live with.
 *
 * ── And two of these are not counts ─────────────────────────────────────────
 *
 * That principle applies inside this file too, which the first version of it
 * missed. See `TOLERANT` below: 43 of the 45 measurements are integer counts of
 * operations and are exactly reproducible. Two are **byte sizes of serialised
 * floating-point data**, which is a different determinism class wearing the same
 * shape. They were asserted exactly anyway, and drifted by 21 bytes in 461 kB
 * between an x86-64 Linux container and an arm64 macOS laptop.
 *
 * The lesson is not "add a tolerance". It is that *the same file* can hold two
 * kinds of quantity, and grouping them by where they live rather than by how
 * they behave is how a gate ends up failing for a reason nobody can act on.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type Measurements, measure } from './measure';

const BUDGET_PATH = fileURLToPath(new URL('./budget.json', import.meta.url));

/**
 * Measurements compared with a relative tolerance rather than exactly.
 *
 * Every entry needs a reason, and the reason has to be about the *quantity*,
 * not about the inconvenience of the failure. "It kept failing" is how a
 * tolerance list grows until nothing is gated.
 */
const TOLERANT: readonly {
  readonly pattern: RegExp;
  readonly relative: number;
  readonly why: string;
}[] = [
  {
    pattern: /^bytes\.document\./u,
    /* 0.1%, chosen from the two numbers that matter:
         NOISE  — observed drift is 21 B in 461 kB (0.005%) and 44 B in 4.94 MB
                  (0.0009%), between an x86-64 Linux container and an arm64
                  macOS laptop. 0.1% is ~20x the larger of those.
         SIGNAL — this counter exists to catch a field added to the element
                  model. One more short field is roughly 15 B per element:
                  15 kB at 1,000 elements, 3.2% — thirty times the tolerance.
       A tolerance is only defensible when you can state both numbers and show
       the gap. Here it is a factor of ~600 between noise and signal, which is
       why this is a safe place to be loose. */
    relative: 0.001,
    why:
      'byte size of serialised floating-point coordinates. Element positions and ' +
      'freehand points carry full float precision, and the last digits of a ' +
      'double->string conversion are not stable across V8 builds and platforms. ' +
      'Note that bytes.svg.* IS exact, because Phase 9 rounds path coordinates ' +
      'to 2 decimals before serialising - the rounding that halved the file also ' +
      'made it machine-independent, which nobody planned.',
  },
];

const toleranceFor = (key: string) => TOLERANT.find((t) => t.pattern.test(key));

const measured = measure();

if (process.env['UPDATE_BUDGET'] === '1') {
  writeFileSync(BUDGET_PATH, `${JSON.stringify(measured, null, 2)}\n`, 'utf8');
}

const recorded = JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) as Measurements;

/**
 * Read as: "you changed the work this engine does. Was that on purpose?"
 *
 * The message matters more than the assertion. A red build that says
 * `expected 10000 to be 46` sends someone to read this file to work out what it
 * means; one that names the command and the decision sends them to their own
 * diff, which is where the answer is.
 */
const explain = (key: string) => {
  const tolerant = toleranceFor(key);
  return [
    ``,
    `  Budget moved: ${key}`,
    ``,
    tolerant === undefined
      ? `  This is an exact operation count, not a timing — it is reproducible on\n` +
        `  every machine, so this is a real change in the work the engine does and\n` +
        `  not runner noise.`
      : `  This one is compared with a ${(tolerant.relative * 100).toFixed(1)}% tolerance and still moved, so the\n` +
        `  change is far larger than platform noise. Why it is tolerant at all:\n` +
        `  ${tolerant.why}`,
    ``,
    `  If your change was meant to move it, record the new number and say why in`,
    `  the commit message:`,
    ``,
    `      UPDATE_BUDGET=1 npm test -- tests/budget`,
    ``,
    `  If it was not, you have found a regression before it shipped. That is what`,
    `  this file is for.`,
    ``,
  ].join('\n');
};

describe('performance budget', () => {
  /* Keys first, and separately. A renamed or dropped measurement is a different
     failure from a moved one — it means the gate stopped watching something,
     which is worse than a regression because it is silent. Folding both into a
     single deep-equal reports it as an unreadable object diff. */
  it('measures exactly the set of things the budget records', () => {
    expect(Object.keys(measured).sort()).toEqual(Object.keys(recorded).sort());
  });

  /* One assertion per key rather than one deep-equal over the whole object.
     A deep-equal stops being readable past about six fields, and — more
     usefully — a per-key test tells you at a glance whether ONE thing moved or
     EVERYTHING did. Those have very different causes: one is a bug in a code
     path, all of them is a changed seed or generator. */
  for (const key of Object.keys(recorded).sort()) {
    const tolerant = toleranceFor(key);

    it(tolerant === undefined ? key : `${key} (±${tolerant.relative * 100}%)`, () => {
      const actual = measured[key];
      const expected = recorded[key];

      if (tolerant === undefined || typeof expected !== 'number' || typeof actual !== 'number') {
        expect(actual, explain(key)).toEqual(expected);
        return;
      }

      /* Relative, not absolute: an absolute byte allowance that is right at
         1,000 elements is ten times too tight at 10,000. The drift scales with
         the data, so the tolerance has to as well. */
      const allowed = Math.abs(expected) * tolerant.relative;
      expect(Math.abs(actual - expected), explain(key)).toBeLessThanOrEqual(allowed);
    });
  }
});
