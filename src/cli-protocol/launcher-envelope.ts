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
 * activity wire phase（phase 2001 引入，phase 2002 增 error）：waiting 是 consumer 本地态
 * （send ack 前后），不上 wire。processing=turn/llm/thinking/text/tool/provider 活跃；
 * responding=send 内容输出中（send_content_end 不结束 turn）；idle=turn_end/turn_interrupted
 * 恢复无活动；error=turn_error——保留可读错误行，直到下一次发送才清除。
 */
export type LauncherActivityPhase = 'processing' | 'responding' | 'idle' | 'error';

/** activity label 机器 token 全集（phase 2002 收窄为封闭集合；展示文案归 consumer ActivityStyle）。 */
export type LauncherActivityLabel = 'thinking' | 'text' | 'tool' | 'tool_result' | 'provider' | 'turn';

/**
 * activity envelope payload：phase + 短 label token + 安全摘要。
 * detail 是单行净化（换行折空格）、截断后的摘要（thinking/text ≤240 字符、error ≤160 字符），
 * 不携带 thinking 全文、工具 input、密钥或完整错误 payload。
 */
export interface LauncherActivityPayload {
  phase: LauncherActivityPhase;
  label?: LauncherActivityLabel;
  detail?: string;
  traceId?: string;
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
  payload: Record<string, unknown>;
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
  return makeLauncherEnvelope(sequence, sessionId, 'activity', payload);
}
