/**
 * ReAct loop - **facade pattern (long-term ratify per phase 1180 r129 E fork)**
 *
 * phase 1856 (AE-D8): 对外 API 改命名最小组合协议 —— ReactOptions 持
 * `stepCallbacks?: ReactStepCallbacks`（StepExecutor 契约的命名组合，编译器保证
 * 字段完整、StepCallbacks 演化时消费方编译期提示），不再平铺复制二十余项回调；
 * step/maxSteps 追加参数适配保留在本 facade 唯一适配点。
 * 内部 adapt 到新契约：StepCallbacks（给 StepExecutor） + onAfterStep（给 AgentExecutor）。
 * 真实实现见 step-executor.ts 和 agent-executor.ts。
 *
 * **NOT a transitional shim** — runtime.ts 1 site + subagent 1 site 真生产依赖、tests/ mock + import
 * facade-pattern 长留稳定、0 sunset 计划 / 升档锚：if NEW caller 同型组合需求出现 N≥2
 * → 抽 generic `ReactFacade` (per phase 1180 升档锚 (a))
 */

import type { ToolDefinition, ToolUseId } from '../../foundation/llm-provider/index.js';
import type { Message } from '../../foundation/dialog-store/index.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { ExecContext } from '../../foundation/tools/index.js';
import type { ToolResult } from '../../foundation/tool-protocol/index.js';
import type { IToolExecutor, ToolRegistry } from '../../foundation/tools/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';

import { DEFAULT_MAX_STEPS } from './defaults.js';
import { runAgent } from './agent-executor.js';
import type { StepCallbacks, FinalStopReason } from '../step-executor/index.js';

import type { TurnEventCommitDeps } from './turn-event-commit.js';


/**
 * phase 1856 (AE-D8): StepExecutor 契约的命名组合。
 * 除下列两项外与 StepCallbacks 逐字段一致（Omit 直通、StepCallbacks 演化编译期同步）；
 * onToolCallInput/onToolResult 由本 facade 唯一适配点追加 step(/maxSteps) 参数。
 */
export type ReactStepCallbacks = Omit<StepCallbacks, 'onToolCallInput' | 'onToolResult'> & {
  /** phase 1411: fires when tool args fully parsed (post-stream, pre-execute). Facade 追加 step 参数。 */
  onToolCallInput?: (toolName: string, toolUseId: ToolUseId, args: Record<string, unknown>, step: number) => void;
  onToolResult?: (toolName: string, toolUseId: ToolUseId, result: ToolResult, step: number, maxSteps: number) => void;
};

export interface ReactOptions {
  messages: Message[];
  systemPrompt: string;
  llm: LLMOrchestrator;
  executor: IToolExecutor;
  ctx: ExecContext;
  maxSteps?: number;
  maxConsecutiveParseErrors?: number;
  maxConsecutiveMaxTokensToolUse?: number;
  idleTimeoutMs?: number;
  wallTimeDeadlineMs?: number;
  /** phase 1856 (AE-D8): StepExecutor 契约的命名组合（编译器保证字段完整）。 */
  stepCallbacks?: ReactStepCallbacks;
  /** phase 706: receives the step count after a successful step for caller persistence/audit. */
  onStepComplete?: (stepCount: number) => Promise<void>;
  tools?: ToolDefinition[];
  registry?: ToolRegistry;
  // phase 706: AgentExecutor needs audit writer + per-turn contract id for tool_call_input.
  auditWriter?: AuditLog;
  currentContractId?: string;
  /** Minimal stream sink used only for AgentExecutor-owned turn event commits. */
  streamCallbacks?: TurnEventCommitDeps;
  // phase 690: 撤 dialogStore + contextManagerConfig — proactive trim
  // 上提到 L5 Runtime 反应式 retry 路径、loop.ts facade 不再透传。
}

export interface ReactResult {
  finalText: string;
  stepsUsed: number;
  // phase 788: 'unknown' propagate（audit-2026-05-14 P0.15）
  // LLM 返 unrecognized stop_reason（refusal、safety、stop_sequence 等）经 step-executor 映射 'unknown'，本字段保留区分 true end_turn。
  // phase 1483: 'content_filter' 字面单独保留（不再折叠为 'unknown'）— Design Principle「运行中信息不丢弃」+ 唯一 caller subagent/agent.ts:411 仅 appendToLog 字符串拼接安全。
  stopReason: 'end_turn' | 'no_tool' | 'max_tokens' | 'content_filter' | 'unknown';
}

export async function runReact(options: ReactOptions): Promise<ReactResult> {
  const {
    messages, systemPrompt, llm, executor, ctx,
    maxSteps = DEFAULT_MAX_STEPS,
    maxConsecutiveParseErrors,
    maxConsecutiveMaxTokensToolUse,
    idleTimeoutMs,
    wallTimeDeadlineMs,
    stepCallbacks,
    onStepComplete,
    tools = [],
    registry,
    auditWriter,
    currentContractId,
  } = options;

  // 用闭包捕获 stepCount（onToolCallInput/onToolResult 的 step/maxSteps 追加参数——唯一适配点；
  // 其余字段 spread 直通，StepCallbacks 演化时编译器在消费方提示）
  let stepCount = 0;
  const onToolCallInput = stepCallbacks?.onToolCallInput;
  const onToolResult = stepCallbacks?.onToolResult;

  const adaptedStepCallbacks: StepCallbacks = {
    ...stepCallbacks,
    onToolCallInput: onToolCallInput
      ? (name, toolUseId, args) => onToolCallInput(name, toolUseId, args, stepCount)
      : undefined,
    onToolResult: onToolResult
      ? (name, toolUseId, result) => onToolResult(name, toolUseId, result, stepCount, maxSteps)
      : undefined,
  };

  const result = await runAgent({
    messages, systemPrompt, llm, tools, executor, registry, ctx,
    maxSteps,
    maxConsecutiveParseErrors,
    maxConsecutiveMaxTokensToolUse,
    idleTimeoutMs,
    wallTimeDeadlineMs,
    stepCallbacks: adaptedStepCallbacks,
    auditWriter,
    currentContractId,
    streamCallbacks: options.streamCallbacks,
    onAfterStep: async (_meta, newStepCount) => {
      stepCount = newStepCount;  // AgentExecutor 已执行步进
      if (onStepComplete) await onStepComplete(stepCount);
    },
  });

  return {
    finalText: result.finalText,
    stepsUsed: result.stepsUsed,
    stopReason: mapStopReason(result.stopReason),
  };
}

function mapStopReason(
  r: FinalStopReason
): 'end_turn' | 'no_tool' | 'max_tokens' | 'content_filter' | 'unknown' {
  // phase 398 Step C (review N8): switch + assertNever default — 新 FinalStopReason
  // 变体编译期失败 (vs phase 1483 / 788 if-cascade + 'end_turn' default 静默折叠)。
  switch (r) {
    case 'max_tokens_text': return 'max_tokens';
    case 'no_tool': return 'no_tool';
    case 'content_filter': return 'content_filter';   // phase 1483 distinct propagate
    case 'unknown': return 'unknown';                 // phase 788 distinct propagate
    case 'end_turn':
    case 'stop':
      return 'end_turn';  // 'end_turn' 与 'stop' 均映射为 'end_turn'（向后兼容 shim）
    default: {
      const _exhaustive: never = r;
      return _exhaustive;
    }
  }
}
