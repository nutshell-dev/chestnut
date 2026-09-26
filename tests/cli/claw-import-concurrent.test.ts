/**
 * Phase 1910 Step F — claw import 目标占有与递归发布（RACE-CLAW-IMPORT-TARGET-CHECK）
 *
 * 验收：
 * - 并发双 import 同一目录目标：恰一个 winner，loser typed 冲突，目标不被覆盖；
 * - 目标在 copy 中途出现（非空）：rename 发布失败 → 显式冲突，staging+claim 证据保留；
 * - copy 中途读失败：不触碰已存在目标/不发布半成品，证据保留；
 * - 同内容重试 / 异内容冲突：已发布目标拒绝语义不变；
 * - 单文件并发 import：O_EXCL 独占写裁决，恰一个 winner。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createTrackedTempDir, cleanupTempDir } from '../utils/temp.js';
import { importCommand } from '../../src/cli/commands/claw-import.js';
import { NodeFileSystem } from '../../src/foundation/fs/node-fs.js';
import { sha256Hex } from '../../src/foundation/node-utils/index.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';
import { makeClawCommandDeps } from '../helpers/claw-command-deps.js';

const fsFactory = (baseDir: string) => new NodeFileSystem({ baseDir });

function clawspaceDir(): string {
  return path.join(tmpDir, '.chestnut', 'claws', 'alice', 'clawspace');
}

let tmpDir: string;
let originalRoot: string | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = await createTrackedTempDir('chestnut-import-race-');
  originalRoot = process.env.CHESTNUT_ROOT;
  process.env.CHESTNUT_ROOT = tmpDir;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  const configPath = path.join(tmpDir, '.chestnut', 'config.yaml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    'version: "1"\nllm:\n  primary:\n    preset: anthropic\n    api_key: test\n    model: claude\n    max_tokens: 4096\n    temperature: 0.7\n    timeout_ms: 60000\n  retry_attempts: 3\n  retry_delay_ms: 1000\n',
  );
  const clawDir = path.join(tmpDir, '.chestnut', 'claws', 'alice');
  fs.mkdirSync(clawDir, { recursive: true });
  fs.writeFileSync(path.join(clawDir, 'config.yaml'), 'name: alice\n');

  fs.mkdirSync(path.join(tmpDir, 'src-bundle'));
  fs.writeFileSync(path.join(tmpDir, 'src-bundle', 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(tmpDir, 'src-bundle', 'b.txt'), 'beta');
});

afterEach(async () => {
  logSpy.mockRestore();
  if (originalRoot === undefined) delete process.env.CHESTNUT_ROOT;
  else process.env.CHESTNUT_ROOT = originalRoot;
  await cleanupTempDir(tmpDir);
});

describe('claw import target claim + staged publish (phase 1910 Step F)', () => {
  it('concurrent double import of same dir target: exactly one winner, loser typed conflict', async () => {
    const results = await Promise.allSettled([
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason.message).toMatch(
      /already (in progress|exists)/,
    );

    // winner 发布完整快照；claim/staging 不残留
    expect(fs.readFileSync(path.join(clawspaceDir(), 'src-bundle', 'a.txt'), 'utf-8')).toBe('alpha');
    expect(fs.readFileSync(path.join(clawspaceDir(), 'src-bundle', 'b.txt'), 'utf-8')).toBe('beta');
    expect(fs.existsSync(path.join(clawspaceDir(), 'src-bundle', '.import-claim'))).toBe(false);
    expect(
      fs.readdirSync(clawspaceDir()).filter((n) => n.startsWith('.import-staging-')),
    ).toEqual([]);
  });

  it('empty dir target already present: no-replace conflict, empty dir preserved as-is (Phase 1911)', async () => {
    // rename(emptySrc, emptyDest) 在 POSIX 会成功 —— mkdirExclusive 在路径占有
    // 裁决点直接拒绝任何已存在目标（含空目录）
    const emptyTarget = path.join(clawspaceDir(), 'src-bundle');
    fs.mkdirSync(emptyTarget, { recursive: true });

    await expect(
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ).rejects.toThrow(/already exists/);

    // 空目录原样保留，未被 staging 内容替换
    expect(fs.readdirSync(emptyTarget)).toEqual([]);
  });

  it('interrupted claim-only crash window: typed conflict with evidence path, nothing overwritten', async () => {
    const target = path.join(clawspaceDir(), 'src-bundle');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.import-claim'), JSON.stringify({ token: 'crashed' }));

    await expect(
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ).rejects.toThrow(/already in progress or was interrupted/);

    // claim 证据保留，等待 owner recovery（不自动清理）
    expect(fs.existsSync(path.join(target, '.import-claim'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'a.txt'))).toBe(false);
  });

  it('target appears mid-fill (external write into placeholder): post-fill sweep conflicts, evidence preserved', async () => {
    // 包装 destParent fs：首次 no-replace 落位前往我们的占位目录里塞外部内容，
    // 模拟填装窗口内占位被外部写入 → 落位后扫描检出混入 → 冲突留证
    const destParent = clawspaceDir();
    const racingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(destParent)) {
        const origLink = real.linkExclusiveSync.bind(real);
        real.linkExclusiveSync = (from: string, to: string) => {
          fs.writeFileSync(path.join(destParent, 'src-bundle', 'external.txt'), 'external');
          return origLink(from, to);
        };
      }
      return real;
    };

    await expect(
      importCommand(makeClawCommandDeps(racingFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ).rejects.toThrow(/modified during import.*evidence preserved/s);

    // 外部内容不被覆盖/删除；claim 证据保留，staging 保留（部分落位文件同属证据）
    expect(fs.readFileSync(path.join(destParent, 'src-bundle', 'external.txt'), 'utf-8')).toBe('external');
    expect(fs.existsSync(path.join(destParent, 'src-bundle', '.import-claim'))).toBe(true);
    expect(
      fs.readdirSync(destParent).filter((n) => n.startsWith('.import-staging-')),
    ).toHaveLength(1);
  });

  it('copy mid-failure (source read error): no publish, staging + claim evidence preserved', async () => {
    const srcDir = path.join(tmpDir, 'src-bundle');
    const failingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(srcDir)) {
        const origRead = real.read.bind(real);
        real.read = async (p: string) => {
          if (p === 'b.txt') throw new Error('simulated source read failure');
          return origRead(p);
        };
      }
      return real;
    };

    await expect(
      importCommand(makeClawCommandDeps(failingFactory), srcDir, 'alice'),
    ).rejects.toThrow(/failed.*evidence preserved/s);

    const destParent = clawspaceDir();
    // 不发布半成品；claim 目录 + staging 证据保留
    expect(fs.existsSync(path.join(destParent, 'src-bundle', 'a.txt'))).toBe(false);
    expect(fs.existsSync(path.join(destParent, 'src-bundle', '.import-claim'))).toBe(true);
    expect(
      fs.readdirSync(destParent).filter((n) => n.startsWith('.import-staging-')),
    ).toHaveLength(1);
  });

  it('re-import after success (same content) keeps rejection semantics; conflicting content also rejected', async () => {
    await importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'src-bundle'), 'alice');

    // 同内容重试
    await expect(
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ).rejects.toThrow(/already exists/);

    // 异内容冲突
    fs.writeFileSync(path.join(tmpDir, 'src-bundle', 'a.txt'), 'CHANGED');
    await expect(
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ).rejects.toThrow(/already exists/);

    // 已发布目标不被覆盖
    expect(fs.readFileSync(path.join(clawspaceDir(), 'src-bundle', 'a.txt'), 'utf-8')).toBe('alpha');
  });

  it('concurrent single-file import: O_EXCL exclusive write arbitrates exactly one winner', async () => {
    fs.writeFileSync(path.join(tmpDir, 'note.md'), 'hello');

    const results = await Promise.allSettled([
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'note.md'), 'alice'),
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'note.md'), 'alice'),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason.message).toMatch(/already exists/);
    expect(fs.readFileSync(path.join(clawspaceDir(), 'note.md'), 'utf-8')).toBe('hello');
  });

  // ---- Phase 1912 Step D：占位全程占有 + 死 holder 恢复 ----

  it('dead-holder claim（无 manifestHash = 源快照事实未持久化）→ 无法证明 payload identity，冲突留证（Phase 1913 Step B）', async () => {
    const target = path.join(clawspaceDir(), 'src-bundle');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.import-claim'), JSON.stringify({
      token: 'dead-holder',
      pid: 99999, // 死 holder（无 startTime → kill(0) ESRCH 证死）
      createdAt: new Date().toISOString(),
      source: path.join(tmpDir, 'src-bundle'),
      target: 'src-bundle',
    }));

    // 只有 source 路径相同不构成 payload identity：源目录可能已变化，
    // 不得把新字节归入旧 intent——fail-closed 交 owner 显式决策
    await expect(
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ).rejects.toThrow(/cannot be proven/);

    // 证据原样保留，不发布、不覆盖
    expect(fs.existsSync(path.join(target, '.import-claim'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'a.txt'))).toBe(false);
  });

  it('dead-holder claim 同 payload（manifestHash 相符）→ 接管恢复并完成发布', async () => {
    const target = path.join(clawspaceDir(), 'src-bundle');
    fs.mkdirSync(target, { recursive: true });
    // 与 owner manifest 构造一致：每文件 {path, bytes, sha256} 排序后 JSON 的 hash
    const manifest = [
      { path: 'a.txt', bytes: 5, sha256: sha256Hex('alpha') },
      { path: 'b.txt', bytes: 4, sha256: sha256Hex('beta') },
    ].sort((a, b) => a.path.localeCompare(b.path));
    fs.writeFileSync(path.join(target, '.import-claim'), JSON.stringify({
      token: 'dead-holder',
      pid: 99999,
      createdAt: new Date().toISOString(),
      source: path.join(tmpDir, 'src-bundle'),
      target: 'src-bundle',
      manifestHash: sha256Hex(JSON.stringify(manifest)),
    }));

    await importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'src-bundle'), 'alice');

    expect(fs.readFileSync(path.join(target, 'a.txt'), 'utf-8')).toBe('alpha');
    expect(fs.readFileSync(path.join(target, 'b.txt'), 'utf-8')).toBe('beta');
    expect(fs.existsSync(path.join(target, '.import-claim'))).toBe(false);
  });

  it('dead-holder claim 异 payload（manifestHash 不符）→ 显式冲突留证，不覆盖不发布', async () => {
    const target = path.join(clawspaceDir(), 'src-bundle');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.import-claim'), JSON.stringify({
      token: 'dead-holder',
      pid: 99999,
      createdAt: new Date().toISOString(),
      source: path.join(tmpDir, 'src-bundle'),
      target: 'src-bundle',
      manifestHash: 'deadbeef',
    }));

    await expect(
      importCommand(makeClawCommandDeps(fsFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ).rejects.toThrow(/different source payload/);

    expect(fs.existsSync(path.join(target, '.import-claim'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'a.txt'))).toBe(false);
  });

  it('占位被外部删除重建（claim 丢失）→ 提交前身份核验失败，冲突留证', async () => {
    const destParent = clawspaceDir();
    const target = path.join(destParent, 'src-bundle');
    const racingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(destParent)) {
        const origLink = real.linkExclusiveSync.bind(real);
        real.linkExclusiveSync = (from: string, to: string) => {
          const r = origLink(from, to);
          // 外部删除并重建空占位（claim 随之丢失）
          fs.rmSync(target, { recursive: true, force: true });
          fs.mkdirSync(target);
          return r;
        };
      }
      return real;
    };

    await expect(
      importCommand(makeClawCommandDeps(racingFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ).rejects.toThrow(/placeholder identity was lost/);
  });
});


describe('claw import claim 探测 fail-closed（Phase 1915 Step D：RACE-IMPORT-VISIBILITY-ERROR-FAILOPEN）', () => {
  it('既有目标的 claim 探测遇未知 I/O → typed unreadable，不再误报 already exists', async () => {
    // 目标目录带 claim（中断的 import）；探测 claim 时发生未知 I/O 错误——
    // existsSync/tryStat 布尔接口会吞成「无 claim」→ 误报 already exists（fail-open）。
    const target = path.join(clawspaceDir(), 'src-bundle');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, '.import-claim'), JSON.stringify({ token: 'crashed' }));

    const ioErrFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(clawspaceDir())) {
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
      importCommand(makeClawCommandDeps(ioErrFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ).rejects.toThrow(/unreadable import state/);

    // 证据原样保留
    expect(fs.existsSync(path.join(target, '.import-claim'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'a.txt'))).toBe(false);
  });
});
