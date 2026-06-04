/**
 * @module L4.OutboxSummary
 * phase 1476: scan all claws/*\/outbox/pending → counts + fileSet.
 * phase 42: outbox/pending 列举改走 Messaging.OutboxReader（消 MLP-3 直访）。
 *
 * 业主仅 own claw outbox/pending 计数 + 文件身份扫描。MOTION_CLAW_ID 跳过
 * （motion 自家不该写 outbox-summary 到自家 outbox）。失败 silent skip per claw
 * （per-tick handler 异常隔离归 cron runner / 详 l5_cron.md §1）.
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import { isFileNotFound } from '../../foundation/fs/types.js';
import type { OutboxReader } from '../../foundation/messaging/index.js';
import type { ChestnutRoot } from '../../foundation/identity/index.js';
import { CLAWS_DIR } from '../../foundation/paths.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import { computeHash } from './hash.js';
import type { OutboxSummaryState } from './types.js';

export interface ScanDeps {
  chestnutRoot: ChestnutRoot;
  fs: FileSystem;             // 仅供 enumerate claws/（§7.B B.4 cross-cutting 留 future）
  outboxReader: OutboxReader; // Messaging 对外入口：单 claw outbox/pending 列举
}

export async function scanOutboxes(deps: ScanDeps): Promise<OutboxSummaryState> {
  const { chestnutRoot, fs, outboxReader } = deps;
  const clawsDir = path.join(chestnutRoot, CLAWS_DIR);

  let clawIds: string[];
  try {
    clawIds = fs.listSync(clawsDir, { includeDirs: true })
      .filter(e => e.isDirectory)
      .map(e => e.name)
      .filter(id => id !== MOTION_CLAW_ID);
  } catch (err) {
    if (isFileNotFound(err)) return emptyState();
    throw err;
  }

  const counts: Record<string, number> = {};
  const fileSet: string[] = [];

  for (const clawId of clawIds) {
    const clawDir = path.join(clawsDir, clawId);
    const files = await outboxReader.listClawOutboxPending(clawDir);
    if (files.length > 0) {
      counts[clawId] = files.length;
      for (const f of files) fileSet.push(`${clawId}:${f}`);
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
  };
}

function emptyState(): OutboxSummaryState {
  return {
    counts: {},
    total_claws: 0,
    total_msgs: 0,
    file_set: [],
    hash: computeHash([]),
  };
}
