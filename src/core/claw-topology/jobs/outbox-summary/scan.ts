/**
 * @module L4.ClawTopology.OutboxSummary
 * phase 1476: scan all claws/*\/outbox/pending → counts + fileSet.
 * phase 42: outbox/pending 列举改走 Messaging.OutboxReader（消 MLP-3 直访）。
 * phase 938: per-claw I/O failure recorded in failed_claws + incomplete flag.
 *
 * 业主仅 own claw outbox/pending 计数 + 文件身份扫描。MOTION_CLAW_ID 跳过
 * （motion 自家不该写 outbox-summary 到自家 outbox）。typed list/peek failure
 * 记录 failed_claws；其他异常继续抛出，不在 scan 内吞掉。
 */

import type { FileSystem } from '../../../../foundation/fs/index.js';
import { isFileNotFound } from '../../../../foundation/fs/index.js';
import type { OutboxReader } from '../../../../foundation/messaging/index.js';
import { MOTION_CLAW_ID } from '../../motion-claw-id.js';
import type { ClawTopology } from '../../types.js';
import type { ClawId } from '../../../../foundation/claw-identity/index.js';
import { computeHash } from './hash.js';
import { PREVIEW_MAX_CHARS } from './types.js';
import type { OutboxSummaryState } from './types.js';
import { llmProviderAbort } from '../../../../foundation/llm-provider/index.js';
const { makeExternalAbortError } = llmProviderAbort;

interface ScanDeps {
  /** phase 259: caller (装配期) 注入的 claw topology */
  clawTopology: ClawTopology;
  fs: FileSystem;             // 仅供 enumerate claws/
  /** One root-bound reader per claw; readers/claims are never shared across roots. */
  outboxReaderFactory: (clawRoot: string) => OutboxReader;
  /** phase 938: cooperative abort signal checked before each claw scan. */
  signal?: AbortSignal;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw makeExternalAbortError(signal.reason);
  }
}

export async function scanOutboxes(deps: ScanDeps): Promise<OutboxSummaryState> {
  const { clawTopology, outboxReaderFactory, signal } = deps;

  let clawIds: ClawId[];
  try {
    clawIds = clawTopology.enumerate().filter(id => id !== MOTION_CLAW_ID);
  } catch (err) {
    if (signal?.aborted) throw makeExternalAbortError(signal.reason);
    if (isFileNotFound(err)) return emptyState();
    throw err;
  }

  const counts: Record<string, number> = {};
  const fileSet: string[] = [];
  const previews: Record<string, string> = {};
  const failedClaws: string[] = [];

  for (const clawId of clawIds) {
    throwIfAborted(signal);

    const location = clawTopology.resolve(clawId);
    const outboxReader = outboxReaderFactory(location.clawDir);
    const listed = await outboxReader.listPendingResult().catch((error: unknown) => {
      if (signal?.aborted) throw makeExternalAbortError(signal.reason);
      throw error;
    });
    if (listed.kind === 'failed') {
      failedClaws.push(clawId);
      continue;
    }
    if (listed.kind === 'empty') continue;

    const last = await outboxReader.peekLastOutboxPending().catch((error: unknown) => {
      if (signal?.aborted) throw makeExternalAbortError(signal.reason);
      throw error;
    });
    // `found` 才入快照；typed failure 与快照竞态均 fail-closed。
    switch (last.kind) {
      case 'found':
        counts[clawId] = listed.files.length;
        for (const f of listed.files) fileSet.push(`${clawId}:${f}`);
        previews[clawId] = truncatePreview(last.message.content);
        break;
      case 'empty':
      case 'failed':
        failedClaws.push(clawId);
        break;
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
