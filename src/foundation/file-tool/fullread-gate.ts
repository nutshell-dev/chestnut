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
 * Returns `{ ok: true }` on pass; otherwise `{ ok: false, reason, result }`:
 *   - `not-read`   — readFileState entry missing (never read OR load failed)
 *   - `partial`    — entry exists but `isFullRead === false` (range / cap)
 *   - `stale`      — mtime advanced AND content hash differs from snapshot
 *   - `verify-failed` — stat / read threw mid-check (fail-safe reject)
 *
 * `result` is the ToolResult callers surface (canonical L1/L2 messages stable
 * across tools). Callers commonly append an operation-specific actionable
 * suffix (e.g. "For files >100 KB, use edit..." for write; "Alternatively,
 * set replaceAll=false..." for edit). Callers also use `reason` to emit
 * granular audit (write.ts OVERWRITE_GATE_REJECTED reason=<reason>).
 *
 * phase 1457 follow-up: was `Promise<ToolResult | null>` — reason was opaque
 * to callers; tests asserting `reason=stale|partial|not-read` failed against
 * generic `reason=gate-rejected`. Now reason is part of the contract.
 */

import type { ExecContext } from '../tools/index.js';
import type { ToolResult } from '../tool-protocol/index.js';
import { computeContentHash } from './file-hash.js';

export type GateRejectReason = 'not-read' | 'partial' | 'stale' | 'verify-failed';

export type GateResult =
  | { ok: true }
  | { ok: false; reason: GateRejectReason; result: ToolResult };

export async function enforceFullReadGate(
  ctx: ExecContext,
  resolved: string,
  filePath: string,
): Promise<GateResult> {
  const state = ctx.readFileState.get(resolved);
  // L1: never-read
  if (!state) {
    return {
      ok: false,
      reason: 'not-read',
      result: {
        success: false,
        content: `Error: File '${filePath}' has not been fully read in this daemon process. Use \`read\` to cover every current line (start at line 1, with limit >= totalLines, no byte-cap truncation) first.`,
      },
    };
  }
  // L1: partial-read
  if (!state.isFullRead) {
    return {
      ok: false,
      reason: 'partial',
      result: {
        success: false,
        content: `Error: File '${filePath}' has not been fully read in this daemon process. Use \`read\` to cover every current line (start at line 1, with limit >= totalLines, no byte-cap truncation) first.`,
      },
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
          ok: false,
          reason: 'stale',
          result: {
            success: false,
            content: `Error: File '${filePath}' has been modified since your last read (either by the user or by another tool). Read it again before this operation.`,
          },
        };
      }
      // mtime touched but content unchanged (cloud sync / antivirus) — refresh + allow
      state.timestamp = currentMtime;
    }
  } catch {
    return {
      ok: false,
      reason: 'verify-failed',
      result: {
        success: false,
        content: `Error: Could not verify '${filePath}' is unchanged since last read. Read it again before this operation.`,
      },
    };
  }
  return { ok: true };
}
