/**
 * @module L2.Messaging
 * phase 1414: inbox 消息格式化协议
 *
 * 业务语义 = inbox 消息格式化时机/接口、归 Messaging L2 own。
 * 散到各业主模块自管自家 message type formatter（消除 Runtime
 * formatInboxMessage case-switch 违反 M#2/#3/#5）。
 *
 * 装配期一次 register、运行期不变（M#6 依赖结构稳定）。Runtime 仅
 * dispatch + DP 不静默 fallback（未注册 type emit `INBOX_UNKNOWN_TYPE`
 * audit + 默 fallback 文本）。
 */

/** 已 format 好的"(2m ago)"字串、formatter 不重复 format。空串表示无 timestamp。*/
export interface MessageFormatterContext {
  /** 消息发件方 claw id 或 'system' */
  from: string;
  /** 消息正文 */
  body: string;
  /** caller 已 format 好的" (2m ago)"字串（含前导空格）；空串=无 timestamp */
  timestampSec: string;
}

export type MessageFormatter = (ctx: MessageFormatterContext) => Promise<string>;

export interface MessageFormatterRegistry {
  /**
   * 注册某 message type 的 formatter。重复注册按 last-win（业主多次注册
   * 仍 idempotent / 防多个装配路径误重）。装配期一次性调用、运行期不再改。
   */
  register(messageType: string, formatter: MessageFormatter): void;

  /**
   * 按 message type 查 formatter。未注册返 undefined（caller 负责
   * fallback + DP 不静默 audit）。
   */
  resolve(messageType: string): MessageFormatter | undefined;
}

export function createMessageFormatterRegistry(): MessageFormatterRegistry {
  const map = new Map<string, MessageFormatter>();
  return {
    register(type, formatter) {
      map.set(type, formatter);
    },
    resolve(type) {
      return map.get(type);
    },
  };
}
