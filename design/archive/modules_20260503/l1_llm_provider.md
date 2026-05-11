# LLMProvider 模块内部契约

> 本文档限本模块**内部**应然 — 8 节结构 derive 自 Module Logic Principles：§1-§4 = M#1-#4 各占一节，§5 审计 = M#3 命名空间细则，§6 层级，§7 drift = M#10/#11，§8 测试。
> 跨模块对外承诺（接口签名、生产/消费方、归本模块加不归本模块、不可消除耦合理由）见 [interfaces/l1.md](../interfaces/l1.md) LLMProvider 节。
> 模块本质加层归属见 [architecture.md](../architecture.md)。

## 1. 职责（M#1 独立可变职责）

> 本节内容 derive 自 [architecture.md](../architecture.md) §3「LLMProvider 本质：单一 LLM provider 调用能力的原语 / L1 原语 / 判据『不依赖任何业务语义就能存在』」加 M#1 / M#2 / M#3 / M#5。

### 做

应用 M#1（一个模块封装一组独立可变的职责），LLMProvider 的单一职责 = **单一 LLM provider 调用能力的原语暴露加 SDK 异构吸收**：

- **单 provider 调用原语暴露**：一次性调用（`call` 返完整 response）加流式调用（`stream` 吐 chunk 序列）— 这是任何 LLM provider 调用机制的能力概念。
- **SDK 异构吸收**：吸收各 LLM provider SDK 异构（Claude SDK / Anthropic-兼容 / OpenAI / Gemini）— 调用方写一套代码经任意 provider 调（derive 自 Design Principle「分布式部署加跨平台」）。
- **abort 透传**：AbortSignal 透传到 SDK / 调用方决定何时 abort，本模块不内化 abort 策略。
- **KV cache 标记透传**：`cache_control` 标记由调用方放入 messages / 本模块原样转发给 provider — 不实现 cache 策略本身。

> 具体 API 形态归 [interfaces/l1.md](../interfaces/l1.md) LLMProvider 节。

### 不做

- **不 own 任何 clawforum 业务概念**（不知 agent / claw / motion / dialog / inbox / outbox / contract / messages 排列规则等）— derive 自 M#2 业务语义归属（LLMProvider 业务语义仅 LLM SDK 调用级）加 M#5 单向依赖
- **不 own 多 provider 协调**（primary + fallbacks 选择 / failover 切换归 L2 LLMOrchestrator）— derive 自 M#1 独立可变职责
- **不 own 重试加 backoff**（retry 加指数退避归 L2 LLMOrchestrator）— derive 自 M#1
- **不 own circuit breaker**（连续失败 / cooldown / half-open 探测归 L2 LLMOrchestrator）— derive 自 M#1
- **不 own idle timeout**（business 级 timeout 决策归 L2 LLMOrchestrator）— derive 自 M#1
- **不 own context_exceeded failover**（多 provider 切换决策归 L2 LLMOrchestrator）— derive 自 M#1
- **不 own message 语义**（assistant / tool_use / tool_result 排列规则归 L3 StepExecutor）— derive 自 M#1
- **不 own tool 执行**（tool_use 作为 chunk 吐出 / handler 归 StepExecutor）— derive 自 M#1
- **不 own KV cache 策略**（cache_control 标记由调用方放入 messages / 本模块只转发）— derive 自 M#1 + M#2
- **不 own token 计费 / 预算管控**（消费者侧业务策略）— derive 自 M#1
- **不 own 模板组装**（system prompt / messages 由调用方传完整内容）— derive 自 M#1 + M#2
- **不 own audit.write**（LLMProvider 不产生事件 / 失败抛 typed error 由 caller L2 LLMOrchestrator 决策 + emit 容错 audit）— derive 自 M#5 依赖单向

## 2. 业务语义（M#2 业务语义归属）

> 应用 M#2（模块为自己的业务语义负责），LLMProvider 的业务语义边界：

