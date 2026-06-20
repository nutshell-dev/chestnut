import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 496: ratchet test for node:child_process direct importers.
 *
 * Expected: only foundation/process-exec/* files (the L1 owner).
 * Dual protection with phase 490 child-process-only-from-foundation-process-exec rule.
 */
describe('child_process importer ratchet (phase 496)', () => {
  it('node:child_process direct importers all under foundation/process-exec/', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const cmd = `grep -rEln "from ['\\\"](?:node:)?child_process['\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f).toMatch(/foundation\/process-exec\//);
    }
  });
});
