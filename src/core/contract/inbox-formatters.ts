/**
 * @module L4.ContractSystem
 * phase 1419: ContractSystem 自家 4 inbox 消息 formatter（phase 1414 落地完整化）。
 * phase 9: + 3 type ('contract_created' / 'contract_resume' / 'contract_audit_feedback')、
 *          'message' catch-all 拆解.
 *
 * 7 type 业主语义全归 ContractSystem：
 *   - 'contract_events'           contract-observer 事件聚合（completed / cancelled / crashed；archive_pending_recovery 归 audit 不投 inbox）
 *   - 'verification_result'       subtask 验证通过（含 force-accept）
 *   - 'verification_rejection'    subtask 验证拒绝
 *   - 'verification_error'        验证执行异常
 *   - 'contract_created'          新 contract 创建（CLI + start onboarding）
 *   - 'contract_resume'           已存在 contract 续作（start onboarding resume）
 *   - 'contract_audit_feedback'   contract-auditor drift 反馈
 *
 * 当前 7 formatter 是 trivial passthrough（body 已自含业务措辞）— 业主未来加
 * 特殊措辞时改本 file 单点、Assembly 不动。
 */

import type { MessageFormatter, MessageFormatterRegistry } from '../../foundation/messaging/index.js';

export const formatContractEvents: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export const formatVerificationResult: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export const formatVerificationRejection: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export const formatVerificationError: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export const formatContractCreated: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export const formatContractResume: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export const formatContractAuditFeedback: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export const formatContractCancelled: MessageFormatter = async ({ body, timestampSec }) =>
  `[system message${timestampSec}] ${body}`;

export function registerContractFormatters(registry: MessageFormatterRegistry): void {
  registry.register('contract_events', formatContractEvents);
  registry.register('verification_result', formatVerificationResult);
  registry.register('verification_rejection', formatVerificationRejection);
  registry.register('verification_error', formatVerificationError);
  registry.register('contract_created', formatContractCreated);
  registry.register('contract_resume', formatContractResume);
  registry.register('contract_audit_feedback', formatContractAuditFeedback);
  registry.register('contract_cancelled', formatContractCancelled);  // phase 63
}
