/**
 * Phase 1872 Step D: loadSubAgentTask 单条只读查询（owner 目录口径）。
 *
 * 语义（与迁移前 Assembly 内联实现逐语义等价）：
 * - pending → running → done → failed 顺序读取首个命中；
 * - 单目录 ENOENT → 下一目录；全部缺失 → undefined；
 * - 非 ENOENT 读取错误 / JSON.parse 失败 → 原样抛出（读取未知 ≠ 不存在）；
 * - shape 无效或 kind !== 'subagent' → 跳过继续；
 * - 只读、无写副作用。
 * 反向：Assembly 不再直引 TASKS_QUEUES_* / validateTaskShape（源码断言）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadSubAgentTask } from '../../../src/core/async-task-system/index.js';
import { resolveTaskResultDir } from '../../../src/core/async-task-system/index.js';
import { makeFullTaskId, makeShortTaskId } from '../../../src/core/async-task-system/types.js';
import type { SubAgentTask } from '../../../src/core/async-task-system/index.js';

const TASK_DIRS = [
  'tasks/queues/pending',
  'tasks/queues/running',
  'tasks/queues/done',
  'tasks/queues/failed',
] as const;

function validTask(id: string): SubAgentTask {
  return {
    kind: 'subagent',
    id: makeFullTaskId(id),
    shortId: makeShortTaskId(id.slice(0, 8)),
    mode: 'standard',
    intent: 'test intent',
    timeoutMs: 300_000,
    maxSteps: 100,
    parentClawId: 'caller-claw',
    createdAt: new Date().toISOString(),
  };
}

/** 目录 → 文件内容 的内存 fs（read 语义：缺失抛 ENOENT，其余原样）。 */
function makeFs(files: Record<string, string>) {
  return {
    read: async (p: string): Promise<string> => {
      if (p in files) return files[p];
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    },
  };
}

const TASK_ID = '550e8401-e29b-41d4-a716-446655440001';

