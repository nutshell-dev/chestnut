/**
 * @module L4.ClawTopology.OutboxSummary
 * phase 1476: scan all claws/*\/outbox/pending → counts + fileSet.
 * phase 42: outbox/pending 列举改走 Messaging.OutboxReader（消 MLP-3 直访）。
 * phase 938: per-claw I/O failure recorded in failed_claws + incomplete flag.
 *
 * 业主仅 own claw outbox/pending 计数 + 文件身份扫描。MOTION_CLAW_ID 跳过
 * （motion 自家不该写 outbox-summary 到自家 outbox）。失败 silent skip per claw
 * （per-tick handler 异常隔离归 cron runner / 详 l5_cron.md §1）.
 */

import type { FileSystem } from '../../../../foundation/fs/index.js';
import { isFileNotFound } from '../../../../foundation/fs/index.js';
import type { OutboxReader } from '../../../../foundation/messaging/index.js';
import { MOTION_CLAW_ID } from '../../index.js';
import type { ClawTopology } from '../../index.js';
import type { ClawId } from '../../../../foundation/claw-identity/index.js';
import { computeHash } from './hash.js';
import { PREVIEW_MAX_CHARS } from './types.js';
import type { OutboxSummaryState } from './types.js';
import { makeExternalAbortError, type AbortReason } from '../../../../foundation/llm-provider/abort-helper.js';

export interface ScanDeps {
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  fs: FileSystem;             // 仅供 enumerate claws/
  outboxReader: OutboxReader; // Messaging 对外入口：单 claw outbox/pending 列举
  /** phase 938: cooperative abort signal checked before each claw scan. */
  signal?: AbortSignal;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw makeExternalAbortError(signal.reason as AbortReason | undefined);
  }
}

export async function scanOutboxes(deps: ScanDeps): Promise<OutboxSummaryState> {
  const { clawTopology, outboxReader, signal } = deps;

  let clawIds: ClawId[];
  try {
    clawIds = clawTopology.enumerate().filter(id => id !== MOTION_CLAW_ID);
  } catch (err) {
    if (signal?.aborted) throw makeExternalAbortError(signal.reason as AbortReason | undefined);
    if (isFileNotFound(err)) return emptyState();
    throw err;
  }

  const counts: Record<string, number> = {};
  const fileSet: string[] = [];
  const previews: Record<string, string> = {};
  const failedClaws: string[] = [];

  for (const clawId of clawIds) {
    throwIfAborted(signal);

    try {
      const location = clawTopology.resolve(clawId);
      if (location.kind !== 'local') continue;

      const files = await outboxReader.listClawOutboxPending(location.clawDir);
      if (files.length === 0) continue;

      const last = await outboxReader.peekLastOutboxPending(location.clawDir);
      if (!last) {
        // List succeeded but peek returned null — incomplete snapshot.
        // Mark this claw as failed rather than silently producing partial data.
        failedClaws.push(clawId);
        continue;
      }

      counts[clawId] = files.length;
      for (const f of files) fileSet.push(`${clawId}:${f}`);
      previews[clawId] = truncatePreview(last.message.content);
    } catch (err) {
      if (signal?.aborted) throw makeExternalAbortError(signal.reason as AbortReason | undefined);
      // phase 938: fail-closed — record the failed claw and mark summary incomplete.
      failedClaws.push(clawId);
    }
  }

  fileSet.sort();
  const hash = computeHash(fileSet);
  const totalMsgs = Object.values(counts).reduce((s, n) => s + n, 0);

  return {
    counts,
    total_claws: Object.keys(counts).length,
    total_msgs: totalMsgs,
    file_set: fileSet,
    hash,
    previews,
    failed_claws: failedClaws,
    incomplete: failedClaws.length > 0,
  };
}

function emptyState(): OutboxSummaryState {
  return {
    counts: {},
    total_claws: 0,
    total_msgs: 0,
    file_set: [],
    hash: computeHash([]),
    previews: {},
    failed_claws: [],
    incomplete: false,
  };
}

/**
 * 截断 outbox message content 作 motion summary 预览：
 * - 取首行（split('\n')[0]）
 * - trim
 * - 若空 → '(空消息)'
 * - 否则按 grapheme 切到 PREVIEW_MAX_CHARS、超长加 '…'
 *
 * 用 Array.from 切防 surrogate pair 中断（emoji / 多字节）。
 */
export function truncatePreview(content: string): string {
  const firstLine = content.split('\n')[0]?.trim() ?? '';
  if (!firstLine) return '(空消息)';
  const chars = Array.from(firstLine);
  if (chars.length <= PREVIEW_MAX_CHARS) return firstLine;
  return chars.slice(0, PREVIEW_MAX_CHARS).join('') + '…';
}
