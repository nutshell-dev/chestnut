/**
 * M10 inbox 呈现外壳：system / user_inbox / user_chat 的统一包装。
 * 触发/接收者：Messaging formatter-registry 标准呈现 → 进入智能体上下文的最终文本。
 * 原 owner：foundation/messaging（按 type 选择 presentation、origin 判定仍在 owner）。
 *
 * 注意：本文件同时包 task_result 等共享 system 外壳；AsyncTaskSystem 的结果 JSON/正文不在本迁移范围。
 */

/** system 消息字面前缀常量（LLM 据文本识别系统通知；chestnut 内部判断走 msg.origin）。 */
export const SYSTEM_MESSAGE_PREFIX = '[system message';

export function systemMessageEnvelope(timestampSec: number | string, body: string): string {
  return `${SYSTEM_MESSAGE_PREFIX}${timestampSec}] ${body}`;
}

export function userInboxMessageEnvelope(timestampSec: number | string, body: string): string {
  return `[user inbox message${timestampSec}]\n${body}`;
}

export function userChatMessageEnvelope(body: string): string {
  return body;
}
