/**
 * Snapshot tests — init, commit, error recovery
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { Snapshot } from '../../src/foundation/snapshot/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { AUDIT_EVENTS } from '../../src/foundation/audit/events.js';
import { makeAudit } from '../helpers/audit.js';

// git 必须可用才能跑这些测试
let gitAvailable = false;
try { execSync('which git', { stdio: 'ignore' }); gitAvailable = true; } catch { /* git not found */ }

describe.skipIf(!gitAvailable)('Snapshot', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snap-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // ========================================================================
  // init()
  // ========================================================================

  it('init creates .git with .gitignore and initial commit', async () => {
    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), makeAudit().audit).init();

    // .git 目录存在
    expect(fsSync.existsSync(path.join(tmpDir, '.git'))).toBe(true);

    // .gitignore 内容正确
    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('stream.jsonl');
    expect(gitignore).toContain('audit.tsv');
    expect(gitignore).toContain('logs/');

    // 有初始 commit
    const log = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(log).toContain('init');
  });

  it('init is idempotent — second call is no-op', async () => {
    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), makeAudit().audit).init();
    // 手动写一个文件作为标记
    await fsp.writeFile(path.join(tmpDir, 'marker.txt'), 'test');

    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), makeAudit().audit).init();

    // marker.txt 应该还在（没有被 init 覆盖或重建）
    const content = await fsp.readFile(path.join(tmpDir, 'marker.txt'), 'utf-8');
    expect(content).toBe('test');
  });

  it('init cleans up .git on failure', async () => {
    // 让 git config 失败（在 init 成功后破坏 git config 能力）
    const { exec: processExec } = await import('../../src/foundation/process-exec/index.js');
    const execSpy = vi.spyOn(await import('../../src/foundation/process-exec/index.js'), 'exec');
    let initCalled = false;
    execSpy.mockImplementation(async (cmd: string, opts: any) => {
      // git init 正常执行
      if (cmd.includes('git') && cmd.includes('init') && !initCalled) {
        initCalled = true;
        return processExec(cmd, opts);
      }
      // git config 抛异常
      if (cmd.includes('config')) {
        throw new Error('mock config failure');
      }
      // 其他 git 命令正常
      return processExec(cmd, opts);
    });

    const audit = { write: vi.fn() };

    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), audit).init();

    // .git 应被清理
    expect(fsSync.existsSync(path.join(tmpDir, '.git'))).toBe(false);
    expect(audit.write).toHaveBeenCalledWith(
      AUDIT_EVENTS.SNAPSHOT_INIT_FAILED,
      expect.stringContaining('reason='),
    );
  });

  it('init writes snapshot_init_failed audit event on failure', async () => {
    const { exec: processExec } = await import('../../src/foundation/process-exec/index.js');
    const execSpy = vi.spyOn(await import('../../src/foundation/process-exec/index.js'), 'exec');
    let initCalled = false;
    execSpy.mockImplementation(async (cmd: string, opts: any) => {
      if (cmd.includes('git') && cmd.includes('init') && !initCalled) {
        initCalled = true;
        return processExec(cmd, opts);
      }
      if (cmd.includes('config')) {
        throw new Error('mock config failure');
      }
      return processExec(cmd, opts);
    });

    vi.spyOn(console, 'error').mockImplementation(() => {});

    const audit = { write: vi.fn() };
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), audit);
    await snapshot.init();

    expect(audit.write).toHaveBeenCalledWith(
      AUDIT_EVENTS.SNAPSHOT_INIT_FAILED,
      expect.stringContaining('reason='),
    );
  });

  // ========================================================================
  // commit()
  // ========================================================================

  it('commit is no-op when no changes', async () => {
    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), makeAudit().audit).init();

    const logBefore = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim();

    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), makeAudit().audit).commit('should-not-appear');

    const logAfter = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(logAfter).toBe(logBefore);
  });

  it('commit creates snapshot when there are changes', async () => {
    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), makeAudit().audit).init();

    // 创建一个文件
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), makeAudit().audit).commit('add data');

    const log = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(log).toContain('add data');
  });





  it('consecutive failures are isolated per instance', async () => {
    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), makeAudit().audit).init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    const audit1 = { write: vi.fn() };
    const audit2 = { write: vi.fn() };
    const snapshot1 = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), audit1);
    const snapshot2 = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), audit2);

    await snapshot1.commit('fail-1');
    await snapshot1.commit('fail-2');

    // snapshot2 的失败次数应独立
    await snapshot2.commit('fail-1');

    // snapshot1 再来一次才达到 3 次
    await snapshot1.commit('fail-3');

    expect(audit1.write).toHaveBeenCalledWith(
      AUDIT_EVENTS.SNAPSHOT_DEGRADED,
      'consecutive=3',
      expect.stringContaining('reason='),
    );
    // audit2 不应有 degraded（只失败 1 次）
    const degradedCalls2 = audit2.write.mock.calls.filter(
      (c: any[]) => c[0] === AUDIT_EVENTS.SNAPSHOT_DEGRADED
    );
    expect(degradedCalls2).toHaveLength(0);
  });

  it('commit writes snapshot_commit_failed on every failure including <3', async () => {
    const audit = { write: vi.fn() };
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), audit);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    // 破坏 git
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    await snapshot.commit('fail-1');
    expect(audit.write).toHaveBeenCalledWith(
      AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED,
      'consecutive=1',
      expect.stringContaining('reason='),
    );

    await snapshot.commit('fail-2');
    expect(audit.write).toHaveBeenLastCalledWith(
      AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED,
      'consecutive=2',
      expect.stringContaining('reason='),
    );
  });

  it('commit continues writing snapshot_commit_failed on 4th+ failure', async () => {
    const audit = { write: vi.fn() };
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), audit);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    await snapshot.commit('fail-1');
    await snapshot.commit('fail-2');
    await snapshot.commit('fail-3'); // degraded + commit_failed
    await snapshot.commit('fail-4');
    await snapshot.commit('fail-5');

    const commitFailedCalls = (audit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any[]) => c[0] === AUDIT_EVENTS.SNAPSHOT_COMMIT_FAILED
    );
    expect(commitFailedCalls).toHaveLength(5);

    const degradedCalls = (audit.write as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any[]) => c[0] === AUDIT_EVENTS.SNAPSHOT_DEGRADED
    );
    expect(degradedCalls).toHaveLength(1); // 仅在第 3 次
  });

  // ========================================================================
  // shell 转义
  // ========================================================================

  it('commit message with special characters works correctly', async () => {
    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), makeAudit().audit).init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    // 消息含空格和引号
    const message = "fix: user's \"data\" file";
    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), makeAudit().audit).commit(message);

    const log = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(log).toContain("fix:");
  });

  it('commit writes snapshot_committed on success', async () => {
    const audit = { write: vi.fn() };
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false }), audit);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await snapshot.commit('add data');
    expect(audit.write).toHaveBeenCalledWith(
      AUDIT_EVENTS.SNAPSHOT_COMMITTED,
      'message=add data',
    );
  });

  it('init writes snapshot_init_cleanup_failed when removeDir fails', async () => {
    const { exec: processExec } = await import('../../src/foundation/process-exec/index.js');
    const execSpy = vi.spyOn(await import('../../src/foundation/process-exec/index.js'), 'exec');
    let initCalled = false;
    execSpy.mockImplementation(async (cmd: string, opts: any) => {
      if (cmd.includes('git') && cmd.includes('init') && !initCalled) {
        initCalled = true;
        return processExec(cmd, opts);
      }
      if (cmd.includes('config')) {
        throw new Error('mock config failure');
      }
      return processExec(cmd, opts);
    });

    // Mock fs.removeDir to throw
    const fsMock = new NodeFileSystem({ baseDir: tmpDir, enforcePermissions: false });
    const originalRemoveDir = fsMock.removeDir.bind(fsMock);
    fsMock.removeDir = vi.fn(async (p: string) => {
      if (p === '.git') throw new Error('cleanup blocked');
      return originalRemoveDir(p);
    });

    const audit = { write: vi.fn() };
    await new Snapshot(tmpDir, fsMock, audit).init();

    expect(audit.write).toHaveBeenCalledWith(
      AUDIT_EVENTS.SNAPSHOT_INIT_CLEANUP_FAILED,
      expect.stringContaining('dir='),
      expect.stringContaining('reason=cleanup blocked'),
    );
  });
});
