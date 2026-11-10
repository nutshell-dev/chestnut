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
import { searchTool } from '../../../src/foundation/file-tool/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import type { FileSystem } from '../../../src/foundation/fs/index.js';
import type { AuditLog } from '../../../src/foundation/audit/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { makeMockAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { SEARCH_PREVIEW_LIMIT } from '../../../src/foundation/file-tool/constants.js';
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
    expect(result.content).not.toContain('Showing 1-');
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
    expect(result.content).toContain(`Showing 1-${SEARCH_PREVIEW_LIMIT} of ${SEARCH_PREVIEW_LIMIT + 10} matches.`);
    // phase 2086 B：durable 三态不附加耐久性限制说明（正常路径文案保持）
    expect(result.content).not.toContain('durability unconfirmed');
    expect(result.content).not.toContain('persist failed');
    // workspace-relative path: workspace defaults to clawspace/, so persisted file at
    // clawDir/tasks/sync/search/ shows as ../tasks/sync/search/ (escapes clawspace).
    expect(result.content).toMatch(/Full results saved at \.\.\/tasks\/sync\/search\//);
    expect(result.content).toMatch(/read\(\{ "path": "\.\.\/tasks\/sync\/search\/.+\.md", "offset": 21, "limit": 200 \}\)/);
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
    expect(result.content).toContain(`Showing 1-${SEARCH_PREVIEW_LIMIT} of ${total} matches.`);
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
    expect(result.content).toContain(`Showing 1-${SEARCH_PREVIEW_LIMIT} of ${total} matches.`);
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
