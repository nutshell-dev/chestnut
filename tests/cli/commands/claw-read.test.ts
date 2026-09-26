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


describe('claw-read 读侧残余治理（Phase 1915 Step D：RACE-VISIBILITY-CHECK-TOCTOU / RACE-IMPORT-VISIBILITY-ERROR-FAILOPEN）', () => {
  let tmpRoot: string;
  let clawDir: string;
  let clawspace: string;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpRoot = path.join(os.tmpdir(), `phase1915-read-${randomUUID()}`);
    clawDir = path.join(tmpRoot, '.chestnut', 'claws', 'test-claw');
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

  it('read 期间 claim 出现（ABA 交错）→ typed state-changed，内容不输出', async () => {
    // 已提交文件；read 执行期间外部开始新 import（claim 落位、文件将逐个重写）
    const target = path.join(clawspace, 'watch-dir');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'f.txt'), 'committed-bytes');

    const racingFactory = (baseDir: string): import('../../../src/foundation/fs/index.js').FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(clawDir)) {
        const origRead = real.read.bind(real);
        real.read = async (p: string) => {
          const content = await origRead(p);
          if (p === 'clawspace/watch-dir/f.txt') {
            // read 返回后、读侧复验前 claim 出现
            fs.writeFileSync(
              path.join(target, '.import-claim'),
              JSON.stringify({ token: 'holder', createdAt: new Date().toISOString() }),
            );
          }
          return content;
        };
      }
      return real;
    };

    await expect(
      readCommand(makeClawCommandDeps(racingFactory), 'test-claw', 'watch-dir/f.txt'),
    ).rejects.toThrow(/import state changed while reading/);
    // 结果被丢弃：可能观察到未提交目录的内容不呈现
    expect(writes.join('')).not.toContain('committed-bytes');
  });

  it('claim 探测遇未知 I/O 错误 → fail-closed typed invalid，不当 published 读取', async () => {
    const ioErrFactory = (baseDir: string): import('../../../src/foundation/fs/index.js').FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(clawDir)) {
        real.statSync = (p: string) => {
          if (p.endsWith('.import-claim')) {
            throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
          }
          return NodeFileSystem.prototype.statSync.call(real, p);
        };
      }
      return real;
    };

    await expect(
      readCommand(makeClawCommandDeps(ioErrFactory), 'test-claw', 'a.md'),
    ).rejects.toThrow(/unreadable import state/);
    expect(writes.join('')).not.toContain('aaa');
  });
});
