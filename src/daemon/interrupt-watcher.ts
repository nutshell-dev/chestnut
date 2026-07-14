/**
 * Interrupt-file watcher — file-watcher event 驱动替 setInterval polling.
 *
 * daemon-loop 监听 agentDir/interrupt 文件、出现时 delete + runtime.abort.
 * 替原 setInterval(pollInterruptFile, 200ms) 走事件驱动路径。
 * Per 项目设计原则「事件驱动、避免预灌上下文」.
 */

import * as path from 'path';
import { createWatcher, type Watcher } from '../foundation/file-watcher/index.js';
import type { WatcherFactory } from '../foundation/file-watcher/index.js';
import { isFileNotFound, type FileSystem } from '../foundation/fs/index.js';

export const INTERRUPT_FILE_NAME = 'interrupt';

export interface InterruptWatcherDeps {
  agentFs: FileSystem;            // baseDir = clawDir、用于 deleteSync('interrupt')
  agentDir: string;               // abs path to clawDir（chokidar 需 abs path）
  onInterrupt: () => void;        // 由 caller 实现 runtime.abort() 等动作
  onError: (err: Error) => void;  // 由 caller 实现 WARN_EVERY + MAX_ERRORS audit + disable+recovery
  /** watcher factory。测试可注入 fake 避免真实 chokidar。默认 createWatcher。 */
  createWatcher?: WatcherFactory;
}

/**
 * Create file watcher that triggers onInterrupt when `<agentDir>/interrupt` 文件出现.
 *
 * 流程:
 *   1. file-watcher 'add' / 'change' event 触发
 *   2. attempt deleteSync('interrupt')
 *   3. delete 成功 → onInterrupt()（caller: runtime.abort()）
 *   4. delete 失败 ENOENT → 已被其他 process 删、ignore
 *   5. delete 失败其他错误 → onError(err)（caller: WARN_EVERY + MAX_ERRORS path）
 *
 * stability='immediate' 因 interrupt 是 latency-sensitive、不 settle.
 */
export function createInterruptWatcher(deps: InterruptWatcherDeps): Watcher {
  const interruptPath = path.join(deps.agentDir, INTERRUPT_FILE_NAME);
  const watcherFactory = deps.createWatcher ?? createWatcher;
  return watcherFactory(
    interruptPath,
    (event) => {
      if (event.type === 'add' || event.type === 'change') {
        try {
          deps.agentFs.deleteSync(INTERRUPT_FILE_NAME);
          deps.onInterrupt();
        } catch (err) {
          if (isFileNotFound(err)) return;  // race: 已被其他 process 删
          deps.onError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    },
    {
      stability: 'immediate',  // latency-sensitive: 不 settle
      persistent: false,
      onError: (err) => deps.onError(err),
    },
  );
}
