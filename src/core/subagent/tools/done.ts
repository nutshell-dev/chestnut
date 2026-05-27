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

import type { Tool, ExecContext } from '../../../foundation/tools/index.js';
import type { ToolResult } from '../../../foundation/tool-protocol/index.js';
export const DONE_TOOL_NAME = 'done' as const;

/**
 * 通用 done 工具
 * capturedResult mechanism：tool instance 自身存 `capturedResult` 字段 / runSubagent 取
 */
export function createDoneTool(): Tool & { capturedResult?: { result: string } } {
  const tool: Tool & { capturedResult?: { result: string } } = {
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
      // phase 777: hard-stop agent loop (kimi-k2.6 audit shows ~30 wasted LLM calls without this)
      ctx.requestStop();
      return {
        success: true,
        content: `Result captured (${result.length} chars). Agent will exit.`,
      };
    },
  };
  return tool;
}
