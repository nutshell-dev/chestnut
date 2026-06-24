import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

/**
 * phase 492: ratchet test 防 node:crypto importer 散用。
 *
 * 期望状态：src/ 内仅 foundation/node-utils/crypto.ts + foundation/node-utils/id.ts 直 import node:crypto。
 * phase 712 合并 hash/uuid 入 L1.NodeUtils。
 *
 * 此 ratchet test 与 lint rule 双重保护 — 若有人删 lint rule、ratchet test 仍 fail-loud。
 */
describe('crypto importer ratchet (phase 492)', () => {
  it('node:crypto direct importer count is exactly 2 (node-utils/crypto + node-utils/id)', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const cmd = `grep -rEln "from ['\\\"](node:)?crypto['\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);

    expect(files.length).toBe(2);
    expect(files.some(f => f.endsWith('foundation/node-utils/id.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('foundation/node-utils/crypto.ts'))).toBe(true);
  });
});
