/**
 * claw-read command tests — Phase 1913 Step B 新建。
 *
 * 覆盖：
 * - 基本读取（已发布文件正常输出）
 * - 读侧发布门控（RACE-PUBLISH-PRECOMMIT-VISIBILITY）：
 *   文件位于未提交 import 目标内 → typed not-published，不暴露半成品；
 *   claim 损坏 → invalid typed 结果；提交后（无 claim）正常读取
 * - unknown claw / path escape → CliError
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { readCommand } from '../../../src/cli/commands/claw-read.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CliError } from '../../../src/cli/errors.js';
import { makeClawCommandDeps } from '../../helpers/claw-command-deps.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('claw-read (Phase 1913 Step B)', () => {
  let tmpRoot: string;
  let clawspace: string;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpRoot = path.join(os.tmpdir(), `phase1913-read-${randomUUID()}`);
    const clawDir = path.join(tmpRoot, '.chestnut', 'claws', 'test-claw');
    clawspace = path.join(clawDir, 'clawspace');
    fs.mkdirSync(clawspace, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'name: test-claw\n');
    fs.writeFileSync(path.join(clawspace, 'a.md'), 'aaa');
    process.env.CHESTNUT_ROOT = tmpRoot;

    writes = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    delete process.env.CHESTNUT_ROOT;
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reads a published file', async () => {
    await readCommand(makeClawCommandDeps(fsFactory), 'test-claw', 'a.md');
    expect(writes.join('')).toContain('aaa');
  });

  it('unknown claw (loadClaw → undefined) throws CliError', async () => {
    const deps = makeClawCommandDeps(fsFactory, { loadClaw: () => undefined });
    await expect(readCommand(deps, 'no-such-claw', 'a.md')).rejects.toBeInstanceOf(CliError);
  });

  it('path escape (..) throws CliError', async () => {
    await expect(
      readCommand(makeClawCommandDeps(fsFactory), 'test-claw', '../../../etc/passwd'),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('读未提交 import 目标内的文件 → typed not-published，半成品不暴露', async () => {
    const target = path.join(clawspace, 'importing-dir');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, '.import-claim'),
      JSON.stringify({ token: 'holder', createdAt: new Date().toISOString() }),
    );
    fs.writeFileSync(path.join(target, 'first.txt'), 'partial-bytes');

    await expect(
      readCommand(makeClawCommandDeps(fsFactory), 'test-claw', 'importing-dir/first.txt'),
    ).rejects.toThrow(/not published yet/);
    expect(writes.join('')).not.toContain('partial-bytes');
  });

  it('claim 损坏（不可解析）→ invalid typed 结果', async () => {
    const target = path.join(clawspace, 'importing-dir');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.import-claim'), 'not-json{');
    fs.writeFileSync(path.join(target, 'first.txt'), 'partial-bytes');

    await expect(
      readCommand(makeClawCommandDeps(fsFactory), 'test-claw', 'importing-dir/first.txt'),
    ).rejects.toThrow(/unreadable import state/);
  });

  it('提交后（claim 已删）→ 同一路径正常读取完整内容', async () => {
    const target = path.join(clawspace, 'importing-dir');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'first.txt'), 'full-bytes');

    await readCommand(makeClawCommandDeps(fsFactory), 'test-claw', 'importing-dir/first.txt');
    expect(writes.join('')).toContain('full-bytes');
  });
});
