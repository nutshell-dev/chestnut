/**
 * phase 1879 Step C: resolveSubagentResultDir（Assembly 跨 owner 组合）。
 *
 * 语义（与迁移前 CLI resolveResultDir 三命名空间探测逐语义等价）：
 * - 探测顺序：async（ATS tasks/queues/results）→ sync（SubAgent tasks/sync/subagent）
 *   → legacy（SubAgent tasks/subagents）；
 * - 首个命中 → clawDir 绝对路径；全部未命中 → null；
 * - 只读；CLI 不再持有命名空间常量/探测逻辑。
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveSubagentResultDir } from '../../src/assembly/index.js';
import type { FileSystem } from '../../src/foundation/fs/index.js';

const CLAW_DIR = '/ws/.chestnut/claws/foo';
const ID = 'task-1';

function makeDeps(existing: ReadonlySet<string>) {
  const seen: string[] = [];
  const clawFs = {
    existsSync: (p: string): boolean => {
      seen.push(p);
      return existing.has(p);
    },
  } as unknown as FileSystem;
  return {
    seen,
    deps: { fsFactory: (baseDir: string): FileSystem => {
      expect(baseDir).toBe(CLAW_DIR);
      return clawFs;
    } },
  };
}

describe('phase 1879 Step C: resolveSubagentResultDir（跨 owner 组合）', () => {
  it('async 命中优先（不再探测 SubAgent 命名空间）', () => {
    const { deps, seen } = makeDeps(new Set([
      `tasks/queues/results/${ID}`,
      `tasks/sync/subagent/${ID}`,
    ]));
    expect(resolveSubagentResultDir(deps, CLAW_DIR, ID)).toBe(path.join(CLAW_DIR, 'tasks/queues/results', ID));
    expect(seen).toEqual([`tasks/queues/results/${ID}`]);
  });

  it('async 未命中 → sync；sync 未命中 → legacy（顺序保持）', () => {
    const { deps, seen } = makeDeps(new Set([`tasks/subagents/${ID}`]));
    expect(resolveSubagentResultDir(deps, CLAW_DIR, ID)).toBe(path.join(CLAW_DIR, 'tasks/subagents', ID));
    expect(seen).toEqual([
      `tasks/queues/results/${ID}`,
      `tasks/sync/subagent/${ID}`,
      `tasks/subagents/${ID}`,
    ]);
  });

  it('全部未命中 → null（错误文案由 CLI 呈现层组合）', () => {
    const { deps } = makeDeps(new Set());
    expect(resolveSubagentResultDir(deps, CLAW_DIR, ID)).toBeNull();
  });
});
