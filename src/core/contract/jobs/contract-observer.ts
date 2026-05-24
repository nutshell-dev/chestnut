import * as path from 'path';
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/types.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { InboxMessageOptionsBase } from '../../../foundation/messaging/index.js';
import { collectContractEvents } from './event-collector.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { CLAWS_DIR } from '../../../foundation/paths.js';

export interface ContractObserverOptions {
  clawforumDir: string;       // .clawforum/ 目录
  motionInboxDir: string;     // motion inbox/pending/ 路径
  fs: FileSystem;             // baseDir = clawforumDir (装配方预 build)
  motionAudit: AuditLog;      // motion system audit (装配方预 build)
  notifyInbox: (payload: InboxMessageOptionsBase & { inboxDir: string }, audit: AuditLog) => void; // 装配方 closure 包装
}

// 持久化文件：上次观察时间戳
const STATE_FILE = 'status/contract-observer-state.json';

export async function runContractObserver(options: ContractObserverOptions): Promise<void> {
  const { clawforumDir, motionInboxDir, fs, motionAudit, notifyInbox } = options;

  // 读上次观察时间戳
  const stateFile = path.join(clawforumDir, 'motion', STATE_FILE);
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
        `error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // 行为兼容: lastCheckTs 保 0 (first-run-like)、不 throw
  }

  // 扫描 claws/ 目录
  const clawsDir = path.join(clawforumDir, CLAWS_DIR);
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
      `reason=${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const events: string[] = [];


  for (const clawId of clawIds) {
    try {
      const clawDir = path.join(clawforumDir, CLAWS_DIR, clawId);
      const clawEvents = collectContractEvents(fs, clawDir, clawId, lastCheckTs, motionAudit);
      if (clawEvents.length > 0) {
        events.push(clawEvents.join('\n'));
      }
    } catch (e) {
      motionAudit.write(
        CONTRACT_AUDIT_EVENTS.OBSERVER_EVENT_FAILED,
        `claw=${clawId}`,
        `reason=${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  // 有事件时写 motion inbox
  if (events.length > 0) {
    notifyInbox({
      inboxDir: motionInboxDir,
      type: 'contract_events',
      source: 'system',
      priority: 'high',
      body: events.join('\n\n'),
      filenameTag: 'contract_events',
    }, motionAudit);
  }

  // 更新时间戳
  const now = Date.now();
  fs.ensureDirSync(path.dirname(stateFile));
  fs.writeAtomicSync(stateFile, JSON.stringify({ lastCheckTs: now }));
}
