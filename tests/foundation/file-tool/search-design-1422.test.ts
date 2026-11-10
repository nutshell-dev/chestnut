/**
 * Phase 1422 — search design completion test
 *
 * Q1 pattern / Q2 unified filename + content / Q3 skip classification /
 * Q4 binary detect + default exclude / Q5 English output /
 * Q6 全扫 + overflow persist + preview 20 / Q7 cross-claw [clawId] prefix
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { promises as fs } from 'fs';
import { searchTool, readTool } from '../../../src/foundation/file-tool/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import {
  SEARCH_PREVIEW_LIMIT,
  SEARCH_PREVIEW_LINE_MAX_BYTES,
  SEARCH_OUTPUT_MAX_BYTES,
} from '../../../src/foundation/file-tool/constants.js';
import { FILE_TOOL_AUDIT_EVENTS } from '../../../src/foundation/file-tool/audit-events.js';

function makeCtx(clawDir: string, opts?: { fs?: FileSystem; audit?: AuditLog }) {
  const mockFs = opts?.fs ?? new NodeFileSystem({ baseDir: clawDir });
  return new ExecContextImpl({
    clawId: 'claw',
    clawDir,
    workspaceDir: path.join(clawDir, 'clawspace'),
    syncDir: path.join(clawDir, 'tasks/sync'),
    profile: 'full',
    fs: mockFs,
    auditWriter: opts?.audit ?? makeMockAudit(),
    permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir, strict: true, fs: new NodeFileSystem({ baseDir: clawDir }) }),
  });
}

type CommittedKind = 'committed_platform_limited' | 'committed_durability_unknown';

/**
 * phase 2086 Step B 注入缝：真实 NodeFileSystem 落盘（rename 成功）后再替换 writeAtomic
 * 返回值为 committed 三态，模拟「内容已提交可见、仅耐久性未确认」。
 */
