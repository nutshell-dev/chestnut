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
import { SUBAGENT_AUDIT_EVENTS } from '../audit-events.js';
export const DONE_TOOL_NAME = 'done' as const;

/**
 * phase 1858 Step F (SA-D5): per-run 独占 capture channel。
 *
 * 取代 phase 1489 的「Tool 实例携带 capturedResult 字段」设计（该设计在 caller 复用/共享
 * registry 时产生竞争或陈旧 result）：结果由执行侧（done 工具）直接写入本 run 通道、
 * run helper（run.ts）直接读取；工具实例不再持有可变捕获状态。
 */
export interface ResultCaptureChannel<T> {
  set(value: T): void;
  get(): T | undefined;
}

export function createResultCaptureChannel<T>(): ResultCaptureChannel<T> {
  let value: T | undefined;
  return {
    set(v: T): void { value = v; },
    get(): T | undefined { return value; },
  };
}

/**
 * phase 1858 Step H (SA-D7): result tool 的 typed capture 协议形状。
 * 生产侧（本模块 done 工具经 capture channel）恒产出本形状；消费侧（getDisplayResult 与
 * 自定义 resultTool 的遗留读取）在边界按本协议校验。
 */
export interface CapturedResult {
  result: string;
}

export type CaptureParseOutcome =
  | { kind: 'ok'; value: CapturedResult }
  | { kind: 'malformed'; reason: string };

/**
 * 边界验证：捕获原始值（unknown、可能来自非本模块的 result tool）是否合协议。
 * 不合 → 显式 malformed（调用侧登记/回退），不静默折叠成 text。
 */
export function parseCapturedResult(raw: unknown): CaptureParseOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'malformed', reason: `expected object, got ${raw === null ? 'null' : typeof raw}` };
  }
  const candidate = (raw as Record<string, unknown>).result;
  if (typeof candidate !== 'string') {
    return { kind: 'malformed', reason: `result field must be string, got ${candidate === null ? 'null' : typeof candidate}` };
  }
  return { kind: 'ok', value: { result: candidate } };
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
 * capture mechanism：结果写入注入的 per-run 通道（未注入时用实例内建通道 /
 * 供独立使用与测试；runSubagent 路径恒注入本 run 通道）。
 */
export function createDoneTool(capture?: ResultCaptureChannel<{ result: string }>): Tool {
  const channel = capture ?? createResultCaptureChannel<{ result: string }>();
  const tool: Tool = {
    name: DONE_TOOL_NAME,
    profiles: ['subagent'],
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
      // phase 337 M5 (review-2026-06-13): 拒第二次 done 调用、防 LLM 自相矛盾的
      // result 静默覆盖首次。第一次 result 保留为权威；二次调返 tool error + audit。
      const existing = channel.get();
      if (existing !== undefined) {
        ctx.auditWriter?.write(
          SUBAGENT_AUDIT_EVENTS.DONE_TOOL_DUPLICATE_CALL,
          `tool_use_id=${ctx.currentToolUseId ?? ''}`,
          `first_result_len=${existing.result.length}`,
          `second_result_len=${result.length}`,
        );
        return {
          success: false,
          content: 'done() already called; second call rejected. First result is preserved; subagent will exit.',
          error: 'duplicate done call',
        };
      }
      // 写入本 run capture 通道给 runSubagent 取
      channel.set({ result });
      // phase 1459 α-5: delegate to narrow helper（仅 ExecutionControl 子接口 sufficient）。
      // phase 777: hard-stop agent loop (kimi-k2.6 audit shows ~30 wasted LLM calls without this)
      return captureDoneResult(result, ctx);
    },
  };
  return tool;
}
