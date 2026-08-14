/**
 * status tool — agent-facing self-introspection.
 *
 * 行内职责：聚合 view（调 aggregator）+ 关键 error 写 audit + format 文本。
 * 业务聚合本身归 `aggregators.ts`（CLI `claw <name> status` 共用）。
 */

import type { Tool, ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { ContractSystem } from '../contract/index.js';
import { STATUS_AUDIT_EVENTS } from './audit-events.js';
import {
  computeContractView,
  computeTaskView,
  computeStorageView,
  formatContractView,
  formatTaskView,
  formatStorageView,
} from './aggregators.js';

// merge note (phase 1472 ← main phase 1468)：
// main side（phase 1468）re-export 3 内联 helper（getContractStatus / getTaskStatus /
// getStorageStatus）作 `__test_*` 测试 surface（F9 audit-2026-05-30）。phase 1472 Step A
// refactor 已把这 3 helper 抽成 `aggregators.ts` 中 pure function (computeContractView /
// computeTaskView / computeStorageView) + format helper、tests/core/status-service/
// aggregators.test.ts 14 case 覆盖等价计算逻辑（含 ENOENT / FS_NOT_FOUND silent + 错误折进 view）。
// audit-emission 路径（pure aggregator 不写 audit、由本 wrapper 写）由
// status-tool-helpers.test.ts 重写为 createStatusTool integration test 保持 phase 1468
// F9 cov 意图（CONTRACT_ERROR / TASK_PENDING_ERROR / TASK_RUNNING_ERROR 三条 audit emit）。

export const STATUS_TOOL_NAME = 'status' as const;

/**
 * createStatusTool —— 单参数；phase 1392 Step B 起 motion guidance 尾段退场
 * （claw 状态查询 hints 与 summon=异步函数心智模型冲突：任务状态经契约通知
 * 的 trace/show affordance 查询、不预灌 claw 命令清单）。
 */
export function createStatusTool(contractSystem: ContractSystem): Tool {
  return {
    name: STATUS_TOOL_NAME,
    profiles: ['full', 'readonly'],
    description:
      'Get comprehensive status: Claw ID, profile, step count, active contract with full subtask list (id/description/status), tasks, storage (MEMORY.md, clawspace). Call at turn start to re-orient after restart.',
    schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    readonly: true,
    idempotent: true,

    async execute(_args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      const lines = [
        `Claw ID: ${ctx.clawId}`,
        `Profile: ${ctx.profile}`,
        `Step: -/-`,
        `Elapsed: ${ctx.getElapsedMs()}ms`,
      ];

      const contractView = await computeContractView(contractSystem);
      if (contractView.type === 'error') {
        ctx.auditWriter?.write(STATUS_AUDIT_EVENTS.CONTRACT_ERROR, `error=${contractView.message}`);
      }
      lines.push(formatContractView(contractView));

      const taskView = await computeTaskView(ctx.fs);
      if (taskView.type === 'counts') {
        if (taskView.pendingError) {
          ctx.auditWriter?.write(STATUS_AUDIT_EVENTS.TASK_PENDING_ERROR, `error=${taskView.pendingError}`);
        }
        if (taskView.runningError) {
          ctx.auditWriter?.write(STATUS_AUDIT_EVENTS.TASK_RUNNING_ERROR, `error=${taskView.runningError}`);
        }
      }
      lines.push(formatTaskView(taskView));

      const storageView = await computeStorageView(ctx.fs);
      lines.push(...formatStorageView(storageView));

      return {
        success: true,
        content: lines.join('\n'),
      };
    },
  };
}
