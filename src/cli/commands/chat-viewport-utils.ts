/**
 * @module L6.CLI.ChatViewport.Utils
 * Pure utility helpers for chat-viewport — 0 闭包依赖
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import { notifyClaw } from '../../foundation/messaging/index.js';
import { makeChestnutRoot } from '../../assembly/install-paths.js';
import { getChestnutRoot } from '../../assembly/install-paths.js';
import { createDirContext } from '../../foundation/audit/index.js';
/** 写用户输入到 inbox（chat 命令期间用户输入流入 daemon）/ 1:1 保 chat-viewport.ts:78-89 body */
export function writeUserChat(agentDir: string, message: string, fsFactory: (baseDir: string) => FileSystem): void {
  const { fs, audit } = createDirContext({ fsFactory }, agentDir);
  // phase 1388 Bug A fix: dirname 单层在普通 claw 布局错位 (`.chestnut/claws/<id>` → `.chestnut/claws` 而非 `.chestnut`)
  // 改用 env-based getChestnutRoot() single truth source / Motion + 普通 claw 同表达式
  const chestnutRoot = makeChestnutRoot(getChestnutRoot());
  const clawId = path.basename(agentDir);
  notifyClaw(fs, chestnutRoot, clawId, {
    type: 'user_chat',
    source: 'user',
    priority: 'high',
    body: message,
    idPrefix: 'chat',
  }, audit);
}

/** 格式化毫秒为可读时长 / 1:1 保 chat-viewport.ts:90-95 body */
export function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/**
 * 截断 error message 字符串、超 maxLen 时截至 maxLen-3 + '...' 形成 maxLen 字符显示长度。
 * 用于 viewport / log display preview、消 trigger/keep pair magic。
 * caller 仅传 trigger length、helper 内化 keep = trigger - 3 数学。
 */
export function shortenErrorMsg(msg: string, maxLen: number): string {
  if (msg.length <= maxLen) return msg;
  return msg.slice(0, maxLen - 3) + '...';
}


