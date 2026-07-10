/**
 * @module L2c.Messaging.LightweightQuery
 * 0-dep read-only messaging query helpers for CLI/watchdog lightweight scenarios.
 * No InboxReader/OutboxReader instance required.
 *
 * @phase 746
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import { formatErr } from '../node-utils/index.js';
import { INBOX_PENDING_DIR, OUTBOX_PENDING_DIR } from './dirs.js';

/**
 * Lightweight Result type for standalone query helpers.
 * Kept local to avoid cross-module coupling; independent from snapshot Result<T,E>.
 */
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Lightweight pending inbox count — directory list only, no file reads.
 * Standalone equivalent of InboxReader.peekPendingCount().
 */
export function peekPendingCount(fs: FileSystem, clawDir: string): Result<number> {
  const dir = path.join(clawDir, INBOX_PENDING_DIR);
  if (!fs.existsSync(dir)) return { ok: true, value: 0 };
  try {
    return { ok: true, value: fs.listSync(dir, { includeDirs: false })
      .filter(e => e.name.endsWith('.md')).length };
  } catch (err) {
    return { ok: false, error: formatErr(err) };
  }
}

/**
 * Lightweight pending inbox filenames — directory list only, no file reads.
 * For callers that need to match filename patterns (e.g. startup-check dedup).
 */
export function peekPendingFilenames(fs: FileSystem, clawDir: string): Result<string[]> {
  const dir = path.join(clawDir, INBOX_PENDING_DIR);
  if (!fs.existsSync(dir)) return { ok: true, value: [] };
  try {
    return { ok: true, value: fs.listSync(dir, { includeDirs: false })
      .filter(e => e.name.endsWith('.md'))
      .map(e => e.name) };
  } catch (err) {
    return { ok: false, error: formatErr(err) };
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
