import * as path from 'path';
import * as fsNative from 'fs';
import { execFile } from '../../../foundation/process-exec/index.js';
import { notifyInbox } from '../../../foundation/messaging/index.js';
import { NodeFileSystem } from '../../../foundation/fs/node-fs.js';
import { AuditWriter } from '../../../foundation/audit/index.js';

export interface ContractObserverOptions {
  clawforumDir: string;       // .clawforum/ 目录
  motionInboxDir: string;     // motion inbox/pending/ 路径
}

// 持久化文件：上次观察时间戳
const STATE_FILE = 'status/contract-observer-state.json';

export async function runContractObserver(options: ContractObserverOptions): Promise<void> {
  const { clawforumDir, motionInboxDir } = options;
  const fs = new NodeFileSystem({ baseDir: clawforumDir, enforcePermissions: false });

  // 读上次观察时间戳
  const stateFile = path.join(clawforumDir, 'motion', STATE_FILE);
  let lastCheckTs = 0;
  try {
    const raw = fsNative.readFileSync(stateFile, 'utf-8');
    lastCheckTs = JSON.parse(raw).lastCheckTs ?? 0;
  } catch { /* 首次运行 */ }

  // 扫描 claws/ 目录
  const clawsDir = path.join(clawforumDir, 'claws');
  let clawIds: string[];
  try {
    clawIds = fsNative.readdirSync(clawsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return; /* claws/ 不存在 */ }

  const events: string[] = [];

  for (const clawId of clawIds) {
    try {
      const { stdout } = await execFile(
        'node', [process.argv[1], 'contract', 'events', clawId, '--since', String(lastCheckTs)],
        { cwd: clawforumDir, timeout: 10000 }
      );
      const trimmed = stdout.trim();
      if (trimmed) {
        events.push(trimmed);
      }
    } catch {
      // CLI 调用失败，跳过该 claw
    }
  }

  // 有事件时写 motion inbox
  if (events.length > 0) {
    const motionAudit = new AuditWriter(fs, path.join(clawforumDir, 'motion', 'audit.tsv'));
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
  fsNative.mkdirSync(path.dirname(stateFile), { recursive: true });
  fsNative.writeFileSync(stateFile, JSON.stringify({ lastCheckTs: now }));
}
