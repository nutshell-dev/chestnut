/**
 * Inbox message writer
 *
 * I/O layer: generates filenames, creates directories, writes to disk.
 * Message formatting delegated to MessageCodec.encodeInbox().
 */

import * as fsNative from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { encodeInbox, parseFrontmatter } from '../foundation/message-codec/index.js';
import type { InboxMessage } from '../types/contract.js';

export interface InboxMessageOptions {
  /** inbox/pending directory path */
  inboxDir: string;
  /** Message type */
  type: string;
  /** Message source (mapped to InboxMessage.from) */
  source: string;
  /** Priority level */
  priority: 'critical' | 'high' | 'normal' | 'low';
  /** Message body content */
  body: string;
  /** Target agent id; omit for broadcast */
  to?: string;
  /** ID prefix (default: type) */
  idPrefix?: string;
  /** Filename tag (default: type) */
  filenameTag?: string;
  /** Extra YAML frontmatter fields */
  extraFields?: Record<string, string>;
}

/**
 * Write an inbox message with standardized YAML frontmatter format.
 * Creates the inbox directory if it doesn't exist.
 */
export function writeInboxMessage(opts: InboxMessageOptions): void {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, '').slice(0, 15);
  const uuid8 = randomUUID().slice(0, 8);
  const idPrefix = opts.idPrefix ?? opts.type;
  const tag = opts.filenameTag ?? opts.type;

  // Construct InboxMessage for encoding
  const message: InboxMessage = {
    id: `${idPrefix}-${now.getTime()}`,
    type: opts.type,
    from: opts.source,
    to: opts.to ?? '',
    content: opts.body,
    priority: opts.priority,
    timestamp: now.toISOString(),
  };

  const content = encodeInbox(message, opts.extraFields);

  // Write to disk (atomic: write temp + rename)
  fsNative.mkdirSync(opts.inboxDir, { recursive: true });
  const finalPath = path.join(opts.inboxDir, `${ts}_${tag}_${uuid8}.md`);
  const tmpPath = path.join(opts.inboxDir, `.${ts}_${tag}_${uuid8}.tmp`);
  fsNative.writeFileSync(tmpPath, content);
  fsNative.renameSync(tmpPath, finalPath);
}

/**
 * 读取 inbox 文件的 frontmatter 元数据。
 * 失败（文件不存在、格式错误等）时返回 null。
 */
export function readInboxFileMeta(filePath: string): Record<string, string> | null {
  try {
    const content = fsNative.readFileSync(filePath, 'utf-8');
    return parseFrontmatter(content).meta;
  } catch {
    return null;
  }
}
