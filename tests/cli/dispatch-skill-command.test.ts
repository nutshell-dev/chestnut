/**
 * Phase 1929 Step B：dispatch-skill 命令族真实 CLI 契约测试。
 *
 * - `dispatch-skill --help` / `dispatch-skill edit --help`：新命令族可解析，
 *   catalog 投影的 help 覆盖 begin/submit/basis/retry/status/history；
 * - 旧 `skill edit` / `skill history` 入口：明确非零迁移错误、指向新命令族，
 *   绝不调用 owner（版本服务状态目录零落盘）；`skill --help` 不再宣传旧接口；
 * - 反向：迁移错误不创建任何编辑事务/版本状态；旧 saved editId 的事务文件
 *   在新命令族下仍可继续（行为等价由 skill-edit.test.ts handler 级覆盖）。
 *
 * 真实链：spawn `node dist/cli.js`（CHESTNUT_ROOT 指向临时工作区），
 * 命令解析与迁移门控在真实 Commander 上验收。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fsSync from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';

const CLI_ENTRY = path.resolve(process.cwd(), 'dist/cli.js');

describe('dispatch-skill 命令族 CLI（phase 1929 Step B）', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTrackedTempDir('dispatch-skill-cli-');
    expect(fsSync.existsSync(CLI_ENTRY)).toBe(true);
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  const runCli = (args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number | null }> =>
    new Promise((resolve, reject) => {
      const child = spawn('node', [CLI_ENTRY, ...args], {
        env: {
          ...process.env,
          CHESTNUT_ROOT: tmpDir,
          NODE_ENV: 'test',
          GIT_CONFIG_NOSYSTEM: '1',
        },
        cwd: tmpDir,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout, stderr, exitCode: code }));
    });

  it('dispatch-skill --help 列出 list/edit/history；edit 子族 help 列出全部事务命令', async () => {
    const help = await runCli(['dispatch-skill', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('dispatch skill pool');
    // Phase 1929 Step C：已发布池列表入口
    expect(help.stdout).toContain('list');
    expect(help.stdout).toContain('edit');
    expect(help.stdout).toContain('history');

    const editHelp = await runCli(['dispatch-skill', 'edit', '--help']);
    expect(editHelp.exitCode).toBe(0);
    for (const sub of ['begin', 'submit', 'basis', 'retry', 'status']) {
      expect(editHelp.stdout).toContain(sub);
    }
  });

  it('旧 skill edit/history 入口：非零迁移错误指向新命令族，owner 零调用（无版本状态落盘）', async () => {
    const edit = await runCli(['skill', 'edit', 'begin', 'alpha', '--reason', 'x']);
    expect(edit.exitCode).not.toBe(0);
    expect(edit.stderr).toContain('dispatch-skill edit');

    const history = await runCli(['skill', 'history', 'alpha']);
    expect(history.exitCode).not.toBe(0);
    expect(history.stderr).toContain('dispatch-skill history');

    // 迁移错误发生在 CLI 呈现层：绝不触碰 dispatch 版本服务（无状态目录落盘）
    expect(fsSync.existsSync(
      path.join(tmpDir, '.chestnut', 'motion', 'clawspace', '.dispatch-version-state'),
    )).toBe(false);
    expect(fsSync.existsSync(
      path.join(tmpDir, '.chestnut', 'motion', 'clawspace', 'dispatch-skills'),
    )).toBe(false);
  });

  it('skill --help 不再宣传旧 edit/history 接口；install/list 仍在', async () => {
    const help = await runCli(['skill', '--help']);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('install');
    expect(help.stdout).toContain('list');
    expect(help.stdout).not.toContain('edit');
    expect(help.stdout).not.toContain('history');
  });

  it('dispatch-skill list 空池：observe_only 可读，已发布空态如实呈现', async () => {
    const list = await runCli(['dispatch-skill', 'list']);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).toContain('Dispatch skill pool (published):');
    expect(list.stdout).toContain('No skills loaded.');
  });

  it('dispatch-skill history 空池：observe_only 可读，空态如实呈现', async () => {
    const history = await runCli(['dispatch-skill', 'history', 'alpha']);
    expect(history.exitCode).toBe(0);
    expect(history.stdout).toContain('No history for dispatch skill "alpha".');
  });

  it('dispatch-skill 未知子命令：非零 + 可用命令列表', async () => {
    const res = await runCli(['dispatch-skill', 'frobnicate']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain("unknown command 'frobnicate'");
  });
});
