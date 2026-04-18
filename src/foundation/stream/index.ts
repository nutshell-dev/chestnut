/**
 * Stream module (L2)
 *
 * 执行过程的实时观察窗口。写入、读取、归档、裁剪。
 * 依赖：FileSystem
 */

export type { StreamEvent, StreamLog } from './types.js';
export { STREAM_FILE } from './types.js';
export { StreamWriter } from './writer.js';
export type { StreamReader } from './reader.js';
export { createStreamReader, readAll } from './reader.js';
