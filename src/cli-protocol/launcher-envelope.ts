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
