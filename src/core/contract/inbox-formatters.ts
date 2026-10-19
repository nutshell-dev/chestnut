/**
 * @module L4.ContractSystem
 * phase 1243: ContractSystem 自家 inbox 消息 rendering declarations。
 *
 * 7 type 业主语义全归 ContractSystem：
 *   - 'contract_events'           contract-observer 事件聚合
 *   - 'verification_result'       subtask 验证通过（含 force-accept）
 *   - 'verification_rejection'    subtask 验证拒绝
 *   - 'verification_error'        验证执行异常
 *   - 'contract_created'          新 contract 创建
 *   - 'contract_resume'           已存在 contract 续作
 *   - 'contract_audit_feedback'   contract-auditor drift 反馈
 *   - 'contract_cancelled'        contract 取消
 *
 * Phase 1955 Step D：contract_created 使用 custom formatter——按持久化投递事实
 * （delivery_attempts）决定 New / Resume 呈现；模板本身不读磁盘。
 */

import {
  renderStandardInboxMessage,
  type InboxMessageTypeDeclaration,
  type MessageFormatter,
} from '../../foundation/messaging/index.js';

/**
 * Phase 1955 Step D：重投递（delivery_attempts > 0）呈现为续作而非新契约。
 * 首次创建时间由正文自身保留（template 的 Created at 行）。
 */
export const contractCreatedInboxFormatter: MessageFormatter = async (ctx) => {
  const attempts = Number.parseInt(ctx.metadata?.delivery_attempts ?? '0', 10);
  const body = Number.isFinite(attempts) && attempts > 0
    ? ctx.body.replace(/^New contract created/, 'Resuming contract')
    : ctx.body;
  return renderStandardInboxMessage({ ...ctx, body }, 'system');
};

export const CONTRACT_INBOX_MESSAGE_TYPES = [
  { owner: 'contract-system', type: 'contract_events', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'verification_result', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'verification_rejection', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'verification_error', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'contract_created', rendering: { kind: 'custom', formatter: contractCreatedInboxFormatter } },
  { owner: 'contract-system', type: 'contract_resume', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'contract_audit_feedback', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'contract_cancelled', rendering: { kind: 'standard', presentation: 'system' } },
] as const satisfies readonly InboxMessageTypeDeclaration[];
