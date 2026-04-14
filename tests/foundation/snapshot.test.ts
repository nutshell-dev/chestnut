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
    await new Snapshot(tmpDir).init();

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
    await new Snapshot(tmpDir).init();
    // 手动写一个文件作为标记
    await fsp.writeFile(path.join(tmpDir, 'marker.txt'), 'test');

    await new Snapshot(tmpDir).init();

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

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await new Snapshot(tmpDir).init();

    // .git 应被清理
    expect(fsSync.existsSync(path.join(tmpDir, '.git'))).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('init failed, cleaning up'),
      expect.any(String),
    );
  });

  // ========================================================================
  // commit()
  // ========================================================================

  it('commit is no-op when no changes', async () => {
    await new Snapshot(tmpDir).init();

    const logBefore = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim();

    await new Snapshot(tmpDir).commit('should-not-appear');

    const logAfter = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(logAfter).toBe(logBefore);
  });

  it('commit creates snapshot when there are changes', async () => {
    await new Snapshot(tmpDir).init();

    // 创建一个文件
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    await new Snapshot(tmpDir).commit('add data');

    const log = execSync('git log --oneline', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(log).toContain('add data');
  });

  it('commit logs warning on failure', async () => {
    await new Snapshot(tmpDir).init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    // 破坏 git 操作（删除 .git/HEAD 让 git status 失败）
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await new Snapshot(tmpDir).commit('will-fail');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('commit failed'),
      expect.any(String),
    );
  });

  it('commit upgrades to error after 3 consecutive failures', async () => {
    await new Snapshot(tmpDir).init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    // 破坏 git
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    // 重置模块级计数器（通过连续调用 3 次）
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const snapshot = new Snapshot(tmpDir);
    await snapshot.commit('fail-1');
    await snapshot.commit('fail-2');
    await snapshot.commit('fail-3');

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('3 consecutive'),
      expect.any(String),
    );
  });

  it('consecutive failures are isolated per instance', async () => {
    await new Snapshot(tmpDir).init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');
    await fsp.rm(path.join(tmpDir, '.git', 'HEAD'));

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const snapshot1 = new Snapshot(tmpDir);
    const snapshot2 = new Snapshot(tmpDir);

    await snapshot1.commit('fail-1');
    await snapshot1.commit('fail-2');

    // snapshot2 的失败次数应独立
    await snapshot2.commit('fail-1');

    // snapshot1 再来一次才达到 3 次
    await snapshot1.commit('fail-3');

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  // ========================================================================
  // shell 转义
  // ========================================================================

  it('commit message with special characters works correctly', async () => {
    await new Snapshot(tmpDir).init();
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'hello');

    // 消息含空格和引号
    const message = "fix: user's \"data\" file";
    await new Snapshot(tmpDir).commit(message);

    const log = execSync('git log --oneline -1', { cwd: tmpDir, encoding: 'utf-8' }).trim();
    expect(log).toContain("fix:");
  });
});
