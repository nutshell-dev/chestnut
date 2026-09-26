/**
 * claw-ls command tests — phase 1480.
 *
 * Integration style (real tmpdir + NodeFileSystem) matching
 * tests/cli/claw-send-confinement.test.ts convention. Covers:
 *
 * Phase 1324 Step B：不再 mock Assembly config internal，改为每次调用注入
 * tests/helpers/claw-command-deps.ts 构造的窄 RootConfig fake。
 *
 * - lists clawspace root entries (default path)
 * - lists a subdir within clawspace
 * - --recursive lists nested entries
 * - --json emits JSON FileEntry view
 * - unknown claw → CliError
 * - path escape (`..`) → CliError
 * - dirs sort before files / alphabetical within group
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { lsCommand } from '../../../src/cli/commands/claw-ls.js';
import { NodeFileSystem } from '../../../src/foundation/fs/node-fs.js';
import { CliError } from '../../../src/cli/errors.js';
import { makeClawCommandDeps } from '../../helpers/claw-command-deps.js';

const fsFactory = (dir: string) => new NodeFileSystem({ baseDir: dir });

describe('claw-ls (phase 1480)', () => {
  let tmpRoot: string;
  let clawspace: string;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpRoot = path.join(os.tmpdir(), `phase1480-ls-${randomUUID()}`);
    // Layout under <tmp>/.chestnut/claws/test-claw/ (mirrors getClawDir()):
    //   .../clawspace/a.md
    //   .../clawspace/b.md
    //   .../clawspace/notes/inner.md
    const clawDir = path.join(tmpRoot, '.chestnut', 'claws', 'test-claw');
    clawspace = path.join(clawDir, 'clawspace');
    fs.mkdirSync(clawspace, { recursive: true });
    fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'name: test-claw\n');
    fs.writeFileSync(path.join(clawspace, 'a.md'), 'aaa');
    fs.writeFileSync(path.join(clawspace, 'b.md'), 'bbb');
    fs.mkdirSync(path.join(clawspace, 'notes'));
    fs.writeFileSync(path.join(clawspace, 'notes', 'inner.md'), 'inner');
    process.env.CHESTNUT_ROOT = tmpRoot;

    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    delete process.env.CHESTNUT_ROOT;
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('default path lists clawspace root entries (dirs first, alphabetical)', async () => {
    await lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', undefined, {});
    const out = writes.join('');
    expect(out).toContain('notes/');
    expect(out).toContain('a.md');
    expect(out).toContain('b.md');
    // dir sorted before files
    expect(out.indexOf('notes/')).toBeLessThan(out.indexOf('a.md'));
    expect(out.indexOf('a.md')).toBeLessThan(out.indexOf('b.md'));
  });

  it('lists a subdirectory (path is workspace-relative, unix `cd` intuition)', async () => {
    await lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', 'notes', {});
    const out = writes.join('');
    expect(out).toContain('inner.md');
    expect(out).not.toContain('a.md');
  });

  it('--recursive includes nested files', async () => {
    await lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', undefined, { recursive: true });
    const out = writes.join('');
    expect(out).toContain('a.md');
    expect(out).toContain('b.md');
    expect(out).toContain('inner.md');
  });

  it('--json emits parseable JSON with size + mtime + isDirectory', async () => {
    await lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', undefined, { json: true });
    const out = writes.join('');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    const names = parsed.map((e: { name: string }) => e.name);
    expect(names).toContain('notes');
    expect(names).toContain('a.md');
    const aEntry = parsed.find((e: { name: string }) => e.name === 'a.md');
    expect(aEntry.size).toBe(3);
    expect(typeof aEntry.mtime).toBe('string');
    expect(aEntry.isDirectory).toBe(false);
    const notesEntry = parsed.find((e: { name: string }) => e.name === 'notes');
    expect(notesEntry.isDirectory).toBe(true);
  });

  it('unknown claw (loadClaw → undefined) throws CliError', async () => {
    const deps = makeClawCommandDeps(fsFactory, { loadClaw: () => undefined });
    await expect(
      lsCommand(deps, 'no-such-claw', undefined, {}),
    ).rejects.toBeInstanceOf(CliError);
  });

  it('path escape (..) throws CliError', async () => {
    await expect(
      lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', '../../../etc', {}),
    ).rejects.toBeInstanceOf(CliError);
  });
});


describe('claw-ls 读侧发布门控（Phase 1913 Step B：RACE-PUBLISH-PRECOMMIT-VISIBILITY）', () => {
  let tmpRoot: string;
  let clawspace: string;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpRoot = path.join(os.tmpdir(), `phase1913-ls-${randomUUID()}`);
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

  /** 构造未提交 import 目标：占位目录 + claim + 部分落位文件。 */
  function writeUnpublishedTarget(name: string, opts?: { corruptClaim?: boolean }): void {
    const target = path.join(clawspace, name);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, '.import-claim'),
      opts?.corruptClaim === true
        ? 'not-json{'
        : JSON.stringify({ token: 'holder', createdAt: new Date().toISOString() }),
    );
    // 半成品：只有首文件落位
    fs.writeFileSync(path.join(target, 'first.txt'), 'partial');
  }

  it('列根目录：未提交目标目录注解保留但其半成品内容不暴露', async () => {
    writeUnpublishedTarget('importing-dir');

    await lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', undefined, {});
    const out = writes.join('');
    expect(out).toContain('importing-dir/');
    expect(out).toContain('(import in progress)');
    expect(out).toContain('a.md');
    // 半成品内容与 claim 不出现在根列表
    expect(out).not.toContain('first.txt');
    expect(out).not.toContain('.import-claim');
  });

  it('--json：未提交目标带 importInProgress 标记', async () => {
    writeUnpublishedTarget('importing-dir');

    await lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', undefined, { json: true });
    const parsed = JSON.parse(writes.join(''));
    const entry = parsed.find((e: { name: string }) => e.name === 'importing-dir');
    expect(entry.importInProgress).toBe(true);
    const normal = parsed.find((e: { name: string }) => e.name === 'a.md');
    expect(normal.importInProgress).toBeUndefined();
  });

  it('--recursive：递归列出时不暴露未提交目标内部条目', async () => {
    writeUnpublishedTarget('importing-dir');

    await lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', undefined, { recursive: true });
    const out = writes.join('');
    expect(out).toContain('importing-dir/');
    expect(out).not.toContain('first.txt');
    expect(out).not.toContain('.import-claim');
  });

  it('直接列未提交目标目录 → typed not-published', async () => {
    writeUnpublishedTarget('importing-dir');

    await expect(
      lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', 'importing-dir', {}),
    ).rejects.toThrow(/not published yet/);
  });

  it('列未提交目标内部子路径 → typed not-published', async () => {
    writeUnpublishedTarget('importing-dir');
    fs.mkdirSync(path.join(clawspace, 'importing-dir', 'sub'));

    await expect(
      lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', 'importing-dir/sub', {}),
    ).rejects.toThrow(/not published yet/);
  });

  it('claim 损坏（不可解析）→ invalid typed 结果，不当已发布', async () => {
    writeUnpublishedTarget('importing-dir', { corruptClaim: true });

    await expect(
      lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', 'importing-dir', {}),
    ).rejects.toThrow(/unreadable import state/);
  });

  it('已提交目标（无 claim）→ 正常列出', async () => {
    const committed = path.join(clawspace, 'committed-dir');
    fs.mkdirSync(committed);
    fs.writeFileSync(path.join(committed, 'f.txt'), 'done');

    await lsCommand(makeClawCommandDeps(fsFactory), 'test-claw', 'committed-dir', {});
    expect(writes.join('')).toContain('f.txt');
  });
});