- **own**：LLM SDK 调用概念 — messages 数组加 cache_control 标记加 provider 字符串加 StreamChunk type 加 LLMResponse 等。这些是 LLMProvider 唯一懂的「业务」（LLM SDK 异构吸收级，不是 clawforum 业务级）。
- **角色定位**：LLMProvider 是「**单 provider 调用通道**」非「**容错编排器**」。仅提供单 provider 调用机制，不持容错策略加多 provider 协调（归 L2 LLMOrchestrator）。

## 3. 资源（M#3 资源唯一归属）

> 应用 M#3（每种资源只归属唯一模块），LLMProvider 独占的资源：

- **单一 LLM provider SDK 接入**：clawforum 内部任何单 provider LLM SDK 调用必经 LLMProvider 间接访问（M#5 业务模块不允许直接 import provider SDK / 一般通过 L2 LLMOrchestrator 间接调用）— 是 clawforum 对单 provider SDK 的唯一调用入口。
- **provider 配置**：构造期注入 / 运行期不变 / 一个 provider 一个实例（多 provider 协调归 L2 LLMOrchestrator）。
- **不持运行期状态**：单 provider 调用是无状态的（每次 call/stream 独立 / SDK 自身有 keepalive 不在本模块层面管）。
- **不占用 audit 命名空间**：LLMProvider 自身不发 audit / 失败抛 typed error 给 caller（L2 LLMOrchestrator）决策 / 详 §5。

## 4. 持久化（M#4）

> 应用 M#4（持久化一切信息到磁盘 / 运行时句柄从磁盘信息重建），LLMProvider 自身的持久化立场：

- **模块零状态**：LLMProvider 不持自有磁盘 artifact 加运行时持久状态 — 是无状态服务。
- **重建语义**：进程重启时 provider 配置由调用方装配期重新注入 / 内部无需从磁盘恢复状态。
- **无业务事件持久化**：LLMProvider 不产生事件（详 §5）/ 失败仅抛 typed error / 容错事件持久化归 L2 LLMOrchestrator。

## 5. 审计事件清单

**LLMProvider 不产生 audit 事件**（应然 / L1 不反向依赖 L2）。失败抛 typed error 给 caller（L2 LLMOrchestrator）决策。

容错事件清单（provider_attempt_failed / retry_scheduled / fallback_switched / breaker_* / idle_failover_triggered / context_exceeded_failover 等）归 [l2_llm_orchestrator.md](l2_llm_orchestrator.md) §5。

## 6. 层级声明

L1 原语 / 外部 LLM provider 异构吸收层 / 不持业务语义。详见 [architecture.md](../architecture.md) 加 [interfaces/l1.md](../interfaces/l1.md)。

## 7. 应然 vs 实然差距登记（M#10 / M#11）

> 原则：本节只登记**实然 ≠ 应然**的 gap（待治理或已治理的历史）+ 偏差 + 历史纪律。当前实然若与应然 align 则不在此登记。

### 7.A 必修违规（含历史已闭环）

| §A 条 | 类型 | 状态 | 触发情境 |
|---|---|---|---|
| ~~audit-sink 物理位置 drift~~ | drift | **✅ closed（phase328 / SHA `430e342`）** | audit-sink 物理迁 src/foundation/llm → src/assembly |
| ~~A.1 interface 名 + signature drift / 物理迁未实施~~ | ~~drift / 高~~ | **✅ closed phase413**（main `9fee6b69`）| 物理拆 src/foundation/llm/ → src/foundation/llm-provider/（L1 / 5 adapter + presets + abort-helper + types）+ src/foundation/llm-orchestrator/（L2 / orchestrator.ts 533 行业务体 + types）/ LLMProvider interface 实装 + createLLMProvider 工厂 + LLMProviderError class / class rename LLMServiceImpl → LLMOrchestratorImpl / 接口 LLMService → LLMOrchestrator / 20+ caller files rename + import path 改 / 18+ tests/ 文件 mock + import 改 / src/foundation/llm/index.ts 留 re-export shim 向后兼容 / 反向 3 项实跑 / 1370 测试 PASS / 整模块拆出模板第 2 次复用（同 phase411 EvolutionSystem）|

