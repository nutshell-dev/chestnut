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
    const cmd = `grep -rEln "from ['\\\\\\\"](node:)?os['\\\\\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);
    expect(files.length).toBe(2);
    expect(files.some(f => f.endsWith('foundation/audit/writer.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('foundation/audit/reader.ts'))).toBe(true);
  });
});

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
    const cmd = `grep -rEln "from ['\\\\\\\"](node:)?net['\\\\\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/foundation\/transport\/unix-socket\.ts$/);
  });
});

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
    const cmd = `grep -rEln "from ['\\\\\\\"](node:)?child_process['\\\\\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);
    expect(files.length).toBe(5);
    for (const expected_file of expected) {
      expect(files.some(f => f.endsWith(expected_file))).toBe(true);
    }
  });
});

/**
 * phase 495: ratchet test for node:fs / fs/promises direct importers.
 *
 * Allowlist (per fs-only-via-foundation-filesystem rule, phase 1298 + 1214):
 *   - foundation/fs/atomic.ts
 *   - foundation/fs/node-fs.ts (the L1 owner)
 *   - foundation/fs/file-lock.ts (fd-level flock primitives, phase 1061)
 *   - foundation/audit/writer.ts (dumpFallback boundary, phase 1214 ratify)
 *   - foundation/audit/reader.ts (tail/follow direct fs read)
 *   - foundation/process-exec/spawn-detached.ts (fd-level openSync, phase ratify)
 *
 * Total 6 files. Other src must go through fsFactory inject.
 */
describe('fs importer ratchet (phase 495)', () => {
  const expected = [
    'foundation/audit/writer.ts',
    'foundation/audit/reader.ts',
    'foundation/fs/atomic.ts',
    'foundation/fs/file-lock.ts',
    'foundation/process-exec/spawn-detached.ts',
    'foundation/fs/node-fs.ts',
  ];

  it('node:fs direct importer count is exactly 6 (allowlisted boundary)', () => {
    const srcRoot = path.join(__dirname, '..', '..', '..', 'src');
    const cmd = `grep -rEln "from ['\\\\\\\"](node:)?fs['\\\\\\\"]|from ['\\\\\\\"](node:)?fs/promises['\\\\\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);
    expect(files.length).toBe(6);
    for (const expected_file of expected) {
      expect(files.some(f => f.endsWith(expected_file))).toBe(true);
    }
  });
});

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
    const cmd = `grep -rEln "from ['\\\\\\\"](node:)?crypto['\\\\\\\"]" ${srcRoot} --include='*.ts' || true`;
    const out = execSync(cmd, { encoding: 'utf8' });
    const files = out.trim().split('\n').filter(Boolean);

    expect(files.length).toBe(2);
    expect(files.some(f => f.endsWith('foundation/node-utils/id.ts'))).toBe(true);
    expect(files.some(f => f.endsWith('foundation/node-utils/crypto.ts'))).toBe(true);
  });
});
