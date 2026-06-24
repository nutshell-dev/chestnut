/**
 * @module L1.NodeUtils
 *
 * 哈希计算 owner（M#3 资源归一、M#7 接口最小）：sha256 唯一封装。
 * 其他模块经本模块 API 计算 sha256、不直 import node:crypto。
 *
 * phase 712 并入 L1.NodeUtils。
 */

import { createHash } from 'node:crypto';

/**
 * 一次性计算 sha256 hex digest。
 *
 * 用作：内容指纹（如 AGENTS.md prompt hash、content hash）。
 * 字符串内容按 utf8 编码（Node createHash.update 默认）。
 */
export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * 计算 sha256 hex digest + slice(0, len) 短指纹。
 *
 * 用作：AGENTS.md 6 字短 hash、content lookup 8 字短 hash、outbox dedup 12 字短 hash 等。
 *
 * @param len 短指纹长度
 */
export function sha256ShortHex(content: string | Buffer, len: number): string {
  return sha256Hex(content).slice(0, len);
}

/**
 * 创建 sha256 streaming hasher、用于多次 update 场景。
 *
 * 返回 minimal API：update(data) + digest()。不暴露 Node createHash 全集。
 *
 * 用作：outbox summary streaming hash、文件集合 hash 等。
 */
export function createSha256Hasher(): { update: (data: string | Buffer) => void; digest: () => string } {
  const h = createHash('sha256');
  return {
    update: (data) => { h.update(data); },
    digest: () => h.digest('hex'),
  };
}
