/**
 * @module L5.EventLoop
 * phase 1869 Step H: EventLoop 自家 'execution_recovery' inbox 消息 rendering declaration。
 *
 * 业务语义 = "执行恢复提醒怎么对 LLM 呈现"（EventLoop 是提醒生产/消费业主）。
 * 当前兜底即 standard/system（runtime.formatInboxMessage 未声明类型 →
 * renderStandardInboxMessage(..., 'system')）；显式声明后渲染输出逐字不变，
 * 变化仅：不再写 runtime_inbox_unknown_type 审计、不再走「未声明类型」兜底路径。
 * 若未来需要专属呈现 → 改 kind:'custom' + formatter（默认不启用）。
 */

import type { InboxMessageTypeDeclaration } from '../../foundation/messaging/index.js';
import { EXECUTION_RECOVERY_MESSAGE_TYPE } from './constants.js';

export const EVENTLOOP_INBOX_MESSAGE_TYPES = [
  {
    owner: 'event-loop',
    type: EXECUTION_RECOVERY_MESSAGE_TYPE,
    rendering: { kind: 'standard', presentation: 'system' },
  },
] as const satisfies readonly InboxMessageTypeDeclaration[];
