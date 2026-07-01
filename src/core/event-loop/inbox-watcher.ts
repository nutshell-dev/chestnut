/**
 * @module L5.EventLoop.InboxWatcher
 * @layer L5 服务层
 * @depends L1.FileSystem, L2.AuditLog, L2.FileWatcher, L2.Messaging
 * @consumers L5.EventLoop
 *
 * inbox 目录 watcher — 等待新文件或 timeout，EventLoop catch 路径后用以决定是否继续。
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { createWatcher } from '../../foundation/file-watcher/index.js';
import type { Watcher } from '../../foundation/file-watcher/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../foundation/messaging/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';

/**
 * Wait for a new file to appear in the inbox directory, or until timeout.
 */
export function waitForInbox(
  fs: FileSystem,
  audit: AuditLog,
  inboxPendingDir: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise(resolve => {
    let watcher: Watcher | null = null;
    let settled = false;

    // 1. Snapshot existing files
    const existingFiles = new Set<string>();
    try {
      for (const e of fs.listSync(inboxPendingDir)) existingFiles.add(e.name);
    } catch { /* silent: dir may not exist yet, empty snapshot is correct */ }

    // 2. Check if genuinely new files exist
    const hasNewFile = (): boolean => {
      try {
        const current = fs.listSync(inboxPendingDir);
        return current.some(e => !existingFiles.has(e.name));
      } catch { return false; }
    };

    // 3. Filtered resolve: only on genuinely new files
    const tryDone = async () => {
      if (settled) return;
      if (!hasNewFile()) return;  // fallback poller false positive → ignore
      settled = true;
      clearTimeout(timer);
      await watcher?.close();
      watcher = null;
      resolve();
    };

    // 4. Timeout with last check
    const timer = setTimeout(() => {
      if (!settled && hasNewFile()) {
        settled = true;
        if (watcher) { void watcher.close().then(() => resolve()); }
        else resolve();
      } else if (!settled) {
        settled = true;
        if (watcher) { void watcher.close().then(() => resolve()); }
        else resolve();
      }
    }, timeoutMs);

    try {
      fs.ensureDirSync(inboxPendingDir);
      watcher = createWatcher(
        fs.resolve(inboxPendingDir),
        () => { void tryDone(); },
        {
          stability: 'immediate',
          onError: (err, context) => {
            const eventType = context === 'callback'
              ? MESSAGING_AUDIT_EVENTS.INBOX_WATCHER_CALLBACK_FAILED
              : MESSAGING_AUDIT_EVENTS.INBOX_WATCHER_FAILED;
            audit.write(
              eventType,
              `path=${inboxPendingDir}`,
              `context=${context}`,
              `reason=${err.message}`,
            );
          },
        },
      );
      // 5. Re-check after watcher setup (close race: file arrived between snapshot and watcher start)
      if (hasNewFile()) { void tryDone(); }
    } catch (err) {
      audit.write(
        MESSAGING_AUDIT_EVENTS.INBOX_WATCHER_FAILED,
        `path=${inboxPendingDir}`,
        'context=init',
        `reason=${formatErr(err)}`,
      );
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    }
  });
}
