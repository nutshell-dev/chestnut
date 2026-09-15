# inbox 系统消息文案（Phase 1828）

经 inbox 进入智能体上下文的系统编写文案单源目录。仅文档，不进入智能体上下文。

## 契约

- 纯静态资源：TS 纯函数/常量，无 FS/网络/时钟/随机数/环境变量/运行时模板配置；入参仅必要标量、已选行、已渲染命令。
- 只相对 import 本目录内文件；可被 foundation / cli-protocol 引用（layer-neutral 纯文本资源，phase 1828 用户拍板；见 `.config/dependency-cruiser.cjs` 的 `no-foundation-to-outside` 注释）。
- 业务分支、路由、优先级、状态与投递仍归各原 owner；集中物理位置不转移职责。
- 机械迁移：文案逐字节相同；禁止顺便润色、删原信息、复制形成双源。

## 分组（M 编号 → 模板文件）

| ID | 模板文件 | 触发 / 接收者 | 原名来源 owner | 对应测试 |
|---|---|---|---|---|
| M01 | execution-recovery.ts（`executionRecoveryMessage`） | EventLoop 停滞恢复 → 本 claw inbox（高优） | core/event-loop | tests/core/event-loop/execution-recovery.test.ts |
| M02 | startup.ts（`startupCheckMessage`） | daemon 启动自检 → 本 claw inbox（高优） | daemon | tests/daemon/startup-check-delivery.test.ts |
| M03 | verification.ts（验收通过/拒绝/放行/异常通知 + 结构化拒绝反馈 + 执行/配置上游反馈 + 持久化错误反馈） | ContractSystem 验证流水线 → 契约所属 claw | core/contract（verification / verification-notify / verification-format / verification-execution） | tests/core/contract/verification-notice-context.test.ts、tests/core/contract/verification-inbox-invariants.test.ts、tests/core/contract/jobs/event-collector-format-contract-event.test.ts |
| M04 | contract-notification.ts（`contractNotificationBody`） | Assembly 契约通知 adapter → 本 daemon 自家 inbox | assembly（序列化与字段顺序仍归 adapter） | tests/assembly/contract-notification-adapter*.test.ts |
| M05 | contract-events.ts（标题/标题行/子任务/证据行/末次失败行 + `contractEventsBody` 双换行组合） | event-collector / contract-observer → motion inbox | core/contract（schema 解析、状态分支、hasFailure 仍在 owner） | tests/core/contract/jobs/event-collector-format-contract-event.test.ts、tests/core/contract/contract-observer.test.ts |
| M06 | contract-audit.ts（drift 行 + 反馈体） | ContractAuditor drift 检出 → 契约所属 claw | core/contract（限流/去重/模型正文仍在 owner） | tests/core/contract/contract-auditor.test.ts |
| M07 | outbox-summary.ts（head/逐 claw 行/范围说明/历史重复提示/失败警告） | ClawTopology outbox-summary job → motion inbox | core/claw-topology（排序、重复判断、失败集合仍在 owner） | tests/core/outbox-summary/*、tests/templates/messages/outbox-summary-semantics.test.ts |
| M08 | heartbeat.ts（base 行 + checklist 组合） | Heartbeat 定时 → 本 claw inbox | core/heartbeat（读文件与错误分支仍在 owner） | tests/core/heartbeat.test.ts |
| M09 | memory.ts（`dreamOutputsPersistedMessage`） | Memory random-dream → motion inbox | core/memory（投递状态机仍在 owner） | tests/core/memory/random-dream-delivery.test.ts |
| M10 | envelope.ts（`SYSTEM_MESSAGE_PREFIX` + 三种标准呈现） | Messaging formatter-registry 标准呈现 → 最终上下文文本 | foundation/messaging（presentation 选择与 origin 判定仍在 owner） | tests/core/runtime/runtime-format-inbox-via-registry.test.ts |
| M11 | task-queue-overflow.ts（通知正文 + guidance 文本） | AsyncTaskSystem 队列溢出 → 本 daemon 自家 inbox + motion guidance | core/async-task-system / assembly composer | tests/core/async-task-system/overflow-invariants.test.ts、tests/assembly/guidance/composers.test.ts |

## 等价与反向证据

- phase 1829：M03 是语义变更（通知正文携带身份与已提交处置、上游系统反馈归位），不是等价迁移。M03 从逐字节等价比较移交新语义验收（`SEMANTICALLY_REDESIGNED_GROUPS`）。
- phase 1830：M06 同样移交新语义验收。
- phase 1834：M07 语义治理（准确表达观察范围与读取消费副作用、历史重复只陈述事实不推断已读、退役自动 skip 建议链），整组移交新语义验收（`tests/templates/messages/outbox-summary-semantics.test.ts`）。M07 的 CLI 读取命令字面与 read-outbox 用途标签仍由 CLIProtocol 持有（M12 排除条款不变；M12 仅 outbox-labels case 随标签变更移交新语义）。
- `tests/templates/messages/inbox-text-equivalence.test.ts`：迁移前从旧实现真实入口捕获的 golden（`__fixtures__/inbox-text-golden.json`，生成器存 `development log/phase1828-logs/B-capture-golden.test.ts.txt`）与迁移后同入口输出逐字节比较。
- `tests/foundation/arch/inbox-message-template-boundary.test.ts`：模板纯资源约束 + 迁移来源不再定义已迁文案且确实消费单源。

## 明确不在此目录

- **M12 CLI guidance 文案（2026-09-11 用户拍板排除）**：label/subject 文本、truncation 行与布局保留单源在 `src/cli-protocol/guidance.ts`——该文本与 CLI 命令字面同行紧耦合，且 cli-protocol 是封闭叶子层（`no-cli-protocol-to-outside`，未开例外）。它只在呈现时追加到 3 个 motion inbox type（claw_outbox_summary / contract_events / contract_cancelled）的最终文本，不落盘。
- AsyncTaskSystem `task_result` 异步结果（JSON/结果正文/截断/fallback）：仅汇总，见 `coding plan/phase1828/异步结果消息清单（仅汇总）.md`。
- 非 inbox 工具结果（如 submit_subtask 工具返回文本）、用户/模型动态正文、`src/templates/prompts`、`memory/prompts`、auditor prompt。
- audit/stream 事件与 UI 文案（非 inbox 消息文本）。
