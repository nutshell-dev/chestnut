import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 497: ratchet test for node:net direct importers.
 *
 * Expected: only foundation/transport/* files (the owner).
 */
describe('net importer ratchet (phase 497)', () => {
  it('node:net direct importers all under foundation/transport/', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const cmd = `grep -rEln "from ['\\\"](?:node:)?net['\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f).toMatch(/foundation\/transport\//);
    }
  });
});
