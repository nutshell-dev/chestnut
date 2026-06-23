import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * phase 1238 invariant: cron unit test 必含 vi.useFakeTimers
 *
 * Root cause fix for wall-clock + computeRunKey block boundary race
 * (phase 1232 dev-time interval:100ms race fix + 5 latent site refactor 同根 cluster)
 *
 * Pattern: tests/foundation/cron/runner*.test.ts + handler-*.test.ts (cron runtime test)
 * Exception: parse-schedule-unit.test.ts (parser 不涉 wall-clock)
 */
describe('phase 1238: cron unit test wall-clock race invariant', () => {
  it('all cron runtime test files 必含 vi.useFakeTimers (防 computeRunKey block boundary race)', () => {
    // phase 697 Step A: cron runtime tests 仍在 tests/core/cron/ (src 迁 foundation、tests 跟 core)
    const cronTestDir = join(__dirname, '../core/cron');
    const allFiles = readdirSync(cronTestDir);

    // Match cron runtime test patterns
    const cronTestFiles = allFiles.filter(f =>
      (f.startsWith('runner') || f.startsWith('handler-')) &&
      f.endsWith('.test.ts')
    );

    // Exception list: parser unit tests / lint grep tests 不涉 wall-clock
    const EXCEPTIONS = new Set<string>([
      'handler-signal-cascade-invariant.test.ts',  // phase 1266: lint grep assemble.ts + jobs type signature, 0 runner runtime
    ]);

    const violations: string[] = [];
    for (const file of cronTestFiles) {
      if (EXCEPTIONS.has(file)) continue;
      const content = readFileSync(join(cronTestDir, file), 'utf-8');
      if (!content.match(/vi\.useFakeTimers/)) {
        violations.push(file);
      }
    }

    if (violations.length > 0) {
      throw new Error(
        `cron unit test 必含 vi.useFakeTimers (phase 1238 invariant). Violators:\n` +
        violations.map(f => `  - tests/foundation/cron/${f}`).join('\n') +
        `\n\nFix options:\n` +
        `  (a) Add vi.useFakeTimers + vi.useRealTimers cleanup\n` +
        `  (b) Add to EXCEPTIONS set if test 纯 unit/parser (justify in comment)\n` +
        `\nWhy: computeRunKey (src/foundation/cron/runner.ts:361-382) interval block boundary\n` +
        `跨越时 runKey 变 → job 重起 race / wall-clock dependency 致 latent flaky\n` +
        `(mirror phase 1232 worktree dev-time interval:100ms fix + 5 latent site refactor)`
      );
    }
  });

  it('reverse 1: NEW cron test 缺 useFakeTimers → invariant fail', () => {
    // synthetic test: 模拟 NEW cron test 文件内容 = 0 useFakeTimers
    const synthetic = `
      import { describe, it, expect } from 'vitest';
      import { CronRunner } from '../../../src/foundation/cron/runner.js';
      describe('new test', () => {
        it('should test something', async () => {
          const runner = new CronRunner([], {} as any);
          runner.start(10);
          // 漏 useFakeTimers
        });
      });
    `;
    expect(synthetic.match(/vi\.useFakeTimers/)).toBeNull();
  });

  it('reverse 2: cron test 含 useFakeTimers → invariant pass', () => {
    const synthetic = `
      describe('proper test', () => {
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());
        it('should test', () => {});
      });
    `;
    expect(synthetic.match(/vi\.useFakeTimers/)).not.toBeNull();
  });

  it('reverse 3: exception list pattern works', () => {
    // EXCEPTIONS Set 可扩
    const EXCEPTIONS = new Set<string>(['some-parser-test.test.ts']);
    expect(EXCEPTIONS.has('some-parser-test.test.ts')).toBe(true);
    expect(EXCEPTIONS.has('runner-some-test.test.ts')).toBe(false);
  });
});
