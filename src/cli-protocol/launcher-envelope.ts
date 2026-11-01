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
 *
 * 静态 wire protocol（phase 1994 Step B）：本文件零 foundation/crypto import；
 * 运行时 producer（LauncherEventMapper / makeLauncherSessionId）归 CLIProcess，
 * 见 src/cli/launcher-envelope-producer.ts。
 */

export const LAUNCHER_PROTOCOL_VERSION = 'chestnut.launcher.v1';

export type LauncherEnvelopeKind = 'event' | 'activity' | 'ack' | 'error' | 'terminal';

/**
 * activity wire phase（phase 2001 引入，phase 2002 增 error，phase 2003 Step F 增
 * interrupted/retry/blocked）：waiting 是 consumer 本地态（send ack 前后），不上 wire。
 * processing=turn/llm/thinking/text/tool/provider 活跃；responding=send 内容输出中
 * （send_content_end 不结束 turn）；idle=turn_end 恢复无活动。
 * 错误/终止族（全部保留可见直到下一次 send 或新 activity 覆盖，detail 为 claw bar
 * 共享 formatter 输出，consumer 原样显示）：error=turn_error（普通错误）；
 * interrupted=turn_interrupted；retry=可恢复 context 超限（turn_error 带
 * context-exceeded 前缀的临时态 / context_trim_retry_scheduled 正式态）；
 * blocked=context_trim_blocked（终局）。retry/blocked 不得被误当普通 processing 或
 * 普通 error 文案——phase 显式区分，符号差异（⟳/⏸/✗）已在 detail 内。
 */
export type LauncherActivityPhase =
  | 'processing'
  | 'responding'
  | 'idle'
  | 'error'
  | 'interrupted'
  | 'retry'
  | 'blocked';

/** activity label 机器 token 全集（phase 2002 收窄为封闭集合；展示文案归 consumer ActivityStyle）。 */
export type LauncherActivityLabel = 'thinking' | 'text' | 'tool' | 'tool_result' | 'provider' | 'turn';

/**
 * activity envelope payload：phase + 短 label token + 安全摘要。
 * detail 是单行净化（换行折空格）、截断后的摘要（thinking/text ≤240 字符；错误族 detail
 * 为 claw bar 共享 formatter 输出，不在 producer 截断——截断归 UI），不携带 thinking 全文、
 * 工具 input、密钥或完整错误 payload。
 * sinceMs（phase 2003 Step F）：错误/终止族的事件时间原点（epoch ms，取事件 ts），
 * viewport 与 launcher 的 inactive duration 共享同一起点，不各自取当前时间。
 */
export interface LauncherActivityPayload {
  phase: LauncherActivityPhase;
  label?: LauncherActivityLabel;
  detail?: string;
  traceId?: string;
  sinceMs?: number;
}

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
  payload: object;
}

/** 会话内连号 sequence 生成器（1 起；launcher 以首个 envelope 建基线）。 */
export function createLauncherSequencer(): () => number {
  let next = 0;
  return () => ++next;
}

