# StepExecutor 接口契约

L3 单步执行器。调用一次 LLM，若返回 tool_use 则执行工具，把消息追加到会话，返回停止信号 + 可观测元数据。

归属：L3 执行与连接。唯一消费者：AgentExecutor。

## 职责边界

### 做

1. 调用一次 LLM（流式，含 thinking/text/tool_use 事件）
2. 若 LLM 返回 `tool_use`：按 readonly/sync 分组执行工具（readonly+sync 并行，其余串行）
3. 把 assistant 消息（含 tool_use）与 tool_result 追加到 messages（in-place）
4. 处理 `max_tokens` 截断 tool_use 的修复（补 `[TRUNCATED]` tool_result）
5. 返回本步结果信号 + 可观测元数据

### 不做

- 不维护跨步计数器（stepCount / consecutiveParseErrors / consecutiveMaxTokensToolUse）
- 不做落盘（SessionStore 由 AgentExecutor 调）
- 不处理 MaxStepsExceeded（归 AgentExecutor）
- 不读写 audit.tsv（归 AuditLog；回调透传）

## 接口

### `StepInput`

```ts
interface StepInput {
  messages: Message[];              // in-place 修改
  systemPrompt: string;
  tools: ToolDefinition[];
  executor: IToolExecutor;
  registry?: ToolRegistry;          // 可选；缺省时放弃 readonly+sync 并行优化，全部走 sequential
  ctx: ExecContext;                 // 含 signal、stepNumber（由 AgentExecutor 同步）
  maxTokens?: number;               // 默认 REACT_DEFAULT_MAX_TOKENS
  callbacks?: StepCallbacks;        // 聚合回调对象（可选）
}
```

11 个平铺回调收敛成单一 `StepCallbacks` 对象。

### `StepCallbacks`

```ts
interface StepCallbacks {
  onBeforeLLMCall?: () => void;
  onLLMResult?: (info: LLMCallInfo) => void;
  onTextDelta?: (delta: string) => void;
  onTextEnd?: () => void;
  onThinkingDelta?: (delta: string) => void;
  onToolCall?: (toolName: string, toolUseId: string) => void | Promise<void>;
  onToolResult?: (toolName: string, toolUseId: string, result: ToolResult) => void;
  onReset?: (provider: string, timeoutMs: number) => void;
  onProviderFailed?: (provider: string, model: string, error: string) => void;
}
```

- 不含 `onStepComplete`（落盘归 AgentExecutor）
- `onToolResult` 不带 step/maxSteps 参数（循环语义归 AgentExecutor）
- 回调 safe-wrap 策略（I/O 边界包裹，流内热路径裸调）：

| 回调 | safe-wrap | 说明 |
|---|---|---|
| `onBeforeLLMCall` | ✅ | I/O 边界；warn 不抛 |
| `onToolCall` | ✅ | I/O 边界；warn 不抛 |
| `onToolResult` | ✅ | I/O 边界；warn 不抛 |
| `onLLMResult` | ❌ 裸调 | 观察性回调；异常冒泡终止 step |
| `onTextDelta` / `onTextEnd` / `onThinkingDelta` | ❌ 裸调 | 流内热路径；异常冒泡终止 step |
| `onReset` / `onProviderFailed` | ❌ 裸调 | 流内告警；异常冒泡终止 step |

取舍：流式 chunk 每次触发的回调不 safe-wrap，避免每 chunk try/catch 的性能与语义噪音；跨 I/O 边界的回调必须 safe-wrap，防止上层回调 bug 污染工具执行流程。

### `StepResult`

```ts
type StepResult =
  | { kind: 'final'; stopReason: 'end_turn' | 'max_tokens_text' | 'no_tool' | 'unknown'; finalText: string }
  | { kind: 'continue'; meta: StepMeta }
  | { kind: 'max_tokens_tool_use'; meta: StepMeta }    // 补了 TRUNCATED tool_result，不计 step
  | { kind: 'context_window_exceeded' };               // AgentExecutor 抛错

interface StepMeta {
  toolCallCount: number;
  parseErrorCount: number;         // 供 AgentExecutor 做 consecutiveParseErrors 判定
  allParseErrors: boolean;         // 等价 toolCallCount>0 && parseErrorCount===toolCallCount
  llm: LLMCallInfo;
}
```

- `kind: 'continue'` vs `'max_tokens_tool_use'` 拆开：AgentExecutor 据此决策是否累 stepCount、是否 onStepComplete
- `allParseErrors` 是跨模块耦合元数据，显式放入 meta
- `context_window_exceeded` 由 StepExecutor 识别，AgentExecutor 决定抛什么错

## 失败语义

| 失败源 | StepExecutor 行为 |
|---|---|
| signal.aborted（LLM 调用前/中/工具执行后） | 抛 `IdleTimeoutSignal` / `PriorityInboxInterrupt` / `UserInterrupt`（从 signal.reason 派生） |
| LLM provider 抛错 | 回调 onLLMResult（带 error），原样抛出 |
| 工具内部抛错 | 吞掉转成 `ToolResult { success: false, content: "[ErrorType] ..." }`（不抛） |
| 工具输入 JSON parse 失败 | 返回 `metadata.parseError=true` 的 ToolResult，计入 parseErrorCount |
| LLM 返回空 content | console.warn，按 stop_reason 分支处理 |

## 不可消除的耦合（显式表达）

1. **跨步计数元数据**：`StepMeta.parseErrorCount` / `allParseErrors` 是 AgentExecutor 做 consecutive 判定的输入。parse error 的判定必须基于单步 ToolResult.metadata，只有 StepExecutor 能看见；熔断决策必须跨步，只有 AgentExecutor 能做。
2. **max_tokens + tool_use 双重职责**：StepExecutor 负责"补 TRUNCATED tool_result"的单步动作，AgentExecutor 负责"不累 stepCount、连续熔断"的循环决策。`kind` 字段作为显式边界。
3. **ctx.signal 双向**：AgentExecutor 持有 AbortController，StepExecutor 消费 ctx.signal；StepExecutor 不调 `ctx.incrementStep()`（由 AgentExecutor 负责）。
