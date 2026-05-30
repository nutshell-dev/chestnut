/**
 * @module L2.FileTool
 * fullread-gate — shared L1+L2 gate for destructive file operations.
 *
 * Used by:
 *   - write overwrite (phase 1447 refactor: was inlined since phase 1430)
 *   - edit replaceAll (phase 1447)
 *   - multi_edit with any replaceAll edit (phase 1447)
 *
 * L1: `readFileState` entry exists AND `isFullRead === true`
 * L2: mtime + content-hash double check (mtime touched but content unchanged
 *      refreshes timestamp + allows; mtime advanced + hash differs rejects)
 *
 * Returns null on pass; otherwise returns a ToolResult that the caller
 * should surface. Callers commonly append an operation-specific actionable
 * suffix (e.g. "For files >100 KB, use edit..." for write; "Alternatively,
 * set replaceAll=false..." for edit).
 *
 * The canonical L1 / L2 messages are stable across callers — tests assert
 * substrings like "not been fully read" and "modified since" against all
 * three tools uniformly.
 */

import type { ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import { computeContentHash } from './file-state.js';

export async function enforceFullReadGate(
  ctx: ExecContext,
  resolved: string,
  filePath: string,
): Promise<ToolResult | null> {
  const state = ctx.readFileState.get(resolved);
  // L1: never-read or partial-read
  if (!state || !state.isFullRead) {
    return {
      success: false,
      content: `Error: File '${filePath}' has not been fully read in this daemon process. Use \`read\` to cover every current line (start at line 1, with limit >= totalLines, no byte-cap truncation) first.`,
    };
  }
  // L2: stale (mtime + hash double check)
  try {
    const stat = await ctx.fs.stat(resolved);
    const currentMtime = stat.mtime.getTime();
    if (currentMtime > state.timestamp) {
      const currentContent = await ctx.fs.read(resolved);
      if (computeContentHash(currentContent) !== state.hash) {
        return {
          success: false,
          content: `Error: File '${filePath}' has been modified since your last read (either by the user or by another tool). Read it again before this operation.`,
        };
      }
      // mtime touched but content unchanged (cloud sync / antivirus) — refresh + allow
      state.timestamp = currentMtime;
    }
  } catch {
    return {
      success: false,
      content: `Error: Could not verify '${filePath}' is unchanged since last read. Read it again before this operation.`,
    };
  }
  return null;
}
