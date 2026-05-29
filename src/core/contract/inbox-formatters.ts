/**
 * @module L4.ContractSystem
 * phase 1419: ContractSystem 自家 4 inbox 消息 formatter（phase 1414 落地完整化）。
 *
 * 4 type 业主语义全归 ContractSystem：
 *   - 'contract_events'         contract-observer + contractNotifyCallback 发的事件聚合通知
 *   - 'verification_result'     subtask 验证通过通知（含 force-accept 路径）
 *   - 'verification_rejection'  subtask 验证拒绝通知
 *   - 'verification_error'      验证执行异常通知
 *
 * 当前 4 formatter 是 trivial passthrough（body 已自含业务措辞）— 业主未来加
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

export function registerContractFormatters(registry: MessageFormatterRegistry): void {
  registry.register('contract_events', formatContractEvents);
  registry.register('verification_result', formatVerificationResult);
  registry.register('verification_rejection', formatVerificationRejection);
  registry.register('verification_error', formatVerificationError);
}
