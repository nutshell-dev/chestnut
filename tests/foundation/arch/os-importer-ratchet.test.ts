import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 498: ratchet test for node:os direct importers.
 *
 * Expected: tmpdir用法仅 foundation/audit/{writer,reader}.ts (fallback dump path).
 * 其他 src 不直 import node:os。
 */
describe('os importer ratchet (phase 498)', () => {
  it('node:os direct importer count is exactly 2 (foundation/audit/writer + reader)', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const cmd = `grep -rEln "from ['\\\"](?:node:)?os['\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);
    expect(files.length).toBe(2);
    expect(files.some(f => f.endsWith('foundation/audit/writer.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('foundation/audit/reader.ts'))).toBe(true);
  });
});
