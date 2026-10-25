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
 * 同一 trace 的 delta 累积进同一消息；每个 trace 独立缓冲。
 *
 * phase 2000 实机修复：真实 stream 中多个 send_content_delta 块的 trace 会交错
 * （A,B,A,B…——实机 stream.jsonl 证据见 phase2000-logs）。旧的单缓冲实现
 * 在每次 trace 切换时清空缓冲，交错场景下每个块只剩切换后的最后一段
 * （用户实机症状：流式输出只保留最后一个块）。改为 Map<trace, buf> 按 trace
 * 独立累积，交错不再互相清空。
 */
export class LauncherEventMapper {
  private replyBufs = new Map<string, string>();

  map(event: StreamEvent): { messageId: string; role: 'motion'; text: string } | null {
    if (event.type !== 'send_content_delta') return null;
    const deltaText = typeof event.delta === 'string' ? event.delta : null;
    if (deltaText === null || deltaText === '') return null;
    const trace = typeof event.trace_id === 'string' && event.trace_id ? event.trace_id : 'untraced';
    const buf = (this.replyBufs.get(trace) ?? '') + deltaText;
    this.replyBufs.set(trace, buf);
    return { messageId: `reply-${trace}`, role: 'motion', text: buf };
  }
}
