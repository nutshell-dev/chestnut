/**
 * @module Templates.Messages
 * Phase 1828：经 inbox 进入智能体上下文的系统编写文案单源目录。
 *
 * 纯静态资源：TS 纯函数/常量，无 FS/网络/时钟/随机数/注册表；入参仅必要标量、
 * 已选行、已渲染命令。业务分支、路由、状态与投递仍归各原 owner（详 README.md）。
 * 本目录可被 foundation/cli-protocol 引用（layer-neutral 纯文本资源，phase 1828 用户拍板）。
 */

export { executionRecoveryMessage } from './execution-recovery.js';
export { startupCheckMessage } from './startup.js';
export {
  subtaskAcceptedMessage,
  verificationRejectionMessage,
  forceAcceptMessage,
  verificationErrorMessage,
  verificationTimeoutFeedback,
  verificationCrashedFeedback,
} from './verification.js';
export { contractNotificationBody } from './contract-notification.js';
export {
  contractEventHeader,
  contractEventTitleLine,
  contractEventGoalLine,
  contractEventReasonLine,
  contractEventEvidenceRefLine,
  contractEventCauseLine,
  contractEventSubtasksHeading,
  contractEventSubtaskEvidenceLine,
  contractEventSubtaskIdLine,
  contractEventLastFailureLine,
  contractEventsBody,
} from './contract-events.js';
export { contractAuditDriftLine, contractAuditFeedbackBody } from './contract-audit.js';
export {
  outboxSummaryHead,
  outboxSummaryClawLine,
  outboxSummaryRepeatHint,
  outboxSummaryIncompleteWarning,
  outboxSummaryBody,
} from './outbox-summary.js';
export { heartbeatBaseLine, heartbeatWithChecklist } from './heartbeat.js';
export { dreamOutputsPersistedMessage } from './memory.js';
export {
  SYSTEM_MESSAGE_PREFIX,
  systemMessageEnvelope,
  userInboxMessageEnvelope,
  userChatMessageEnvelope,
} from './envelope.js';
export { taskQueueOverflowBody, taskQueueOverflowGuidanceText } from './task-queue-overflow.js';
