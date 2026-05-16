/**
 * Snapshot tests — init, commit, error recovery
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsp from 'fs/promises';
import * as fsSync from 'fs';
import { execSync } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { Snapshot, SNAPSHOT_IGNORE_PATTERNS } from '../../src/foundation/snapshot/index.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { SNAPSHOT_AUDIT_EVENTS } from '../../src/foundation/snapshot/audit-events.js';

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
    const result = await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, ['stream.jsonl', 'audit.tsv', 'tasks/queues/results/']).init();
    expect(result.ok).toBe(true);

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
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, []);
    await snapshot.init();
    // 手动写一个文件作为标记
    await fsp.writeFile(path.join(tmpDir, 'marker.txt'), 'test');

    const result = await snapshot.init();
    expect(result.ok).toBe(true);

    // marker.txt 应该还在（没有被 init 覆盖或重建）
    const content = await fsp.readFile(path.join(tmpDir, 'marker.txt'), 'utf-8');
    expect(content).toBe('test');
  });

  it('init returns Result.err on expected failure and cleans up .git', async () => {
    const { exec: processExec } = await import('../../src/foundation/process-exec/index.js');
    const execSpy = vi.spyOn(await import('../../src/foundation/process-exec/index.js'), 'exec');
    let initCalled = false;
    execSpy.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      const fullCmd = `${cmd} ${args.join(' ')}`;
      // git init 正常执行
      if (fullCmd.includes('git') && fullCmd.includes('init') && !initCalled) {
        initCalled = true;
        return processExec(cmd, args, opts);
      }
      // git config 抛异常（模拟预期失败）
      if (fullCmd.includes('config')) {
        const err = new Error('mock config failure') as any;
        err.exitCode = 1;
        err.stderr = '';
        throw err;
      }
      // 其他 git 命令正常
      return processExec(cmd, args, opts);
    });

    const audit = { write: vi.fn() };
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), audit, []);
    const result = await snapshot.init();

    expect(result.ok).toBe(false);
    // .git 应被清理
    expect(fsSync.existsSync(path.join(tmpDir, '.git'))).toBe(false);
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.INIT_FAILED,
      expect.stringContaining('dir='),
      expect.stringContaining('kind='),
    );
  });

  it('init throws on unexpected failure (ENOENT)', async () => {
    const execSpy = vi.spyOn(await import('../../src/foundation/process-exec/index.js'), 'exec');
    execSpy.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      const err = new Error('ENOENT: git not found') as any;
      err.code = 'ENOENT';
      throw err;
    });

    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, []);
    await expect(snapshot.init()).rejects.toThrow();
  });

  it('init returns Result.err even when cleanup itself fails (best-effort cleanup)', async () => {
    const { exec: processExec } = await import('../../src/foundation/process-exec/index.js');
    const execSpy = vi.spyOn(await import('../../src/foundation/process-exec/index.js'), 'exec');
    let initCalled = false;
    execSpy.mockImplementation(async (cmd: string, args: string[], opts: any) => {
      const fullCmd = `${cmd} ${args.join(' ')}`;
      if (fullCmd.includes('git') && fullCmd.includes('init') && !initCalled) {
        initCalled = true;
        return processExec(cmd, args, opts);
      }
      if (fullCmd.includes('config')) {
        const err = new Error('mock config failure') as any;
        err.exitCode = 1;
        err.stderr = '';
        throw err;
      }
      return processExec(cmd, args, opts);
    });

    // 注入一个 fs 实现 / removeDir 抛
    const baseFs = new NodeFileSystem({ baseDir: tmpDir });
    const fs = Object.create(baseFs);
    fs.removeDir = vi.fn().mockRejectedValue(new Error('mock cleanup failure'));

    const audit = { write: vi.fn() };
    const snapshot = new Snapshot(tmpDir, fs, audit, []);

    // 关键：init 不抛 / 仍返 Result.err
    const result = await snapshot.init();
    expect(result.ok).toBe(false);

    // audit 含 cleanup failure + init failed
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.INIT_CLEANUP_FAILED,
      expect.stringContaining('dir='),
      expect.stringContaining('reason=mock cleanup failure'),
    );
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.INIT_FAILED,
      expect.stringContaining('dir='),
      expect.stringContaining('kind='),
    );
  });

  // ========================================================================
  // .gitignore content (ignorePatterns behavior)
  // ========================================================================

  it('init writes .gitignore with only DEFAULT_IGNORES when ignorePatterns is empty', async () => {
    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, []).init();

    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toBe('logs/\n*.tmp\n');
  });

  it('init preserves duplicate patterns (Snapshot does not dedup)', async () => {
    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, ['x', 'x', 'y']).init();

    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toBe('x\nx\ny\nlogs/\n*.tmp\n');
  });

  it('init writes injected patterns before DEFAULT_IGNORES', async () => {
    await new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, ['injected1', 'injected2']).init();

    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toBe('injected1\ninjected2\nlogs/\n*.tmp\n');
  });

  it('init writes tasks/subagents/ into .gitignore (phase 512)', async () => {
    const s = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, SNAPSHOT_IGNORE_PATTERNS);
    await s.init();

    const gitignore = await fsp.readFile(path.join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('tasks/subagents/');
  });

  // ========================================================================
  // commit()
  // ========================================================================

  it('commit is no-op when no changes', async () => {
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, []);
    await snapshot.init();

    const logBefore = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim();

    const result = await snapshot.commit('should-not-appear');
    expect(result.ok).toBe(true);

    const logAfter = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(logAfter).toBe(logBefore);
  });

  it('commit creates snapshot when there are changes', async () => {
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, []);
    await snapshot.init();

    // 创建一个文件
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    const result = await snapshot.commit('add data');
    expect(result.ok).toBe(true);

    const log = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(log).toContain('add data');
  });

  it('commit returns Result.err on expected failure', async () => {
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, []);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    // 破坏 git 操作（删除 .git/HEAD 让 git status 失败）
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    const result = await snapshot.commit('will-fail');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 删除 HEAD 后 git 报告 "not a git repository"，属于预期失败
      expect(result.error.kind).toBe('not_a_repo');
    }
  });

  it('commit upgrades to error after 3 consecutive failures', async () => {
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, []);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    // 破坏 git
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    const result1 = await snapshot.commit('fail-1');
    const result2 = await snapshot.commit('fail-2');
    const result3 = await snapshot.commit('fail-3');

    expect(result1.ok).toBe(false);
    expect(result2.ok).toBe(false);
    expect(result3.ok).toBe(false);
  });

  it('consecutive failures are isolated per instance', async () => {
    const snapshot1 = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, []);
    const snapshot2 = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, []);
    await snapshot1.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    await snapshot1.commit('fail-1');
    await snapshot1.commit('fail-2');

    // snapshot2 的失败次数应独立
    await snapshot2.commit('fail-1');

    // snapshot1 再来一次才达到 3 次
    await snapshot1.commit('fail-3');
  });

  it('commit writes snapshot_degraded audit at exactly 3 consecutive failures', async () => {
    const audit = { write: vi.fn() };
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), audit, []);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    // 破坏 git
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    await snapshot.commit('fail-1');
    await snapshot.commit('fail-2');
    expect(audit.write).not.toHaveBeenCalledWith(SNAPSHOT_AUDIT_EVENTS.DEGRADED, expect.anything(), expect.anything());

    await snapshot.commit('fail-3');
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.DEGRADED,
      expect.stringContaining('dir='),
      expect.stringContaining('consecutive=3'),
    );
  });

  it('commit does not write snapshot_degraded on 4th+ failure', async () => {
    const audit = { write: vi.fn() };
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), audit, []);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    await snapshot.commit('fail-1');
    await snapshot.commit('fail-2');
    await snapshot.commit('fail-3'); // 写一次 degraded
    await snapshot.commit('fail-4');
    await snapshot.commit('fail-5');

    const degradedCalls = audit.write.mock.calls.filter((c: any[]) => c[0] === SNAPSHOT_AUDIT_EVENTS.DEGRADED);
    expect(degradedCalls).toHaveLength(1);
  });

  // ========================================================================
  // shell 转义
  // ========================================================================

  it('commit message with special characters works correctly', async () => {
    const snapshot = new Snapshot(tmpDir, new NodeFileSystem({ baseDir: tmpDir }), { write: () => {} }, []);
    await snapshot.init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    // 消息含空格和引号
    const message = "fix: user's \"data\" file";
    const result = await snapshot.commit(message);
    expect(result.ok).toBe(true);

    const log = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(log).toContain("fix:");
  });

  // =======================================================================
  // syncCleanupDirs whitelist (phase772)
  // =======================================================================

  it('commit cleans only whitelisted sync scratch dirs, leaving lifecycle dirs intact', async () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = { write: vi.fn() };
    const scratchDir = path.join(tmpDir, 'tasks', 'sync', 'exec');
    const lifecycleDir = path.join(tmpDir, 'tasks', 'sync', 'shadow');
    await fs.ensureDir(scratchDir);
    await fs.ensureDir(lifecycleDir);

    const snapshot = new Snapshot(tmpDir, fs, audit, [], [scratchDir]);
    await snapshot.init();

    // pre-populate both dirs
    await fsp.writeFile(path.join(scratchDir, 'scratch.md'), 'scratch');
    await fsp.writeFile(path.join(lifecycleDir, 'lifecycle.md'), 'lifecycle');

    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    const result = await snapshot.commit('test-whitelist');
    expect(result.ok).toBe(true);

    // scratch dir 被清空重建
    const scratchFiles = await fsp.readdir(scratchDir).catch(() => [] as string[]);
    expect(scratchFiles).toHaveLength(0);

    // lifecycle dir 保留
    const lifecycleFiles = await fsp.readdir(lifecycleDir);
    expect(lifecycleFiles).toContain('lifecycle.md');
  });

  it('commit cleans multiple whitelisted dirs independently', async () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const execDir = path.join(tmpDir, 'tasks', 'sync', 'exec');
    const writeDir = path.join(tmpDir, 'tasks', 'sync', 'write');
    const spawnDir = path.join(tmpDir, 'tasks', 'sync', 'spawn');
    await fs.ensureDir(execDir);
    await fs.ensureDir(writeDir);
    await fs.ensureDir(spawnDir);

    const snapshot = new Snapshot(tmpDir, fs, { write: () => {} }, [], [execDir, writeDir]);
    await snapshot.init();

    await fsp.writeFile(path.join(execDir, 'a.md'), 'a');
    await fsp.writeFile(path.join(writeDir, 'b.md'), 'b');
    await fsp.writeFile(path.join(spawnDir, 'c.md'), 'c');

    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    const result = await snapshot.commit('test-multi-whitelist');
    expect(result.ok).toBe(true);

    expect(await fsp.readdir(execDir)).toHaveLength(0);
    expect(await fsp.readdir(writeDir)).toHaveLength(0);
    expect(await fsp.readdir(spawnDir)).toContain('c.md');
  });

  // ========================================================================
  // commit() cleanup empty relDir guard (phase 831 audit.P2.snap-2)
  // ========================================================================

  it('commit skips cleanup + emits audit when caller mis-configures syncCleanupDirs with agent dir itself', async () => {
    const fs = new NodeFileSystem({ baseDir: tmpDir });
    const audit = { write: vi.fn() };
    // mis-config: syncCleanupDirs contains agent dir itself → relDir === ''
    const snapshot = new Snapshot(tmpDir, fs, audit, [], [tmpDir]);
    await snapshot.init();

    // marker file to verify dir is not deleted
    await fsp.writeFile(path.join(tmpDir, 'marker.txt'), 'do-not-delete');

    // trigger commit
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'change');
    const result = await snapshot.commit('test-misconfig');
    expect(result.ok).toBe(true);

    // marker should still exist (guard triggered, cleanup skipped)
    expect(fsSync.existsSync(path.join(tmpDir, 'marker.txt'))).toBe(true);

    // audit should contain empty_or_escaping_relDir context
    expect(audit.write).toHaveBeenCalledWith(
      SNAPSHOT_AUDIT_EVENTS.SYNC_CLEAN_FAILED,
      expect.stringContaining('dir='),
      expect.stringContaining('empty_or_escaping_relDir'),
      expect.stringContaining('cleanupDir='),
    );
  });
});
