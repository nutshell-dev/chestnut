/**
 * Phase 1817: prepareWrite / GuardedWrite — write 分类与实际 I/O 绑定同一
 * canonical target（drift-backlog PERMISSIONS-CHECK-IO-SYMLINK-TOCTOU）。
 *
 * 治理前：checker.resolveAndCheck 通过后 caller 拿裸 path 另行 I/O，symlink 可在
 * 两步间从 writable 目标改指 claw root 内 system-readonly 目标，FileSystem
 * containment 仍放行。治理后：分类作用于 canonical target，capability 绑定同一
 * target，判定后 symlink 改指不影响 I/O 落点。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import type { ClawPermissionFs } from '../../../src/core/permissions/claw-permissions.js';
import { makeMockAudit } from '../../helpers/audit.js';
import {
  PathNotInClawSpaceError,
  WriteOperationForbiddenError,
} from '../../../src/core/permissions/errors.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';

describe('claw-permissions prepareWrite canonical binding (phase 1817)', () => {
  let root: string;
  let clawDir: string;
  let outsideDir: string;

  beforeAll(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    root = fs.mkdtempSync(path.join(tmpdir(), 'claw-perm-guarded-write-'));
    clawDir = path.join(root, 'claw-a');
    outsideDir = path.join(root, 'outside');
    fs.mkdirSync(path.join(clawDir, 'memory'), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'system: readonly\n');
    fs.writeFileSync(path.join(clawDir, 'memory', 'real.md'), 'real\n');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'hidden\n');
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const makeChecker = () =>
    createClawPermissionChecker({
      audit: makeMockAudit(),
      clawDir,
      fs: new NodeFileSystem({ baseDir: clawDir }),
    });

  it('classifies the canonical target: symlink to system-readonly file is denied', async () => {
    const link = path.join(clawDir, 'memory', 'evil-link.md');
    fs.symlinkSync(path.join(clawDir, 'config.yaml'), link);
    try {
      const checker = makeChecker();
      // 词法路径 memory/evil-link.md 在 writable allowlist 内——旧路径放行；
      // canonical target 是 config.yaml → system_readonly deny
      await expect(checker.prepareWrite('memory/evil-link.md')).rejects.toThrow(
        WriteOperationForbiddenError,
      );
    } finally {
      fs.unlinkSync(link);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'TOCTOU: symlink retargeted after prepareWrite does not redirect the write',
    async () => {
      const link = path.join(clawDir, 'memory', 'link.md');
      const realTarget = path.join(clawDir, 'memory', 'real.md');
      const systemTarget = path.join(clawDir, 'config.yaml');
      fs.symlinkSync(realTarget, link);
      try {
        const checker = makeChecker();
        const op = await checker.prepareWrite('memory/link.md');
        // 判定时 canonical target = memory/real.md（writable）
        expect(op.target).toBe(await fs.promises.realpath(realTarget));

        // 攻击窗口：checker 通过后 symlink 改指 system-readonly 目标
        fs.unlinkSync(link);
        fs.symlinkSync(systemTarget, link);

        await op.write('pwned');

        // I/O 落在已验证目标；system-readonly 文件未被触碰
        expect(fs.readFileSync(realTarget, 'utf8')).toBe('pwned');
        expect(fs.readFileSync(systemTarget, 'utf8')).toBe('system: readonly\n');
        // 写穿透作用于 canonical target，symlink 本身不被 rename 覆盖
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      } finally {
        fs.unlinkSync(link);
        fs.writeFileSync(realTarget, 'real\n');
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'append binds the same canonical target after retarget',
    async () => {
      const link = path.join(clawDir, 'memory', 'append-link.md');
      const realTarget = path.join(clawDir, 'memory', 'real.md');
      fs.symlinkSync(realTarget, link);
      try {
        const checker = makeChecker();
        const op = await checker.prepareWrite('memory/append-link.md');
        fs.unlinkSync(link);
        fs.symlinkSync(path.join(clawDir, 'config.yaml'), link);

        await op.append('+more');

        expect(fs.readFileSync(realTarget, 'utf8')).toBe('real\n+more');
        expect(fs.readFileSync(path.join(clawDir, 'config.yaml'), 'utf8')).toBe('system: readonly\n');
      } finally {
        fs.unlinkSync(link);
        fs.writeFileSync(realTarget, 'real\n');
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects symlink escaping claw root',
    async () => {
      const link = path.join(clawDir, 'memory', 'escape.md');
      fs.symlinkSync(path.join(outsideDir, 'secret.txt'), link);
      try {
        const checker = makeChecker();
        await expect(checker.prepareWrite('memory/escape.md')).rejects.toThrow(
          PathNotInClawSpaceError,
        );
      } finally {
        fs.unlinkSync(link);
      }
    },
  );

  it('creates a new file at the canonical target (non-existent path)', async () => {
    const checker = makeChecker();
    const op = await checker.prepareWrite('memory/new-file.md');
    await op.write('fresh');
    expect(fs.readFileSync(path.join(clawDir, 'memory', 'new-file.md'), 'utf8')).toBe('fresh');
  });

  it('deny-by-default still applies on canonical target outside writable allowlist', async () => {
    const checker = makeChecker();
    await expect(checker.prepareWrite('docker-compose.yml')).rejects.toThrow(
      WriteOperationForbiddenError,
    );
  });

  it('non-strict mode audits bypass and binds the lexical target', async () => {
    const audit = makeMockAudit();
    const checker = createClawPermissionChecker({
      clawDir,
      strict: false,
      audit,
      fs: new NodeFileSystem({ baseDir: clawDir }),
    });
    const op = await checker.prepareWrite('memory/non-strict.md');
    await op.write('bypassed');
    expect(fs.readFileSync(path.join(clawDir, 'memory', 'non-strict.md'), 'utf8')).toBe('bypassed');
    expect(audit.write).toHaveBeenCalledWith(
      expect.stringContaining('strict'),
      'reason=non_strict_mode_bypass',
    );
  });

  it('constructor rejects fs lacking GuardedWrite write methods (capability widened)', () => {
    // phase 1818 将 fs 提为构造期必需；phase 1817 prepareWrite 消费 realpath/
    // writeAtomic/append——只带 resolve 的残缺 fs（含 as any 绕过）同样构造期抛错。
    expect(() =>
      createClawPermissionChecker({
        audit: makeMockAudit(),
        clawDir,
        fs: { resolve: (p: string) => p } as unknown as ClawPermissionFs,
      }),
    ).toThrow(/writeAtomic/);
  });
});
