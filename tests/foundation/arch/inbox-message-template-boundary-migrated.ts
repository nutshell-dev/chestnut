/**
 * inbox-message-template-boundary 守卫的《消息迁移清单》数据（M 编号 → 来源文件 + 防回潮片段）。
 *
 * phase 1909 补齐（M12–M19）后清单随条目增长，守卫 .test.ts 超 phase 676 的
 * arch test ≤150 行 ratchet；照 cli-guidance-boundary-cases.ts 先例把纯数据
 * 拆到本非测试文件（ratchet 只核 *.test.ts），断言逻辑留在守卫测试内。
 */

export interface MigratedSource {
  id: string;
  file: string;
  /** 迁移前该文件内的特征文案片段（注释剥离后不应再出现）。 */
  fragments: string[];
}

export const MIGRATED: MigratedSource[] = [
  {
    // phase 1845: 真实消费者是 controller（execution-recovery.ts）；旧 event-loop.ts 位置由独立检查核正文不回流。新语义片段同样不得在模板外定义第二份（旧英文保留防回潮）。
    id: 'M01', file: 'core/event-loop/execution-recovery.ts',
    fragments: ['Execution stalled with no persisted activity', '系统在检查时发现契约', '本消息用于唤醒你继续'],
  },
  {
    // phase 1839: 新语义正文片段同样不得在模板外定义第二份（旧 fragment 保留防回潮）
    id: 'M02', file: 'daemon/daemon-loop.ts',
    fragments: ['System startup. Please review active contracts', '执行进程已启动', '启动检查时发现仍有活跃契约', '继续尚未完成的工作'],
  },
  {
    // phase 1829: 新语义文案同样不得在模板外定义第二份
    id: 'M03', file: 'core/contract/verification-notify.ts',
    fragments: [
      'accepted. All subtasks complete!', 'No feedback provided', 'force-accepted after', 'Acceptance verification failed with error',
      'Acceptance verifier timed out after', 'Acceptance verification crashed (system bug)', '本次验收未通过', '契约验收通知', '本次验收流程异常', '按现行规则将该子任务记为完成',
    ],
  },
  {
    id: 'M03', file: 'core/contract/verification.ts',
    fragments: ['verification config script 类型缺少', 'verification config llm 类型缺少', '本次验收'],
  },
  { id: 'M03', file: 'core/contract/verification-format.ts', fragments: ['未提供具体问题', '需要修正的问题', '验收标准', '已失败'] },
  { id: 'M03', file: 'core/contract/verification-execution.ts', fragments: ['路径安全拒绝', 'LLM 验收未配置', '验收子代理超时', 'Script verification passed', 'LLM 验收失败', 'prompt_file 读失败'] },
  { id: 'M04', file: 'assembly/contract-notification-adapter.ts', fragments: ['claw=${deps.clawId} ${formatNotifyData(data)}'] },
  {
    id: 'M05', file: 'core/contract/jobs/event-collector.ts',
    fragments: [
      '[contract_completed] claw=', '[contract_cancelled] claw=', '[contract_failed] claw=', '[contract_crashed] claw=',
      '[contract_archive_corrupted] claw=', 'subtasks (completed before cancel)', 'subtasks (completed before crash)', '⚠ last_failure:',
    ],
  },
  { id: 'M05', file: 'core/contract/jobs/contract-observer.ts', fragments: [".join('\\n\\n')"] },
  { id: 'M06', file: 'core/contract/contract-auditor.ts', fragments: ['看了你最近的活动', '（auditor 标 drift 但未给具体条目）', '（无）'] },
  {
    id: 'M07', file: 'core/claw-topology/jobs/outbox-summary/write.ts',
    fragments: ['outbox 未读：共', '（无预览）', '〔提示〕以上未读消息与此前推送完全重复', '计数可能不完整'],
  },
  { id: 'M08', file: 'core/heartbeat/inbox-formatter.ts', fragments: ['Heartbeat triggered. Please perform a routine check.'] },
  // phase 1835: 新语义文案同样不得在模板外定义第二份（旧英文保留防回退）
  { id: 'M09', file: 'core/memory/random-dream.ts', fragments: ['Dream outputs persisted', '跨 claw 经验探索输出已保存', '产物：', '尚未自动整理为可检索的长期记忆'] },
  { id: 'M10', file: 'foundation/messaging/formatter-registry.ts', fragments: ['[system message${', '[user inbox message${'] },
  {
    // phase 1836: 新语义文案同样不得在模板外定义第二份（旧英文保留防回退）
    id: 'M11', file: 'core/async-task-system/system.ts',
    fragments: ['Task queue is at capacity', '因待处理队列超限被拒绝', '检查时队列数量', '系统已将该任务记为失败'],
  },
  {
    // phase 1906: 契约创建通知正文迁模板单源（Step B 文本不变，Step C 工具名修为 submit_subtask）；旧 done 片段保留防回潮
    id: 'M12', file: 'cli/commands/contract-helpers.ts',
    fragments: ['New contract created (', 'After each subtask, submit verification via', 'done: { "subtask"', '- ${s.id}: ${s.description}'],
  },
  {
    // phase 1909 Step B: onboarding 创建/恢复通知正文迁模板单源（机械迁移，逐字节不变）
    // phase 1909 Step C: 同文件 onboarding 子任务描述字面随迁（复用本条目扩 fragments）
    id: 'M13', file: 'cli/commands/start.ts',
    fragments: [
      'New contract created (${contractId}): Onboarding. Please begin execution.',
      'Resuming Onboarding contract (${onboarding.contractId}). Pending subtasks: ${pendingList}. Please continue.',
      "Detect the user's preferred language from their first message",
      'You are the coordinator of Claws',
      'Open SOUL.md together',
      'Onboarding is complete. Let them know',
    ],
  },
  {
    // phase 1909 Step B: LLM 配置重载通知正文迁模板单源
    id: 'M14', file: 'cli/commands/config.ts',
    fragments: ['LLM config changed on disk; please reload.'],
  },
  {
    // phase 1909 Step B: 用户附件包装系统行迁模板单源（preview 渲染仍在 viewport owner）
    id: 'M15', file: 'viewport/chat-viewport-utils.ts',
    fragments: ['[user-input attachment: ${size} chars]', 'Use the read tool to fetch full or partial content'],
  },
  {
    // phase 1909 Step C: runtime injector 契约/记忆段字面迁模板单源（段落顺序与完成态分支仍在 owner）
    id: 'M16', file: 'core/runtime/injector.ts',
    fragments: ['## Active Contract', '**Subtasks:**', '## Memory', '${checkbox} `${subtask.id}`: ${subtask.description}'],
  },
  {
    // phase 1909 Step C: 技能段字面迁模板单源（加载状态与缺省回退分支仍在 owner）
    id: 'M17', file: 'foundation/skill-system/registry.ts',
    fragments: ['## Available Skills', 'No skills loaded.', 'No description'],
  },
  {
    // phase 1909 Step C: 契约审计子代理系统提示词迁模板单源（逐字节）
    id: 'M18', file: 'core/contract/contract-auditor.ts',
    fragments: ['You are a contract auditor'],
  },
  {
    // phase 1909 Step C: status 工具 motion guidance 字面迁模板单源（facts 组装仍在 owner）
    id: 'M19', file: 'core/status-service/motion-guidance.ts',
    fragments: ['claw <name> status', '列出所有 claw 加 name', '[CLI hints for motion]', 'motion 用 status 工具查自己状态后'],
  },
  {
    // phase 1909 Step C: composer 的 CLI binary 字面迁模板单源（binary 拼接仍在 composer）
    id: 'M19', file: 'assembly/motion-guidance-composer.ts',
    fragments: ["CLI_BINARY = 'chestnut'"],
  },
];
