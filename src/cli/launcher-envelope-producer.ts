/**
 * @module L6.CLI.LauncherEnvelopeProducer
 *
 * chestnut.launcher.v1 运行时 producer（phase 1994 Step B 自 cli-protocol 拆出）：
 * CLIProtocol 是 L6 叶子静态协议模块，不依赖 foundation stream/crypto；
 * 运行时 stream 适配与熵源使用归 CLIProcess（本模块）。
 * 静态协议构造器（envelope/sequencer/error）仍在 src/cli-protocol/launcher-envelope.ts。
 */

import { newUuid } from '../foundation/node-utils/index.js';
import type { StreamEvent } from '../foundation/stream/index.js';

/** 本次订阅/调用会话 ID；UUID v4，形状与 phase 1990 一致。 */
export function makeLauncherSessionId(): string {
  return newUuid();
}

/**
 * 内部 StreamEvent → 对外消息 payload 的稳定映射（不泄漏内部 union）。
 * 只映射 send_content_delta（Motion 经 send 工具发给用户的消息流）——
 * LLM 裸正文 text_delta 属内部思考/组织过程，不对外（phase 1990 实机决策）。
 * 其余事件不转发（v1 主动收窄、减少协议面）。
 *
 * payload 为累积快照（同 messageId 幂等覆盖，consumer upsert）：
 * 同一 trace 的 delta 累积进同一消息；trace 切换开新消息。
 */
export class LauncherEventMapper {
  private replyTrace: string | null = null;
  private replyBuf = '';

  map(event: StreamEvent): { messageId: string; role: 'motion'; text: string } | null {
    if (event.type !== 'send_content_delta') return null;
    const deltaText = typeof event.delta === 'string' ? event.delta : null;
    if (deltaText === null || deltaText === '') return null;
    const trace = typeof event.trace_id === 'string' && event.trace_id ? event.trace_id : 'untraced';
    if (this.replyTrace !== trace) {
      this.replyTrace = trace;
      this.replyBuf = '';
    }
    this.replyBuf += deltaText;
    return { messageId: `reply-${trace}`, role: 'motion', text: this.replyBuf };
  }
}
