import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { readTool } from '../../../src/foundation/file-tool/read.js';
import { writeTool } from '../../../src/foundation/file-tool/write.js';
import { READ_OUTPUT_HARD_CAP_BYTES } from '../../../src/foundation/file-tool/constants.js';
import { NodeFileSystem, type FileSystem } from '../../../src/foundation/fs/index.js';
import { assertWellFormedUnicode, truncateUtf8Prefix } from '../../../src/foundation/node-utils/utf8.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { makeAudit, makeMockAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

const CAP = READ_OUTPUT_HARD_CAP_BYTES;
const TARGET = 'clawspace/data.txt';
const FAILURE_NOTE = '\n[truncated - overflow persist failed]';

describe('phase 2102: read UTF-8 byte budget', () => {
  let tempDir: string;
  let clawDir: string;
  let workspaceDir: string;
  let syncDir: string;
  let realFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = tempDir;
    workspaceDir = path.join(clawDir, 'clawspace');
    syncDir = path.join(clawDir, 'tasks', 'sync');
    await fs.mkdir(workspaceDir, { recursive: true });
    realFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function makeCtx(fsImpl: FileSystem = realFs) {
    const { audit, events } = makeAudit();
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir,
      workspaceDir,
      syncDir,
      profile: 'full',
      fs: fsImpl,
      auditWriter: audit,
      permissionChecker: createClawPermissionChecker({
        audit: makeMockAudit(),
        clawDir,
        strict: true,
        fs: realFs,
      }),
    });
    return { ctx, events };
  }

  function makeFailingCtx(error: Error, afterWriteAttempt?: () => void) {
    let writes = 0;
    const failingFs = new Proxy(realFs, {
      get(target, prop) {
        if (prop === 'writeAtomic') {
          return async (p: string, content: string) => {
            if (!p.includes('tasks/sync/read/')) return target.writeAtomic(p, content);
            writes++;
            afterWriteAttempt?.();
            throw error;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as FileSystem;
    return { ...makeCtx(failingFs), writes: () => writes };
  }

  async function artifactFiles(): Promise<string[]> {
    return fs.readdir(path.join(syncDir, 'read')).catch(() => [] as string[]);
  }

  function parseReadHint(content: string): string | undefined {
    return /read: \{ "path": "(.+?)", "offset": 1, "limit": 200 \}/.exec(content)?.[1];
  }

  function parseFullOutputBytes(content: string): number | undefined {
    const value = /Full output \((\d+) bytes\) saved\./.exec(content)?.[1];
    return value === undefined ? undefined : Number(value);
  }

  async function writeSource(source: string, name = 'data.txt'): Promise<void> {
    await fs.writeFile(path.join(workspaceDir, name), source);
  }

  it.each([
    ['ASCII cap-1', 'a'.repeat(CAP - 1), CAP - 1, false],
    ['ASCII cap', 'a'.repeat(CAP), CAP, false],
    ['ASCII cap+1', 'a'.repeat(CAP + 1), CAP + 1, true],
    ['CJK cap', `${'中'.repeat(34133)}x`, CAP, false],
    ['CJK cap+1', `${'中'.repeat(34133)}xx`, CAP + 1, true],
    ['emoji cap', '😀'.repeat(25600), CAP, false],
    ['emoji cap+4', '😀'.repeat(25601), CAP + 4, true],
  ])('%s：严格大于 UTF-8 字节预算才保存 overflow', async (_name, source, bytes, overflows) => {
    expect(Buffer.byteLength(source, 'utf8')).toBe(bytes);
    await writeSource(source);
    const { ctx } = makeCtx();

    const result = await readTool.execute({ path: 'data.txt' }, ctx);
    const files = await artifactFiles();

    expect(result.success).toBe(true);
    expect(files).toHaveLength(overflows ? 1 : 0);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(!overflows);
    if (!overflows) {
      expect(result.content).toBe(source);
      return;
    }
    expect(result.content).not.toBe(source);
    expect(parseReadHint(result.content)).toBeDefined();
    expect(parseFullOutputBytes(result.content)).toBe(Buffer.byteLength(source, 'utf8'));
    expect(() => assertWellFormedUnicode(result.content)).not.toThrow();
    expect(result.content).not.toContain('\uFFFD');
    const artifact = await fs.readFile(path.join(syncDir, 'read', files[0]!), 'utf8');
    expect(artifact.endsWith(source)).toBe(true);
  });

  it('真实 read 预览两侧不切断 emoji，提示与完整产物使用同一原文字节总量', async () => {
    const source = `${'a'.repeat(599)}😀${'中'.repeat(40000)}😀${'z'.repeat(1399)}`;
    await writeSource(source);
    const { ctx } = makeCtx();

    const result = await readTool.execute({ path: 'data.txt' }, ctx);
    const files = await artifactFiles();

    expect(result.success).toBe(true);
    expect(files).toHaveLength(1);
    expect(result.content.startsWith(`${'a'.repeat(599)}\n[...truncated 120008 bytes...]\n`)).toBe(true);
    expect(result.content).toContain(`${'z'.repeat(1399)}\nFull output (${Buffer.byteLength(source, 'utf8')} bytes) saved.`);
    expect(() => assertWellFormedUnicode(result.content)).not.toThrow();
    expect(result.content).not.toContain('\uFFFD');
    const artifact = await fs.readFile(path.join(syncDir, 'read', files[0]!), 'utf8');
    expect(artifact.endsWith(source)).toBe(true);
  });

  it.each([
    ['40000 CJK', Array.from({ length: 2000 }, (_, i) => `${i}:${'中'.repeat(20)}`).join('\n')],
    ['30000 emoji', Array.from({ length: 1000 }, (_, i) => `${i}:${'😀'.repeat(30)}`).join('\n')],
  ])('%s：旧 UTF-16 阈值漏判的多行 Unicode 可保存并分页取回', async (_name, source) => {
    expect(source.length).toBeLessThan(CAP);
    expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(CAP);
    await writeSource(source);
    const { ctx } = makeCtx();

    const result = await readTool.execute({ path: 'data.txt', limit: 3000 }, ctx);
    const files = await artifactFiles();

    expect(result.success).toBe(true);
    expect(files).toHaveLength(1);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(false);
    const artifact = await fs.readFile(path.join(syncDir, 'read', files[0]!), 'utf8');
    expect(artifact.endsWith(source)).toBe(true);

    const relPath = parseReadHint(result.content)!;
    const head = await readTool.execute({ path: relPath, offset: 1, limit: 6 }, ctx);
    const tail = await readTool.execute({ path: relPath, offset: -1, limit: 1 }, ctx);
    expect(head.success).toBe(true);
    expect(head.content).toContain('source: read_overflow');
    expect(head.content).toContain(source.split('\n')[0]!);
    expect(tail).toEqual({ success: true, content: source.split('\n').at(-1)! });
    expect(await artifactFiles()).toEqual(files);
  });

  it('大文件只选一个短行时不按整份文件大小触发 overflow', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `${i}:${'x'.repeat(1000)}`);
    await writeSource(lines.join('\n'));
    const { ctx } = makeCtx();

    const result = await readTool.execute({ path: 'data.txt', offset: 150, limit: 1 }, ctx);

    expect(result).toEqual({ success: true, content: lines[149] });
    expect(await artifactFiles()).toEqual([]);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(false);
  });

  it('默认 200 行窗口保持不变，行数提示计入 UTF-8 字节阈值', async () => {
    const lines = [...Array.from({ length: 200 }, () => 'x'.repeat(511)), 'LAST-LINE'];
    const first200 = lines.slice(0, 200).join('\n');
    const footer = '\n[Showing lines 1-200 of 201. Pass `limit` to read more.]';
    const selected = first200 + footer;
    expect(Buffer.byteLength(first200, 'utf8')).toBeLessThanOrEqual(CAP);
    expect(Buffer.byteLength(selected, 'utf8')).toBeGreaterThan(CAP);
    await writeSource(lines.join('\n'));
    const { ctx } = makeCtx();

    const result = await readTool.execute({ path: 'data.txt' }, ctx);
    const files = await artifactFiles();

    expect(result.success).toBe(true);
    expect(files).toHaveLength(1);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(false);
    const artifact = await fs.readFile(path.join(syncDir, 'read', files[0]!), 'utf8');
    expect(artifact.endsWith(selected)).toBe(true);
    expect(artifact).not.toContain(lines[200]!);
  });

  it('Unicode overflow 后真实 write 仍因未全文读取被拒绝', async () => {
    const source = '中'.repeat(40000);
    await writeSource(source);
    const { ctx } = makeCtx();

    const result = await readTool.execute({ path: 'data.txt' }, ctx);
    expect(result.success).toBe(true);
    expect(await artifactFiles()).toHaveLength(1);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(false);

    const write = await writeTool.execute({ path: 'data.txt', content: 'REPLACED' }, ctx);
    expect(write.success).toBe(false);
    expect(write.content).toContain('has not been fully read');
    expect(await fs.readFile(path.join(workspaceDir, 'data.txt'), 'utf8')).toBe(source);
  });

  for (const code of ['EIO', 'ENOSPC'] as const) {
    it.each([
      ['ASCII', 'a'.repeat(CAP + 500)],
      ['CJK', '中'.repeat(40000)],
      ['emoji', '😀'.repeat(30000)],
      ['mixed code points', 'a中😀é'.repeat(20000)],
    ])(`${code} %s 保存失败：完整响应含标记且不超 UTF-8 字节预算`, async (_name, source) => {
      expect(Buffer.byteLength(source, 'utf8')).toBeGreaterThan(CAP);
      await writeSource(source);
      const longMessage = `${code} ${'sensitive-diagnostic-'.repeat(100)}`;
      const error = Object.assign(new Error(longMessage), { code });
      const { ctx, events, writes } = makeFailingCtx(error);

      const result = await readTool.execute({ path: 'data.txt' }, ctx);

      expect(result.success).toBe(false);
      expect(writes()).toBe(1);
      expect(await artifactFiles()).toEqual([]);
      expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(CAP);
      expect(result.content.endsWith(FAILURE_NOTE)).toBe(true);
      expect(parseReadHint(result.content)).toBeUndefined();
      expect(result.content).not.toContain(longMessage);
      expect(result.content).not.toContain('\uFFFD');
      expect(() => assertWellFormedUnicode(result.content)).not.toThrow();
      const preview = result.content.slice(0, -FAILURE_NOTE.length);
      expect(source.startsWith(preview)).toBe(true);
      const previewBytes = CAP - Buffer.byteLength(FAILURE_NOTE, 'utf8');
      expect(previewBytes).toBeGreaterThanOrEqual(0);
      expect(result.content).toBe(truncateUtf8Prefix(source, previewBytes) + FAILURE_NOTE);
      if (_name === 'ASCII') expect(Buffer.byteLength(result.content, 'utf8')).toBe(CAP);
      expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(false);
      const audit = events.find((event) => event[0] === 'read_overflow_persist_failed');
      expect(audit?.join(' ')).toContain(code);
      expect(audit?.join(' ')).toContain(longMessage);
    });
  }

  it('保存失败将旧 full-read 状态降级，后续真实 write 仍被拒绝', async () => {
    await writeSource('small');
    const error = Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
    const { ctx } = makeFailingCtx(error);
    expect((await readTool.execute({ path: 'data.txt' }, ctx)).success).toBe(true);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(true);
    const source = '😀'.repeat(30000);
    await writeSource(source);

    const result = await readTool.execute({ path: 'data.txt' }, ctx);

    expect(result.success).toBe(false);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(CAP);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(false);
    const write = await writeTool.execute({ path: 'data.txt', content: 'REPLACED' }, ctx);
    expect(write.success).toBe(false);
    expect(write.content).toContain('has not been fully read');
    expect(await fs.readFile(path.join(workspaceDir, 'data.txt'), 'utf8')).toBe(source);
  });

  it('保存失败后取消仍沿 AbortError 传播且不重试', async () => {
    await writeSource('中'.repeat(40000));
    const controller = new AbortController();
    const error = Object.assign(new Error('synthetic EIO'), { code: 'EIO' });
    const { ctx, writes } = makeFailingCtx(error, () => {
      controller.abort({ type: 'tool_timeout', ms: 1 });
    });
    ctx.signal = controller.signal;

    await expect(readTool.execute({ path: 'data.txt' }, ctx))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(writes()).toBe(1);
    expect(await artifactFiles()).toEqual([]);
  });
});
