import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { readTool } from '../../../src/foundation/file-tool/read.js';
import { writeTool } from '../../../src/foundation/file-tool/write.js';
import {
  loadReadFileState,
  persistReadFileState,
} from '../../../src/foundation/file-tool/file-state-persist.js';
import { NodeFileSystem, type FileSystem } from '../../../src/foundation/fs/index.js';
import { ExecContextImpl } from '../../../src/foundation/tools/context.js';
import type { ExecContext } from '../../../src/foundation/tools/index.js';
import { createClawPermissionChecker } from '../../../src/core/permissions/claw-permissions.js';
import { makeAudit, makeMockAudit } from '../../helpers/audit.js';
import { createTempDir, cleanupTempDir } from '../../utils/temp.js';

const TARGET = 'clawspace/data.txt';
const OTHER = 'clawspace/other.txt';
const STAT_FAILED = 'read_file_stat_failed';
const ORIGINAL = 'ONE\nTWO\nTHREE';

describe('phase 2099: read stat failure invalidates only the target credential', () => {
  let tempDir: string;
  let clawDir: string;
  let workspaceDir: string;
  let realFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await createTempDir();
    clawDir = tempDir;
    workspaceDir = path.join(clawDir, 'clawspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(clawDir, TARGET), ORIGINAL);
    await fs.writeFile(path.join(clawDir, OTHER), 'OTHER');
    realFs = new NodeFileSystem({ baseDir: clawDir });
  });

  afterEach(async () => {
    await cleanupTempDir(tempDir);
  });

  function statError(code: 'EIO' | 'ENOENT'): Error {
    return Object.assign(new Error(`synthetic stat ${code}`), { code });
  }

  function failStat(error: Error, onTargetStat?: () => void): FileSystem {
    return new Proxy(realFs, {
      get(target, prop) {
        if (prop === 'stat') {
          return async (p: string) => {
            if (p === TARGET) {
              onTargetStat?.();
              throw error;
            }
            return target.stat(p);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as FileSystem;
  }

  function makeCtx(overrides: Partial<ExecContext> = {}) {
    const { audit, events } = makeAudit();
    const ctx = new ExecContextImpl({
      clawId: 'test-claw',
      clawDir,
      workspaceDir,
      syncDir: path.join(clawDir, 'tasks', 'sync'),
      profile: 'full',
      fs: realFs,
      auditWriter: audit,
      permissionChecker: createClawPermissionChecker({
        audit: makeMockAudit(),
        clawDir,
        strict: true,
        fs: realFs,
      }),
      ...overrides,
    });
    return { ctx, events };
  }

  function failureEvents(events: ReturnType<typeof makeAudit>['events']) {
    return events.filter((event) => event[0] === STAT_FAILED);
  }

  it('旧 full-read 凭据被单路径撤销，保留旧状态审计并阻断真实覆盖', async () => {
    const { ctx, events } = makeCtx();
    expect((await readTool.execute({ path: 'data.txt' }, ctx)).success).toBe(true);
    expect((await readTool.execute({ path: 'other.txt' }, ctx)).success).toBe(true);
    const previous = ctx.readFileState.get(TARGET)!;
    const other = ctx.readFileState.get(OTHER);
    expect(previous.isFullRead).toBe(true);

    ctx.fs = failStat(statError('EIO'));
    const result = await readTool.execute({ path: 'data.txt', limit: 1 }, ctx);

    expect(result).toEqual({ success: true, content: 'ONE' });
    expect(ctx.readFileState.has(TARGET)).toBe(false);
    expect(ctx.readFileState.get(OTHER)).toEqual(other);
    expect(failureEvents(events)).toEqual([[
      STAT_FAILED,
      `claw_dir=${clawDir}`,
      `path=${TARGET}`,
      'invalidated=true',
      `previous_hash=${previous.hash}`,
      `previous_timestamp=${previous.timestamp}`,
      'previous_isFullRead=true',
      expect.stringContaining('EIO'),
    ]]);

    ctx.fs = realFs;
    const write = await writeTool.execute({ path: 'data.txt', content: 'REPLACED' }, ctx);
    expect(write.success).toBe(false);
    expect(write.content).toContain('has not been fully read');
    expect(await fs.readFile(path.join(clawDir, TARGET), 'utf8')).toBe(ORIGINAL);
  });

  it('旧 partial-read 凭据同样撤销，审计明确 previous_isFullRead=false', async () => {
    const { ctx, events } = makeCtx();
    await readTool.execute({ path: 'data.txt', limit: 1 }, ctx);
    const previous = ctx.readFileState.get(TARGET)!;
    expect(previous.isFullRead).toBe(false);

    ctx.fs = failStat(statError('EIO'));
    expect((await readTool.execute({ path: 'data.txt', limit: 1 }, ctx)).success).toBe(true);

    expect(ctx.readFileState.has(TARGET)).toBe(false);
    const event = failureEvents(events).at(-1);
    expect(event).toContain('invalidated=true');
    expect(event).toContain('previous_isFullRead=false');
    expect(event).toContain(`previous_hash=${previous.hash}`);
    expect(event).toContain(`previous_timestamp=${previous.timestamp}`);
  });

  it.each(['EIO', 'ENOENT'] as const)('无旧条目时 %s 仍交付正文并留下 invalidated=false 审计', async (code) => {
    const { ctx, events } = makeCtx({ fs: failStat(statError(code)) });

    const result = await readTool.execute({ path: 'data.txt' }, ctx);

    expect(result).toEqual({ success: true, content: ORIGINAL });
    expect(ctx.readFileState.has(TARGET)).toBe(false);
    const failures = failureEvents(events);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('invalidated=false');
    expect(failures[0]).toContain(`path=${TARGET}`);
    expect(failures[0]?.join(' ')).toContain(code);
    expect(failures[0]?.some((col) => String(col).startsWith('previous_'))).toBe(false);
  });

  it('健康 stat 保持全文/部分读取状态且零失败事件', async () => {
    const { ctx, events } = makeCtx();

    expect((await readTool.execute({ path: 'data.txt' }, ctx)).success).toBe(true);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(true);
    expect((await readTool.execute({ path: 'data.txt', limit: 1 }, ctx)).success).toBe(true);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(false);
    expect(failureEvents(events)).toHaveLength(0);
  });

  it('故障恢复后重新全文读取可重建凭据并真实覆盖', async () => {
    const { ctx } = makeCtx();
    await readTool.execute({ path: 'data.txt' }, ctx);
    ctx.fs = failStat(statError('EIO'));
    await readTool.execute({ path: 'data.txt', limit: 1 }, ctx);
    expect(ctx.readFileState.has(TARGET)).toBe(false);

    ctx.fs = realFs;
    expect((await readTool.execute({ path: 'data.txt' }, ctx)).success).toBe(true);
    expect(ctx.readFileState.get(TARGET)?.isFullRead).toBe(true);
    const write = await writeTool.execute({ path: 'data.txt', content: 'REPLACED' }, ctx);
    expect(write.success).toBe(true);
    expect(await fs.readFile(path.join(clawDir, TARGET), 'utf8')).toBe('REPLACED');
  });

  it('完整 step 持久化并重建后目标条目仍缺失，其他路径保留且可重读恢复', async () => {
    const { ctx } = makeCtx({ persistReadFileState: true });
    await readTool.execute({ path: 'data.txt' }, ctx);
    await readTool.execute({ path: 'other.txt' }, ctx);
    await persistReadFileState(ctx);
    const before = JSON.parse(await realFs.read('read-state.json')) as { entries: Record<string, unknown> };
    expect(Object.keys(before.entries).sort()).toEqual([OTHER, TARGET].sort());

    ctx.fs = failStat(statError('ENOENT'));
    expect((await readTool.execute({ path: 'data.txt', limit: 1 }, ctx)).success).toBe(true);
    await persistReadFileState(ctx);

    const restored = await loadReadFileState(realFs);
    expect(restored.has(TARGET)).toBe(false);
    expect(restored.get(OTHER)).toEqual(ctx.readFileState.get(OTHER));
    const persisted = JSON.parse(await realFs.read('read-state.json')) as { entries: Record<string, unknown> };
    expect(Object.keys(persisted.entries)).toEqual([OTHER]);

    const { ctx: restarted } = makeCtx({ persistReadFileState: true, readFileState: restored });
    const rejected = await writeTool.execute({ path: 'data.txt', content: 'REPLACED' }, restarted);
    expect(rejected.success).toBe(false);
    expect(await fs.readFile(path.join(clawDir, TARGET), 'utf8')).toBe(ORIGINAL);

    expect((await readTool.execute({ path: 'data.txt' }, restarted)).success).toBe(true);
    const accepted = await writeTool.execute({ path: 'data.txt', content: 'REPLACED' }, restarted);
    expect(accepted.success).toBe(true);
    expect(await fs.readFile(path.join(clawDir, TARGET), 'utf8')).toBe('REPLACED');
  });

  it('stat 抛错同时取消 signal 仍抛 AbortError，已撤销凭据不复活', async () => {
    const controller = new AbortController();
    const { ctx } = makeCtx({ signal: controller.signal });
    await readTool.execute({ path: 'data.txt' }, ctx);
    ctx.fs = failStat(statError('EIO'), () => controller.abort());

    await expect(readTool.execute({ path: 'data.txt', limit: 1 }, ctx))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(ctx.readFileState.has(TARGET)).toBe(false);
  });

  it('源 read 先失败时不进入 stat 失败处置、不伪造事件', async () => {
    const { ctx, events } = makeCtx();
    let statCalls = 0;
    ctx.fs = new Proxy(realFs, {
      get(target, prop) {
        if (prop === 'read') {
          return async () => { throw Object.assign(new Error('synthetic read EACCES'), { code: 'EACCES' }); };
        }
        if (prop === 'stat') {
          return async (p: string) => {
            statCalls++;
            return target.stat(p);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as FileSystem;

    const result = await readTool.execute({ path: 'data.txt' }, ctx);
    expect(result.success).toBe(false);
    expect(result.content).toContain('EACCES');
    expect(statCalls).toBe(0);
    expect(failureEvents(events)).toHaveLength(0);
  });
});
