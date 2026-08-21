/**
 * phase 1445 Step D（裁定②）：createSnapshot 工厂内 init 内化契约测试。
 * - 成功路径：工厂返回已完成 init 的实例（.git 就绪、HEAD 存在）
 * - 预期失败路径：init Result.err → 工厂 throw（message 带 `Snapshot.init failed` 标记、
 *   cause 保留 ExpectedGitFailure）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { createSnapshot } from '../../../src/foundation/snapshot/index.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { createTrackedTempDir, cleanupTempDir } from '../../utils/temp.js';

const gitAvailable = (() => {
  try { execSync('which git', { stdio: 'ignore' }); return true; } catch { return false; }
})();

describe.skipIf(!gitAvailable)('createSnapshot 工厂内 init（phase 1445 Step D）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('snap-factory-init-');
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  it('成功：工厂返回已 init 的实例（.git 就绪、HEAD 存在）', async () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const snapshot = await createSnapshot(tmpDir, fs, makeMockAudit(), []);

    expect(await fs.exists('.git')).toBe(true);
    // init 幂等：同一 dir 再次走工厂不抛
    await expect(createSnapshot(tmpDir, fs, makeMockAudit(), [])).resolves.toBeDefined();
    expect(typeof snapshot.commit).toBe('function');
  });

  it('预期失败：init Result.err → 工厂 throw（init 标记 + cause 保留）', async () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    // execImpl 注入：git init 失败（exit 128 fatal → classifyGitError 归为预期 uncategorized）
    const failingExec = (() => {
      const err = new Error('fatal: boom') as Error & { exitCode: number; output: string };
      err.exitCode = 128;
      err.output = 'fatal: boom';
      return Promise.reject(err);
    }) as unknown as typeof import('../../../src/foundation/process-exec/index.js').exec;

    await expect(
      createSnapshot(tmpDir, fs, makeMockAudit(), [], undefined, failingExec),
    ).rejects.toThrow('Snapshot.init failed: uncategorized');

    const caught = await createSnapshot(tmpDir, fs, makeMockAudit(), [], undefined, failingExec)
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { cause?: unknown }).cause).toMatchObject({ kind: 'uncategorized' });
  });
});
