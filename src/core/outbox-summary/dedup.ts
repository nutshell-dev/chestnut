/**
 * phase 42 改写：dedup 改走 Messaging InboxReader.findByExtraMeta、
 * 不再用文件名正则扫 motion inbox dir。
 *
 * 历史（phase 1476）：曾用 SUMMARY_FILENAME_PATTERN 正则 + listSync motion/inbox/{pending,done}、
 * 通过文件名编入 hash 去重。但 InboxReader.markDone 在归档时给文件名 prepend `<doneTs>_<uuid8>_`、
 * 正则 ^\d+_claw_outbox_summary_... 永匹配不上 done 文件 → dedup miss → motion 反复收。
 *
 * phase 42 根治：hash 移入 InboxMessage.extraMeta、查走 Messaging 对外入口、绕过 filename schema。
 */

import type { InboxReader } from '../../foundation/messaging/index.js';

export const DEDUP_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SUMMARY_HASH_META_KEY = 'summary-hash' as const;

export type DedupHit = 'pending' | 'done' | null;

export interface DedupDeps {
  inboxReader: InboxReader;
}

export async function findExistingSummaryByHash(
  deps: DedupDeps,
  hash: string,
): Promise<DedupHit> {
  const hit = await deps.inboxReader.findByExtraMeta(
    SUMMARY_HASH_META_KEY,
    hash,
    { includeDoneWithinMs: DEDUP_DONE_WINDOW_MS },
  );
  return hit?.location ?? null;
}