> 容错相关 §A 历史条目（A.1 / A.3 / A.4 / A.5 / A.6 / breaker events / 30s magic）已迁 [l2_llm_orchestrator.md](l2_llm_orchestrator.md) §7.A。

### 7.B 偏差登记（应然 silent / 实然采选 / 升档条件）

| §B 条 | 偏差性质 | 升档条件 |
|---|---|---|
| `createProvider` 双形态入参（鸭子测试）| 测试注入点 / 轻微违反耦合界面稳定 | 抽 `LLMProviderConfig.adapterFactory?` 显式化 |
| `StreamChunk.type` union 扩张原则 | 非破坏加法 / 新 type 对旧消费者必须 safe-ignore | 引入新 type 时遵守 |
| `healthCheck` 失败返 false 而非抛错 | 与 call/stream 语义不对称 / 调用方通常是 Daemon 启动期可选探测 / 沉默 false 合理 | / |
| `LLMProvider` interface 位置分裂 | interface 写在 index.ts / Impl 又回 import types / 历史遗留 | 清理不紧急 |
| 中断原因未传递 | drift / 中 | `makeExternalAbortError()` 不传递中断原因 / 导致上游无法区分 user abort / idle timeout / priority inbox / 其他信号类型 / 影响链：LLMProvider → React loop → SubAgent 均无法准确识别中断原因 / 错误信息误导性（如显示 "Timeout after 3600000ms" 实际非 timeout）/ 升档：`makeExternalAbortError(reason?: { type: string; ms?: number })` 传递上下文 |

> 容错相关 §B 条目（reset chunk 丢弃决策 / Circuit breaker mem-only）已迁 [l2_llm_orchestrator.md](l2_llm_orchestrator.md) §7.B。

### 7.C 应然原则对照

> 仅列**应然**对各原则的承诺立场。

#### Module Logic Principles（11 条）

- **M1 独立可变职责**：单 provider SDK 调用原语 / 不混业务编排（拆出 L2 LLMOrchestrator 后真合规）
- **M2 业务语义归属**：仅 LLM SDK 调用级业务语义（messages 加 cache_control 加 StreamChunk 等）/ 不持容错策略
- **M3 资源归属**：单 provider SDK 接入 / 无磁盘资源 / 无运行期状态
- **M4 持久化**：模块零状态 / 重启 reset
- **M5 依赖单向**：不依赖 L2 / 失败抛 typed error / caller（L2 LLMOrchestrator）决策
- **M6 依赖结构稳定**：构造期 `LLMProviderConfig` 注入 / 运行期不变
- **M7 耦合界面稳定**：`createProvider(config): LLMProvider` 工厂切换 / 不暴露 Impl class
- **M8 耦合界面最小**：灰度（9 种 StreamChunk type 是 provider 异构的必要封装面）
- **M9 显式表达编译器可检**：`LLMProviderError` 命名 class / StreamChunk discriminated union
- **M10 不合理停下** / **M11 边界不对停下**：未触发

#### Design Principles（11 条 / #1 展 4 面）

- **D1a 信息不丢失**：失败抛 typed error 不静默
- **D1c 中断可恢复**：AbortError 立即抛 / `reset` chunk 通知调用方丢弃部分
- **D2 不得丢弃/静默**：失败 throw / 不软吞 / SSE parse 失败回调暴露
- **D7 系统可信路径**：受信组件
- **D8 事件驱动**：StreamChunk 流式
- **D1b / D1d / D3 / D4 / D5**：归 L2 LLMOrchestrator（容错事件 / 退避状态 / failover / 日志重建）
- **D6 / D9-D11**：无关

#### Philosophy（4 条）

- **P1 Agent 即目录**：无关（LLM 是 L1 原语 / 不直接消费目录形态）
- **P2 上下文工程**：LLM 是上下文执行的核心
- **P3 分多个智能体加分子任务**：单一 LLMProvider 代码基 / provider config 按身份注入
- **P4 系统为智能体服务**：LLMProvider 提供基础设施 / 不参与决策 / 仅 call/stream 协议

