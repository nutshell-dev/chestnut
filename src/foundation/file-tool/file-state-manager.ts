/**
 * @module L2.FileTool
 * FileState manager — single authority for mutating `ctx.readFileState` Map (phase 1439 V3).
 *
 * Centralizes the overwrite-gate state mutations that were previously scattered across
 * read.ts / write.ts / edit.ts / multi_edit.ts. Each tool now calls exactly one helper
 * with semantics declared by the function name; the helper handles hash + map.set + any
 * prev-state inheritance rules + audit emission + persistence.
 *
 * Design constraint (per phase 1437): edit/multi_edit must NOT promote `isFullRead` —
 * the tool's internal full-file read is private; claw only saw what `read` returned.
 * This rule is encapsulated in `recordEditResult` and not duplicated at call sites.
 *
 * phase 1443: each mutation now emits `READ_FILE_STATE_RECORDED` audit and (best-effort)
 * persists the Map to `<clawDir>/read-state.json`. Persist is fire-and-forget — failures
 * audit `READ_FILE_STATE_PERSIST_FAILED` but don't block tool result.
 */

import type { ExecContext } from '../tools/types.js';
import { computeContentHash } from './file-hash.js';
import { persistReadFileState } from './file-state-persist.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';

/**
 * Record a `read` tool invocation result into the gate state map.
 *
 * Caller is responsible for computing `isFullRead` from the 4 conditions
 * (offset+limit absent, no line cap, no byte cap, same-target read).
 *
 * MUST NOT be called for cross-target reads (per §7.A.invariant 2: target claw's path
 * does not belong to caller claw's write-gate authority).
 */
export function recordReadResult(
  ctx: ExecContext,
  resolvedPath: string,
  fullFileContent: string,
  mtime: number,
  isFullRead: boolean,
): void {
  ctx.readFileState.set(resolvedPath, {
    hash: computeContentHash(fullFileContent),
    timestamp: mtime,
    isFullRead,
  });
  ctx.auditWriter?.write(
    FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_RECORDED,
    `op=read path=${resolvedPath} isFullRead=${isFullRead}`,
  );
  void persistReadFileState(ctx);
}

/**
 * Record a `write` tool overwrite success into the gate state map.
 *
 * `isFullRead: true` — claw provided the new content explicitly, so by definition claw
 * has now "seen" the whole file (they authored it).
 */
export function recordWriteResult(
  ctx: ExecContext,
  resolvedPath: string,
  newContent: string,
  newMtime: number,
): void {
  ctx.readFileState.set(resolvedPath, {
    hash: computeContentHash(newContent),
    timestamp: newMtime,
    isFullRead: true,
  });
  ctx.auditWriter?.write(
    FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_RECORDED,
    `op=write path=${resolvedPath} isFullRead=true`,
  );
  void persistReadFileState(ctx);
}

/**
 * Record an `edit` / `multi_edit` write success into the gate state map.
 *
 * phase 1437 invariant: `isFullRead` is INHERITED from prevState (false if no prev).
 * The tool's internal full-file read is a private implementation detail; claw only
 * explicitly committed to an `old_string → new_string` substitution. Promoting to
 * `isFullRead: true` would let a never-read-or-partial-read claw bypass the overwrite
 * gate (silent X data loss).
 */
export function recordEditResult(
  ctx: ExecContext,
  resolvedPath: string,
  newContent: string,
  newMtime: number,
): void {
  const prev = ctx.readFileState.get(resolvedPath);
  const isFullRead = prev?.isFullRead ?? false;
  ctx.readFileState.set(resolvedPath, {
    hash: computeContentHash(newContent),
    timestamp: newMtime,
    isFullRead,
  });
  ctx.auditWriter?.write(
    FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_RECORDED,
    `op=edit path=${resolvedPath} isFullRead=${isFullRead}`,
  );
  void persistReadFileState(ctx);
}
