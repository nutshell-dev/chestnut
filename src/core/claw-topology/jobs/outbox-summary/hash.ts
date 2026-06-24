/**
 * @module L4.ClawTopology.OutboxSummary
 * phase 1476: dedup hash 计算.
 *
 * `SHA256(sortedFileSet.join('\n')).slice(0, 12)`:
 * - 任何文件 add/remove/swap → fileSet 变 → hash 变
 * - 同 count 不同 msg → 不同 fileSet → 不同 hash（防 anti-pattern #2）
 * - 12 字符 16^12 ≈ 2.8e14 碰撞概率现实零
 */

import { createSha256Hasher } from '../../../../foundation/node-utils/index.js';

/**
 * Outbox summary dedup hash 长度（SHA256 前缀截取）.
 * Derivation: 12 hex char = 48 bit / 碰撞率 ≈ 2^48 (>200 万亿) 足够 outbox dedup /
 * 比 full SHA256 (64 char) 短 5×、节省 audit row + storage 空间 / 业界 git short SHA 同长.
 */
export const HASH_LEN = 12;

/** Compute dedup hash from already-sorted file set ("<clawId>:<filename>" pairs). */
export function computeHash(sortedFileSet: string[]): string {
  const h = createSha256Hasher();
  h.update(sortedFileSet.join('\n'));
  return h.digest().slice(0, HASH_LEN);
}
