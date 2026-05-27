/**
 * @module L2.Stream
 * Stream module (L2)
 *
 * 执行过程的实时观察窗口。写入、读取、归档、裁剪。
 * 依赖：FileSystem
 */

export type { StreamEvent, StreamLog } from './types.js';
export { STREAM_FILE } from './types.js';
export { StreamWriter } from './writer.js';
export type { StreamRetentionOptions } from './writer.js';
export type { StreamReader } from './reader.js';
export { createStreamReader, readAll } from './reader.js';
export { findRecentTurnStartOffset } from './turn-start-offset.js';
export { LLM_OUTPUT_EVENTS } from './types.js';
export { STREAM_AUDIT_EVENTS } from './audit-events.js';

import type { FileSystem } from '../fs/types.js';
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
