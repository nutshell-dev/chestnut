# AgentExecutor 接口契约

L3 完整 agent 执行驱动。反复调 StepExecutor 跑单步，每次 LLM 调用后通过 SessionStore 落盘，直到停止信号。

归属：L3 执行与连接。依赖：StepExecutor, SessionManager（可选）。被调用：Runtime（常驻 agent）、SubagentSystem（一次性子代理）。

## 职责边界

### 做

1. 循环调 StepExecutor，直到 `kind: 'final'` 或异常
2. 维护跨步计数：stepCount、consecutiveParseErrors、consecutiveMaxTokensToolUse
3. 若提供 sessionStore，每次 `kind: 'continue'` 后**直接调 SessionManager 落盘**（不走回调）
4. stepCount 达 maxSteps 抛 `MaxStepsExceededError`
5. 连续熔断判定（parse errors / max_tokens tool_use）
6. ctx.signal 跨步检查
7. 每步完成后调 `onAfterStep` 钩子（调用方在此注入 step_yield 判定）

### 不做

- 不调 LLM、不执行工具（归 StepExecutor）
- 不做 idle timeout（归 Runtime：它持有 AbortController，基于 StepCallbacks delta 回调维护计时器）
- 不读写 audit.tsv（调用方透传回调到 StepExecutor）
- 不管 turn 语义 / snapshot commit / turn counter（归 Runtime）
- 不读 inbox（step_yield 判定归调用方）

## 接口

### `runAgent(input: AgentInput): Promise<AgentResult>`

```ts
interface AgentInput {
  messages: Message[];              // in-place；调用方传入（通常来自 SessionManager.load）
  systemPrompt: string;
  tools: ToolDefinition[];
  executor: IToolExecutor;
  registry?: ToolRegistry;          // 可选；透传给 StepExecutor
  ctx: ExecContext;                 // signal 由调用方注入（AbortController）

  sessionStore?: SessionManager;    // 可选；不传则跳过每步落盘（SubAgent 场景）

  maxSteps?: number;                // 默认 20
  maxTokens?: number;               // 透传给 StepExecutor
  stepCallbacks?: StepCallbacks;    // 透传给 StepExecutor
  onAfterStep?: (meta: StepMeta) => void | Promise<void>;  // 每步完成（含落盘）后触发
}

interface AgentResult {
  finalText: string;
  stepsUsed: number;
  stopReason: 'end_turn' | 'max_tokens_text' | 'no_tool' | 'unknown';
}
```

### `onAfterStep` 的角色

- **时机**：`kind: 'continue'` 分支中，`sessionStore.save` **完成之后**、`stepCount++` **之后**
- **不触发时机**：`kind: 'max_tokens_tool_use'`（本步不计、不落盘）、`kind: 'final'`（直接返回）
- **用途**：Runtime 在此检查高优先级 inbox 并 `abortController.abort({ type: 'step_yield' })`
- **约束**：回调内部抛错不吞（让 AgentExecutor 抛出终止循环）；回调 abort ctx.signal 后，下一轮 step 开头会被 StepExecutor 识别并抛 `PriorityInboxInterrupt`

## 失败语义

| 触发源 | AgentExecutor 行为 |
|---|---|
| stepCount 达到 maxSteps | 抛 `MaxStepsExceededError(maxSteps)` |
| StepExecutor 抛 IdleTimeoutSignal / PriorityInboxInterrupt / UserInterrupt | 原样往上抛 |
| StepExecutor 返回 `kind: 'context_window_exceeded'` | 抛 `Error('LLM context window exceeded...')` |
| 连续 MAX_CONSECUTIVE_PARSE_ERRORS 步 allParseErrors | 抛 `Error('工具输入 JSON 连续解析失败...')` |
| 连续 MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE 次 max_tokens_tool_use | 抛 `Error('LLM 连续 ... 次 max_tokens 截断 tool_use...')` |
| SessionManager.save 抛错 | 原样抛出（落盘失败不可恢复） |
| onAfterStep 抛错 | 原样抛出 |

## StepExecutor 接合点

| StepExecutor 返回 | AgentExecutor 行为 |
|---|---|
| `kind: 'final'` | 返回 AgentResult，结束 |
| `kind: 'continue'` | sessionStore.save → stepCount++ → 检查 maxSteps → onAfterStep → 更新 consecutiveParseErrors → 下一轮 |
| `kind: 'max_tokens_tool_use'` | 不落盘、不 stepCount++、consecutiveMaxTokensToolUse++ → 检查熔断 → 下一轮 |
| `kind: 'context_window_exceeded'` | 抛错 |

`consecutiveParseErrors` 更新规则：
- `meta.allParseErrors === true` → 累加，达阈值抛错
- `meta.allParseErrors === false` → 重置为 0

## 不可消除的耦合（显式表达）

1. **AgentExecutor → SessionManager 直接依赖**（当 sessionStore 传入时）：不走回调。落盘是 AgentExecutor 业务语义的一部分（"每次 LLM 调用后通过 SessionManager 落盘"），由该模块发起（原则 2：模块为自己的业务语义负责）。
2. **onAfterStep 钩子**：step_yield 中断的触发归调用方（Runtime 知道 inbox、SubagentSystem 不关心）。这是 AgentExecutor 与上层的显式耦合点。
3. **ctx.signal 由调用方持有**：AgentExecutor 不 new AbortController。调用方（Runtime / SubagentSystem）持有 controller，注入 signal 到 ctx，控制 abort。

## 配置常量归属

`MAX_CONSECUTIVE_PARSE_ERRORS` / `MAX_CONSECUTIVE_MAX_TOKENS_TOOL_USE` 从 `constants.ts` 读，不走参数（修改频率低，跨模块共享无意义）。
