/**
 * done tool - Generic subagent result submission
 *
 * phase 765：通用子代理结果提交工具 / 替原 ContractSystem 申请验收的 done（已迁 submit_subtask）。
 * 自身即标准 result-capture 工具（phase 1056 清除 report_result）。
 *
 * 用例：
 * - shadow tool D5 γ 路径：shadow 内 LLM 调 done(result=...) 显式退出 / runSubagent 取 capturedResult.result 返主代理
 * - spawn subagent（可选）：subagent 显式 done(result=...) 替代末条 text fallback
 */

import type { Tool, ExecContext, ExecutionControl } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
export const DONE_TOOL_NAME = 'done' as const;

/**
 * phase 1489: M#9 显式表达「Tool 实例携带 captured result 回 caller」这条不可消除的耦合。
 * caller (run.ts) 凭 registry.get(name) 拿 Tool 后读 capturedResult / 类型推断成立、不需 `as` 断言绕过编译器。
 */
export interface CapturableTool<T = unknown> {
  capturedResult?: T;
}

/**
 * phase 1459 α-5 ISP narrow helper: done 真依赖仅 `ctx.requestStop` → `ExecutionControl` 子接口 sufficient。
 * Tool.execute 签名保完整 ExecContext（implements Tool 兼容性约束）、内部 delegate 到 narrow ctx。
 * 收益：编译期 audit 真依赖范围 / 测试 fixture 可只 mock `{ requestStop }` / 未来如 stopRequested 迁出可静态 trace。
 */
function captureDoneResult(
  result: string,
  ctx: ExecutionControl,
): ToolResult {
  ctx.requestStop();
  return {
    success: true,
    content: `Result captured (${result.length} chars). Agent will exit.`,
  };
}

/**
 * 通用 done 工具
 * capturedResult mechanism：tool instance 自身存 `capturedResult` 字段 / runSubagent 取
 */
export function createDoneTool(): Tool & CapturableTool<{ result: string }> {
  const tool: Tool & CapturableTool<{ result: string }> = {
    name: DONE_TOOL_NAME,
    profiles: ['subagent'],
    group: 'subagent-protocol',
    description: 'Submit your final result and exit. ' +
      'Use when your task is complete and you have a result to return to the caller. ' +
      'After calling done, no further tool use is expected.',
    schema: {
      type: 'object',
      properties: {
        result: {
          type: 'string',
          description: 'Your final result text (will be returned verbatim to the caller).',
        },
      },
      required: ['result'],
    },
    readonly: false,
    idempotent: false,

    async execute(args: Record<string, unknown>, ctx: ExecContext): Promise<ToolResult> {
      const result = String(args.result ?? '');
      if (!result) {
        return { success: false, content: 'done: result is required', error: 'missing result' };
      }
      // 存 capturedResult 给 runSubagent 取
      tool.capturedResult = { result };
      // phase 1459 α-5: delegate to narrow helper（仅 ExecutionControl 子接口 sufficient）。
      // phase 777: hard-stop agent loop (kimi-k2.6 audit shows ~30 wasted LLM calls without this)
      return captureDoneResult(result, ctx);
    },
  };
  return tool;
}
