import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 495: ratchet test for node:fs / fs/promises direct importers.
 *
 * Allowlist (per fs-only-via-foundation-filesystem rule, phase 1298 + 1214):
 *   - foundation/fs/atomic.ts
 *   - foundation/fs/node-fs.ts (the L1 owner)
 *   - foundation/audit/writer.ts (dumpFallback boundary, phase 1214 ratify)
 *   - foundation/audit/reader.ts (tail/follow direct fs read)
 *   - foundation/process-exec/spawn-detached.ts (fd-level openSync, phase ratify)
 *
 * Total 5 files. Other src must go through fsFactory inject.
 */
describe('fs importer ratchet (phase 495)', () => {
  const expected = [
    'foundation/audit/writer.ts',
    'foundation/audit/reader.ts',
    'foundation/fs/atomic.ts',
    'foundation/process-exec/spawn-detached.ts',
    'foundation/fs/node-fs.ts',
  ];

  it('node:fs direct importer count is exactly 5 (allowlisted boundary)', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const cmd = `grep -rEln "from ['\\\"](?:node:)?fs['\\\"]|from ['\\\"](?:node:)?fs/promises['\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);
    expect(files.length).toBe(5);
    for (const expected_file of expected) {
      expect(files.some(f => f.endsWith(expected_file))).toBe(true);
    }
  });
});