#### Path Principles（6 条）

- **Path #1 实测核**：治理动作要 grep 实然代码佐证
- **Path #2 §A 显式登记**：违规明文上墙
- **Path #3 APPEND 不解构**：契约修订加节不重写
- **Path #4 破坏性论证**：API 改动 caller 评估
- **Path #5 默认拆**：能力扩展优于职责合并
- **Path #6 停下报告**：scope 模糊或决策点必停报告

### 7.D 历史纪律

详 phase187 / phase212 / phase251 / phase275 / phase328 各 phase 收尾报告。

关键里程碑：
- phase187 L1 LLMService 契约 backfill / §A 4 条聚合登记
- phase212 `createLLMService` 工厂引入（main `5968b3a`）
- phase251 §7.A/§7.B 全核
- phase275 G5 console 评估（0 console 全清确认）
- phase328 audit-sink 物理迁出（main `430e342`）/ L1 真合规 / r34 C / Stage 2 P0 #2
- 2026-05-03 / phase413 LLMService 拆 L1 LLMProvider + L2 LLMOrchestrator 落地（main `9fee6b69`）/ 物理拆 src/foundation/llm/ → src/foundation/llm-provider/（L1 / 5 adapter + presets + abort-helper） + src/foundation/llm-orchestrator/（L2 / orchestrator.ts 533 行业务体）/ LLMProvider interface 实装 + createLLMProvider 工厂 / 20+ caller rename + 18+ tests 改 / src/foundation/llm/index.ts 留 re-export shim 向后兼容 / 整模块拆出模板第 2 次复用 / 模块边界重构阶段最后大候选闭环 / 1370 测试 PASS / 反向 3 项实跑
- r60+ 重编号：9 节 → 8 节，每节 derive 自一条 Module Logic Principle（删原 §2 接口 / §5 上游依赖 / §6 不可消除耦合 → 已并入 interfaces/l1.md / 拆原 §1 所有权 hub 为 §1 职责 + §2 业务语义 + §3 资源 + §4 持久化 / 删原 §7 内部不变式 杂物筐 → 行为级回 §1.做、anchor 性质回 §7.A）
- r61+ L1 LLMService 拆 L1 LLMProvider + L2 LLMOrchestrator（M#1 模块边界拆分 / 容错编排迁出本模块 / 容错相关历史 phase254 / phase263 / phase313 / phase408 / r44 A breaker 已迁 [l2_llm_orchestrator.md](l2_llm_orchestrator.md) §7.D）

### 7.E 关键决策映射（modules.md 引用）

| KD | 描述 | 一致性 |
|---|---|---|
| KD（应然）LLMProvider L1 sharpen v2「OS/external 抽象层 / no audit / no permissions / no agent tools」| ✓（phase328 audit-sink 物理迁 + r61+ 拆出 LLMOrchestrator 后真合规）|
| KD（应然）provider 异构吸收（4 adapter）| ✓ |
| KD（r61+）L1/L2 拆分（LLMProvider own 单 provider SDK 调用 / LLMOrchestrator own 多 provider 容错编排）| ✓ M#1 真合规 |

## 8. 测试覆盖

应然行为应有测试覆盖：

- **核心 request 组装**：preset 解析 / 4 类 adapter（Claude SDK / Anthropic / OpenAI / Gemini）/ tool_use chunk 吐出 / AbortError 不重试 / cache_control 透传
- **abort 透传**：AbortSignal 透传 SDK / 立即 throw
- **流式中途错误**：抛 typed error 给 caller / 不内部 retry
- **SSE parse 软吞**：`onStreamParseError?` 回调暴露 raw 加 error
- **`getProviderInfo()`**：当前 provider info
- **`healthCheck()`**：`maxTokens=1` 最小探测 / 失败返 false

> 多 provider 容错编排测试（failover / breaker / idle timeout / context_exceeded）归 [l2_llm_orchestrator.md](l2_llm_orchestrator.md) §8。
