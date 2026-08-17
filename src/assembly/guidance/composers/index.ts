/**
 * @module L6.Assembly.Guidance
 * phase 1469: Composer registration aggregate.
 * phase 1476: 22 → 18 type reframe（移 5 outbox-routed type + 加 1 claw_outbox_summary real composer）.
 * phase 63 γ: 加 contract_cancelled real composer.
 * phase 1121 Step D: 移除 contract_crashed composer（legacy crashed 只走 audit、不生成 motion 决策）。
 *
 * 装配期一次性调 `registerAllMotionGuidance(registry)`、按 inbox type 显式 register 各 composer.
 * 当前结构：13 NO_GUIDANCE sentinel + generic real composer + 5 CLI typed binding。
 * phase 1264 Step A: claw_inactivity 迁入 typed binding（aggregate 注释不再逐个列举 CLI composer）。
 * phase 1265 Step A: claw_outbox_summary 迁入同一次 typed bindings 聚合（第三个迁移的 CLI binding）。
 * phase 1266 Step A: contract_events 迁入同一次 typed bindings 聚合（第四个迁移的 CLI binding）。
 * phase 1267 Step A: contract_cancelled 迁入同一次 typed bindings 聚合（第五个、最后一个迁移的 CLI binding）。
 *
 * DP「不静默」+ M#9 显式表达：每 sender type 必显式 register / 漏注由
 * `tests/foundation/assembly/guidance-registry-coverage.test.ts` 抓.
 */

import type { MotionGuidanceRegistry } from '../types.js';

import { registerCliGuidance } from '../../../cli-protocol/index.js';
import { clawOutboxSummaryGuidanceBinding } from '../bindings/claw-outbox-summary.js';
import { contractEventsGuidanceBinding } from '../bindings/contract-events.js';
import { contractCancelledGuidanceBinding } from '../bindings/contract-cancelled.js';
import { composer as verificationResult } from './verification-result.js';
import { composer as verificationRejection } from './verification-rejection.js';
import { composer as verificationError } from './verification-error.js';
import { composer as randomDream } from './random-dream.js';
import { composer as deepDream } from './deep-dream.js';
import { composer as heartbeat } from './heartbeat.js';
import { composer as startupCheck } from './startup-check.js';
import { composer as taskQueueOverflow } from './task-queue-overflow.js';
import { composer as userChat } from './user-chat.js';
import { composer as userInboxMessage } from './user-inbox-message.js';
import { composer as taskResult } from './task-result.js';
import { composer as contractCreated } from './contract-created.js';
import { composer as contractResume } from './contract-resume.js';
import { composer as contractAuditFeedback } from './contract-audit-feedback.js';

export function registerAllMotionGuidance(registry: MotionGuidanceRegistry): void {
  // phase 1265 Step A: claw_outbox_summary 经 CLIProtocol typed binding 注册；
  // phase 1266 Step A: contract_events 加入同一聚合；
  // phase 1267 Step A: contract_cancelled 加入同一聚合。
  // Phase 1396 Step F: claw_crashed / claw_inactivity typed bindings 已退役；旧 inbox
  // 历史消息由 Runtime 通用 fallback 读取，不阻塞 drain。
  registerCliGuidance(registry, [
    clawOutboxSummaryGuidanceBinding,
    contractEventsGuidanceBinding,
    contractCancelledGuidanceBinding,
  ]);
  registry.register('verification_result', verificationResult);
  registry.register('verification_rejection', verificationRejection);
  registry.register('verification_error', verificationError);
  registry.register('random_dream', randomDream);
  registry.register('random_dream_completed', randomDream);
  registry.register('deep_dream', deepDream);
  registry.register('heartbeat', heartbeat);
  registry.register('startup_check', startupCheck);
  registry.register('task_queue_overflow', taskQueueOverflow);
  registry.register('user_chat', userChat);
  registry.register('user_inbox_message', userInboxMessage);
  // phase 9: 'message' catch-all 拆为 4 typed event
  registry.register('task_result', taskResult);
  registry.register('contract_created', contractCreated);
  registry.register('contract_resume', contractResume);
  registry.register('contract_audit_feedback', contractAuditFeedback);
}
