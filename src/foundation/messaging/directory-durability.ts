import * as path from 'node:path';
import type { FileSystem } from '../fs/index.js';

export class DirectoryDurabilityError extends Error {
  constructor(readonly targetPath: string, cause: unknown) {
    super(`Directory durability sync failed at ${targetPath}`, { cause });
    this.name = 'DirectoryDurabilityError';
  }
}

/** Commit every newly created directory entry, ending at its existing parent. */
export function syncCreatedDirectoryChain(
  fs: FileSystem,
  directoryPath: string,
  firstCreatedPath: string,
): void {
  const target = path.normalize(directoryPath);
  const firstCreated = path.normalize(firstCreatedPath);
  if (target !== firstCreated && !target.startsWith(firstCreated + path.sep)) {
    throw new TypeError(`Invalid first-created directory ${firstCreatedPath} for ${directoryPath}`);
  }

  let child = target;
  while (true) {
    const parent = path.dirname(child);
    try {
      fs.syncSync(parent);
    } catch (cause) {
      throw new DirectoryDurabilityError(parent, cause);
    }
    if (child === firstCreated) return;
    child = parent;
  }
}
