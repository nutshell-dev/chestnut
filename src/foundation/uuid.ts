/**
 * @module L1.Uuid
 *
 * 熵源资源 owner（M#3 资源唯一归属）：`randomUUID` + `randomBytes` 唯一封装。
 * 其他模块经本模块 API 取唯一 ID / 熵字节、不直 import node:crypto。
 *
 * phase 449 立、F3 partial randomUUID 资源归一。
 * createHash 计算函数留 F3 余（性质不同、单独 phase 评归 foundation/hash）。
 */

import { randomUUID, randomBytes } from 'node:crypto';
/** Short UUID prefix length for human-readable IDs (phase 520: inlined from former root constants.ts) */
export const UUID_SHORT_LEN = 8;

/**
 * 生成 UUID v4。
 *
 * 用作：subtask ID / task ID / trace ID / 临时文件名 / 等需唯一标识场景。
 */
export function newUuid(): string {
  return randomUUID();
}

/**
 * 生成 UUID v4 + slice(0, len) 短 ID。
 *
 * 用作：人类可读的 short ID（如 commit msg、log 行 prefix）。
 *
 * @param len 短 ID 长度、默认 `UUID_SHORT_LEN = 8`
 */
export function newShortUuid(len: number = UUID_SHORT_LEN): string {
  return randomUUID().slice(0, len);
}

/**
 * 生成 N 字节随机熵 hex 编码字符串。
 *
 * 用作：trace ID 等需 cryptographic 强度但比 UUID 短的场景。
 *
 * @param byteLen 熵字节数
 */
export function randomHex(byteLen: number): string {
  return randomBytes(byteLen).toString('hex');
}
