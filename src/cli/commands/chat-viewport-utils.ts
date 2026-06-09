/**
 * @module L6.CLI.ChatViewport.Utils
 * Pure utility helpers for chat-viewport — 0 闭包依赖
 */

import { randomUUID } from 'crypto';
import { UUID_SHORT_LEN } from '../../constants.js';
import { EXEC_MAX_OUTPUT } from '../../foundation/command-tool/constants.js';
import { getChestnutRoot, makeChestnutRoot } from '../../assembly/install-paths.js';
import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import { notifyClaw } from '../../foundation/messaging/index.js';
import { createDirContext } from '../../foundation/audit/index.js';

const ATTACHMENT_SUBDIR = 'inbox/attachments';
const PREVIEW_HEAD_CHARS = 200;

/** 写用户输入到 inbox（chat 命令期间用户输入流入 daemon）
 *  phase 142: 阈值超过 maxInlineChars 时落盘到 inbox/attachments/、body 改提示。
 *  maxInlineChars 默 EXEC_MAX_OUTPUT (2000、phase 142 ratify 与 chestnut 现有"信息流入 motion"阈值一致)。
 */
export function writeUserChat(
  agentDir: string,
  message: string,
  fsFactory: (baseDir: string) => FileSystem,
  maxInlineChars: number = EXEC_MAX_OUTPUT,
): void {
  const { fs, audit } = createDirContext({ fsFactory }, agentDir);
  // phase 1388 Bug A fix: dirname 单层在普通 claw 布局错位 (`.chestnut/claws/<id>` → `.chestnut/claws` 而非 `.chestnut`)
  // 改用 env-based getChestnutRoot() single truth source / Motion + 普通 claw 同表达式
  const chestnutRoot = makeChestnutRoot(getChestnutRoot());
  const clawId = path.basename(agentDir);

  let body: string;
  if (message.length > maxInlineChars) {
    const attachmentRelPath = persistAttachment(fs, agentDir, message);
    if (attachmentRelPath) {
      body = formatAttachmentBody(message, attachmentRelPath);
    } else {
      // attachment 写盘失败 fallback → inline（用户消息不丢）
      body = message;
    }
  } else {
    body = message;
  }

  notifyClaw(fs, chestnutRoot, clawId, {
    type: 'user_chat',
    source: 'user',
    priority: 'high',
    body,
    idPrefix: 'chat',
  }, audit);
}

/** 写 attachment 到 inbox/attachments/<ts>_<uuid>.txt、返回 inbox-relative path 或 null（写失败）。 */
function persistAttachment(fs: FileSystem, agentDir: string, content: string): string | null {
  try {
    const ts = Date.now();
    const id = randomUUID().slice(0, UUID_SHORT_LEN);
    const relPath = path.join(ATTACHMENT_SUBDIR, `${ts}_${id}.txt`);
    const absPath = path.join(agentDir, relPath);
    fs.writeAtomicSync(absPath, content);
    return relPath;
  } catch {
    return null;
  }
}

/** 长文本附件 body 模板：含 size + preview head + attachment 路径。 */
function formatAttachmentBody(message: string, attachmentRelPath: string): string {
  const size = message.length;
  const preview = message.slice(0, PREVIEW_HEAD_CHARS) + (message.length > PREVIEW_HEAD_CHARS ? '…' : '');
  return [
    `[user-input attachment: ${size} chars]`,
    `path: ${attachmentRelPath}`,
    `preview (first ${PREVIEW_HEAD_CHARS} chars):`,
    preview,
    '',
    'Use the read tool to fetch full or partial content (supports offset/limit).',
  ].join('\n');
}

/** 格式化毫秒为可读时长 / 1:1 保 chat-viewport.ts:90-95 body */
export function fmtDuration(ms: number): string {
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}


