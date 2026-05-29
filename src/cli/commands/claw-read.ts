/**
 * @module L6.CLI.Claw.Read
 * Read a file from a Claw's clawspace via file-tool public API
 */

import * as path from 'path';
import { loadGlobalConfig, clawExists, getClawDir } from '../../foundation/config/index.js';
import { CONFIG_DEFAULTS } from '../../assembly/index.js';
import { CLAWSPACE_DIR } from '../../foundation/paths.js';
import { resolveWorkspacePath } from '../../foundation/file-tool/resolve-path.js';
import { CliError } from '../errors.js';
import type { FileSystem } from '../../foundation/fs/types.js';

export async function readCommand(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  clawName: string,
  filePath: string,
  options?: { offset?: number; limit?: number },
): Promise<void> {
  loadGlobalConfig(deps, CONFIG_DEFAULTS);

  if (!clawExists(deps, clawName)) {
    throw new CliError(`Claw "${clawName}" does not exist`);
  }

  const clawDir = getClawDir(clawName);
  const workspaceDir = path.join(clawDir, CLAWSPACE_DIR);
  // resolveWorkspacePath returns clawDir-relative path, so fs must be scoped to clawDir
  const fs = deps.fsFactory(clawDir);

  const miniCtx = { clawDir, workspaceDir } as { clawDir: string; workspaceDir: string };
  const resolved = resolveWorkspacePath(miniCtx as any, filePath);
  if (resolved.startsWith('..') || resolved.startsWith('/')) {
    throw new CliError(`Path escapes claw directory: "${filePath}"`);
  }

  let content: string;
  try {
    content = await fs.read(resolved);
  } catch (error) {
    throw new CliError(`Error reading file: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (options?.offset !== undefined || options?.limit !== undefined) {
    const lines = content.split('\n');
    let start = (options.offset ?? 1) - 1;
    if (start < 0) start = Math.max(0, lines.length + start + 1);
    const end = options.limit !== undefined ? start + options.limit : lines.length;
    content = lines.slice(start, end).join('\n');
  }

  process.stdout.write(content);
  if (!content.endsWith('\n')) process.stdout.write('\n');
}
