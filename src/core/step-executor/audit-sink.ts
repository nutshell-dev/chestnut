/**
 * @module L3.StepExecutor.EventSink
 * phase 1857 Step I (SE-D9): StepExecutor 单一事件出口。
 *
 * 裁决事实经本结构化 sink 恰好发出一次；展示（callbacks）与持久化（audit 行，
 * 含 contract_id/trace_id 身份绑定）由 caller adapter 组合（模式对齐 1856 Step I
 * 的 agent-executor-audit-sink）。step-executor 内不再 callback+audit 双写。
 *
 * 实现契约：sink 方法不得向上抛错——展示失败经 safeCallback 留证不终止 step；
 * 持久化失败经 writeAuditGuarded 最后手段留证（SE-D4：审计失败不改变被记录失败）。
 * 协议类型经 barrel 导出（caller adapter 在 agent-executor 实现，同 AE event-sink 惯例）。
 */

/** 展示载荷全量透传的 LLM 调用事实（结构性兼容 types.ts 的 LLMCallInfo）。 */
export interface StepEventLlmCallInfo {
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string;
}

/** orphan prebuilt drop 的单项（content 为全文，截断/预览归消费侧）。 */
export interface StateAOrphanItem {
  toolUseId: string;
  isError: boolean;
  content: string;
}

export interface StepExecutorEventSink {
  /** args 解析失败（flush/finalize/missing-required 三站点同型）。 */
  toolInputParseFailed(e: { toolName: string; toolUseId: string; reason: string; summary: string }): void;
  /** 工具执行可呈现失败（ToolError 面；含 timeout）。 */
  toolExecutionFailed(e: { toolName: string; toolUseId: string; errorType: string; errorMsg: string }): void;
  /** partial assistant content 丢弃决策（catch 路径，原 err 随后原样抛出）。 */
  partialAssistantDiscarded(e: {
    cause: string;
    toolUseCount: number;
    hasText: boolean;
    hasThinking: boolean;
    /** 预格式化 `start-end`（ts 取值在产生侧）。 */
    tsRange: string;
    errMessage: string;
  }): void;
  /** B 级 callback 失败留证（safeCallback  machinery）。 */
  callbackFailed(e: { label: string; error: string }): void;
  llmEmptyResponse(e: { stopReason: string }): void;
  llmUnknownStopReason(e: { stopReason: string }): void;
  unparseableToolUse(e: { stopReason: string }): void;
  maxTokensAssistantEmptySkipped(e: { llm: StepEventLlmCallInfo }): void;
  /** State A orphan drop：一次事件；消费侧展示一次 + 按 orphan 逐行持久化。 */
  maxTokensStateAOrphanDrop(e: { orphans: StateAOrphanItem[]; llm: StepEventLlmCallInfo }): void;
  maxTokensPrebuiltOnlyFinal(e: { prebuiltCount: number; llm: StepEventLlmCallInfo }): void;
  /** 系统不变量（无对应 callback 的纯审计行）。 */
  invariantViolation(e: { site: string; kind: string; msg: string; reason?: string; index?: number }): void;
}
