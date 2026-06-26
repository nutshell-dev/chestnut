/**
 * @module L2c.Messaging.LightweightQuery
 * 0-dep read-only messaging query helpers for CLI/watchdog lightweight scenarios.
 * No InboxReader/OutboxReader instance required.
 *
 * @phase 746
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import { INBOX_PENDING_DIR, OUTBOX_PENDING_DIR } from './dirs.js';

/**
 * Lightweight pending inbox count — directory list only, no file reads.
 * Standalone equivalent of InboxReader.peekPendingCount().
 */
export function peekPendingCount(fs: FileSystem, clawDir: string): number {
  const dir = path.join(clawDir, INBOX_PENDING_DIR);
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.listSync(dir, { includeDirs: false })
      .filter(e => e.name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/**
 * Lightweight pending inbox filenames — directory list only, no file reads.
 * For callers that need to match filename patterns (e.g. startup-check dedup).
 */
export function peekPendingFilenames(fs: FileSystem, clawDir: string): string[] {
  const dir = path.join(clawDir, INBOX_PENDING_DIR);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.listSync(dir, { includeDirs: false })
      .filter(e => e.name.endsWith('.md'))
      .map(e => e.name);
  } catch {
    return [];
  }
}

/**
 * Sync list of outbox pending filenames.
 * Standalone sync equivalent of OutboxReader.listClawOutboxPending().
 */
export function listOutboxPendingSync(fs: FileSystem, clawDir: string): string[] {
  const dir = path.join(clawDir, OUTBOX_PENDING_DIR);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.listSync(dir, { includeDirs: false })
      .filter(e => e.name.endsWith('.md'))
      .map(e => e.name)
      .sort();
  } catch {
    return [];
  }
}
