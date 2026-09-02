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

import type { InboxReader, ScannedInboxLocation } from '../../../../foundation/messaging/index.js';

export const DEDUP_DONE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SUMMARY_HASH_META_KEY = 'summary-hash' as const;

type DedupHit = ScannedInboxLocation | null;

interface DedupDeps {
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

/**
 * done/ 全量历史查询：判断该 hash 是否曾推送过（含 24h 窗外的陈旧记录）。
 * 前置条件 = dedup miss（pending/inflight/done<24h 均无）→ 命中必来自
 * done 中 mtime ≥ 24h 的旧 summary；failed 不扫为 findByExtraMeta 固有语义。
 * phase 1749：∞ 窗口复用 includeDoneWithinMs 参数、零 Messaging 接口扩展
 * （inbox-reader done 分支 windowMs<=0 才拒、∞ 时 cutoff=-Infinity 不过滤）。
 */
export async function findHistoricalSummaryByHash(
  deps: DedupDeps,
  hash: string,
): Promise<boolean> {
  const hit = await deps.inboxReader.findByExtraMeta(
    SUMMARY_HASH_META_KEY,
    hash,
    { includeDoneWithinMs: Number.POSITIVE_INFINITY },
  );
  return hit !== null;
}
