/**
 * @module L2.FileTool
 * readFileState persistence — atomic write + load + clear for `<clawDir>/read-state.json`.
 *
 * phase 1443 introduction:
 *   - Treats readFileState as run-time information that must survive daemon restart
 *     (ML#4「持久化一切信息到磁盘、运行时句柄从磁盘信息重建」).
 *   - Triggered by FileStateManager helpers after every mutation (best-effort, audit on failure).
 *   - Loaded by Runtime.initialize() on startup.
 *   - Cleared by regime-switch hook (state is dialog-scoped from claw's perspective).
 *   - Skipped for subagent contexts (ctx.persistReadFileState !== true → early return).
 *
 * Format v1: JSON with `{ version, updated_at, entries: { <path>: FileState } }`.
 * Path: `read-state.json` relative to fs baseDir (Assembly wires baseDir = clawDir for main claw fs).
 */

import type { FileSystem } from '../fs/types.js';
import { isFileNotFound } from '../fs/types.js';
import type { AuditLog } from '../audit/index.js';
import type { ExecContext, FileState } from '../tools/types.js';
import { formatErr } from '../utils/format.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';

/** Relative-to-fs-baseDir path of the persistence file. */
export const READ_STATE_FILE = 'read-state.json';

interface PersistFormatV1 {
  version: 1;
  updated_at: string;
  entries: Record<string, FileState>;
}

/**
 * Persist `ctx.readFileState` Map to disk atomically.
 *
 * Best-effort: failures emit `READ_FILE_STATE_PERSIST_FAILED` audit and do NOT throw —
 * the agent's tool result is unaffected. Per DP「信息不丢」, the audit captures the failure;
 * per smooth-degrade, the in-memory Map remains intact for current daemon lifetime.
 *
 * Subagent contexts (no `persistReadFileState` flag) skip entirely.
 */
export async function persistReadFileState(ctx: ExecContext): Promise<void> {
  if (!ctx.persistReadFileState) return;
  const payload: PersistFormatV1 = {
    version: 1,
    updated_at: new Date().toISOString(),
    entries: Object.fromEntries(ctx.readFileState),
  };
  try {
    await ctx.fs.writeAtomic(READ_STATE_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    ctx.auditWriter?.write(
      FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_PERSIST_FAILED,
      `op=write reason=${formatErr(err)}`,
    );
  }
}

/**
 * Load `read-state.json` from disk into a Map.
 *
 * Failure modes:
 *   - ENOENT (file not found): fresh state, return empty Map silently.
 *   - parse error / unknown version / IO error: audit + return empty Map (fail-safe — claw must re-read).
 *
 * Returns a fresh Map for caller to assign to `ctx.readFileState`.
 */
export async function loadReadFileState(
  fs: FileSystem,
  audit?: AuditLog,
): Promise<Map<string, FileState>> {
  let raw: string;
  try {
    raw = await fs.read(READ_STATE_FILE);
  } catch (err) {
    if (isFileNotFound(err)) {
      return new Map();
    }
    audit?.write(
      FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED,
      `result=failed reason=${formatErr(err)}`,
    );
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw) as PersistFormatV1;
    if (parsed.version !== 1) {
      audit?.write(
        FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED,
        `result=skipped_unknown_version version=${parsed.version}`,
      );
      return new Map();
    }
    const map = new Map(Object.entries(parsed.entries));
    audit?.write(
      FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED,
      `result=ok entry_count=${map.size}`,
    );
    return map;
  } catch (err) {
    audit?.write(
      FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED,
      `result=parse_failed reason=${formatErr(err)}`,
    );
    return new Map();
  }
}

/**
 * Clear in-memory Map AND delete the on-disk file.
 *
 * Called by regime-switch hook: when the dialog context is purged (compaction),
 * the gate state should be purged too — otherwise after regime switch the claw's
 * context shows no read history but the gate still allows overwrite, which violates
 * "智能体是决策主体" (gate decisions should track what the claw actually saw).
 *
 * Subagent contexts (no persist flag) just clear the in-memory Map; the disk file
 * doesn't exist for them.
 *
 * ENOENT on delete is silently ignored (file may have already been cleared).
 */
export async function clearReadFileState(ctx: ExecContext): Promise<void> {
  // Defensive: test fixtures may pass `undefined` or a stub `{} as any` for execContext
  // (Runtime hasn't been fully initialized in some unit tests).
  if (!ctx) return;
  if (ctx.readFileState && typeof ctx.readFileState.clear === 'function') {
    ctx.readFileState.clear();
  }
  if (!ctx.persistReadFileState) return;
  try {
    await ctx.fs.delete(READ_STATE_FILE);
  } catch (err) {
    if (isFileNotFound(err)) return;
    ctx.auditWriter?.write(
      FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_PERSIST_FAILED,
      `op=clear reason=${formatErr(err)}`,
    );
  }
}
