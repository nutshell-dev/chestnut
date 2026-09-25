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
    expect(fs.existsSync(path.join(clawspaceDir(), '.src-bundle.importing'))).toBe(false);
    expect(
      fs.readdirSync(clawspaceDir()).filter((n) => n.startsWith('.import-staging-')),
    ).toEqual([]);
  });

  it('target appears mid-copy (non-empty): publish rename fails closed, evidence preserved, target untouched', async () => {
    // 包装 destParent fs：moveDir 前先在目标放入外部内容，模拟 copy 窗口内目标被创建
    const destParent = clawspaceDir();
    const racingFactory = (baseDir: string): FileSystem => {
      const real = new NodeFileSystem({ baseDir });
      if (path.resolve(baseDir) === path.resolve(destParent)) {
        const origMoveDir = real.moveDir.bind(real);
        real.moveDir = async (from: string, to: string) => {
          fs.mkdirSync(path.join(destParent, to), { recursive: true });
          fs.writeFileSync(path.join(destParent, to, 'external.txt'), 'external');
          return origMoveDir(from, to);
        };
      }
      return real;
    };

    await expect(
      importCommand(makeClawCommandDeps(racingFactory), path.join(tmpDir, 'src-bundle'), 'alice'),
    ).rejects.toThrow(/failed.*evidence preserved/s);

    // 已存在目标不被覆盖；staging + claim 证据保留，不静默删除
    expect(fs.readFileSync(path.join(destParent, 'src-bundle', 'external.txt'), 'utf-8')).toBe('external');
    expect(fs.existsSync(path.join(destParent, 'src-bundle', 'a.txt'))).toBe(false);
    expect(fs.existsSync(path.join(destParent, '.src-bundle.importing'))).toBe(true);
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
    expect(fs.existsSync(path.join(destParent, 'src-bundle'))).toBe(false);
    expect(fs.existsSync(path.join(destParent, '.src-bundle.importing'))).toBe(true);
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
});