export function makeLauncherEnvelope(
  sequence: number,
  sessionId: string,
  kind: LauncherEnvelopeKind,
  payload: object,
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

/** activity envelope 构造器（phase 2001）：可选字段缺省不写入 payload。 */
export function launcherActivityEnvelope(
  sequence: number,
  sessionId: string,
  activity: LauncherActivityPayload,
): LauncherEnvelope {
  const payload: Record<string, unknown> = { phase: activity.phase };
  if (activity.label !== undefined) payload.label = activity.label;
  if (activity.detail !== undefined) payload.detail = activity.detail;
  if (activity.traceId !== undefined) payload.traceId = activity.traceId;
  if (activity.sinceMs !== undefined) payload.sinceMs = activity.sinceMs;
  return makeLauncherEnvelope(sequence, sessionId, 'activity', payload);
}


// Phase 2013: v2 is additive; the claw-specific v1 surface above remains unchanged.
export const LAUNCHER_PROTOCOL_VERSION_V2 = 'chestnut.launcher.v2' as const;
export type DaemonState = 'unknown' | 'starting' | 'running' | 'stopped' | 'error';
export type LauncherOnboardingState = 'complete' | 'created' | 'resumed' | 'pending';
export type DeliveryState = 'persisted' | 'queued' | 'processing' | 'rejected';
export type LauncherTerminalReason = 'stopped' | 'completed' | 'protocol_error';

export interface LauncherDaemonPayload {
  state: DaemonState;
  sinceMs?: number;
  detail?: string;
  /** Present on start ready: shared bootstrap has already ensured/notified onboarding. */
  onboarding?: LauncherOnboardingState;
}

export interface LauncherMessagePayload {
  messageId: string;
  role: string;
  text: string;
  /** Persistent turn/send facts supplied by the stream owner; consumers never infer them. */
  turnId?: string;
  sendOrdinal?: number;
}

export interface LauncherSendAckPayload {
  requestId: string;
  delivery: DeliveryState;
  daemon: DaemonState;
}

export interface LauncherErrorPayload {
  class: string;
  detail: string;
  retryable: boolean;
  requestId?: string;
}

export interface LauncherSnapshotPayload {
  workspace: { claw: string };
  initialization: string;
  daemon: LauncherDaemonPayload;
  capabilities: unknown;
  active: boolean;
  messages: LauncherMessagePayload[];
  activity?: LauncherActivityPayload;
  afterSequence?: number;
  resync?: 'resync_required';
  [key: string]: unknown;
}

export type LauncherV2Envelope =
  | { protocol: typeof LAUNCHER_PROTOCOL_VERSION_V2; kind: 'snapshot'; sequence: number; payload: LauncherSnapshotPayload }
  | { protocol: typeof LAUNCHER_PROTOCOL_VERSION_V2; kind: 'daemon'; sequence: number; payload: LauncherDaemonPayload }
  | { protocol: typeof LAUNCHER_PROTOCOL_VERSION_V2; kind: 'activity'; sequence: number; payload: LauncherActivityPayload }
  | { protocol: typeof LAUNCHER_PROTOCOL_VERSION_V2; kind: 'message'; sequence: number; payload: LauncherMessagePayload }
  | { protocol: typeof LAUNCHER_PROTOCOL_VERSION_V2; kind: 'send_ack'; sequence: number; payload: LauncherSendAckPayload }
  | { protocol: typeof LAUNCHER_PROTOCOL_VERSION_V2; kind: 'error'; sequence: number; payload: LauncherErrorPayload }
  | { protocol: typeof LAUNCHER_PROTOCOL_VERSION_V2; kind: 'terminal'; sequence: number; payload: { reason: LauncherTerminalReason } };

export type LauncherV2EnvelopeKind = LauncherV2Envelope['kind'];
export type LauncherV2Payload = LauncherV2Envelope['payload'];

export function makeLauncherV2Envelope<K extends LauncherV2EnvelopeKind>(
  sequence: number,
  kind: K,
  payload: Extract<LauncherV2Envelope, { kind: K }>['payload'],
): Extract<LauncherV2Envelope, { kind: K }> {
  return { protocol: LAUNCHER_PROTOCOL_VERSION_V2, sequence, kind, payload } as Extract<LauncherV2Envelope, { kind: K }>;
}

export function writeLauncherV2Envelope(out: NodeJS.WritableStream, value: LauncherV2Envelope): void {
  out.write(JSON.stringify(value) + '\n');
}

export interface UnknownLauncherV2Envelope {
  protocol: typeof LAUNCHER_PROTOCOL_VERSION_V2;
  kind: `unknown:${string}`;
  rawKind: string;
  sequence: number;
  payload: unknown;
}

/** Parse and validate the common v2 frame; future kinds remain auditable as unknown. */
export function parseLauncherV2Envelope(line: string): LauncherV2Envelope | UnknownLauncherV2Envelope {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('launcher envelope must be an object');
  const frame = value as Record<string, unknown>;
  if (frame.protocol !== LAUNCHER_PROTOCOL_VERSION_V2) throw new Error('unsupported launcher protocol');
  if (!Number.isInteger(frame.sequence) || (frame.sequence as number) < 1) throw new Error('sequence must be a positive integer');
  if (typeof frame.kind !== 'string' || !frame.kind) throw new Error('kind is required');
  if (!('payload' in frame)) throw new Error('payload is required');
  const known: readonly LauncherV2EnvelopeKind[] = ['snapshot', 'daemon', 'activity', 'message', 'send_ack', 'error', 'terminal'];
  if (!known.includes(frame.kind as LauncherV2EnvelopeKind)) {
    return {
      protocol: LAUNCHER_PROTOCOL_VERSION_V2,
      kind: `unknown:${frame.kind}`,
      rawKind: frame.kind,
      sequence: frame.sequence as number,
      payload: frame.payload,
    };
  }
  return frame as unknown as LauncherV2Envelope;
}
