/**
 * @module L6.CLI.LauncherEnvelopeProducer
 *
 * chestnut.launcher.v1 运行时 producer（phase 1994 Step B 自 cli-protocol 拆出）：
 * CLIProtocol 是 L6 叶子静态协议模块，不依赖 foundation stream/crypto；
 * 运行时 stream 适配与熵源使用归 CLIProcess（本模块）。
 * 静态协议构造器（envelope/sequencer/error）仍在 src/cli-protocol/launcher-envelope.ts。
 */

import { newUuid } from '../foundation/node-utils/index.js';
import { isContextExceededStreamError, type StreamEvent } from '../foundation/stream/index.js';
import { formatClawBarError, type LauncherActivityPayload } from '../cli-protocol/index.js';

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
 * 同一次 send 的 delta 累积进同一消息；send_content_end 开启下一消息边界。
 * trace 只标识 turn，不能合并同 turn 的多次 send（phase 2017 实机证据）。
 *
 * phase 2000 实机修复：真实 stream 中多个 send_content_delta 块的 trace 会交错
 * （A,B,A,B…——实机 stream.jsonl 证据见 phase2000-logs）。旧的单缓冲实现
 * 在每次 trace 切换时清空缓冲，交错场景下每个块只剩切换后的最后一段
 * （用户实机症状：流式输出只保留最后一个块）。改为 Map<trace, buf> 按 trace
 * 独立累积，交错不再互相清空。
 */
export class LauncherEventMapper {
  private replyBufs = new Map<string, string>();
  private sendOrdinals = new Map<string, number>();

  map(event: StreamEvent): { messageId: string; role: 'motion'; text: string } | null {
    const trace = typeof event.trace_id === 'string' && event.trace_id ? event.trace_id : 'untraced';
    if (event.type === 'send_content_end') {
      this.sendOrdinals.set(trace, (this.sendOrdinals.get(trace) ?? 1) + 1);
      return null;
    }
    if (event.type !== 'send_content_delta') return null;
    const deltaText = typeof event.delta === 'string' ? event.delta : null;
    if (deltaText === null || deltaText === '') return null;
    const ordinal = this.sendOrdinals.get(trace) ?? 1;
    const messageId = ordinal === 1 ? `reply-${trace}` : `reply-${trace}-send-${ordinal}`;
    const buf = (this.replyBufs.get(messageId) ?? '') + deltaText;
    this.replyBufs.set(messageId, buf);
    return { messageId, role: 'motion', text: buf };
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

/** 事件时间原点（epoch ms）：stream 事件必有 ts（reader 保证），缺失时不上 wire。 */
function eventTs(event: StreamEvent): number | undefined {
  return typeof event.ts === 'number' && Number.isFinite(event.ts) ? event.ts : undefined;
}

/** thinking/text 摘要上限（字符）：只保留尾部——最新进展比开头更有信息量（claw fitLine 语义）。 */
const ACTIVITY_SUMMARY_LIMIT = 240;

/** 单行净化：换行/连续空白折为单个空格（claw bar 语义：textBuffer.replace(/\n/g,' ')）。 */
function sanitizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 内部 StreamEvent → activity wire payload（phase 2001 引入，phase 2002 按 claw bar 重做摘要，
 * phase 2003 Step E 错误行复用共享 formatter）：
 * - thinking_delta / 裸 text_delta：按 trace 累计缓冲，单行净化 + 尾部截断，随 delta 流式刷新
 *   （裸 text_delta 只进活动摘要，不作为 Motion 聊天消息——phase 1990 消息面决策不变）；
 * - tool/provider 事件只更新短标签（工具名/provider 名），不带 input 与完整错误；
 * - send_content_delta/end → responding（send 完成不结束 turn，活动保留）；
 * - turn_end → idle；错误/终止族（phase 2003 Step F，detail 一律为 formatClawBarError
 *   输出，与 viewport claw bar 逐字节一致，不自造摘要、不加角色前缀）：
 *   turn_error（普通）→ error；turn_error（context-exceeded 前缀）→ retry 临时态；
 *   context_trim_retry_scheduled → retry 正式态；context_trim_blocked → blocked；
 *   turn_interrupted → interrupted（保留可见，不再静默 idle）；sinceMs 携带事件 ts
 *   作为 duration 统一时间原点；
 * - 同一 stream event 可同时产生 activity 与消息 event（如 send_content_delta）。
 *
 * 有状态：按 trace 分桶的摘要缓冲；turn_start/turn_end/turn_error/turn_interrupted 清理对应
 * trace 的生命周期缓冲（多 trace 交错互不串摘要——phase 2000 交错教训）。
 */
export class LauncherActivityMapper {
  private buffers = new Map<string, { kind: 'thinking' | 'text'; text: string }>();

  /** claw 标识：错误行格式化前缀（[id]），由 claw-stream 传入。 */
  constructor(private readonly clawId: string) {}

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
        this.clearBuffer(traceId);
        return { phase: 'idle', traceId };
      // phase 2003 Step F：错误/终止族完整同步 claw bar——detail 一律为共享 formatter
      // 输出（consumer 原样显示），sinceMs 携带事件时间原点（viewport/launcher duration
      // 同一起点）；retry/blocked 用显式 phase，不误当普通 processing 或普通 error。
      case 'turn_interrupted':
        this.clearBuffer(traceId);
        return {
          phase: 'interrupted',
          detail: formatClawBarError(this.clawId, { kind: 'interrupted' }),
          sinceMs: eventTs(event),
          traceId,
        };
      case 'turn_error': {
        this.clearBuffer(traceId);
        const raw = (event as { error?: unknown }).error;
        const message = typeof raw === 'string' && raw ? raw : undefined;
        // 可恢复 context 超限（wire 前缀约定，foundation/stream 单源）：先置临时 retry
        // 提示，随后 context_trim_retry_scheduled 覆盖为带 attempt/delay 的正式提示。
        if (isContextExceededStreamError(message)) {
          return {
            phase: 'retry',
            detail: formatClawBarError(this.clawId, { kind: 'retry', message: 'context exceeded; trimming…' }),
            sinceMs: eventTs(event),
            traceId,
          };
        }
        return {
          phase: 'error',
          label: 'turn',
          detail: message
            ? formatClawBarError(this.clawId, { kind: 'error', message })
            : undefined,
          sinceMs: eventTs(event),
          traceId,
        };
      }
      case 'context_trim_retry_scheduled': {
        const attempt = (event as { attempt?: unknown }).attempt;
        const maxAttempts = (event as { maxAttempts?: unknown }).maxAttempts;
        const delayMs = (event as { delayMs?: unknown }).delayMs;
        const message =
          typeof attempt === 'number' && typeof maxAttempts === 'number' && typeof delayMs === 'number'
            ? `context exceeded · retrying (${attempt}/${maxAttempts}, ${Math.round(delayMs / 1000)}s)`
            : 'context exceeded; trimming…';
        return {
          phase: 'retry',
          detail: formatClawBarError(this.clawId, { kind: 'retry', message }),
          traceId,
        };
      }
      case 'context_trim_blocked': {
        const reason = (event as { reason?: unknown }).reason;
        const message = `context blocked (${typeof reason === 'string' && reason ? reason : 'unknown'})`;
        return {
          phase: 'blocked',
          detail: formatClawBarError(this.clawId, { kind: 'blocked', message }),
          sinceMs: eventTs(event),
          traceId,
        };
      }
      default:
        return null;
    }
  }
}
