import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Design invariant: tests must not contain literal-value setTimeout/setInterval calls.
 *
 * Per `memory/playbook/魔法数字.md` Tier 1 零容忍立法.
 *
 * Allowed patterns:
 * - setTimeout/setInterval(fn, NAME_MS) where NAME_MS is a named const with derivation comment
 * - setTimeout/setInterval(fn, opts.intervalMs) where param/var-driven
 * - setImmediate(fn) for yield semantics
 * - String fixtures using template + ${CONST} interpolation
 *
 * Banned patterns:
 * - setTimeout(fn, N) where N is a numeric literal (e.g. 100, 50)
 * - setInterval(fn, N) similarly
 *
 * Phase 318: T-4 子型治理后立此 ratchet 防回归.
 */

const TESTS_ROOT = path.resolve(__dirname, '..');
const SELF_RELATIVE = path.join('design', 'no-magic-sleep-in-tests.test.ts');

const MAGIC_LITERAL_PATTERN = /\b(setTimeout|setInterval)\s*\([^,]+,\s*\d+\s*[,)]/;

// White-listed files (currently only the invariant test itself).
// Add new entries with explicit reason comment if needed.
const ALLOWED_RELATIVE_PATHS = new Set<string>([
  SELF_RELATIVE,
]);

async function* walkTestFiles(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTestFiles(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

describe('design invariant: no magic-value sleep in tests', () => {
  it('no setTimeout/setInterval literal-value call in tests/ (per playbook §零容忍立法)', async () => {
    const violations: Violation[] = [];

    for await (const filePath of walkTestFiles(TESTS_ROOT)) {
      const relative = path.relative(TESTS_ROOT, filePath);
      if (ALLOWED_RELATIVE_PATHS.has(relative)) continue;

      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (MAGIC_LITERAL_PATTERN.test(line)) {
          violations.push({
            file: relative,
            line: idx + 1,
            text: line.trim(),
          });
        }
      });
    }

    if (violations.length > 0) {
      const detail = violations
        .map(v => `  ${v.file}:${v.line}  ${v.text}`)
        .join('\n');
      throw new Error(
        `magic-value sleep found (${violations.length} site, 零容忍):\n${detail}\n\n` +
          `Fix: rename literal to inline const NAME_MS with derivation comment.\n` +
          `See memory/playbook/魔法数字.md §T-4 for naming pattern.`,
      );
    }

    expect(violations).toEqual([]);
  });
});
