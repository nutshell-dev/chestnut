/**
 * Inbox writer - write messages to inbox/pending/
 *
 * Core write operation for the Messaging module.
 * Uses FileSystem for async, atomic writes.
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import type { FileSystem } from '../fs/types.js';
import type { InboxMessage } from '../../types/contract.js';
import { encodeInbox, parseFrontmatter } from '../message-codec/index.js';
import { ok, err as errResult, type Result } from '../common/result.js';
import type { InboxMetaError } from './errors.js';

/**
 * Write a message to an inbox/pending/ directory.
 *
 * @param fs - FileSystem instance
 * @param inboxDir - Absolute path to inbox/pending/
 * @param msg - Message to write
 * @param extraFields - Optional extra YAML frontmatter fields
 */
export async function writeInbox(
  fs: FileSystem,
  inboxDir: string,
  msg: InboxMessage,
  extraFields?: Record<string, string>,
): Promise<void> {
  await fs.ensureDir(inboxDir);

  const timestamp = Date.now();
  const priority = msg.priority ?? 'normal';
  const filename = `${timestamp}_${priority}_${randomUUID().slice(0, 8)}.md`;
  const filePath = path.join(inboxDir, filename);

  await fs.writeAtomic(filePath, encodeInbox(msg, extraFields));
}

// === Sync variants moved from utils/inbox-writer.ts ===

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
export function writeInboxMessage(fs: FileSystem, opts: InboxMessageOptions): void {
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

  fs.ensureDirSync(opts.inboxDir);

  const filename = `${ts}_${tag}_${uuid8}.md`;
  fs.writeAtomicSync(path.join(opts.inboxDir, filename), content);
}

/**
 * Read frontmatter metadata from an inbox file.
 * Returns Result with detailed error on failure.
 */
export function readInboxFileMeta(
  fs: FileSystem,
  filePath: string,
): Result<Record<string, string>, InboxMetaError> {
  let content: string;
  try {
    content = fs.readSync(filePath);
  } catch (err: any) {
    if (err?.code === 'FS_NOT_FOUND' || err?.code === 'ENOENT') {
      return errResult({ kind: 'not_found', cause: err });
    }
    return errResult({ kind: 'read_failed', cause: err });
  }
  try {
    return ok(parseFrontmatter(content).meta);
  } catch (e) {
    return errResult({ kind: 'parse_failed', cause: e });
  }
}
