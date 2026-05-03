import * as path from 'path';
import { notifyInbox } from '../../../foundation/messaging/index.js';
import { NodeFileSystem } from '../../../foundation/fs/node-fs.js';
import { createSystemAudit } from '../../../foundation/audit/index.js';
import { collectContractEvents } from './event-collector.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';

export interface ContractObserverOptions {
  clawforumDir: string;       // .clawforum/ 目录
  motionInboxDir: string;     // motion inbox/pending/ 路径
}

// 持久化文件：上次观察时间戳
const STATE_FILE = 'status/contract-observer-state.json';

export async function runContractObserver(options: ContractObserverOptions): Promise<void> {
  const { clawforumDir, motionInboxDir } = options;
  const fs = new NodeFileSystem({ baseDir: clawforumDir });

  // 读上次观察时间戳
  const stateFile = path.join(clawforumDir, 'motion', STATE_FILE);
  let lastCheckTs = 0;
  try {
    const raw = fs.readSync(stateFile);
    lastCheckTs = JSON.parse(raw).lastCheckTs ?? 0;
  } catch { /* 首次运行 */ }

  // 扫描 claws/ 目录
  const clawsDir = path.join(clawforumDir, 'claws');
  let clawIds: string[];
  try {
    clawIds = fs.listSync(clawsDir, { includeDirs: true })
      .filter(e => e.isDirectory)
      .map(e => e.name);
  } catch { return; /* claws/ 不存在 */ }

  const events: string[] = [];
  const motionAudit = createSystemAudit(fs, path.join(clawforumDir, 'motion'));

  for (const clawId of clawIds) {
    try {
      const clawDir = path.join(clawforumDir, 'claws', clawId);
      const clawEvents = collectContractEvents(fs, clawDir, clawId, lastCheckTs);
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
    notifyInbox(fs, {
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
