/**
 * @module L2.Stream
 * Stream module (L2)
 *
 * 执行过程的实时观察窗口。写入、读取、归档、裁剪。
 * 依赖：FileSystem
 */

export type { StreamEvent, StreamLog } from './types.js';
export { STREAM_FILE } from './types.js';

// phase 693 Step A: stream 模块声明自家 ephemeral 资源 ignore list (M#3 single owner)
// Assembly 装配期 aggregate 各 owner 声明、注入 Snapshot ctor (per architecture §29)
import { STREAM_FILE as _STREAM_FILE } from './types.js';
export const STREAM_SNAPSHOT_IGNORE: readonly string[] = [_STREAM_FILE];

export { StreamWriter } from './writer.js';
export type { StreamReader } from './reader.js';
export { createStreamReader, readAll } from './reader.js';
export { findRecentTurnStartOffset } from './turn-start-offset.js';
export { LLM_OUTPUT_EVENTS } from './types.js';
export { STREAM_AUDIT_EVENTS } from './audit-events.js';

import type { FileSystem } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import { StreamWriter } from './writer.js';
import type { StreamRetentionOptions } from './writer.js';

export function createStreamWriter(
  fs: FileSystem,
  audit: AuditLog,
  retention?: StreamRetentionOptions,
): StreamWriter {
  return new StreamWriter(fs, audit, retention);
}

export { PerResourceStreamWriter, createPerResourceStreamWriter } from './per-resource-writer.js';
