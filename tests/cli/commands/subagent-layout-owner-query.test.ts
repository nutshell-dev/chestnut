/**
 * phase 1879 Step C (cli-subagent-layout-probing): 布局/格式理解归 owner source-scan。
 *
 * - subagent-steps.ts：三命名空间存在性探测 → Assembly 组合查询（resolveSubagentResultDir），
 *   不再持 ATS/SubAgent 命名空间常量与探测逻辑；
 * - session-parser.ts：dialog 当前/归档两态读取 → DialogStore owner 查询（loadSessionFile），
 *   不再有 JSON.parse(readSync(...)) 原始读。
 *
 * 形态对齐 tests/cli/steps-hint-invariant.test.ts 的 src source-scan 先例。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

describe('phase 1879 Step C: subagent/dialog 布局探测归 owner', () => {
  it('subagent-steps.ts 不再持命名空间常量/探测，消费 Assembly 组合查询', () => {
    const src = readSrc('src/cli/commands/subagent-steps.ts');
    for (const banned of ['TASKS_QUEUES_RESULTS_DIR', 'TASKS_SYNC_SUBAGENT_DIR', 'TASKS_SUBAGENTS_DIR']) {
      expect(src, banned).not.toContain(banned);
    }
    expect(src).toContain('resolveSubagentResultDir');
    expect(src).toContain("from '../../assembly/index.js'");
  });

  it('session-parser.ts 不再 JSON.parse(readSync) 直读，消费 DialogStore owner 查询', () => {
    const src = readSrc('src/cli/commands/session-parser.ts');
    expect(src).not.toContain('readSync(');
    expect(src).not.toContain('JSON.parse(');
    expect(src).not.toContain('findLatestArchiveSync');
    expect(src).toContain('loadSessionFile');
    expect(src).toContain("from '../../foundation/dialog-store/index.js'");
  });

  it('owner 查询面经各 barrel 导出（CLI 只消费 barrel）', () => {
    expect(readSrc('src/foundation/dialog-store/index.ts')).toContain('loadSessionFile');
    expect(readSrc('src/core/async-task-system/index.ts')).toContain('resolveTaskResultDir');
    expect(readSrc('src/core/subagent/index.ts')).toContain('resolveSubagentRunDir');
    expect(readSrc('src/assembly/index.ts')).toContain('resolveSubagentResultDir');
  });
});
