/**
 * invariants — mechanical merge of the following source files
 * (no assertion logic changed):
 *  - zod-strict-reject-cwd.test.ts
 *  - search-signal-observance.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { throwIfFileToolAborted } from '../../../src/foundation/file-tool/abort.js';
import { readTool } from '../../../src/foundation/file-tool/read.js';
import { writeTool } from '../../../src/foundation/file-tool/write.js';
import { lsTool } from '../../../src/foundation/file-tool/ls.js';
import { editTool } from '../../../src/foundation/file-tool/edit.js';
import { multiEditTool } from '../../../src/foundation/file-tool/multi_edit.js';
import { searchTool } from '../../../src/foundation/file-tool/search.js';
import * as path from 'path';
import { promises as fs } from 'fs';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import { NodeFileSystem } from '../../../src/foundation/fs/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { makeAudit, makeMockAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';
import { makeExecContext } from '../../helpers/exec-context.js';

describe('zod-strict-reject-cwd', () => {
  describe('file-tool Zod strict reject cwd (phase 305 cluster G #9 A 类)', () => {
    const TOOLS = [
      { name: 'read', tool: readTool, validArgs: { path: 'test.ts' } },
      { name: 'write', tool: writeTool, validArgs: { path: 'test.ts', content: 'hello' } },
      { name: 'ls', tool: lsTool, validArgs: { path: '.' } },
      { name: 'edit', tool: editTool, validArgs: { path: 'test.ts', oldText: 'a', newText: 'b' } },
      { name: 'multi_edit', tool: multiEditTool, validArgs: { path: 'test.ts', edits: [] } },
      { name: 'search', tool: searchTool, validArgs: { text: 'hello', path: '.' } },
    ];

    for (const { name, tool, validArgs } of TOOLS) {
      it(`${name}: schema 不含 cwd field (Zod SoT)`, () => {
        const schema = tool.schema as { properties?: Record<string, unknown> };
        expect(schema.properties).not.toHaveProperty('cwd');
      });

      it(`${name}: LLM input 含 cwd → execute returns validation failure (Zod strict runtime)`, async () => {
        const mockCtx = {} as any;
        const result = await tool.execute({ ...validArgs, cwd: '/tmp/illegal' }, mockCtx);
        expect(result.success).toBe(false);
        expect(result.content).toMatch(/validation failed|unrecognized key/i);
      });
    }
  });
});

describe('file-tool signal observance', () => {
  const cases = [
    { name: 'read', tool: readTool, args: { path: 'test.ts' } },
    { name: 'write', tool: writeTool, args: { path: 'test.ts', content: 'hello' } },
    { name: 'ls', tool: lsTool, args: { path: '.' } },
    { name: 'edit', tool: editTool, args: { path: 'test.ts', oldText: 'a', newText: 'b' } },
    { name: 'multi_edit', tool: multiEditTool, args: { path: 'test.ts', edits: [{ oldText: 'a', newText: 'b' }] } },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.name} rejects a pre-aborted signal before filesystem access`, async () => {
      const controller = new AbortController();
      controller.abort({ type: 'tool_timeout', ms: 1 });
      const fsNeverCalled = new Proxy({}, {
        get: (_target, property) => () => { throw new Error(`unexpected fs access: ${String(property)}`); },
      });
      const ctx = makeExecContext({ signal: controller.signal, fs: fsNeverCalled as never });

      await expect(testCase.tool.execute(testCase.args as Record<string, unknown>, ctx))
        .rejects.toMatchObject({ name: 'AbortError' });
    });
  }
});

describe('abort-reason-formatting', () => {
  it('circular abort reason falls back to String and still throws AbortError', () => {
    const controller = new AbortController();
    const reason: Record<string, unknown> = {};
    reason.self = reason;
    controller.abort(reason);

    let thrown: unknown;
    try {
      throwIfFileToolAborted(controller.signal);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('AbortError');
    expect((thrown as Error).message).toContain('File tool execution aborted:');
    expect((thrown as Error).message).toContain('[object Object]');
  });
});

describe('search-signal-observance', () => {
  /**
   * Phase 1036 — search.ts walk signal observance reverse test
   *
   * Verify that an aborted AbortSignal interrupts walk recursion
   * and causes graceful return (0 matches) instead of continuing the search.
   */

  describe('phase 1036: search.ts walk signal observance (F-4)', () => {
    let tempDir: string;

    beforeEach(async () => {
      tempDir = await createTempDir();
    });

    afterEach(async () => {
      await cleanupTempDir(tempDir);
    });

    it('walk finds matches without abort signal', async () => {
      const clawDir = path.join(tempDir, 'claw');
      const clawspaceDir = path.join(clawDir, 'clawspace');
      await fs.mkdir(clawspaceDir, { recursive: true });
      await fs.writeFile(path.join(clawspaceDir, 'note.txt'), 'needle in haystack');

      const mockFs = new NodeFileSystem({ baseDir: clawDir });
      const ctx = new ExecContextImpl({
        clawId: 'claw',
        clawDir,
        workspaceDir: clawspaceDir,
        syncDir: path.join(clawDir, 'tasks/sync'),
        profile: 'full',
        fs: mockFs,
        permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir, strict: true, fs: new NodeFileSystem({ baseDir: clawDir }) }),
      });

      const result = await searchTool.execute(
        { text: 'needle', path: 'clawspace' },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.content).toContain('needle');
    });

    it('aborted signal interrupts walk recursion (反向 1)', async () => {
      const clawDir = path.join(tempDir, 'claw');
      const clawspaceDir = path.join(clawDir, 'clawspace');
      await fs.mkdir(clawspaceDir, { recursive: true });
      await fs.writeFile(path.join(clawspaceDir, 'note.txt'), 'needle in haystack');

      const controller = new AbortController();
      controller.abort();

      const mockFs = new NodeFileSystem({ baseDir: clawDir });
      const ctx = new ExecContextImpl({
        clawId: 'claw',
        clawDir,
        workspaceDir: clawspaceDir,
        syncDir: path.join(clawDir, 'tasks/sync'),
        profile: 'full',
        fs: mockFs,
        signal: controller.signal,
        permissionChecker: createClawPermissionChecker({ audit: makeMockAudit(), clawDir, strict: true, fs: new NodeFileSystem({ baseDir: clawDir }) }),
      });

      const result = await searchTool.execute(
        { text: 'needle', path: 'clawspace' },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.content).toBe('No matches for "needle".');
    });
  });
});

