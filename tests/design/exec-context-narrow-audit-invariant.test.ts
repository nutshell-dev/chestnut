/**
 * Phase 1459 α-6 — ExecContext narrow opportunity audit invariant
 *
 * 目的：grep-based 静态 audit / 报告每个 tool 文件消费 `ctx.X` 字段及该字段所属子接口（5 dim 之一）
 * + maintain a baseline snapshot of which tools have narrowed (per α-5 demo) vs which are wide。
 *
 * **本测试不强制 narrow**（α-6 lint hard enforce 留 Meta 候选）；
 * 但提供 visibility：新工具 PR 时 reviewer 可对照基线核「真依赖窄」是否对应 narrow helper / 直接 narrow ctx 类型断言。
 *
 * 字段 → 子接口 mapping（phase 1459 α-1 / 详 `coding plan/phase1455/Step B — design ExecContext ISP.md` §2.1）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/** D1 ClawIdentity */
const D1_FIELDS = new Set([
  'clawId', 'clawDir', 'clawsDir', 'workspaceDir', 'syncDir',
]);
/** D2 ToolPermissions */
const D2_FIELDS = new Set([
  'profile', 'allowedGroups', 'callerLabel', 'permissionChecker',
]);
/** D3 ExecutionInfra */
const D3_FIELDS = new Set([
  'fs', 'fsFactory', 'llm', 'registry', 'taskSystem',
]);
/** D4 ExecutionControl */
const D4_FIELDS = new Set([
  'signal', 'toolTimeoutMs',
  'stopRequested', 'requestStop', 'getElapsedMs',
]);
/** D5 ExecutionAudit */
const D5_FIELDS = new Set([
  'auditWriter', 'currentToolUseId', 'trace_id', 'readFileState', 'persistReadFileState', 'getCallerSnapshot', 'subagentTaskId',
]);

function classifyField(field: string): string {
  if (D1_FIELDS.has(field)) return 'D1.ClawIdentity';
  if (D2_FIELDS.has(field)) return 'D2.ToolPermissions';
  if (D3_FIELDS.has(field)) return 'D3.ExecutionInfra';
  if (D4_FIELDS.has(field)) return 'D4.ExecutionControl';
  if (D5_FIELDS.has(field)) return 'D5.ExecutionAudit';
  return 'Unknown';
}

function listToolFiles(): string[] {
  const out: string[] = [];
  const roots = [
    'src/foundation/file-tool',
    'src/foundation/command-tool',
    'src/foundation/messaging/tools',
    'src/foundation/skill-system/tools',
    'src/core/contract/tools',
    'src/core/spawn-system/tools',
    'src/core/summon-system/tools',
    'src/core/shadow-system/tools',
    'src/core/subagent/tools',
    'src/core/memory/tools',
    'src/core/async-task-system/tools',
    'src/core/claw-topology/tools',
    'src/core/gateway',
    'src/core/status-service',
  ];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    const entries = fs.readdirSync(r);
    for (const e of entries) {
      if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(path.join(r, e));
    }
  }
  return out;
}

function getCtxFields(src: string): string[] {
  const matches = src.match(/ctx\.[a-zA-Z_]+/g) ?? [];
  return Array.from(new Set(matches.map(m => m.substring(4))));
}

describe('phase 1459 α-6 ExecContext narrow opportunity audit', () => {
  const files = listToolFiles().filter(f =>
    fs.readFileSync(f, 'utf-8').includes('ctx: ExecContext')
  );

  it('(1) every ctx.X field reference must classify into a known dim (no Unknown drift)', () => {
    const unknownFields: { file: string; field: string }[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      const fields = getCtxFields(src);
      for (const f of fields) {
        if (classifyField(f) === 'Unknown') {
          unknownFields.push({ file, field: f });
        }
      }
    }
    expect(unknownFields).toEqual([]);
  });

  it('(2) baseline snapshot: tool → consumed dim set (informational)', () => {
    const report: Record<string, string[]> = {};
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf-8');
      const fields = getCtxFields(src);
      const dims = Array.from(new Set(fields.map(classifyField))).sort();
      if (dims.length > 0) report[file] = dims;
    }
    // 基线 assertion：至少存在已 narrow demo 3 个（phase 1459 α-5）+ notify-claw（本 phase 续）
    // 这些 file 真依赖 dim set 应 ≤ 2 个 dim
    const narrowDemos = [
      'src/core/subagent/tools/done.ts',
      'src/core/memory/tools/memory_search.ts',
      'src/foundation/skill-system/tools/skill.ts',
      'src/core/claw-topology/tools/notify-claw.ts',
    ];
    for (const demo of narrowDemos) {
      const dims = report[demo];
      expect(dims, `${demo} should have narrow-able dim set`).toBeDefined();
      expect(dims.length, `${demo} dim count`).toBeLessThanOrEqual(2);
    }
  });

  it('(3) 5 sub-interfaces export covered (regression)', () => {
    const indexSrc = fs.readFileSync('src/foundation/tools/index.ts', 'utf-8');
    expect(indexSrc).toContain('ClawIdentity');
    expect(indexSrc).toContain('ToolPermissions');
    expect(indexSrc).toContain('ExecutionInfra');
    expect(indexSrc).toContain('ExecutionControl');
    expect(indexSrc).toContain('ExecutionAudit');
  });
});
