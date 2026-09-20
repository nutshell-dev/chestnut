/**
 * @module L6.CLI.ChatViewport.Utils
 * Pure utility helpers for chat-viewport — 0 闭包依赖
 */

import { newShortUuid } from '../foundation/node-utils/index.js';
import { VIEWPORT_USER_INPUT_INLINE_MAX_CHARS_DEFAULT } from '../cli-protocol/index.js';
import { getChestnutRoot } from '../foundation/claw-identity/index.js';
import { makeChestnutRoot } from '../foundation/claw-identity/index.js';
import * as path from 'path';
import type { FileSystem } from '../foundation/fs/index.js';
import { makeClawNotifyTargetResolver } from '../core/claw-topology/index.js';
import { createClawNotifier } from '../foundation/messaging/index.js';
import { createDirContext } from '../foundation/audit/index.js';
import { formatErr } from '../foundation/node-utils/index.js';
import { VIEWPORT_AUDIT_EVENTS } from './viewport-audit-events.js';

const ATTACHMENT_SUBDIR = 'inbox/attachments';
const PREVIEW_HEAD_CHARS = 200;

/** 写用户输入到 inbox（chat 命令期间用户输入流入 daemon）
 *  phase 142: 阈值超过 maxInlineChars 时落盘到 inbox/attachments/、body 改提示。
 *  maxInlineChars 默 VIEWPORT_USER_INPUT_INLINE_MAX_CHARS_DEFAULT (2000、phase 1283 起归 CLIProtocol viewport 配置协议)。
 */
export function writeUserChat(
  agentDir: string,
  message: string,
  fsFactory: (baseDir: string) => FileSystem,
  maxInlineChars: number = VIEWPORT_USER_INPUT_INLINE_MAX_CHARS_DEFAULT,
): void {
  const { fs, audit } = createDirContext({ fsFactory }, agentDir);
  // phase 1388 Bug A fix: dirname 单层在普通 claw 布局错位 (`.chestnut/claws/<id>` → `.chestnut/claws` 而非 `.chestnut`)
  // 改用 env-based getChestnutRoot() single truth source / Motion + 普通 claw 同表达式
  const chestnutRoot = makeChestnutRoot(getChestnutRoot());
  const clawId = path.basename(agentDir);

  let body: string;
  if (message.length > maxInlineChars) {
    const attachmentRelPath = persistAttachment(fs, audit, agentDir, message);
    if (attachmentRelPath) {
      body = formatAttachmentBody(message, attachmentRelPath);
    } else {
      // attachment 写盘失败 fallback → inline（用户消息不丢）
      body = message;
    }
  } else {
    body = message;
  }

  // phase 1864 Step C（CT-D2）：发送归 Messaging；位置经拓扑 resolver 注入。
  createClawNotifier({
    fs,
    audit,
    resolveTarget: makeClawNotifyTargetResolver(chestnutRoot),
  }).notify(clawId, {
    type: 'user_chat',
    source: 'user',
    priority: 'high',
    body,
    idPrefix: 'chat',
  });
}

/** 写 attachment 到 inbox/attachments/<ts>_<uuid>.txt、返回 clawspace-relative path 或 null（写失败）。 */
function persistAttachment(
  fs: FileSystem,
  audit: ReturnType<typeof createDirContext>['audit'],
  agentDir: string,
  content: string,
): string | null {
  try {
    const ts = Date.now();
    const id = newShortUuid();
    const relPath = path.join(ATTACHMENT_SUBDIR, `${ts}_${id}.txt`);
    const absPath = path.join(agentDir, relPath);
    fs.writeAtomicSync(absPath, content);
    // clawspace-relative: inbox/attachments/ 在 agentDir 下，clawspace 在 agentDir/clawspace 下
    return path.join('..', relPath);
  } catch (err) {
    try {
      audit.write(
        VIEWPORT_AUDIT_EVENTS.ATTACHMENT_PERSIST_FAILED,
        `chars=${content.length}`,
        `reason=${formatErr(err)}`,
        'fallback=inline',
      );
    } catch { /* audit self-failure must not discard the user message */ }
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
