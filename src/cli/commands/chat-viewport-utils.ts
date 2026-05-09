/**
 * @module L6.CLI.ChatViewport.Utils
 * Pure utility helpers for chat-viewport — 0 闭包依赖
 */

import * as path from 'path';
import { InboxWriter } from '../../foundation/messaging/index.js';
import { createDirContext } from '../utils/factories.js';
/** 写用户输入到 inbox（chat 命令期间用户输入流入 daemon）/ 1:1 保 chat-viewport.ts:78-89 body */
export function writeUserChat(agentDir: string, message: string): void {
  const inboxDir = path.join(agentDir, 'inbox', 'pending');
  const { fs, audit } = createDirContext(agentDir);
  new InboxWriter(fs, inboxDir, audit).writeSync({
    type: 'user_chat',
    source: 'user',
    priority: 'high',
    body: message,
    idPrefix: 'chat',
  });
}

/** 格式化毫秒为可读时长 / 1:1 保 chat-viewport.ts:90-95 body */
export function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}


