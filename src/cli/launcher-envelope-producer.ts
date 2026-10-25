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
import type { LauncherActivityPayload } from '../cli-protocol/index.js';

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

/** 从事件中提取安全短 detail：仅工具名（tool_call/tool_use_input/tool_result），不含 input/参数。 */
function shortDetail(event: StreamEvent): string | undefined {
  const name = (event as { name?: unknown }).name;
  return typeof name === 'string' && name ? name : undefined;
}

function traceOf(event: StreamEvent): string | undefined {
  const t = (event as { trace_id?: unknown }).trace_id;
  return typeof t === 'string' && t ? t : undefined;
}

function stringField(event: StreamEvent, key: string): string | undefined {
  const v = (event as Record<string, unknown>)[key];
  return typeof v === 'string' && v ? v : undefined;
}

/** thinking/text 摘要上限（字符）：只保留尾部——最新进展比开头更有信息量（claw fitLine 语义）。 */
const ACTIVITY_SUMMARY_LIMIT = 240;
/** 错误摘要上限（字符）：保留开头——错误分类与可行动提示在前。 */
const ACTIVITY_ERROR_LIMIT = 160;

/** 单行净化：换行/连续空白折为单个空格（claw bar 语义：textBuffer.replace(/\n/g,' ')）。 */
function sanitizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 安全错误摘要（phase 2002）：单行净化 + 截断；不携带密钥/完整 payload/工具参数。 */
function safeErrorDetail(error: unknown): string | undefined {
  if (typeof error !== 'string' || !error) return undefined;
  return sanitizeLine(error).slice(0, ACTIVITY_ERROR_LIMIT) || undefined;
}

/**
 * 内部 StreamEvent → activity wire payload（phase 2001 引入，phase 2002 按 claw bar 重做摘要）：
 * - thinking_delta / 裸 text_delta：按 trace 累计缓冲，单行净化 + 尾部截断，随 delta 流式刷新
 *   （裸 text_delta 只进活动摘要，不作为 Motion 聊天消息——phase 1990 消息面决策不变）；
 * - tool/provider 事件只更新短标签（工具名/provider 名），不带 input 与完整错误；
 * - send_content_delta/end → responding（send 完成不结束 turn，活动保留）；
 * - turn_end/turn_interrupted → idle；turn_error → error 保留可读错误行（不伪装 idle），
 *   由 consumer 在下一次 send 时清除；
 * - 同一 stream event 可同时产生 activity 与消息 event（如 send_content_delta）。
 *
 * 有状态：按 trace 分桶的摘要缓冲；turn_start/turn_end/turn_error/turn_interrupted 清理对应
 * trace 的生命周期缓冲（多 trace 交错互不串摘要——phase 2000 交错教训）。
 */
export class LauncherActivityMapper {
  private buffers = new Map<string, { kind: 'thinking' | 'text'; text: string }>();

  private appendSummary(trace: string | undefined, kind: 'thinking' | 'text', delta: string): string {
    const key = trace ?? 'untraced';
    const prior = this.buffers.get(key);
    const text = prior?.kind === kind ? prior.text + delta : delta;
    this.buffers.set(key, { kind, text });
    return sanitizeLine(text).slice(-ACTIVITY_SUMMARY_LIMIT);
  }

  private clearBuffer(trace: string | undefined): void {
    this.buffers.delete(trace ?? 'untraced');
  }

  map(event: StreamEvent): LauncherActivityPayload | null {
    const traceId = traceOf(event);
    switch (event.type) {
      case 'turn_start':
        this.clearBuffer(traceId);
        return { phase: 'processing', label: 'turn', traceId };
      case 'llm_start':
        return { phase: 'processing', label: 'provider', traceId };
      case 'thinking_delta':
      case 'text_delta': {
        const delta = stringField(event, 'delta');
        if (!delta) return null;
        const kind = event.type === 'thinking_delta' ? 'thinking' : 'text';
        return { phase: 'processing', label: kind, detail: this.appendSummary(traceId, kind, delta), traceId };
      }
      case 'tool_call':
      case 'tool_use_input':
        return { phase: 'processing', label: 'tool', detail: shortDetail(event), traceId };
      case 'tool_result':
        return { phase: 'processing', label: 'tool_result', detail: shortDetail(event), traceId };
      case 'provider_failed':
      case 'provider_failover':
        return { phase: 'processing', label: 'provider', detail: stringField(event, 'provider') ?? stringField(event, 'from'), traceId };
      case 'fallback_switched':
        return { phase: 'processing', label: 'provider', detail: stringField(event, 'to'), traceId };
      case 'llm_retry_waiting': {
        const attempt = (event as { attempt?: unknown }).attempt;
        const max = (event as { maxAttempts?: unknown }).maxAttempts;
        const detail = typeof attempt === 'number' && typeof max === 'number' ? `retry ${attempt}/${max}` : undefined;
        return { phase: 'processing', label: 'provider', detail, traceId };
      }
      case 'send_content_delta':
      case 'send_content_end':
        return { phase: 'responding', traceId };
      case 'turn_end':
      case 'turn_interrupted':
        this.clearBuffer(traceId);
        return { phase: 'idle', traceId };
      case 'turn_error':
        this.clearBuffer(traceId);
        return { phase: 'error', label: 'turn', detail: safeErrorDetail((event as { error?: unknown }).error), traceId };
      default:
        return null;
    }
  }
}
