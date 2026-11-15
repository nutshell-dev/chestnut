/**
 * @module L6.CLI.Utils.CopyDir
 * @layer L6
 * phase 31 P1.2: 治 N=3 copyDir 复制 dup（motion + skill + claw-import）。
 * stats 可选；不传时不跟踪、行为同 simple 形态。
 */

import * as path from 'path';
import type { AtomicWriteResult, FileSystem } from '../../foundation/fs/index.js';

export interface CopyStats {
  dirs: number;
  files: number;
  bytes: number;
}

/** A rename may be visible even when its directory durability is not proven. */
export class CopyDirDurabilityError extends Error {
  constructor(readonly path: string, readonly result: Exclude<AtomicWriteResult, { kind: 'durable' }>) {
    super(`Directory copy durability unavailable at ${path}: ${result.kind}`, { cause: result.error });
    this.name = 'CopyDirDurabilityError';
  }
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
      const result = await destFs.writeAtomic(entry.name, content);
      if (result.kind !== 'durable') throw new CopyDirDurabilityError(entry.name, result);
      if (stats) {
        stats.files++;
        stats.bytes += Buffer.byteLength(content, 'utf-8');
      }
    }
  }
  // Persist empty directories and newly-created child directory entries too.
  // Atomic file writes have already fsynced their immediate parent.
  destFs.syncSync('.');
}
