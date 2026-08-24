/**
 * @module L1.NodeUtils
 *
 * 熵源资源 owner（M#3 资源唯一归属）：`randomUUID` + `randomBytes` 唯一封装。
 * 其他模块经本模块 API 取唯一 ID / 熵字节、不直 import node:crypto。
 *
 * phase 712 并入 L1.NodeUtils。
 */

import { randomUUID, randomBytes } from 'node:crypto';
/** Short UUID prefix length for human-readable IDs (phase 520: inlined from former root constants.ts) */
const UUID_SHORT_LEN = 8;

/**
 * 生成 UUID v4。
 *
 * 用作：subtask ID / task ID / trace ID / 临时文件名 / 等需唯一标识场景。
 */
export function newUuid(): string {
  return randomUUID();
}

/**
 * 从 UUID 截取前缀得到短 ID。
 *
 * 用作：Human-readable short ID、task shortId、blockId short ref 等需要
 * 从长 UUID 推导短引用的场景。长度默认 UUID_SHORT_LEN = 8。
 *
 * 这是「长→短」的单源规则——所有需要从长 UUID 取前缀的地方都调这里，
 * 不各自 slice(0, 8)。
 */
export function uuidToShort(uuid: string, len: number = UUID_SHORT_LEN): string {
  return uuid.slice(0, len);
}

/**
 * 生成 UUID v4 + slice(0, len) 短 ID。
 *
 * 用作：人类可读的 short ID（如 commit msg、log 行 prefix）。
 *
 * @param len 短 ID 长度、默认 `UUID_SHORT_LEN = 8`
 */
export function newShortUuid(len: number = UUID_SHORT_LEN): string {
  return uuidToShort(randomUUID(), len);
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
