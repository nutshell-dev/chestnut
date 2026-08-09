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
 * 当前均使用标准 system presentation（body 已自含业务措辞）。
 */

import type { InboxMessageTypeDeclaration } from '../../foundation/messaging/index.js';

export const CONTRACT_INBOX_MESSAGE_TYPES = [
  { owner: 'contract-system', type: 'contract_events', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'verification_result', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'verification_rejection', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'verification_error', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'contract_created', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'contract_resume', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'contract_audit_feedback', rendering: { kind: 'standard', presentation: 'system' } },
  { owner: 'contract-system', type: 'contract_cancelled', rendering: { kind: 'standard', presentation: 'system' } },
] as const satisfies readonly InboxMessageTypeDeclaration[];
