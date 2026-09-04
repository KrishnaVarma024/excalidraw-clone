#!/usr/bin/env node
/**
 * Bundle-size gate.
 *
 * ── Why a ceiling here, when tests/budget uses exact equality ───────────────
 *
 * Because the quantity is a different shape. The work counts in
 * `tests/budget/budget.json` are pure functions of this repository's code — same
 * seed, same integer, forever. Bundle bytes are not: they move when a dependency
 * ships a patch release, when a minifier changes a heuristic, when Node's zlib
 * is rebuilt. An exact assertion on those fails for reasons that are not about
 * this project, and a gate that fails for reasons outside your control is a gate
 * people learn to ignore.
 *
 * So: a ceiling, plus the half most size gates leave out — a **complaint when
 * you are far under it**. A ceiling alone only ratchets one way. Ship something
 * that halves the bundle, nobody lowers the number, and the budget silently
 * stops constraining anything long before anyone notices.
 *
 * ── Why brotli and not raw ──────────────────────────────────────────────────
 *
 * The raw byte count is not what a user waits for. Every CDN and every static
 * host serves this compressed, so a change that adds 40 kB of highly repetitive
 * code and a change that adds 40 kB of entropy cost the user completely
 * different amounts. Budgeting raw bytes measures a number nobody experiences.
 *
 * Brotli rather than gzip because it is what browsers actually negotiate today,
 * and it is 15–20% smaller on JavaScript. Both are reported; only brotli is
 * gated.
 *
 * ── Why this is a script and not a test ─────────────────────────────────────
 *
 * It needs `dist/`, which means it needs a build. Vitest runs in ~10 s from
 * source; making it depend on a 3 s bundle would slow every run of the whole
 * suite to gate one number. CI builds anyway, so this hangs off that step, and
 * `npm run verify` stays fast enough that people run it before pushing — which
 * is the only property that makes a pre-push gate worth having.
 *
 *     node scripts/checkBundle.mjs            check against the budget
 *     node scripts/checkBundle.mjs --update   record the current sizes
 */

import { brotliCompressSync, gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BUDGET_PATH = join(ROOT, 'scripts', 'bundle-budget.json');

/**
 * A budget is called stale when it is BOTH a small fraction of the ceiling AND
 * more than `SLACK_FLOOR_BYTES` clear of it.
 *
 * The ratio alone is wrong, and the first run proved it: ceilings are rounded up
 * to a whole kB, so a 2.3 kB stylesheet gets a 3 kB ceiling and sits at 75% by
 * arithmetic, not by neglect. Warning about that is warning about the rounding.
 * The absolute gate means the notice only appears where 20% is actually worth
 * reclaiming. **A warning that fires on quantisation noise trains people to
 * ignore warnings**, which costs more than the check is worth.
 */
const SLACK_FLOOR = 0.8;
const SLACK_FLOOR_BYTES = 8 * 1024;

/**
 * Headroom `--update` leaves above the measured size.
 *
 * A ceiling recorded at exactly today's size fails on the next byte anyone adds,
 * so every change to any file becomes a budget update — and a gate that has to
 * be updated on every commit is one nobody reads before updating. Ten percent is
 * enough for ordinary feature work and small enough that a new dependency still
 * trips it, which is the thing worth catching.
 *
 * It is applied at RECORD time, not at check time, so the number in the JSON is
 * the actual ceiling. A tolerance applied silently at comparison time means the
 * file says one thing and the gate enforces another.
 */
const HEADROOM = 1.1;

/** Hashed filenames change every build; group by what the file IS. */
function bucket(name) {
  if (name.endsWith('.html')) return 'html';
  if (name.endsWith('.css')) return 'css';
  if (name.endsWith('.js')) return 'js';
  return 'other';
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function measure() {
  let files;
  try {
    files = walk(DIST);
  } catch {
    console.error(`\n  No dist/ directory. Run \`npx vite build\` first.\n`);
    process.exit(2);
  }

  const totals = {};
  for (const file of files) {
    const buf = readFileSync(file);
    const key = bucket(relative(DIST, file));
    const t = (totals[key] ??= { raw: 0, gzip: 0, brotli: 0, files: 0 });
    t.raw += buf.length;
    t.gzip += gzipSync(buf).length;
    t.brotli += brotliCompressSync(buf).length;
    t.files++;
  }
  return totals;
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

const totals = measure();

if (process.argv.includes('--update')) {
  const budget = Object.fromEntries(
    Object.entries(totals).map(([k, v]) => [
      k,
      // Rounded up to a whole kB: a ceiling of "89217 bytes" implies a precision
      // this measurement does not have, and invites arguments about 200 bytes.
      { brotli: Math.ceil((v.brotli * HEADROOM) / 1024) * 1024 },
    ]),
  );
  writeFileSync(BUDGET_PATH, `${JSON.stringify(budget, null, 2)}\n`, 'utf8');
  console.log(
    `\n  Wrote ${relative(ROOT, BUDGET_PATH)} — measured size + ${((HEADROOM - 1) * 100).toFixed(0)}% headroom:\n`,
  );
  for (const [k, v] of Object.entries(totals)) {
    console.log(`    ${k.padEnd(6)} ${kb(v.brotli).padStart(9)} now  →  ${kb(budget[k].brotli)} ceiling`);
  }
  console.log();
  process.exit(0);
}

const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));

let failed = false;
const warnings = [];

console.log(`\n  bundle           raw      gzip    brotli    budget\n`);
for (const [key, t] of Object.entries(totals)) {
  const ceiling = budget[key]?.brotli;
  const pct = ceiling === undefined ? null : t.brotli / ceiling;

  let verdict = '  (no budget)';
  if (pct !== null) {
    if (pct > 1) {
      verdict = `  OVER by ${kb(t.brotli - ceiling)}`;
      failed = true;
    } else if (pct < SLACK_FLOOR && ceiling - t.brotli >= SLACK_FLOOR_BYTES) {
      verdict = `  ${(pct * 100).toFixed(0)}% of budget`;
      warnings.push(
        `${key} is at ${(pct * 100).toFixed(0)}% of its ceiling — lower it to ${kb(t.brotli)} so it keeps meaning something.`,
      );
    } else {
      verdict = `  ${(pct * 100).toFixed(0)}%`;
    }
  }

  console.log(
    `  ${key.padEnd(8)} ${kb(t.raw).padStart(9)} ${kb(t.gzip).padStart(9)} ${kb(t.brotli).padStart(9)} ${
      ceiling === undefined ? '        —' : kb(ceiling).padStart(9)
    }${verdict}`,
  );
}
console.log();

for (const w of warnings) console.log(`  note: ${w}`);
if (warnings.length > 0) console.log();

if (failed) {
  console.error(
    `  Over budget. Either the growth is justified — in which case record it and say why:\n` +
      `\n      node scripts/checkBundle.mjs --update\n` +
      `\n  — or find out what got pulled in:\n` +
      `\n      npx vite build && npx vite-bundle-visualizer\n`,
  );
  process.exit(1);
}
