import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 497: ratchet test for node:net direct importers.
 *
 * Expected: only foundation/transport/* files (the owner).
 *
 * phase 571 tighten: 从 length > 0 + per-file match 改为精确 count 1 + 精确路径断言、
 * 与 fs/crypto/os importer ratchet 形态一致、新 importer file 添加即 fail-loud。
 */
describe('net importer ratchet (phase 497 / phase 571 tightened)', () => {
  it('node:net direct importer count is exactly 1 (foundation/transport/unix-socket)', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const cmd = `grep -rEln "from ['\\\"](?:node:)?net['\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/foundation\/transport\/unix-socket\.ts$/);
  });
});
