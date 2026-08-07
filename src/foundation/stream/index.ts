/**
 * @module L2b.Stream
 * Stream module (L2)
 *
 * 执行过程的实时观察窗口。写入、读取、归档、裁剪。
 * 依赖：FileSystem
 */

export type { StreamEvent, StreamEventType, StreamEventMap, StreamLog } from './types.js';
export { STREAM_FILE, STREAM_EVENT_NAMES } from './types.js';

// phase 693 Step A: stream 模块声明自家 ephemeral 资源 ignore list (M#3 single owner)
// Assembly 装配期 aggregate 各 owner 声明、注入 Snapshot ctor (per architecture §29)
export { STREAM_SNAPSHOT_IGNORE } from './writer.js';

export { StreamWriter } from './writer.js';
export type { StreamReader } from './reader.js';
export { createStreamReader, readAll } from './reader.js';
export { findRecentTurnStartOffset } from './turn-start-offset.js';
export { LLM_OUTPUT_EVENTS } from './types.js';

// phase 749: sync NDJSON line parser for incremental stream readers
export { parseStreamLines } from './parse-stream-lines.js';

export { createStreamWriter } from './writer.js';

export { createPerResourceStreamWriter } from './per-resource-writer.js';
export { STREAM_FILE_ROUTING } from './audit-events.js';
