import * as path from 'path';
import { formatErr } from "../../../foundation/utils/index.js";
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { InboxMessageOptionsBase } from '../../../foundation/messaging/index.js';
import { collectContractEvents } from './event-collector.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { CLAWS_DIR } from '../../../foundation/paths.js';
import { MOTION_CLAW_ID } from '../../../constants.js';
import { makeClawId } from '../../../foundation/identity/index.js'
import { type ChestnutRoot } from '../../../foundation/identity/index.js';
import { makeClawDir } from '../../../foundation/identity/index.js';


/**
 * Cron job timeout (ms) / 防 stuck handler 占 cron tick.
 * 由本 module 业务自决 (per ML#2 模块为自己业务语义负责).
 */
export const CONTRACT_OBSERVER_CRON_TIMEOUT_MS = 5 * 60_000;

export interface ContractObserverOptions {
  chestnutRoot: ChestnutRoot;       // .chestnut/ 目录
  fs: FileSystem;             // baseDir = chestnutRoot (装配方预 build)
  motionAudit: AuditLog;      // motion system audit (装配方预 build)
  notifyClaw: (fs: FileSystem, chestnutRoot: ChestnutRoot, targetClawId: string, payload: InboxMessageOptionsBase, audit: AuditLog) => void; // 装配方 closure 包装
  signal?: AbortSignal;
}

// 持久化文件：上次观察时间戳
const STATE_FILE = 'status/contract-observer-state.json';

export async function runContractObserver(options: ContractObserverOptions): Promise<void> {
  const { chestnutRoot, fs, motionAudit, notifyClaw: notifyClawFn } = options;

  // 读上次观察时间戳
  const stateFile = path.join(chestnutRoot, 'motion', STATE_FILE);
  let lastCheckTs = 0;
  try {
    const raw = fs.readSync(stateFile);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null &&
        typeof (parsed as { lastCheckTs?: unknown }).lastCheckTs === 'number') {
      lastCheckTs = (parsed as { lastCheckTs: number }).lastCheckTs;
    } else {
      motionAudit.write(CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_PARSE_FAILED,
        `reason=shape_mismatch`, `stateFile=${stateFile}`);
    }
  } catch (err) {
    // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
    if (!isFileNotFound(err)) {
      const code = (err as NodeJS.ErrnoException)?.code;
      motionAudit.write(
        CONTRACT_AUDIT_EVENTS.OBSERVER_STATE_LOAD_FAILED,
        `file=${stateFile}`,
        `code=${code ?? 'unknown'}`,
        `error=${formatErr(err)}`,
      );
    }
    // 行为兼容: lastCheckTs 保 0 (first-run-like)、不 throw
  }

  // 扫描 claws/ 目录
  const clawsDir = path.join(chestnutRoot, CLAWS_DIR);
  let clawIds: string[];
  try {
    clawIds = fs.listSync(clawsDir, { includeDirs: true })
      .filter(e => e.isDirectory)
      .map(e => e.name);
  } catch (err) {
    if (isFileNotFound(err)) return;
    motionAudit.write(
      CONTRACT_AUDIT_EVENTS.CONTRACT_DIR_SCAN_FAILED,
      `dir=${clawsDir}`,
      `reason=${formatErr(err)}`,
    );
    return;
  }

  const events: string[] = [];
  const allProblemPairs: string[] = [];


  for (const clawId of clawIds) {
    if (options.signal?.aborted) return;
    try {
      const clawDir = makeClawDir(path.join(chestnutRoot, CLAWS_DIR, clawId));
      const result = collectContractEvents(fs, clawDir, makeClawId(clawId), lastCheckTs, motionAudit);
      if (result.events.length > 0) {
        events.push(result.events.join('\n'));
      }
      if (result.problemPairs.length > 0) {
        allProblemPairs.push(...result.problemPairs);
      }
    } catch (e) {
      motionAudit.write(
        CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
        `claw=${clawId}`,
        `reason=${formatErr(e)}`
      );
    }
  }

  // 有事件时写 motion inbox
  if (events.length > 0) {
    // phase 1487: 经 extraFields 透传 problem_pairs 给 motion guidance composer
    // observer 不扫 motion 自家 archive（scan claws/ 只含 worker）→ 不设 source_claw
    //   (composer 见 source_claw 缺 → 走 problem_pairs 分支判 guidance)
    // A3 callback 在 assemble.ts:550 单独透传 source_claw=clawId（含 motion 自家 contract 路径）
    notifyClawFn(fs, chestnutRoot, MOTION_CLAW_ID, {
      type: 'contract_events',
      source: 'system',
      priority: 'high',
      body: events.join('\n\n'),
      extraFields: {
        problem_pairs: allProblemPairs.join(','),
      },
    }, motionAudit);
  }

  // 更新时间戳
  const now = Date.now();
  fs.ensureDirSync(path.dirname(stateFile));
  fs.writeAtomicSync(stateFile, JSON.stringify({ lastCheckTs: now }));
}
