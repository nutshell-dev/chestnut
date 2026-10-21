/**
 * @module L5.EventLoop.InboxWatcher
 * @layer L5 服务层
 * @depends L1.FileSystem, L2.AuditLog, L2.FileWatcher, L2.Messaging
 * @consumers L5.EventLoop
 *
 * inbox 目录 watcher — 等待新文件或 timeout，EventLoop catch 路径后用以决定是否继续。
 *
 * Phase 1958 Step D：等待结果为判别联合（InboxWaitResult）——观察失败
 * （snapshot/list/init/watch/close）不再折叠为正常 resolve；只有真实
 * timeout/abort 才允许调用方走正常 idle/退出路径。close 失败不覆盖更早的
 * 观察失败（首个错误优先）。
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { createWatcher } from '../../foundation/file-watcher/index.js';
import type { Watcher } from '../../foundation/file-watcher/index.js';
import { MESSAGING_AUDIT_EVENTS } from '../../foundation/messaging/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';

/**
 * Phase 1958 Step D：inbox 等待结果的判别联合。
 * - new_file / timeout / aborted：正常路径（真实事件、真实超时、真实中断）；
 * - observation_failed：目录读取 / watcher init / watch 致命错误 / close 失败——
 *   error 保留原始原因，context 标记失败阶段；调用方必须显式消费，不得视为正常 idle。
 */
export type InboxWaitResult =
  | { kind: 'new_file' }
  | { kind: 'timeout' }
  | { kind: 'aborted' }
  | { kind: 'observation_failed'; error: string; context: string };

/**
 * Wait for a new file to appear in the inbox directory, or until timeout.
 * Respects an optional AbortSignal so EventLoop.abort() can break the wait
 * without waiting for the full timeout.
 */
export function waitForInbox(
  fs: FileSystem,
  audit: AuditLog,
  inboxPendingDir: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<InboxWaitResult> {
  return new Promise(resolve => {
    let watcher: Watcher | null = null;
    let settled = false;

    // 1. Snapshot existing files
    const existingFiles = new Set<string>();
    let snapshotError: string | null = null;
    try {
      for (const e of fs.listSync(inboxPendingDir)) existingFiles.add(e.name);
    } catch (err) {
      if (isFileNotFound(err)) {
        // 目录确定不存在 → 空 snapshot 是正确事实（dir may not exist yet）
      } else {
        // 非「目录确定不存在」的读取失败 = 观察失败：空 snapshot 会把存量文件
        // 误判为新文件，不得继续假装基线已知
        snapshotError = formatErr(err);
        audit.write(
          MESSAGING_AUDIT_EVENTS.INBOX_WATCHER_FAILED,
          `path=${inboxPendingDir}`,
          'context=snapshot',
          `reason=${snapshotError}`,
        );
      }
    }

    // 2. Check if genuinely new files exist。目录确定不存在 = 确定无新文件（false）；
    //    其余读取失败 throw（不得折叠为「无新文件」），由调用点转 observation_failed。
    const hasNewFile = (): boolean => {
      try {
        const current = fs.listSync(inboxPendingDir);
        return current.some(e => !existingFiles.has(e.name));
      } catch (err) {
        if (isFileNotFound(err)) return false;
        throw err;
      }
    };

    // 3. Unconditional settle helper: audit close errors but always resolve once.
    //    close 失败只在无更早观察失败时成为 observation_failed（不覆盖原始错误）。
    const settleAndClose = async (outcome: InboxWaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try {
        await watcher?.close();
      } catch (err) {
        audit.write(
          MESSAGING_AUDIT_EVENTS.INBOX_WATCHER_FAILED,
          `path=${inboxPendingDir}`,
          'context=close',
          `reason=${formatErr(err)}`,
        );
        if (outcome.kind !== 'observation_failed') {
          outcome = { kind: 'observation_failed', error: formatErr(err), context: 'close' };
        }
      } finally {
        watcher = null;
        resolve(outcome);
      }
    };

    const onAbort = (): void => { void settleAndClose({ kind: 'aborted' }); };

    // 4. Filtered resolve: only on genuinely new files
    const tryDone = () => {
      if (settled) return;
      let found: boolean;
      try {
        found = hasNewFile();
      } catch (err) {
        void settleAndClose({ kind: 'observation_failed', error: formatErr(err), context: 'list' });
        return;
      }
      if (!found) return;  // fallback poller false positive → ignore
      void settleAndClose({ kind: 'new_file' });
    };

    // 5. Timeout with last check；最终检查失败 = 观察失败（不是干净 timeout）
    const timer = setTimeout(() => {
      if (settled) return;
      let outcome: InboxWaitResult = { kind: 'timeout' };
      try {
        if (hasNewFile()) outcome = { kind: 'new_file' };
      } catch (err) {
        outcome = { kind: 'observation_failed', error: formatErr(err), context: 'list' };
      }
      void settleAndClose(outcome);
    }, timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      void settleAndClose({ kind: 'aborted' });
      return;
    }

    // snapshot 观察失败：基线不可信，直接上交（不建 watcher 继续假装观察）
    if (snapshotError !== null) {
      void settleAndClose({ kind: 'observation_failed', error: snapshotError, context: 'snapshot' });
      return;
    }

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
            // watch 致命错误（watcher 已被 disable，观察不再可信）→ 显式上交；
            // callback 类错误由本模块 callback（tryDone）内部转 observation_failed，
            // ready/fallback_limit_reset 仅留证（观察本身仍有效）。
            if (context === 'watch') {
              void settleAndClose({ kind: 'observation_failed', error: err.message, context: 'watch' });
            }
          },
        },
      );
      // 6. Re-check after watcher setup (close race: file arrived between snapshot and watcher start)
      void tryDone();
    } catch (err) {
      audit.write(
        MESSAGING_AUDIT_EVENTS.INBOX_WATCHER_FAILED,
        `path=${inboxPendingDir}`,
        'context=init',
        `reason=${formatErr(err)}`,
      );
      void settleAndClose({ kind: 'observation_failed', error: formatErr(err), context: 'init' });
    }
  });
}
