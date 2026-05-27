/**
 * @module L6.CLI.ChatViewport.Watcher
 * fs watcher wrapper for chat-viewport / claw stream observation — 0 闭包依赖
 */

import type { FileSystem } from '../../foundation/fs/types.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { createWatcher } from '../../foundation/file-watcher/index.js';
import type { Watcher } from '../../foundation/file-watcher/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';
import type { ClawId } from '../../foundation/identity/index.js';


export type { Watcher };

/**
 * 创建 chat-viewport stream watcher / 1:1 保 chat-viewport.ts:40-77 body
 *
 * @param fs FileSystem
 * @param clawId claw 标识
 * @param streamPath 监听文件路径
 * @param refresh 文件 change 回调
 * @param audit AuditLog（写 watcher 错误事件）
 * @param onClose watcher close 回调（cleanup map）
 * @param persistent persistent=true 持续监听
 */
export function createChatViewportWatcher(
  fs: FileSystem,
  clawId: ClawId,
  streamPath: string,
  refresh: () => void,
  audit: AuditLog,
  onClose: () => void,
  persistent?: boolean,
): Watcher {
  let self: Watcher | null = null;
  const w = createWatcher(
    fs.resolve(streamPath),
    refresh,
    {
      stability: 'immediate',
      persistent,
      onError: (err, context) => {
        const eventType = context === 'callback'
          ? VIEWPORT_AUDIT_EVENTS.WATCHER_CALLBACK_FAILED
          : VIEWPORT_AUDIT_EVENTS.WATCHER_FAILED;
        audit.write(
          eventType,
          `claw=${clawId}`,
          `path=${streamPath}`,
          `context=${context}`,
          `reason=${err.message}`,
        );
        if (context === 'watch') {
          void self?.close();
          onClose();
        }
      },
    },
  );
  self = w;
  return w;
}
