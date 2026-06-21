import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 496: ratchet test for node:child_process direct importers.
 *
 * Expected: only foundation/process-exec/* files (the L1 owner).
 * Dual protection with phase 490 child-process-only-from-foundation-process-exec rule.
 *
 * phase 571 tighten: 从 length > 0 + per-file match 改为精确 count 5 + 5 file 精确路径断言、
 * 与 fs/crypto/os importer ratchet 形态一致、新 importer file 添加即 fail-loud。
 */
describe('child_process importer ratchet (phase 496 / phase 571 tightened)', () => {
  const expected = [
    'foundation/process-exec/process-starttime.ts',
    'foundation/process-exec/argv-verify.ts',
    'foundation/process-exec/exec.ts',
    'foundation/process-exec/spawn-detached.ts',
    'foundation/process-exec/find-by-pattern.ts',
  ];

  it('node:child_process direct importer count is exactly 5 (foundation/process-exec/*)', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const cmd = `grep -rEln "from ['\\\"](?:node:)?child_process['\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);
    expect(files.length).toBe(5);
    for (const expected_file of expected) {
      expect(files.some(f => f.endsWith(expected_file))).toBe(true);
    }
  });
});
