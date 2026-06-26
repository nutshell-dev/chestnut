/**
 * @module L2b.DialogStore.ListArchive
 * DialogStore archive file listing helper
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import { DIALOG_ARCHIVE_DIR } from './dirs.js';

/**
 * List archived dialog filenames sorted by timestamp (oldest first).
 * Encapsulates DIALOG_ARCHIVE_DIR location + .json filter + timestamp sort.
 */
export async function listArchiveDialogFiles(
  fs: FileSystem,
  clawDir: string,
): Promise<string[]> {
  const archiveDir = path.join(clawDir, DIALOG_ARCHIVE_DIR);
  if (!fs.existsSync(archiveDir)) return [];
  try {
    const entries = await fs.list(archiveDir, { includeDirs: false });
    return entries
      .filter(e => e.isFile && e.name.endsWith('.json'))
      .map(e => e.name)
      .sort((a, b) => {
        const aTs = parseInt(a.split('_')[0], 10);
        const bTs = parseInt(b.split('_')[0], 10);
        if (isNaN(aTs) || isNaN(bTs)) return 0;
        return aTs - bTs;
      });
  } catch {
    return [];
  }
}
