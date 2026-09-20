/**
 * assembly 自有 stream 事件（phase 1321 分层拆件）。
 * daemon_started 写端仅 assembly 自身（assemble.ts）。
 * 全量判别联合（含本 const 的 payload）归 CLI 汇总（viewport/stream-event-types.ts）。
 */
export const ASSEMBLY_STREAM_EVENTS = {
  DAEMON_STARTED: 'daemon_started',
} as const;