function committedFs(baseDir: string, kind: CommittedKind, error: NodeJS.ErrnoException) {
  const inner = new NodeFileSystem({ baseDir });
  const control = { writeAtomicCalls: 0 };
  const fs = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'writeAtomic') {
        return async (p: string, content: string) => {
          control.writeAtomicCalls += 1;
          await target.writeAtomic(p, content);
          return { kind, error };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as FileSystem;
  return { fs, control };
}

/** phase 2086 Step B 注入缝：rename 前失败（writeAtomic 直接抛错，内容未落盘）。 */
function throwingFs(baseDir: string, message: string) {
  const inner = new NodeFileSystem({ baseDir });
  const control = { writeAtomicCalls: 0 };
  const fs = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'writeAtomic') {
        return async (): Promise<never> => {
          control.writeAtomicCalls += 1;
          throw new Error(message);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as FileSystem;
  return { fs, control };
}

function auditCalls(audit: AuditLog): Array<[string, ...(string | number)[]]> {
  return (audit.write as unknown as { mock: { calls: Array<[string, ...(string | number)[]]> } }).mock.calls;
}

describe('phase 1422: search design completion', () => {
  let tempDir: string;
  let clawDir: string;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claw');
    await fs.mkdir(path.join(clawDir, 'clawspace'), { recursive: true });
    await fs.mkdir(path.join(clawDir, 'tasks/sync/search'), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  it('Q1: rejects missing text arg with error', async () => {
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('text');
  });

  it('Q1: rejects empty text', async () => {
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: '' }, ctx);
    expect(result.success).toBe(false);
  });

  it('Q1: rejects text longer than 1024 chars', async () => {
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'x'.repeat(1025) }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('1024');
  });

  it('Q2: unified search returns both [Filename matches] and [Content matches]', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace', 'foo-config.txt'), 'unrelated\nmiddle line\nfoo somewhere here');
    await fs.writeFile(path.join(clawDir, 'clawspace', 'other.txt'), 'nothing relevant');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'foo' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('[Filename matches]');
    expect(result.content).toContain('foo-config.txt');
    expect(result.content).toContain('[Content matches]');
    expect(result.content).toContain('3: foo somewhere here');
  });

  it('Q3 caseSensitive default false: matches FOO with pattern foo', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), 'FOO line here');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'foo' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('FOO line here');
  });

  it('Q3 caseSensitive true: does NOT match FOO with pattern foo', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), 'FOO line here');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'foo', caseSensitive: true }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toBe('No matches for "foo".');
  });

  it('Q3 skip classification: binary file appears in [Skipped] with reason binary', async () => {
    const bin = Buffer.from([0x68, 0x69, 0x00, 0x00, 0x77, 0x6f]); // "hi\0\0wo"
    await fs.writeFile(path.join(clawDir, 'clawspace', 'logo.bin'), bin);
    await fs.writeFile(path.join(clawDir, 'clawspace', 'normal.txt'), 'has hi inside');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'hi' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('[Skipped]');
    expect(result.content).toContain('logo.bin (binary)');
    expect(result.content).toContain('binary=1');
    expect(result.content).toContain('normal.txt');
  });

  it('Q4 default exclude: node_modules content is not searched', async () => {
    await fs.mkdir(path.join(clawDir, 'clawspace', 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(clawDir, 'clawspace', 'node_modules', 'pkg', 'index.js'), 'needle in module');
    await fs.writeFile(path.join(clawDir, 'clawspace', 'src.txt'), 'needle in src');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'needle' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('needle in src');
    expect(result.content).not.toContain('needle in module');
  });

  it('Q4 explicit path overrides default exclude', async () => {
    await fs.mkdir(path.join(clawDir, 'clawspace', 'node_modules', 'pkg'), { recursive: true });
    await fs.writeFile(path.join(clawDir, 'clawspace', 'node_modules', 'pkg', 'index.js'), 'needle in module');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'needle', path: 'node_modules' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain('needle in module');
  });

  it('Q5: zero matches uses English message', async () => {
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), 'nothing here');
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'absent' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toBe('No matches for "absent".');
  });

  it('Q6: matches <= preview limit returned full, no overflow file written', async () => {
    const lines = Array.from({ length: SEARCH_PREVIEW_LIMIT - 1 }, () => 'needle line').join('\n');
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), lines);
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'needle' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).not.toContain('Preview truncated');
    expect(result.content).not.toContain('Showing up to');
    expect(result.content).not.toContain('Full results saved at');
    const overflowDir = path.join(clawDir, 'tasks/sync/search');
    const files = await fs.readdir(overflowDir);
    expect(files.length).toBe(0);
  });

  it('Q6: matches > preview limit triggers overflow persist + preview footer', async () => {
    const lines = Array.from({ length: SEARCH_PREVIEW_LIMIT + 10 }, () => 'needle line').join('\n');
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), lines);
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'needle' }, ctx);
    expect(result.success).toBe(true);
    expect(result.content).toContain(`Showing up to ${SEARCH_PREVIEW_LIMIT} of ${SEARCH_PREVIEW_LIMIT + 10} matches.`);
    // phase 2086 B：durable 三态不附加耐久性限制说明（正常路径文案保持）
    expect(result.content).not.toContain('durability unconfirmed');
    expect(result.content).not.toContain('persist failed');
    // workspace-relative path: workspace defaults to clawspace/, so persisted file at
    // clawDir/tasks/sync/search/ shows as ../tasks/sync/search/ (escapes clawspace).
    expect(result.content).toMatch(/Full results saved at \.\.\/tasks\/sync\/search\//);
    // phase 2086 C：取回从 offset 1 开始（匹配序号不是文件行号）
    expect(result.content).toMatch(/read\(\{ "path": "\.\.\/tasks\/sync\/search\/.+\.md", "offset": 1, "limit": 200 \}\)/);
    const overflowDir = path.join(clawDir, 'tasks/sync/search');
    const files = await fs.readdir(overflowDir);
    expect(files.length).toBe(1);
    const persisted = await fs.readFile(path.join(overflowDir, files[0]), 'utf-8');
    expect(persisted).toContain('source: search_overflow');
    expect(persisted).toContain('content_length:');
  });

  /* ---------------- phase 2086 Step B：落盘三态显式交付 ---------------- */

  async function makeOverflowFixture(): Promise<{ total: number }> {
    const lines = Array.from({ length: SEARCH_PREVIEW_LIMIT + 5 }, () => 'needle line').join('\n');
    await fs.writeFile(path.join(clawDir, 'clawspace', 'a.txt'), lines);
    return { total: SEARCH_PREVIEW_LIMIT + 5 };
  }

  it('B/committed_platform_limited：保留 artifact 与路径，footer 标明耐久性未确认，审计含 stage/commit/path', async () => {
    const { total } = await makeOverflowFixture();
    const fsError = Object.assign(new Error('dir fsync unsupported'), { code: 'EINVAL' });
    const { fs: wrappedFs, control } = committedFs(clawDir, 'committed_platform_limited', fsError);
    const audit = makeMockAudit();
    const ctx = makeCtx(clawDir, { fs: wrappedFs, audit });
    const result = await searchTool.execute({ text: 'needle' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain(`Showing up to ${SEARCH_PREVIEW_LIMIT} of ${total} matches.`);
    expect(result.content).toMatch(/Full results saved at \.\.\/tasks\/sync\/search\//);
    // 必须显式交付耐久性限制，且不得把已提交 artifact 描述成未落盘
    expect(result.content).toContain('durability unconfirmed: committed_platform_limited');
    expect(result.content).not.toContain('persist failed');
    expect(result.content).not.toContain('not delivered');

    // committed 不重写：writeAtomic 只调用一次，artifact 内容完整可读
    expect(control.writeAtomicCalls).toBe(1);
    const files = await fs.readdir(path.join(clawDir, 'tasks/sync/search'));
    expect(files).toHaveLength(1);
    const persisted = await fs.readFile(path.join(clawDir, 'tasks/sync/search', files[0]), 'utf-8');
    expect(persisted.match(/needle line/g)).toHaveLength(total);
    expect(result.content).toContain(files[0]);

    const persistCall = auditCalls(audit).find(([type]) => type === FILE_TOOL_AUDIT_EVENTS.SEARCH_OVERFLOW_PERSIST_FAILED);
    expect(persistCall).toBeDefined();
    expect(persistCall).toContain('stage=durability');
    expect(persistCall).toContain('commit=committed_platform_limited');
    expect(persistCall!.some((col) => String(col).startsWith('path=../tasks/sync/search/'))).toBe(true);
    expect(persistCall!.some((col) => String(col).includes('dir fsync unsupported'))).toBe(true);
  });

  it('B/committed_durability_unknown：同样保留 artifact 与路径，审计 commit 状态为该 kind', async () => {
    const { total } = await makeOverflowFixture();
    const fsError = Object.assign(new Error('dir fsync EIO'), { code: 'EIO' });
    const { fs: wrappedFs, control } = committedFs(clawDir, 'committed_durability_unknown', fsError);
    const audit = makeMockAudit();
    const ctx = makeCtx(clawDir, { fs: wrappedFs, audit });
    const result = await searchTool.execute({ text: 'needle' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('durability unconfirmed: committed_durability_unknown');
    expect(result.content).not.toContain('persist failed');
    expect(control.writeAtomicCalls).toBe(1);
    const files = await fs.readdir(path.join(clawDir, 'tasks/sync/search'));
    expect(files).toHaveLength(1);
    const persistCall = auditCalls(audit).find(([type]) => type === FILE_TOOL_AUDIT_EVENTS.SEARCH_OVERFLOW_PERSIST_FAILED);
    expect(persistCall).toContain('commit=committed_durability_unknown');
    expect(persistCall).toContain('stage=durability');
    expect(result.content).toContain(String(total));
  });

  it('B/failed：真正未落盘时 success=false、只回当前预览、不谎报 saved、不回退全量', async () => {
    const { total } = await makeOverflowFixture();
    const { fs: wrappedFs, control } = throwingFs(clawDir, 'disk full injection');
    const audit = makeMockAudit();
    const ctx = makeCtx(clawDir, { fs: wrappedFs, audit });
    const result = await searchTool.execute({ text: 'needle' }, ctx);

    expect(result.success).toBe(false);
    // 未提交不谎报 saved
    expect(result.content).not.toContain('Full results saved at');
    expect(result.content).not.toContain('durability unconfirmed');
    expect(result.content).toContain('overflow persist failed:');
    expect(result.content).toContain('disk full injection');
    // 只回有限预览（SEARCH_PREVIEW_LIMIT 条），不输出全量
    expect(result.content.match(/needle line/g)).toHaveLength(SEARCH_PREVIEW_LIMIT);
    expect(result.content).toContain(`Showing up to ${SEARCH_PREVIEW_LIMIT} of ${total} matches.`);
    // 无 artifact 残留
    expect(control.writeAtomicCalls).toBe(1);
    const files = await fs.readdir(path.join(clawDir, 'tasks/sync/search'));
    expect(files).toHaveLength(0);
    // 既有审计出口保留原诊断
    const persistCall = auditCalls(audit).find(([type]) => type === FILE_TOOL_AUDIT_EVENTS.SEARCH_OVERFLOW_PERSIST_FAILED);
    expect(persistCall).toBeDefined();
    expect(persistCall!.some((col) => String(col).includes('disk full injection'))).toBe(true);
  });
});


/* ========================================================================
 * phase 2086 Step C：有界预览（单行 2KiB / 总 16KiB / 一次完整结果保存）
 * ====================================================================== */

function bytesOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** 从 footer 的取回命令中解析 artifact 路径（JSON.stringify 形式） */
function parseReadPath(content: string): string | undefined {
  const m = /read\(\{ "path": (".+?"), "offset": 1, "limit": 200 \}\)/.exec(content);
  return m === null ? undefined : (JSON.parse(m[1]) as string);
}

/** 断言字符串没有孤立 surrogate（Node 22 的 isWellFormed 在缺类型时跳过） */
function isWellFormedString(text: string): boolean {
  const fn = (text as unknown as { isWellFormed?: () => boolean }).isWellFormed;
  return fn === undefined ? true : fn.call(text);
}

/** 记录 writeAtomic 调用但不真正落盘（仅用于「路径极长、OS 不允许真实落盘」的防御分支） */
function recordingFs(baseDir: string) {
  const inner = new NodeFileSystem({ baseDir });
  const control = { writeAtomicCalls: 0, lastContent: '' };
  const fs = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'writeAtomic') {
        return async (_p: string, content: string): Promise<{ kind: 'durable' }> => {
          control.writeAtomicCalls += 1;
          control.lastContent = content;
          return { kind: 'durable' };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as FileSystem;
  return { fs, control };
}

/** 虚拟目录：返回指定文件名（可超长）的“文件”，read 抛 EACCES → 全部进 Skipped */
function virtualSkipFs(baseDir: string, names: string[]): FileSystem {
  const inner = new NodeFileSystem({ baseDir });
  const fs = new Proxy(inner, {
    get(target, prop) {
      if (prop === 'list') {
        return async (dirPath: string) => {
          const normalized = dirPath.replace(/\\/g, '/').replace(/\/+$/, '');
          if (normalized === '.' || normalized === '' || normalized === 'clawspace') {
            return names.map((name) => ({
              name,
              path: `clawspace/${name}`,
              isDirectory: false,
              isFile: true,
              size: 16,
              mtime: new Date(),
            }));
          }
          return [];
        };
      }
      if (prop === 'stat') {
        return async () => ({ size: 16, mtime: new Date(), ctime: new Date(), isDirectory: false, isFile: true, mode: 0o644 });
      }
      if (prop === 'read') {
        return async (): Promise<string> => {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as FileSystem;
  return fs;
}

describe('phase 2086 C: bounded search preview (line / total byte budget)', () => {
  let tempDir: string;
  let clawDir: string;
  const workspace = (): string => path.join(clawDir, 'clawspace');
  const overflowDir = (): string => path.join(clawDir, 'tasks/sync/search');

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = path.join(tempDir, 'claw');
    await fs.mkdir(workspace(), { recursive: true });
    await fs.mkdir(overflowDir(), { recursive: true });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  async function overflowFiles(): Promise<string[]> {
    return fs.readdir(overflowDir());
  }

  it('C/边界：1 条短命中原文本零落盘；20 条保持原文本；21 条触发一次落盘且 artifact 完整', async () => {
    // 1 条：短且完整 → 原文本、无 footer、零落盘
    await fs.writeFile(path.join(workspace(), 'one.txt'), 'needle only-once');
    const oneCtx = makeCtx(clawDir);
    const one = await searchTool.execute({ text: 'needle' }, oneCtx);
    expect(one.success).toBe(true);
    expect(one.content).toContain('1: needle only-once');
    expect(one.content).not.toContain('Preview truncated');
    expect(one.content).not.toContain('Full results saved at');
    expect(await overflowFiles()).toHaveLength(0);
    await fs.rm(path.join(workspace(), 'one.txt'));

    const twenty = Array.from({ length: SEARCH_PREVIEW_LIMIT }, (_, i) => `needle-${String(i).padStart(3, '0')}`).join('\n');
    await fs.writeFile(path.join(workspace(), 'a.txt'), twenty);
    const ctx = makeCtx(clawDir);

    const full = await searchTool.execute({ text: 'needle' }, ctx);
    expect(full.success).toBe(true);
    expect(full.content).not.toContain('Preview truncated');
    expect(full.content).not.toContain('Full results saved at');
    expect(full.content).toContain('needle-000');
    expect(full.content).toContain(`needle-${String(SEARCH_PREVIEW_LIMIT - 1).padStart(3, '0')}`);
    expect(bytesOf(full.content)).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX_BYTES);
    expect(await overflowFiles()).toHaveLength(0);

    // 21 条：仍只有 20 条预览，但完整 21 条必须落盘可取回
    const twentyOne = `${twenty}\nneedle-020`;
    await fs.writeFile(path.join(workspace(), 'a.txt'), twentyOne);
    const bounded = await searchTool.execute({ text: 'needle' }, ctx);
    expect(bounded.success).toBe(true);
    expect(bounded.content).toContain(`Showing up to ${SEARCH_PREVIEW_LIMIT} of ${SEARCH_PREVIEW_LIMIT + 1} matches.`);
    expect(bounded.content).not.toContain('needle-020');
    expect(bytesOf(bounded.content)).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX_BYTES);
    const files = await overflowFiles();
    expect(files).toHaveLength(1);
    const persisted = await fs.readFile(path.join(overflowDir(), files[0]), 'utf-8');
    expect(persisted.match(/needle-\d{3}/g)).toHaveLength(21);
  });

  it('C/单条 450KB 长行（ASCII/中文/emoji）：响应有界、行显式截短、artifact 保留完整长行尾标记', async () => {
    const variants: Array<{ name: string; filler: string }> = [
      { name: 'ascii', filler: 'a' },
      { name: 'cjk', filler: '中' },
      { name: 'emoji', filler: '🙂' },
    ];
    for (const variant of variants) {
      // 清空 artifact（同一 tempDir 内顺序验证三种编码）
      for (const f of await overflowFiles()) await fs.rm(path.join(overflowDir(), f));
      const tail = ' TAIL-SENTINEL-2086';
      // 一次性构造（避免逐字符拼接 + 反复计算字节数带来的 O(n^2) 开销）
      const perRepeat = bytesOf(variant.filler);
      const filler = variant.filler.repeat(Math.ceil((450 * 1024) / perRepeat));
      const longLine = `needle ${filler}${tail}`;
      expect(bytesOf(longLine)).toBeGreaterThanOrEqual(450 * 1024);
      await fs.writeFile(path.join(workspace(), 'long.txt'), longLine);

      const ctx = makeCtx(clawDir);
      const result = await searchTool.execute({ text: 'needle' }, ctx);

      expect(result.success).toBe(true);
      expect(bytesOf(result.content)).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX_BYTES);
      expect(result.content).toContain('… [truncated]');
      expect(result.content).toContain('Preview truncated');
      expect(isWellFormedString(result.content)).toBe(true);
      // 预览行本身不得超过 2KiB
      const rendered = result.content.split('\n').find((l) => l.startsWith('  1: '));
      expect(rendered).toBeDefined();
      expect(bytesOf(rendered!)).toBeLessThanOrEqual(SEARCH_PREVIEW_LINE_MAX_BYTES);

      const files = await overflowFiles();
      expect(files).toHaveLength(1);
      const persisted = await fs.readFile(path.join(overflowDir(), files[0]), 'utf-8');
      expect(persisted).toContain('TAIL-SENTINEL-2086');
      expect(bytesOf(persisted)).toBeGreaterThanOrEqual(bytesOf(longLine));
    }
  });

  it('C/多条各不超单行但总计超总预算：正文按预算截短（ASCII 恰为 16KiB）、artifact 保留全部匹配', async () => {
    const lines = Array.from({ length: SEARCH_PREVIEW_LIMIT }, (_, i) =>
      `needle ${String(i).padStart(2, '0')} ${'a'.repeat(1400)}`).join('\n');
    await fs.writeFile(path.join(workspace(), 'many.txt'), lines);
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'needle' }, ctx);

    expect(result.success).toBe(true);
    // 每条渲染行都在 2KiB 内 → 只有总预算触发裁剪；ASCII 截断后总量恰为总上限
    expect(result.content.split('\n').filter((l) => l.startsWith('  ') && l.includes('needle'))
      .every((l) => bytesOf(l) <= SEARCH_PREVIEW_LINE_MAX_BYTES)).toBe(true);
    expect(bytesOf(result.content)).toBe(SEARCH_OUTPUT_MAX_BYTES);
    expect(result.content).toContain('… [truncated]');
    expect(result.content).toContain('Preview truncated');

    const files = await overflowFiles();
    expect(files).toHaveLength(1);
    const persisted = await fs.readFile(path.join(overflowDir(), files[0]), 'utf-8');
    expect(persisted.match(/needle \d{2}/g)).toHaveLength(SEARCH_PREVIEW_LIMIT);
  });

  it('C/行上限：恰等于 2KiB 不截短（零落盘），超 1 字节即截短且无孤立 surrogate', async () => {
    // 渲染行 = '  1: '(5B) + 匹配行原文（以 'needle ' 开头，7B）→ 正文 2036B 恰好 2048
    const prefixBytes = 5 + 'needle '.length;
    const exact = 'b'.repeat(SEARCH_PREVIEW_LINE_MAX_BYTES - prefixBytes);
    await fs.writeFile(path.join(workspace(), 'exact.txt'), `needle ${exact}`);
    const ctx = makeCtx(clawDir);
    const atLimit = await searchTool.execute({ text: 'needle' }, ctx);
    expect(atLimit.success).toBe(true);
    expect(atLimit.content).not.toContain('… [truncated]');
    expect(atLimit.content).not.toContain('Preview truncated');
    expect(await overflowFiles()).toHaveLength(0);

    const over = 'c'.repeat(SEARCH_PREVIEW_LINE_MAX_BYTES - prefixBytes + 1);
    await fs.writeFile(path.join(workspace(), 'over.txt'), `needle ${over}`);
    const bounded = await searchTool.execute({ text: 'needle' }, ctx);
    expect(bounded.success).toBe(true);
    expect(bounded.content).toContain('… [truncated]');
    expect(bytesOf(bounded.content)).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX_BYTES);
    expect(isWellFormedString(bounded.content)).toBe(true);
    const rendered = bounded.content.split('\n').find((l) => l.startsWith('  1: '));
    expect(bytesOf(rendered!)).toBeLessThanOrEqual(SEARCH_PREVIEW_LINE_MAX_BYTES);
    // artifact 保留完整未截短行
    const files = await overflowFiles();
    expect(files).toHaveLength(1);
    const persisted = await fs.readFile(path.join(overflowDir(), files[0]), 'utf-8');
    expect(persisted).toContain(over);

    // 多字节：截断落在码点边界，不得出现孤立 surrogate
    for (const f of await overflowFiles()) await fs.rm(path.join(overflowDir(), f));
    await fs.writeFile(path.join(workspace(), 'cjk.txt'), `needle ${'中'.repeat(1500)}`);
    const cjk = await searchTool.execute({ text: 'needle' }, ctx);
    expect(cjk.success).toBe(true);
    expect(isWellFormedString(cjk.content)).toBe(true);
    const cjkLine = cjk.content.split('\n').find((l) => l.startsWith('  1: '));
    expect(bytesOf(cjkLine!)).toBeLessThanOrEqual(SEARCH_PREVIEW_LINE_MAX_BYTES);
  });

  it('C/零匹配 + Skipped 超长路径：整响应计入预算，截短并落盘一次完整结果', async () => {
    const longName = `${'z'.repeat(5000)}.txt`;
    const ctx = makeCtx(clawDir, { fs: virtualSkipFs(clawDir, [longName]) });
    const result = await searchTool.execute({ text: 'absent' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('No matches for "absent".');
    expect(result.content).toContain('[Skipped]');
    expect(result.content).toContain('… [truncated]');
    expect(bytesOf(result.content)).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX_BYTES);
    expect(result.content).not.toContain(longName);
    const files = await overflowFiles();
    expect(files).toHaveLength(1);
    const persisted = await fs.readFile(path.join(overflowDir(), files[0]), 'utf-8');
    expect(persisted).toContain(longName);
  });

  it('C/失败与 committed 变体在超长故障消息下仍有界，且 artifact 只写一次', async () => {
    const lines = Array.from({ length: SEARCH_PREVIEW_LIMIT + 5 }, () => 'needle line').join('\n');
    await fs.writeFile(path.join(workspace(), 'a.txt'), lines);
    const longMessage = `boom-${'e'.repeat(4000)}`;

    const committed = committedFs(clawDir, 'committed_durability_unknown', Object.assign(new Error(longMessage), { code: 'EIO' }));
    const ctxCommitted = makeCtx(clawDir, { fs: committed.fs, audit: makeMockAudit() });
    const committedResult = await searchTool.execute({ text: 'needle' }, ctxCommitted);
    expect(committedResult.success).toBe(true);
    expect(bytesOf(committedResult.content)).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX_BYTES);
    expect(committedResult.content).toContain('durability unconfirmed');
    expect(committedResult.content).not.toContain(longMessage);
    expect(committed.control.writeAtomicCalls).toBe(1);

    for (const f of await overflowFiles()) await fs.rm(path.join(overflowDir(), f));
    const throwing = throwingFs(clawDir, longMessage);
    const ctxFailed = makeCtx(clawDir, { fs: throwing.fs, audit: makeMockAudit() });
    const failedResult = await searchTool.execute({ text: 'needle' }, ctxFailed);
    expect(failedResult.success).toBe(false);
    expect(bytesOf(failedResult.content)).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX_BYTES);
    expect(failedResult.content).toContain('overflow persist failed');
    expect(failedResult.content).not.toContain('Full results saved at');
    expect(failedResult.content).not.toContain(longMessage);
    expect(throwing.control.writeAtomicCalls).toBe(1);
    expect(await overflowFiles()).toHaveLength(0);
  });

  it('C/footer 自身放不下（异常长 artifact 路径）：固定短 success=false，不伪造可用路径，审计留全量路径', async () => {
    const lines = Array.from({ length: SEARCH_PREVIEW_LIMIT + 5 }, () => 'needle line').join('\n');
    await fs.writeFile(path.join(workspace(), 'a.txt'), lines);

    // 构造超长 syncDir（真实 OS 不允许这么长的路径，因此注入只记录的 writeAtomic）
    const deepSegment = 'd'.repeat(200);
    const deepSync = path.join(clawDir, 'tasks', 'sync', ...Array.from({ length: 60 }, () => deepSegment));
    const recorder = recordingFs(clawDir);
    const audit = makeMockAudit();
    const ctx = new ExecContextImpl({
      clawId: 'claw',
      clawDir,
      workspaceDir: workspace(),
      syncDir: deepSync,
      profile: 'full',
      fs: recorder.fs,
      auditWriter: audit,
      permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir, strict: true, fs: new NodeFileSystem({ baseDir: clawDir }) }),
    });

    const result = await searchTool.execute({ text: 'needle' }, ctx);
    expect(result.success).toBe(false);
    expect(bytesOf(result.content)).toBeLessThanOrEqual(SEARCH_OUTPUT_MAX_BYTES);
    expect(result.content).toContain('preview unavailable');
    // 不得把被截断的长路径当成可用路径返回
    expect(result.content).not.toContain(deepSegment);
    expect(result.content).not.toContain('read({');
    // artifact 仍有一次写入尝试，审计记录完整路径与状态
    expect(recorder.control.writeAtomicCalls).toBe(1);
    const budgetCall = auditCalls(audit).find(([type, ...cols]) =>
      type === FILE_TOOL_AUDIT_EVENTS.SEARCH_OVERFLOW_PERSIST_FAILED && cols.includes('stage=output-budget'));
    expect(budgetCall).toBeDefined();
    const pathCol = budgetCall!.find((col) => typeof col === 'string' && col.startsWith('path='));
    expect(pathCol).toBeDefined();
    expect(String(pathCol).length).toBeGreaterThan(deepSegment.length);
    expect(budgetCall!.some((col) => String(col).startsWith('commit=durable'))).toBe(true);
  });

  it('C/取回：提示路径交给 read 能从 offset 1 取回首段（含 frontmatter 与标题）', async () => {
    const lines = Array.from({ length: SEARCH_PREVIEW_LIMIT + 10 }, (_, i) =>
      `needle-${String(i).padStart(3, '0')} body`).join('\n');
    await fs.writeFile(path.join(workspace(), 'a.txt'), lines);
    const ctx = makeCtx(clawDir);
    const result = await searchTool.execute({ text: 'needle' }, ctx);

    const artifactPath = parseReadPath(result.content);
    expect(artifactPath).toBeDefined();
    expect(artifactPath!.startsWith('../tasks/sync/search/')).toBe(true);

    const readBack = await readTool.execute({ path: artifactPath!, offset: 1, limit: 200 }, ctx);
    expect(readBack.success).toBe(true);
    expect(readBack.content).toContain('source: search_overflow');
    expect(readBack.content).toContain('needle-000');
  });
});