describe('phase 1872 Step D: loadSubAgentTask（owner 单条查询）', () => {
  it('pending 命中优先（命中即返回，不读后续目录）', async () => {
    const task = validTask(TASK_ID);
    const fsImpl = makeFs({
      [`${TASK_DIRS[0]}/${TASK_ID}.json`]: JSON.stringify(task),
      [`${TASK_DIRS[1]}/${TASK_ID}.json`]: JSON.stringify({ ...task, intent: 'should not win' }),
    });
    const found = await loadSubAgentTask(fsImpl, makeFullTaskId(TASK_ID));
    expect(found?.intent).toBe('test intent');
  });

  it('pending 缺失 → 依序回落 running / done / failed', async () => {
    const task = validTask(TASK_ID);
    for (const dir of [TASK_DIRS[1], TASK_DIRS[2], TASK_DIRS[3]]) {
      const fsImpl = makeFs({ [`${dir}/${TASK_ID}.json`]: JSON.stringify(task) });
      const found = await loadSubAgentTask(fsImpl, makeFullTaskId(TASK_ID));
      expect(found?.kind).toBe('subagent');
    }
  });

  it('四目录全缺失 → undefined（缺失不是错误）', async () => {
    const fsImpl = makeFs({});
    expect(await loadSubAgentTask(fsImpl, makeFullTaskId(TASK_ID))).toBeUndefined();
  });

  it('非 ENOENT 读取错误原样抛出（不折 undefined）', async () => {
    const fsImpl = {
      read: async () => {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    };
    await expect(loadSubAgentTask(fsImpl, makeFullTaskId(TASK_ID))).rejects.toThrow('permission denied');
  });

  it('JSON.parse 失败原样抛出（读取未知 ≠ 不存在）', async () => {
    const fsImpl = makeFs({ [`${TASK_DIRS[0]}/${TASK_ID}.json`]: '{ not valid json' });
    await expect(loadSubAgentTask(fsImpl, makeFullTaskId(TASK_ID))).rejects.toThrow();
  });

  it('shape 无效 / kind 非 subagent → 跳过继续（不作命中）', async () => {
    const valid = validTask(TASK_ID);
    // pending 是无效 shape → 跳过；running 是 tool kind → 跳过；done 命中
    const fsImpl = makeFs({
      [`${TASK_DIRS[0]}/${TASK_ID}.json`]: JSON.stringify({ id: 'broken' }),
      [`${TASK_DIRS[1]}/${TASK_ID}.json`]: JSON.stringify({ ...valid, kind: 'tool' }),
      [`${TASK_DIRS[2]}/${TASK_ID}.json`]: JSON.stringify(valid),
    });
    const found = await loadSubAgentTask(fsImpl, makeFullTaskId(TASK_ID));
    expect(found?.kind).toBe('subagent');
    expect(found?.intent).toBe('test intent');
  });

  it('仅 kind 非 subagent（无后续命中）→ undefined', async () => {
    const fsImpl = makeFs({
      [`${TASK_DIRS[0]}/${TASK_ID}.json`]: JSON.stringify({ ...validTask(TASK_ID), kind: 'tool' }),
    });
    expect(await loadSubAgentTask(fsImpl, makeFullTaskId(TASK_ID))).toBeUndefined();
  });

  it('ShortTaskId 同样可查（TaskId union）', async () => {
    const task = validTask(TASK_ID);
    // 目录文件名用 full id；shortId 仅类型面通过（owner 调用面按 fullId 落盘）
    const fsImpl = makeFs({ [`${TASK_DIRS[0]}/${TASK_ID}.json`]: JSON.stringify(task) });
    const found = await loadSubAgentTask(fsImpl, makeShortTaskId(TASK_ID.slice(0, 8)));
    expect(found).toBeUndefined();  // shortId 不是目录文件名 → 缺失（语义：调用方用 fullId）
  });

  it('反向：Assembly 事实读取面不再直引 TASKS_QUEUES_* / validateTaskShape', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const assemblyDir = path.resolve(__dirname, '../../../src/assembly');
    // claw-subdirs.ts 是 Assembly-owned 布局初始化（建目录），非 task 事实读取——
    // 允许列目录常量；其余任何文件出现 TASKS_QUEUES_* 或 validateTaskShape 即违规。
    const layoutInitAllowlist = new Set(['claw-subdirs.ts']);
    const violations: string[] = [];
    for (const entry of fs.readdirSync(assemblyDir)) {
      if (!entry.endsWith('.ts')) continue;
      const content = fs.readFileSync(path.join(assemblyDir, entry), 'utf-8');
      for (const [i, line] of content.split('\n').entries()) {
        if (/\bvalidateTaskShape\b/.test(line)) {
          violations.push(`${entry}:${i + 1}: ${line.trim()}`);
          continue;
        }
        if (!layoutInitAllowlist.has(entry) && /TASKS_QUEUES_(PENDING|RUNNING|DONE|FAILED)_DIR/.test(line)) {
          violations.push(`${entry}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('phase 1879 Step C: resolveTaskResultDir（results 命名空间存在性归 owner）', () => {
  const makeExistsFs = (existing: ReadonlySet<string>) => ({
    existsSync: (p: string): boolean => existing.has(p),
  });

  it('命中 → 返回 clawDir 相对路径（tasks/queues/results/<id>）', () => {
    const fsImpl = makeExistsFs(new Set([`tasks/queues/results/${TASK_ID}`]));
    expect(resolveTaskResultDir(fsImpl, TASK_ID)).toBe(`tasks/queues/results/${TASK_ID}`);
  });

  it('未命中 → null（不存在 ≠ 错误，纯存在性判定）', () => {
    const fsImpl = makeExistsFs(new Set());
    expect(resolveTaskResultDir(fsImpl, TASK_ID)).toBeNull();
  });

  it('只读：不探测其他命名空间（布局知识封装在 owner 内）', () => {
    const seen: string[] = [];
    const fsImpl = { existsSync: (p: string): boolean => { seen.push(p); return false; } };
    expect(resolveTaskResultDir(fsImpl, TASK_ID)).toBeNull();
    expect(seen).toEqual([`tasks/queues/results/${TASK_ID}`]);
  });
});
