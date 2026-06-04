/**
 * @module L6.CLI.Utils.CopyDir
 * @layer L6
 * phase 31 P1.2: 治 N=3 copyDir 复制 dup（motion + skill + claw-import）。
 * stats 可选；不传时不跟踪、行为同 simple 形态。
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';

export interface CopyStats {
  dirs: number;
  files: number;
  bytes: number;
}

/**
 * 递归复制 dir、stats 跟踪可选。
 */
export async function copyDir(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  src: string,
  dest: string,
  stats?: CopyStats,
): Promise<void> {
  const srcFs = deps.fsFactory(src);
  const destFs = deps.fsFactory(dest);
  await destFs.ensureDir('.');
  const entries = await srcFs.list('.', { includeDirs: true });
  for (const entry of entries) {
    if (entry.isDirectory) {
      if (stats) stats.dirs++;
      await copyDir(deps, path.join(src, entry.name), path.join(dest, entry.name), stats);
    } else {
      const content = await srcFs.read(entry.name);
      await destFs.writeAtomic(entry.name, content);
      if (stats) {
        stats.files++;
        stats.bytes += Buffer.byteLength(content, 'utf-8');
      }
    }
  }
}
