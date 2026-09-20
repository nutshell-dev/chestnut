/**
 * phase 1879 Step C: resolveSubagentRunDir（SubAgent 两命名空间存在性归 owner）。
 *
 * 语义（与迁移前 CLI resolveResultDir 的 sync/legacy 段逐语义等价）：
 * - sync（tasks/sync/subagent）优先、legacy（tasks/subagents）次之；
 * - 首个命中返回 clawDir 相对路径；全部未命中 → null；
 * - 只读、无写副作用。
 */
import { describe, it, expect } from 'vitest';
import { resolveSubagentRunDir } from '../../../src/core/subagent/index.js';

const ID = 'verifier-c1-s1';

function makeExistsFs(existing: ReadonlySet<string>) {
  const seen: string[] = [];
  return {
    seen,
    existsSync: (p: string): boolean => {
      seen.push(p);
      return existing.has(p);
    },
  };
}

describe('phase 1879 Step C: resolveSubagentRunDir（owner 两命名空间查询）', () => {
  it('sync 命中优先（不再探测 legacy）', () => {
    const fsImpl = makeExistsFs(new Set([
      `tasks/sync/subagent/${ID}`,
      `tasks/subagents/${ID}`,
    ]));
    expect(resolveSubagentRunDir(fsImpl, ID)).toBe(`tasks/sync/subagent/${ID}`);
    expect(fsImpl.seen).toEqual([`tasks/sync/subagent/${ID}`]);
  });

  it('sync 未命中 → legacy 回落', () => {
    const fsImpl = makeExistsFs(new Set([`tasks/subagents/${ID}`]));
    expect(resolveSubagentRunDir(fsImpl, ID)).toBe(`tasks/subagents/${ID}`);
    expect(fsImpl.seen).toEqual([`tasks/sync/subagent/${ID}`, `tasks/subagents/${ID}`]);
  });

  it('全部未命中 → null', () => {
    const fsImpl = makeExistsFs(new Set());
    expect(resolveSubagentRunDir(fsImpl, ID)).toBeNull();
  });
});
