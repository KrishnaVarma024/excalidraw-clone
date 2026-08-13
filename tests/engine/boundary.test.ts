import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Architectural fitness test.
 *
 * The central claim of this project (ARCHITECTURE 1) is that the rendering
 * engine is independent of React. That claim is worth exactly as much as its
 * enforcement — and a convention that lives only in a document decays the first
 * time someone is in a hurry.
 *
 * So it lives here instead, as a test that fails the build. Importing React
 * into `src/engine/` is not a code-review conversation; it is a red CI run.
 *
 * The same idea appears in larger codebases as ArchUnit (JVM), dependency-cruiser,
 * or an ESLint `no-restricted-imports` rule. Twenty lines is enough at this size.
 */

const ENGINE_DIR = fileURLToPath(new URL('../../src/engine', import.meta.url));

const FORBIDDEN = [
  { pattern: /from\s+['"]react(-dom)?['"]/, reason: 'React' },
  { pattern: /from\s+['"]react\//, reason: 'React submodule' },
  { pattern: /\.tsx['"]/, reason: 'a .tsx module' },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('engine/react boundary', () => {
  const files = walk(ENGINE_DIR);

  it('finds engine source files to check', () => {
    // Guards against the test silently passing because the glob broke.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s does not import React', (file) => {
    const source = readFileSync(file, 'utf8');
    for (const { pattern, reason } of FORBIDDEN) {
      expect(
        pattern.test(source),
        `${file} imports ${reason}. The engine must stay framework-free — ` +
          `see ARCHITECTURE §1. If you need engine state in a component, ` +
          `subscribe to it from src/react/ instead of reaching the other way.`,
      ).toBe(false);
    }
  });

  it('contains no .tsx files', () => {
    const tsx = walk(ENGINE_DIR).filter((f) => f.endsWith('.tsx'));
    expect(tsx).toEqual([]);
  });
});
