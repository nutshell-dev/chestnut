import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/**
 * Design invariant: tests/ 内 `.catch(() => {})` 必须加 `/* silent: <reason> *​/` annotation.
 *
 * Per `memory/playbook/静默失败.md` §1 + DP-2「错误暴露而非吞没」.
 *
 * src/ 已由 ESLint rule `no-silent-x-without-allowed-pattern` (phase 349) 强制 0 unannotated.
 * tests/ 不在 ESLint scope、本 vitest design test 取而代之锁状态。
 *
 * Allowed patterns:
 * - `.catch(() => { /* silent: <reason> *​/ })` block form
 * - `.catch(() => { // silent: <reason> })` line form
 * - Non-empty catch body (有 audit / console / throw / expect 等已是非 silent)
 *
 * Banned pattern:
 * - `.catch(() => {})` 完全空体且无 silent annotation
 *
 * phase 428: tests/ 230 sites bulk annotate 后立此 ratchet 防回归.
 */

const TESTS_ROOT = path.resolve(__dirname, '..');
const SELF_RELATIVE = path.join('design', 'no-unannotated-silent-catch-in-tests.test.ts');

// `.catch(() => {})` 完全空体（promise form）— phase 428 立
const EMPTY_CATCH_PATTERN = /\.catch\(\(\) => \{\}\)/;

// `} catch {}` / `} catch (e) {}` 完全空块体（block form）— phase 431 立
const EMPTY_BLOCK_CATCH_PATTERN = /\}\s*catch\s*(?:\(\w*\))?\s*\{\s*\}/;

// Allowed: 带 silent: 注释（block 或 line form）— 覆盖两种 catch 形式
const SILENT_ANNOTATION_PATTERN = /(?:\.catch\(\(\) => \{|\}\s*catch\s*(?:\(\w*\))?\s*\{)\s*(?:\/\*\s*silent:|\/\/\s*silent:)/;

const ALLOWED_RELATIVE_PATHS = new Set<string>([
  SELF_RELATIVE,
  // Allowed: ESLint rule test fixtures (RuleTester embedded code strings、不是真 source)
  path.join('foundation', 'eslint-rules', 'no-silent-catch-outside-allowlist.test.ts'),
  path.join('foundation', 'eslint-rules', 'no-silent-x-without-allowed-pattern.test.ts'),
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

describe('design invariant: no unannotated silent catch in tests', () => {
  it('no `.catch(() => {})` without `silent:` annotation in tests/ (per playbook §静默失败 §1)', async () => {
    const violations: Violation[] = [];
    for await (const file of walkTestFiles(TESTS_ROOT)) {
      const rel = path.relative(TESTS_ROOT, file);
      if (ALLOWED_RELATIVE_PATHS.has(rel)) continue;
      const content = await fs.readFile(file, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hasEmptyCatch = EMPTY_CATCH_PATTERN.test(line) || EMPTY_BLOCK_CATCH_PATTERN.test(line);
        if (hasEmptyCatch && !SILENT_ANNOTATION_PATTERN.test(line)) {
          violations.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    if (violations.length > 0) {
      const detail = violations
        .map(v => `  ${v.file}:${v.line}  ${v.text}`)
        .join('\n');
      throw new Error(
        `unannotated silent catch found (${violations.length} site, 零容忍):\n${detail}\n\n` +
          `Fix: add \`/* silent: <reason> */\` annotation. Common reasons: cleanup, shutdown, expected-failure, best-effort.\n` +
          `See memory/playbook/静默失败.md §1 for pattern guidance.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