describe('claw-ls 读侧残余治理（Phase 1915 Step D：RACE-VISIBILITY-CHECK-TOCTOU / RACE-IMPORT-VISIBILITY-ERROR-FAILOPEN）', () => {
  let tmpRoot: string;
  let clawDir: string;
  let clawspace: string;
  let writes: string[];
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // eslint-disable-next-line chestnut-custom/no-bare-tempdir-in-tests
    tmpRoot = path.join(os.tmpdir(), `phase1915-ls-${randomUUID()}`);
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

  it('list 期间 claim 出现（检查与读取两次独立观察）→ typed state-changed，结果被丢弃', async () => {
    // 已提交目标；list 执行期间外部开始新 import（claim 落位）
    const target = path.join(clawspace, 'committed-dir');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'f.txt'), 'done');

    const racingFactory = (baseDir: string): import('../../../src/foundation/fs/index.js').FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(clawDir)) {
        const origList = real.list.bind(real);
        real.list = async (p: string, options?: Parameters<typeof real.list>[1]) => {
          const entries = await origList(p, options);
          if (p === 'clawspace/committed-dir') {
            // list 返回后、读侧复验前 claim 出现（import 开始落位）
            fs.writeFileSync(
              path.join(target, '.import-claim'),
              JSON.stringify({ token: 'holder', createdAt: new Date().toISOString() }),
            );
          }
          return entries;
        };
      }
      return real;
    };

    await expect(
      lsCommand(makeClawCommandDeps(racingFactory), 'test-claw', 'committed-dir', {}),
    ).rejects.toThrow(/import state changed while listing/);
    // 结果被丢弃：不把可能混入未提交目录的列表呈现给用户
    expect(writes.join('')).not.toContain('f.txt');
  });

  it('claim 探测遇未知 I/O 错误 → fail-closed typed invalid，不当 published', async () => {
    // existsSync 布尔接口会把 EIO/EACCES 吞成 false（fail-open）；类型化探测必须拦截
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
      lsCommand(makeClawCommandDeps(ioErrFactory), 'test-claw', 'a.md', {}),
    ).rejects.toThrow(/unreadable import state/);
  });

  it('列根目录时子目录 claim 探测遇未知 I/O → fail-closed，不列出半成品', async () => {
    const sub = path.join(clawspace, 'sub-dir');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'half.txt'), 'partial');

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
      lsCommand(makeClawCommandDeps(ioErrFactory), 'test-claw', undefined, {}),
    ).rejects.toThrow(/unreadable import state/);
    expect(writes.join('')).not.toContain('half.txt');
  });

  it('claim 读取遇未知 I/O 错误（非缺席非解析失败）→ fail-closed typed invalid', async () => {
    const target = path.join(clawspace, 'importing-dir');
    fs.mkdirSync(target);
    fs.writeFileSync(
      path.join(target, '.import-claim'),
      JSON.stringify({ token: 'holder', createdAt: new Date().toISOString() }),
    );

    const ioErrFactory = (baseDir: string): import('../../../src/foundation/fs/index.js').FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(clawDir)) {
        const origReadSync = real.readSync.bind(real);
        real.readSync = (p: string) => {
          if (p.endsWith('.import-claim')) {
            throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
          }
          return origReadSync(p);
        };
      }
      return real;
    };

    await expect(
      lsCommand(makeClawCommandDeps(ioErrFactory), 'test-claw', 'importing-dir', {}),
    ).rejects.toThrow(/unreadable import state/);
  });
});