/* ========================================================================
 * phase 2093 Step B：write 备份结果分型与覆盖阻断（真实 read → write 故障矩阵）
 *
 * 契约：write 在「明确备份失败」时不得进入 guarded.write、不得更新
 * readFileState、不得谎报成功；确定不存在的新建仍可创建；append 不调用备份；
 * 已确认存在但备份前消失 → 保守失败且不重建。
 *
 * 测试全部使用真实 NodeFileSystem / 真实 readTool / 真实 permissionChecker，
 * 只在 sync 备份侧注入 I/O 故障（不 mock write 成功、不绕过权限）。
 * ===================================================================== */
describe('phase 2093 Step B: write backup result gating', () => {
  const TARGET = 'clawspace/data.txt';
  const BACKUP_FAILED = 'file_tool_backup_failed';

  interface Faults {
    /** sync 备份 writeAtomic 抛错（EIO / ENOSPC） */
    backupWriteThrows?: Error;
    /** 目标 read 抛错（在 readTool 建立 gate 之后设置） */
    targetReadThrows?: Error;
    /** 第 N 次之后的 exists 调用抛错（1 = gate 之后的备份 exists） */
    existsThrowsAfter?: number;
    /** 第 N 次及之后的 exists 返回 false 并真实删除目标（模拟备份前消失） */
    targetGoneAfter?: number;
    backupWrites: number;
    targetWrites: number;
    existsCalls: number;
  }

  let tempDir: string;
  let clawDir: string;
  let clawspaceDir: string;
  let syncDir: string;
  let realFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = tempDir;
    clawspaceDir = path.join(clawDir, 'clawspace');
    syncDir = path.join(clawDir, 'tasks', 'sync');
    await fs.mkdir(clawspaceDir, { recursive: true });
    realFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function targetAbs(): string {
    return path.join(clawspaceDir, 'data.txt');
  }

  function backupFiles(): Promise<string[]> {
    return fs.readdir(path.join(syncDir, 'write')).catch(() => [] as string[]);
  }

  function makeHarness() {
    const faults: Faults = { backupWrites: 0, targetWrites: 0, existsCalls: 0 };
    const { audit, events } = makeAudit();
    const guardedCalls = { write: 0, append: 0 };

    // 只注入备份侧 I/O 故障；其余全部转发真实 NodeFileSystem
    const faultFs = new Proxy(realFs, {
      get(target, prop, receiver) {
        if (prop === 'writeAtomic') {
          return async (p: string, content: string) => {
            if (faults.backupWriteThrows && p.includes('tasks/sync/write/')) {
              throw faults.backupWriteThrows;
            }
            if (p === TARGET) faults.targetWrites++;
            if (p.includes('tasks/sync/write/')) faults.backupWrites++;
            return target.writeAtomic(p, content);
          };
        }
        if (prop === 'read') {
          return async (p: string) => {
            if (faults.targetReadThrows && p === TARGET) throw faults.targetReadThrows;
            return target.read(p);
          };
        }
        if (prop === 'exists') {
          return async (p: string) => {
            if (p === TARGET) {
              faults.existsCalls++;
              if (faults.existsThrowsAfter !== undefined && faults.existsCalls > faults.existsThrowsAfter) {
                throw new Error('synthetic exists EIO');
              }
              if (faults.targetGoneAfter !== undefined && faults.existsCalls > faults.targetGoneAfter) {
                // 真实删除：目标在读取确认存在之后、备份之前消失
                await fs.rm(path.join(clawDir, TARGET), { force: true });
                return false;
              }
            }
            return target.exists(p);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as NodeFileSystem;

    // 计数 guarded.write / guarded.append，证明失败路径 0 目标写入
    const realChecker = createClawPermissionChecker({ audit, clawDir, strict: true, fs: realFs });
    const countingChecker = new Proxy(realChecker, {
      get(target, prop, receiver) {
        if (prop === 'prepareWrite') {
          return async (rel: string) => {
            const guarded = await target.prepareWrite(rel);
            return {
              target: guarded.target,
              write: async (content: string) => {
                guardedCalls.write++;
                return guarded.write(content);
              },
              append: async (content: string) => {
                guardedCalls.append++;
                return guarded.append(content);
              },
            };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir,
      workspaceDir: clawspaceDir,
      syncDir,
      profile: 'full',
      fs: faultFs,
      permissionChecker: countingChecker,
      auditWriter: audit,
    });

    return { ctx, events, faults, guardedCalls };
  }

  it.each([
    ['EIO', new Error('[EIO] synthetic backup EIO')],
    ['ENOSPC', new Error('[ENOSPC] synthetic backup ENOSPC')],
  ])('备份 write %s 抛错：success=false、原文不变、read-state 不变、BACKUP_FAILED 可见、guarded.write=0', async (_label, error) => {
    await fs.writeFile(targetAbs(), 'ORIGINAL');
    const { ctx, events, faults, guardedCalls } = makeHarness();

    const readResult = await readTool.execute({ path: 'data.txt' }, ctx);
    expect(readResult.success).toBe(true);
    const stateBefore = ctx.readFileState.get(TARGET);
    expect(stateBefore?.isFullRead).toBe(true);

    faults.backupWriteThrows = error;
    const result = await writeTool.execute({ path: 'data.txt', content: 'REPLACEMENT' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).not.toContain('Written:');
    expect(result.content).toMatch(/backup/i);

    // 原字节不变 / 0 目标写（writeAtomic 与 guarded.write 双证）
    expect(await fs.readFile(targetAbs(), 'utf8')).toBe('ORIGINAL');
    expect(faults.targetWrites).toBe(0);
    expect(guardedCalls.write).toBe(0);

    // read-state 条目不变
    const stateAfter = ctx.readFileState.get(TARGET);
    expect(stateAfter).toEqual(stateBefore);
    expect(stateAfter?.hash).toBe(stateBefore?.hash);

    // BACKUP_FAILED 可见
    expect(events.some((e) => e[0] === BACKUP_FAILED)).toBe(true);
  });

  it('备份 read 抛错（gate 通过后）：同样阻断且 0 目标写入', async () => {
    await fs.writeFile(targetAbs(), 'ORIGINAL');
    const { ctx, events, faults, guardedCalls } = makeHarness();

    const readResult = await readTool.execute({ path: 'data.txt' }, ctx);
    expect(readResult.success).toBe(true);
    const stateBefore = ctx.readFileState.get(TARGET);

    // gate 完成后才注入：mtime 未变 → gate 不再 read，只有备份 read 命中
    faults.targetReadThrows = new Error('[EIO] synthetic backup read EIO');
    const result = await writeTool.execute({ path: 'data.txt', content: 'REPLACEMENT' }, ctx);

    expect(result.success).toBe(false);
    expect(await fs.readFile(targetAbs(), 'utf8')).toBe('ORIGINAL');
    expect(faults.targetWrites).toBe(0);
    expect(guardedCalls.write).toBe(0);
    expect(ctx.readFileState.get(TARGET)).toEqual(stateBefore);
    expect(events.some((e) => e[0] === BACKUP_FAILED)).toBe(true);
  });

  it('备份 exists 抛错（gate 的 exists 之后）：同样阻断且 0 目标写入', async () => {
    await fs.writeFile(targetAbs(), 'ORIGINAL');
    const { ctx, events, faults, guardedCalls } = makeHarness();

    const readResult = await readTool.execute({ path: 'data.txt' }, ctx);
    expect(readResult.success).toBe(true);
    const stateBefore = ctx.readFileState.get(TARGET);

    faults.existsThrowsAfter = 1; // 第 1 次（gate）正常，第 2 次（备份）抛错
    const result = await writeTool.execute({ path: 'data.txt', content: 'REPLACEMENT' }, ctx);

    expect(result.success).toBe(false);
    expect(faults.existsCalls).toBe(2);
    expect(await fs.readFile(targetAbs(), 'utf8')).toBe('ORIGINAL');
    expect(faults.targetWrites).toBe(0);
    expect(guardedCalls.write).toBe(0);
    expect(ctx.readFileState.get(TARGET)).toEqual(stateBefore);
    expect(events.some((e) => e[0] === BACKUP_FAILED)).toBe(true);
  });

  it('已确认存在但备份前消失：保守失败、0 写入、不重建，文件仍缺失', async () => {
    await fs.writeFile(targetAbs(), 'ORIGINAL');
    const { ctx, events, faults, guardedCalls } = makeHarness();

    const readResult = await readTool.execute({ path: 'data.txt' }, ctx);
    expect(readResult.success).toBe(true);
    const stateBefore = ctx.readFileState.get(TARGET);

    faults.targetGoneAfter = 1; // gate 看到存在；备份时目标消失
    const result = await writeTool.execute({ path: 'data.txt', content: 'REPLACEMENT' }, ctx);

    expect(result.success).toBe(false);
    expect(result.content).toMatch(/disappear/i);
    // 文件仍缺失（区别于「内容不变」）
    await expect(fs.stat(targetAbs())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(faults.targetWrites).toBe(0);
    expect(guardedCalls.write).toBe(0);
    expect(ctx.readFileState.get(TARGET)).toEqual(stateBefore);
    const disappeared = events.find(
      (e) => e[0] === BACKUP_FAILED && e.join(' ').includes('reason=target_disappeared'),
    );
    expect(disappeared).toBeDefined();
  });

  it('新文件确定不存在：无备份仍成功创建，且不调用备份', async () => {
    const { ctx, events, faults, guardedCalls } = makeHarness();

    const result = await writeTool.execute({ path: 'data.txt', content: 'FRESH' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Written: data.txt');
    expect(result.content).not.toContain('(backup:');
    expect(await fs.readFile(targetAbs(), 'utf8')).toBe('FRESH');
    expect(faults.backupWrites).toBe(0);
    expect(guardedCalls.write).toBe(1);
    expect(await backupFiles()).toEqual([]);
    expect(events.some((e) => e[0] === BACKUP_FAILED)).toBe(false);
  });

  it('append：不调用备份、不触发 gate，内容追加成功', async () => {
    await fs.writeFile(targetAbs(), 'ORIGINAL');
    const { ctx, events, faults, guardedCalls } = makeHarness();

    const result = await writeTool.execute({ path: 'data.txt', content: '+MORE', append: true }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Written: data.txt');
    expect(await fs.readFile(targetAbs(), 'utf8')).toBe('ORIGINAL+MORE');
    expect(faults.backupWrites).toBe(0);
    expect(guardedCalls.append).toBe(1);
    expect(guardedCalls.write).toBe(0);
    expect(await backupFiles()).toEqual([]);
    expect(events.some((e) => e[0] === BACKUP_FAILED)).toBe(false);
  });

  it('正常备份成功：备份含旧全文、目标为新全文、read-state 更新', async () => {
    await fs.writeFile(targetAbs(), 'ORIGINAL');
    const { ctx, faults, guardedCalls } = makeHarness();

    const readResult = await readTool.execute({ path: 'data.txt' }, ctx);
    expect(readResult.success).toBe(true);
    const stateBefore = ctx.readFileState.get(TARGET);

    const result = await writeTool.execute({ path: 'data.txt', content: 'REPLACEMENT' }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('Written: data.txt');
    expect(result.content).toContain('(backup: tasks/sync/write/');
    expect(await fs.readFile(targetAbs(), 'utf8')).toBe('REPLACEMENT');
    expect(faults.backupWrites).toBe(1);
    expect(guardedCalls.write).toBe(1);

    const files = await backupFiles();
    expect(files).toHaveLength(1);
    const backupContent = await fs.readFile(path.join(syncDir, 'write', files[0]), 'utf8');
    expect(backupContent).toContain('source: file_backup');
    expect(backupContent).toContain('ORIGINAL');

    const stateAfter = ctx.readFileState.get(TARGET);
    expect(stateAfter?.isFullRead).toBe(true);
    expect(stateAfter?.hash).not.toBe(stateBefore?.hash);
  });
});


/* ========================================================================
 * phase 2095 Step B：read 溢出提交结果必须同时进入提示与审计。
 * 使用真实 NodeFileSystem / permissionChecker / readTool；只在真实原子写
 * 完成后替换 AtomicWriteResult，模拟目录 fsync 的两种已提交结果。
 * ===================================================================== */
describe('phase 2095 Step B: read overflow commit result visibility', () => {
  const TARGET = 'clawspace/big.txt';
  const OVERFLOW_FAILED = 'read_overflow_persist_failed';
  const SOURCE = Array.from(
    { length: 1500 },
    (_, i) => `overflow-${String(i).padStart(4, '0')} ${'r'.repeat(90)}`,
  ).join('\n');

  type CommittedResult = {
    kind: 'committed_platform_limited' | 'committed_durability_unknown';
    error: NodeJS.ErrnoException;
  };

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
    await fs.writeFile(path.join(clawDir, TARGET), SOURCE);
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function parseReadHint(content: string): string | undefined {
    return /read: \{ "path": "(.+?)", "offset": 1, "limit": 200 \}/.exec(content)?.[1];
  }

  async function artifactFiles(): Promise<string[]> {
    return fs.readdir(path.join(syncDir, 'read')).catch(() => [] as string[]);
  }

  function makeHarness(options?: {
    committed?: CommittedResult;
    writeThrows?: Error;
    afterWrite?: () => void;
  }) {
    const { audit, events } = makeAudit();
    let overflowWrites = 0;
    const instrumentedFs = new Proxy(realFs, {
      get(target, prop) {
        if (prop === 'writeAtomic') {
          return async (p: string, content: string) => {
            if (!p.includes('tasks/sync/read/')) return target.writeAtomic(p, content);
            overflowWrites++;
            if (options?.writeThrows) throw options.writeThrows;
            const written = await target.writeAtomic(p, content);
            options?.afterWrite?.();
            return options?.committed ?? written;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as NodeFileSystem;
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir,
      workspaceDir,
      syncDir,
      profile: 'full',
      fs: instrumentedFs,
      permissionChecker: createClawPermissionChecker({
        audit,
        clawDir,
        strict: true,
        fs: realFs,
      }),
      auditWriter: audit,
    });
    return {
      ctx,
      events,
      writes: () => overflowWrites,
    };
  }

  async function expectCompleteArtifact(relPath: string, ctx: ExecContextImpl) {
    const absolute = path.resolve(workspaceDir, relPath);
    const artifact = await fs.readFile(absolute, 'utf8');
    expect(artifact.endsWith(SOURCE)).toBe(true);
    const readBack = await readTool.execute({ path: relPath, offset: 1, limit: 6 }, ctx);
    expect(readBack.success).toBe(true);
    expect(readBack.content).toContain('source: read_overflow');
    expect(readBack.content).toContain('overflow-0000');
  }

  it('durable：一次真实写入、完整取回，无耐久性失败提示或审计', async () => {
    const { ctx, events, writes } = makeHarness();
    const result = await readTool.execute({ path: 'big.txt', limit: 2000 }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).not.toContain('durability unconfirmed');
    expect(result.content).not.toContain('overflow persist failed');
    expect(events.filter((event) => event[0] === OVERFLOW_FAILED)).toEqual([]);
    expect(writes()).toBe(1);
    expect(await artifactFiles()).toHaveLength(1);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(false);
    await expectCompleteArtifact(parseReadHint(result.content)!, ctx);
  });

  it.each([
    ['committed_platform_limited', 'EINVAL'],
    ['committed_durability_unknown', 'EIO'],
  ] as const)('%s：保留产物并披露 kind、path、reason，不重试', async (kind, code) => {
    const error = Object.assign(new Error(`synthetic ${code} after rename`), { code });
    const { ctx, events, writes } = makeHarness({ committed: { kind, error } });
    const result = await readTool.execute({ path: 'big.txt', limit: 2000 }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain(`[artifact committed but durability unconfirmed: ${kind}]`);
    expect(result.content).not.toContain('overflow persist failed');
    const relPath = parseReadHint(result.content)!;
    expect(relPath).toBeDefined();
    expect(writes()).toBe(1);
    expect(await artifactFiles()).toEqual([path.basename(relPath)]);
    const event = events.find((entry) => entry[0] === OVERFLOW_FAILED);
    expect(event).toBeDefined();
    expect(event).toContain('stage=durability');
    expect(event).toContain(`commit=${kind}`);
    expect(event).toContain(`path=${relPath}`);
    expect(event?.join(' ')).toContain(`reason=`);
    expect(event?.join(' ')).toContain(code);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(false);
    await expectCompleteArtifact(relPath, ctx);
  });

  it('长错误诊断只进入审计 reason，LLM 输出保持固定状态说明', async () => {
    const longMessage = `EIO ${'sensitive-diagnostic-'.repeat(300)}`;
    const error = Object.assign(new Error(longMessage), { code: 'EIO' });
    const { ctx, events } = makeHarness({
      committed: { kind: 'committed_durability_unknown', error },
    });
    const result = await readTool.execute({ path: 'big.txt', limit: 2000 }, ctx);

    expect(result.content).toContain(
      '[artifact committed but durability unconfirmed: committed_durability_unknown]',
    );
    expect(result.content).not.toContain(longMessage);
    expect(result.content).not.toContain('sensitive-diagnostic-');
    const event = events.find((entry) => entry[0] === OVERFLOW_FAILED);
    expect(event?.join(' ')).toContain(longMessage);
    expect(event?.join(' ')).toContain('EIO');
  });

  it('rename 前 EIO：无产物、无 saved 路径，保留失败提示和非全文状态', async () => {
    const error = Object.assign(new Error('synthetic pre-rename EIO'), { code: 'EIO' });
    const { ctx, events, writes } = makeHarness({ writeThrows: error });
    const result = await readTool.execute({ path: 'big.txt', limit: 2000 }, ctx);

    expect(result.success).toBe(true);
    expect(result.content).toContain('[truncated - overflow persist failed]');
    expect(result.content).not.toContain('durability unconfirmed');
    expect(parseReadHint(result.content)).toBeUndefined();
    expect(writes()).toBe(1);
    expect(await artifactFiles()).toEqual([]);
    expect(events.find((entry) => entry[0] === OVERFLOW_FAILED)?.join(' ')).toContain('EIO');
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(false);
  });

  it('短读：零 overflow 写，正文和 full-read 状态不变', async () => {
    await fs.writeFile(path.join(workspaceDir, 'small.txt'), 'small body');
    const { ctx, events, writes } = makeHarness();
    const result = await readTool.execute({ path: 'small.txt' }, ctx);

    expect(result).toEqual({ success: true, content: 'small body' });
    expect(writes()).toBe(0);
    expect(await artifactFiles()).toEqual([]);
    expect(events.filter((event) => event[0] === OVERFLOW_FAILED)).toEqual([]);
    expect(ctx.readFileState.get('clawspace/small.txt')?.isFullRead).toBe(true);
  });

  it('写入后取消：沿 AbortError 通道传播，产物保留且不重写', async () => {
    const controller = new AbortController();
    const { ctx, writes } = makeHarness({
      afterWrite: () => controller.abort({ type: 'tool_timeout', ms: 1 }),
    });
    ctx.signal = controller.signal;

    await expect(readTool.execute({ path: 'big.txt', limit: 2000 }, ctx))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(writes()).toBe(1);
    const files = await artifactFiles();
    expect(files).toHaveLength(1);
    const artifact = await fs.readFile(path.join(syncDir, 'read', files[0]!), 'utf8');
    expect(artifact.endsWith(SOURCE)).toBe(true);
  });
});
