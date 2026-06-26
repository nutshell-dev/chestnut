/**
 * @module L2b.DialogStore.ListArchive
 * DialogStore archive file listing helper
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import { DIALOG_ARCHIVE_DIR } from './dirs.js';

/** Lightweight reference to an archived dialog file. */
export interface ArchiveDialogRef {
  /** Basename (e.g. "1700000000000_abc123.json"). */
  name: string;
  /** Path relative to clawDir (e.g. "dialog/archive/1700000000000_abc123.json"). */
  relPath: string;
  /** Last modification time (epoch ms). */
  mtime: number;
}

/**
 * List archived dialog files sorted by timestamp (oldest first).
 * Encapsulates DIALOG_ARCHIVE_DIR location + .json filter + timestamp sort.
 * Returns full relative paths and mtimes so callers do not need to re-stat.
 */
export async function listArchiveDialogFiles(
  fs: FileSystem,
  clawDir: string,
): Promise<ArchiveDialogRef[]> {
  const archiveDir = path.join(clawDir, DIALOG_ARCHIVE_DIR);
  if (!fs.existsSync(archiveDir)) return [];
  try {
    const entries = await fs.list(archiveDir, { includeDirs: false });
    const refs: ArchiveDialogRef[] = [];
    for (const e of entries) {
      if (!e.isFile || !e.name.endsWith('.json')) continue;
      let mtime = 0;
      try {
        const s = await fs.stat(path.join(archiveDir, e.name));
        mtime = s.mtime.getTime();
      } catch { /* silent: TOCTOU race — file vanished between list and stat */ }
      refs.push({ name: e.name, relPath: path.join(DIALOG_ARCHIVE_DIR, e.name), mtime });
    }
    return refs.sort((a, b) => {
      const aTs = parseInt(a.name.split('_')[0], 10);
      const bTs = parseInt(b.name.split('_')[0], 10);
      if (isNaN(aTs) || isNaN(bTs)) return 0;
      return aTs - bTs;
    });
  } catch {
    return [];
  }
}
