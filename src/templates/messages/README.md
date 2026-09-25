# 智能体上下文系统文案（Phase 1828；phase 1909 口径扩张）

进入智能体上下文的系统编写文案单源目录——phase 1828 原口径为「经 **inbox** 进入」，phase 1909 扩为含 **system prompt 内联片段**（M16–M19）。**工具返回值里的系统文案暂不纳入**（用户 2026-09-25 判定，维持 phase 1828 排除）。仅文档，不进入智能体上下文。

## 契约

- 纯静态资源：TS 纯函数/常量，无 FS/网络/时钟/随机数/环境变量/运行时模板配置；入参仅必要标量、已选行、已渲染命令。
- 只相对 import 本目录内文件；可被 foundation / cli-protocol 引用（layer-neutral 纯文本资源，phase 1828 用户拍板；见 `.config/dependency-cruiser.cjs` 的 `no-foundation-to-outside` 注释）。
- 业务分支、路由、优先级、状态与投递仍归各原 owner；集中物理位置不转移职责。
- 机械迁移：文案逐字节相同；禁止顺便润色、删原信息、复制形成双源。

## 分组（M 编号 → 模板文件）

| ID | 模板文件 | 触发 / 接收者 | 原名来源 owner | 对应测试 |
|---|---|---|---|---|
| M01 | execution-recovery.ts（`executionRecoveryMessage`） | EventLoop 停滞恢复 → 本 claw inbox（高优） | core/event-loop | tests/core/event-loop/execution-recovery.test.ts、tests/templates/messages/execution-recovery-semantics.test.ts |
| M02 | startup.ts（`startupCheckMessage`） | daemon 启动自检 → 本 claw inbox（高优） | daemon | tests/daemon/startup-check-delivery.test.ts、tests/templates/messages/startup-check-semantics.test.ts |
| M03 | verification.ts（验收通过/拒绝/放行/异常通知 + 结构化拒绝反馈 + 执行/配置上游反馈 + 持久化错误反馈） | ContractSystem 验证流水线 → 契约所属 claw | core/contract（verification / verification-notify / verification-format / verification-execution） | tests/core/contract/verification-notice-context.test.ts、tests/core/contract/verification-inbox-invariants.test.ts、tests/core/contract/jobs/event-collector-format-contract-event.test.ts |
| M04 | contract-notification.ts（`contractNotificationBody`） | Assembly 契约通知 adapter → 本 daemon 自家 inbox | assembly（序列化与字段顺序仍归 adapter） | tests/assembly/contract-notification-adapter*.test.ts |
| M05 | contract-events.ts（标题/标题行/子任务/证据行/末次失败行 + `contractEventsBody` 双换行组合） | event-collector / contract-observer → motion inbox | core/contract（schema 解析、状态分支、hasFailure 仍在 owner） | tests/core/contract/jobs/event-collector-format-contract-event.test.ts、tests/core/contract/contract-observer.test.ts |
| M06 | contract-audit.ts（drift 行 + 反馈体） | ContractAuditor drift 检出 → 契约所属 claw | core/contract（限流/去重/模型正文仍在 owner） | tests/core/contract/contract-auditor.test.ts |
| M07 | outbox-summary.ts（head/逐 claw 行/范围说明/历史重复提示/失败警告） | ClawTopology outbox-summary job → motion inbox | core/claw-topology（排序、重复判断、失败集合仍在 owner） | tests/core/outbox-summary/*、tests/templates/messages/outbox-summary-semantics.test.ts |
| M08 | heartbeat.ts（base 行 + checklist 组合） | Heartbeat 定时 → 本 claw inbox | core/heartbeat（读文件与错误分支仍在 owner） | tests/core/heartbeat.test.ts |
| M09 | memory.ts（`dreamOutputsPersistedMessage`，最小事实对象 taskId/outputCount/outputPath） | Memory random-dream → motion inbox | core/memory（投递状态机与持久事实仍在 owner） | tests/core/memory/random-dream-delivery.test.ts、tests/core/memory/random-dream-late-settle.test.ts、tests/templates/messages/random-dream-notice-semantics.test.ts |
| M10 | envelope.ts（`SYSTEM_MESSAGE_PREFIX` + 三种标准呈现） | Messaging formatter-registry 标准呈现 → 最终上下文文本 | foundation/messaging（presentation 选择与 origin 判定仍在 owner） | tests/core/runtime/runtime-format-inbox-via-registry.test.ts |
| M11 | task-queue-overflow.ts（通知正文，最小事实对象 taskId/queueLength/cap；旧 guidance 文本已退役，composer = NO_GUIDANCE 注册保留） | AsyncTaskSystem 队列溢出 → 本 daemon 自家 inbox | core/async-task-system | tests/core/async-task-system/overflow-invariants.test.ts、tests/templates/messages/task-queue-overflow-semantics.test.ts |
| M12 | contract-created.ts（`contractCreatedNotificationBody`） | CLI `contract create` / `create-from-dir` → 契约所属 claw inbox（高优） | cli/commands（投递面仍归 owner；phase 1906 工具名修为 submit_subtask） | tests/templates/messages/contract-created-semantics.test.ts、tests/cli/contract.test.ts |
| M13 | onboarding-contract.ts（创建/恢复通知正文 + onboarding 子任务描述字面） | CLI `start` → motion inbox（高优）；子任务描述写进 contract.yaml → 子任务与提示词 | cli/commands/start.ts（子任务 id/顺序/语言分支与投递面仍归 owner） | tests/templates/messages/onboarding-contract-semantics.test.ts、tests/cli/start-first-run-supervision.test.ts |
| M14 | config-reload.ts（`CONFIG_RELOAD_NOTICE` 单行常量） | `chestnut config` 写盘后广播 → 各存活 claw daemon inbox（高优） | cli/commands/config.ts | 无独立语义测试（单行常量，守卫覆盖） |
| M15 | user-attachment.ts（`userAttachmentBody`，系统行 + 已渲染 preview 透传） | chat viewport 超长用户消息 → claw inbox 附件包装 | viewport/chat-viewport-utils.ts（落盘、路径、preview 截断渲染仍归 owner） | tests/templates/messages/user-attachment-semantics.test.ts、tests/cli/chat-viewport-input-attachment.test.ts |
| M16 | runtime-prompt-sections.ts（契约/记忆段头、标签、子任务复选框行） | ContextInjector → 每轮 system prompt（不经 inbox） | core/runtime/injector.ts（段落顺序、读取缓存、完成态判断仍归 owner） | tests/templates/messages/runtime-prompt-sections-semantics.test.ts、tests/core/dialog.test.ts |
| M17 | skill-context.ts（技能段头/空态/技能行） | SkillSystem.formatForContext → system prompt 技能段（不经 inbox） | foundation/skill-system/registry.ts（加载状态与缺省回退分支仍归 owner） | tests/templates/messages/skill-context-semantics.test.ts、tests/core/skill/registry.test.ts |
| M18 | auditor-prompt.ts（`AUDITOR_SYSTEM_PROMPT`） | ContractAuditor 周期审计 → auditor 子代理 system prompt（不经 inbox） | core/contract/contract-auditor.ts | tests/templates/messages/auditor-prompt-semantics.test.ts（逐字节断言） |
| M19 | motion-status-guidance.ts（verb 片段/purpose/note/段头/CLI binary 字面 + 命令行渲染） | status 工具（motion）→ 工具返回值尾段「CLI hints for motion」 | core/status-service（facts 组装）+ assembly/motion-guidance-composer.ts（binary 拼接）仍归 owner | tests/templates/messages/motion-status-guidance-semantics.test.ts、tests/core/status-service/status-tool-invariants.test.ts |

## 等价与反向证据

- phase 1829：M03 是语义变更（通知正文携带身份与已提交处置、上游系统反馈归位），不是等价迁移。M03 从逐字节等价比较移交新语义验收（`SEMANTICALLY_REDESIGNED_GROUPS`）。
- phase 1830：M06 同样移交新语义验收。
- phase 1834：M07 语义治理（准确表达观察范围与读取消费副作用、历史重复只陈述事实不推断已读、退役自动 skip 建议链），整组移交新语义验收（`tests/templates/messages/outbox-summary-semantics.test.ts`）。M07 的 CLI 读取命令字面与 read-outbox 用途标签仍由 CLIProtocol 持有（M12 排除条款不变；M12 仅 outbox-labels case 随标签变更移交新语义）。
- phase 1835：M09 语义治理（正文自含任务标识、输出块数、相对 motion 根的产物路径与按需读取用途；只陈述输出块已保存，不冒称契约数、洞见已验证或已自动整理为长期记忆），completion case 移交新语义验收（`SEMANTICALLY_REDESIGNED_CASES` + `tests/templates/messages/random-dream-notice-semantics.test.ts` 真实链），模板签名改为最小事实对象，正常/迟到/pending 重投共用同一正文构造。
- phase 1836：M11 语义治理（正文准确说明单次拒绝事件：被拒任务身份、拒绝处置前观测的队列数量/上限、系统已执行处置；移除长期故障推断与升级用户/停派指令，guidance 退役为 NO_GUIDANCE），M11 两 case（guidance、overflow-body）移交新语义验收（`SEMANTICALLY_REDESIGNED_CASES` + `tests/templates/messages/task-queue-overflow-semantics.test.ts` 真实链）。
- phase 1839：M02 语义治理（正文说明启动唤醒依据：启动检查时发现仍有活跃契约、本消息用于唤醒后续处理；指导结合当前契约状态与已有工作记录继续未完成工作，已完成步骤不因重启重复、相关工作已完成时无需因通知新增任务；只陈述启动检查所见，不承诺到达时契约仍活跃或系统已完整恢复），M02 唯一 case（startup-check）移交新语义验收（`SEMANTICALLY_REDESIGNED_CASES` + equivalence 测试现场完整 literal 断言 + `tests/templates/messages/startup-check-semantics.test.ts` 真实 delivery→InboxReader→Runtime 呈现链）。
- phase 1906：M12（contract-created）迁移故意携带工具名修正（done → submit_subtask），不纳入逐字节等价面；语义由 tests/templates/messages/contract-created-semantics.test.ts 锁定。
- phase 1909：口径从「经 inbox 进入」扩为「进入智能体上下文的系统编写文案」，M13–M19 迁入；均为机械迁移（逐字节不变），不改语义故不移交语义验收通道；**工具返回值系统文案暂不纳入**（用户 2026-09-25 判定）。
- phase 1845：M01 语义治理（正文只提供当次唤醒所需信息：检查时所见——契约仍活跃、一段时间未观察到新的执行活动，与唤醒用途——继续该契约尚未完成的工作；移除调度次数与 stalled 终态暗示，attempt 证据仍保留在 record/delivery/审计，模板签名只收 contractId），M01 唯一 case（stalled-contract）移交新语义验收（`SEMANTICALLY_REDESIGNED_CASES` + equivalence 测试现场完整 literal 断言 + `tests/templates/messages/execution-recovery-semantics.test.ts` 真实链——真实 store/controller/EventLoop 适配投递 → InboxReader 读回 ack → 现行未注册 type 经 unknown_type 审计后标准 system 兜底呈现）；已持久 pending 义务按原冻结 body 补投，不批量重写历史消息。
- `tests/templates/messages/inbox-text-equivalence.test.ts`：迁移前从旧实现真实入口捕获的 golden（`__fixtures__/inbox-text-golden.json`，生成器存 `development log/phase1828-logs/B-capture-golden.test.ts.txt`）与迁移后同入口输出逐字节比较。
- `tests/foundation/arch/inbox-message-template-boundary.test.ts`：模板纯资源约束 + 迁移来源不再定义已迁文案且确实消费单源。

## 明确不在此目录

- **工具返回值里的系统文案（2026-09-25 用户拍板「暂不动」）**：submit_subtask/done/spawn/exec 等工具返回文本中的指示与说明（审计报告 §2.3，约 40 处）维持 phase 1828 排除，不在本目录范围；注意与 M19 区分——M19 迁的是 status 工具尾段 motion guidance 的**字面**，其经工具返回值到达智能体，但属 2026-09-25 判定点名迁入的提示词片段（§2.2），不是 §2.3 的工具返回值文案。
- **M12 CLI guidance 文案（2026-09-11 用户拍板排除；历史编号，指 cli-protocol/outbox-labels，与守卫 MIGRATED 的 M12 契约创建通知不同）**：label/subject 文本、truncation 行与布局保留单源在 `src/cli-protocol/guidance.ts`——该文本与 CLI 命令字面同行紧耦合，且 cli-protocol 是封闭叶子层（`no-cli-protocol-to-outside`，未开例外）。它只在呈现时追加到 3 个 motion inbox type（claw_outbox_summary / contract_events / contract_cancelled）的最终文本，不落盘。
- AsyncTaskSystem `task_result` 异步结果（JSON/结果正文/截断/fallback）：仅汇总，见 `coding plan/phase1828/异步结果消息清单（仅汇总）.md`。
- 非 inbox 工具结果（如 submit_subtask 工具返回文本）、用户/模型动态正文、`src/templates/prompts`、`core/memory/prompts`（两 prompts 目录 2026-09-25 拍板保留原位、不合并）。
- audit/stream 事件与 UI 文案（非 inbox 消息文本）。
