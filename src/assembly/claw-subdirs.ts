/**
 * @module L6.Assembly.ClawSubdirs
 * claw 实例化 mkdir 子目录列表（L6 装配期决策）。
 *
 * phase 69 自 foundation/paths.ts 整迁 → L6 Assembly own、解 L1 持业务漏抽象 +
 * 解 L11 messaging 反向 import（L1 paths → L2c messaging）。
 *
 * list 整体 own = L6 Assembly（装配期决定「claw 实例化时 mkdir 哪些子目录」）。
 * list 内 25 entry 业务来源分散（L2b/L2c/L4/L5/L6）— phase 70+ 各模块自报后
 * Assembly collect union（α 真治本）；phase 69 仅整迁 list 形式（β 过渡）。
 *
 * cluster L1-L4 去 claw 化 / paths.ts 解散第二步、详
 * `coding plan/cluster-claw-decoupling-roadmap.md`。
 */

import {
  INBOX_PENDING_DIR, INBOX_DONE_DIR, INBOX_FAILED_DIR,
  OUTBOX_PENDING_DIR, OUTBOX_DONE_DIR, OUTBOX_FAILED_DIR,
} from '../foundation/messaging/index.js';
import { DIALOG_DIR, DIALOG_ARCHIVE_DIR } from '../foundation/dialog-store/index.js';
import { SKILLS_DIR_DEFAULT } from '../foundation/skill-system/index.js';
import { STATUS_SUBDIR } from '../foundation/process-manager/index.js';
import { TASKS_SYNC_EXEC_DIR } from '../foundation/command-tool/index.js';
import { TASKS_SYNC_WRITE_DIR, TASKS_SYNC_SEARCH_DIR } from '../foundation/file-tool/constants.js';
import {
  TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR, TASKS_QUEUES_FAILED_DIR, TASKS_QUEUES_RESULTS_DIR,
  TASKS_SUBAGENTS_DIR,
} from '../core/async-task-system/index.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../core/subagent/index.js';
import { TASKS_SYNC_SPAWN_DIR } from '../core/spawn-system/index.js';
import { TASKS_SYNC_SHADOW_DIR } from '../core/shadow-system/index.js';
import { MEMORY_DIR } from '../core/memory/index.js';
import { CLAWSPACE_DIR } from '../foundation/claw-identity/index.js';

export const CLAW_SUBDIRS = [
  // L2b DialogStore
  DIALOG_DIR,
  DIALOG_ARCHIVE_DIR,
  // L2c Messaging
  INBOX_PENDING_DIR,
  INBOX_DONE_DIR,
  INBOX_FAILED_DIR,
  OUTBOX_PENDING_DIR,
  OUTBOX_DONE_DIR,
  OUTBOX_FAILED_DIR,
  // L4 AsyncTaskSystem
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_RESULTS_DIR,
  // L6 Assembly admit (per l4_async_task_system.md §3「不含 tasks/sync/、装配方 own」)
  TASKS_SYNC_EXEC_DIR,
  TASKS_SYNC_WRITE_DIR,
  TASKS_SYNC_SEARCH_DIR,
  TASKS_SYNC_SUBAGENT_DIR,
  TASKS_SYNC_SPAWN_DIR,
  TASKS_SYNC_SHADOW_DIR,
  TASKS_SUBAGENTS_DIR,
  // L4 MemorySystem
  MEMORY_DIR,
  // L4 ContractSystem
  // phase 120 design-gap: contract dir 用户排除本 phase、未立 CONTRACT_DIR const、待后续 phase 治
  'contract',
  // L2c SkillSystem
  SKILLS_DIR_DEFAULT,
  // L6 Assembly
  CLAWSPACE_DIR,
  // logs/ 顶级是 multi-owner subdir composition、各 sub-owner own 自己子树：
  //   - logs/stream/         ← L2 Stream (foundation/stream/writer.ts:18 ARCHIVE_DIR)
  //   - logs/watchdog.log    ← L6 Watchdog (watchdog/constants.ts:11 WATCHDOG_LOG)
  //   - logs/chat-crash.log  ← L6 cli/chat-viewport (cli/commands/chat-viewport.ts CHAT_CRASH_LOG_FILE、phase 125 立)
  // 顶级 'logs' mkdir 是 assembly 装配 concern、inline by-design（不立 LOGS_DIR 顶级 const、因跨 L 层 use 无 single owner module）
  'logs',
  // L5 StatusService (own const = process-manager STATUS_SUBDIR)
  STATUS_SUBDIR,
] as const;
