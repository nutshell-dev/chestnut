/**
 * @module L6.CLIProtocol.LauncherEnvelope
 *
 * chestnut.launcher.v1 对外协议 envelope（producer 侧单源，phase 1990 Step B）。
 * consumer（launcher-core JsonlWireDecoder）已冻结字段名：
 * protocolVersion/sequence/sessionId/kind/payload——本模块形状不得漂移。
 *
 * stdout 只含协议 JSONL（每行一个 envelope）；人类提示一律 stderr。
 * sequence 为本次订阅/调用会话内严格连号（launcher 首事件建立基线，
 * 跳号判 resync）；序号持久化恢复入口（--from-sequence）属后续 phase。
 */

import { randomUUID } from 'crypto';
import type { StreamEvent } from '../foundation/stream/index.js';

export const LAUNCHER_PROTOCOL_VERSION = 'chestnut.launcher.v1';

export type LauncherEnvelopeKind = 'event' | 'ack' | 'error' | 'terminal';

/** launcher WireErrorMapper 已冻结的 class 集合 + local（1990 补映射）。 */
export type LauncherErrorClass =
  | 'daemon_stopped'
  | 'daemon_unavailable'
  | 'rejected'
  | 'protocol_mismatch'
  | 'local';

export interface LauncherEnvelope {
  protocolVersion: typeof LAUNCHER_PROTOCOL_VERSION;
  sequence: number;
  sessionId: string;
  kind: LauncherEnvelopeKind;
  payload: Record<string, unknown>;
}

/** 会话内连号 sequence 生成器（1 起；launcher 以首个 envelope 建基线）。 */
export function createLauncherSequencer(): () => number {
  let next = 0;
  return () => ++next;
}

export function makeLauncherSessionId(): string {
  return randomUUID();
}

export function makeLauncherEnvelope(
  sequence: number,
  sessionId: string,
  kind: LauncherEnvelopeKind,
  payload: Record<string, unknown>,
): LauncherEnvelope {
  return { protocolVersion: LAUNCHER_PROTOCOL_VERSION, sequence, sessionId, kind, payload };
}

export function writeLauncherEnvelope(out: NodeJS.WritableStream, value: LauncherEnvelope): void {
  out.write(JSON.stringify(value) + '\n');
}

export function launcherErrorEnvelope(
  sequence: number,
  sessionId: string,
  errorClass: LauncherErrorClass,
  detail: string,
): LauncherEnvelope {
  return makeLauncherEnvelope(sequence, sessionId, 'error', { class: errorClass, detail });
}

/**
 * 内部 StreamEvent → 对外消息 payload 的稳定映射（不泄漏内部 union）。
 * 只映射用户可见文本流：text_delta（Motion 正文）与 send_content_delta
 * （Motion 经 send 工具给用户的消息）；其余事件不转发（launcher 对无法
 * 解析为消息的 event 也会忽略，但 v1 主动收窄、减少协议面）。
 *
 * payload 为累积快照（同 messageId 幂等覆盖，consumer upsert）：
 * 同一 trace 的 delta 累积进同一消息；trace 切换开新消息。
 */
export class LauncherEventMapper {
  private textTrace: string | null = null;
  private textBuf = '';
  private replyTrace: string | null = null;
  private replyBuf = '';

  map(event: StreamEvent): { messageId: string; role: 'motion'; text: string } | null {
    switch (event.type) {
      case 'text_delta': return this.delta('text', event);
      case 'send_content_delta': return this.delta('reply', event);
      default: return null;
    }
  }

  private delta(
    channel: 'text' | 'reply',
    event: StreamEvent,
  ): { messageId: string; role: 'motion'; text: string } | null {
    const deltaText = typeof event.delta === 'string' ? event.delta : null;
    if (deltaText === null || deltaText === '') return null;
    const trace = typeof event.trace_id === 'string' && event.trace_id ? event.trace_id : 'untraced';
    if (channel === 'text') {
      if (this.textTrace !== trace) {
        this.textTrace = trace;
        this.textBuf = '';
      }
      this.textBuf += deltaText;
      return { messageId: `${channel}-${trace}`, role: 'motion', text: this.textBuf };
    }
    if (this.replyTrace !== trace) {
      this.replyTrace = trace;
      this.replyBuf = '';
    }
    this.replyBuf += deltaText;
    return { messageId: `${channel}-${trace}`, role: 'motion', text: this.replyBuf };
  }
}
