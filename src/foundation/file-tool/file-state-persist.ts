/**
 * @module L2.FileTool
 * readFileState persistence — atomic write + load + clear for `<clawDir>/read-state.json`.
 *
 * phase 1443 introduction:
 *   - Treats readFileState as run-time information that must survive daemon restart
 *     (M#4「持久化一切信息到磁盘、运行时句柄从磁盘信息重建」).
 *   - Triggered by FileStateManager helpers after every mutation (best-effort, audit on failure).
 *   - Loaded by Runtime.initialize() on startup.
 *   - Cleared by regime-switch hook (state is dialog-scoped from claw's perspective).
 *   - Skipped for subagent contexts (ctx.persistReadFileState !== true → early return).
 *
 * Format v1: JSON with `{ version, updated_at, entries: { <path>: FileState } }`.
 * Path: `read-state.json` relative to fs baseDir (Assembly wires baseDir = clawDir for main claw fs).
 */

import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';

import type { ExecContext, FileState } from '../tools/types.js';
import { formatErr } from '../utils/index.js';
import { FILE_TOOL_AUDIT_EVENTS } from './audit-events.js';

/** Relative-to-fs-baseDir path of the persistence file. */
export const READ_STATE_FILE = 'read-state.json';

interface PersistFormatV1 {
  version: 1;
  updated_at: string;
  entries: Record<string, FileState>;
}

// phase 220 Step A: per-ctx in-flight persist tracker.
// recordReadResult/recordWriteResult/recordEditResult fire persistReadFileState as fire-and-forget;
// without serialization, a background persist can resolve AFTER clearReadFileState (called by
// regime-switch hook), re-creating the on-disk file we just deleted.
// All persist + clear ops chain through this WeakMap so clear awaits any pending persist.
const inflightPersist = new WeakMap<ExecContext, Promise<void>>();

async function _doPersistReadFileState(ctx: ExecContext): Promise<void> {
  const payload: PersistFormatV1 = {
    version: 1,
    updated_at: new Date().toISOString(),
    entries: Object.fromEntries(ctx.readFileState),
  };
  try {
    await ctx.fs.writeAtomic(READ_STATE_FILE, JSON.stringify(payload, null, 2));
  } catch (err) {
    // phase 693: 拆 op + reason 为两 col、与 phase 690-692 同模式
    ctx.auditWriter?.write(
      FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_PERSIST_FAILED,
      `op=write`,
      `reason=${formatErr(err)}`,
    );
  }
}

/**
 * Persist `ctx.readFileState` Map to disk atomically.
 *
 * Best-effort: failures emit `READ_FILE_STATE_PERSIST_FAILED` audit and do NOT throw —
 * the agent's tool result is unaffected. Per DP「信息不丢」, the audit captures the failure;
 * per smooth-degrade, the in-memory Map remains intact for current daemon lifetime.
 *
 * Subagent contexts (no `persistReadFileState` flag) skip entirely.
 *
 * phase 220: serialized per ctx via inflightPersist chain so clearReadFileState can drain
 * any pending writes before delete (prevents race where fire-and-forget resolves after clear).
 */
export async function persistReadFileState(ctx: ExecContext): Promise<void> {
  if (!ctx.persistReadFileState) return;
  const prev = inflightPersist.get(ctx);
  const next = (async () => {
    if (prev) await prev.catch(() => { /* silent: prev persist's own error path already audits READ_FILE_STATE_PERSIST_FAILED in _doPersistReadFileState; we only need to serialize ordering, not re-report */ });
    await _doPersistReadFileState(ctx);
  })();
  inflightPersist.set(ctx, next);
  return next;
}

/**
 * Load `read-state.json` from disk into a Map.
 *
 * Failure modes:
 *   - ENOENT (file not found): fresh state, return empty Map silently.
 *   - parse error / unknown version / IO error: audit + return empty Map (fail-safe — claw must re-read).
 *
 * Returns a fresh Map for caller to assign to `ctx.readFileState`.
 *
 * Version migration policy (phase 1452 / F-NEXT.2):
 *   The persistence format is versioned (currently v1). When a future v2 ships:
 *     - **Downgrade** (new disk file v2, old binary v1): unknown version → discard +
 *       `READ_FILE_STATE_LOADED result=skipped_unknown_version` audit + empty Map. claw
 *       must re-read files of interest in current session (idempotent).
 *     - **Upgrade** (old disk file v1, new binary v2): same policy in reverse.
 *     - This «discard + rebuild on next read» strategy is **by design** — readFileState is
 *       a gate accelerator, not a primary data source. Losing it costs at most one re-read
 *       per file; preserving it across format changes adds complexity (migration table,
 *       bilateral codec) for negligible benefit (daemon restarts are rare; re-reads cheap).
 *     - A binary that wants to honor older v1 files MAY add explicit branch (e.g.
 *       `if (parsed.version === 1) loadV1(); else if (parsed.version === 2) loadV2()`)
 *       — current load() is single-branch; future v2 work owns adding sister branch.
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
    // phase 693: 拆 result + reason 为两 col
    audit?.write(
      FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED,
      `result=failed`,
      `reason=${formatErr(err)}`,
    );
    return new Map();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    // phase 21: inline schema check 防 corrupt JSON 流入业务（playbook 静默失败 §8）
    // version 检与 shape 检分开：v!=1 是已知版本不匹配（forward-compat skip）、shape invalid 是 corrupt
    if (typeof parsed !== 'object' || parsed === null) {
      // phase 693: 拆 result + raw 为两 col
      audit?.write(
        FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED,
        `result=skipped_schema_invalid`,
        `raw=${audit?.message(raw) ?? raw}`,
      );
      return new Map();
    }
    const obj = parsed as { version?: unknown; updated_at?: unknown; entries?: unknown };
    if (obj.version !== 1) {
      // phase 693: 拆 result + version 为两 col
      audit?.write(
        FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED,
        `result=skipped_unknown_version`,
        `version=${String(obj.version)}`,
      );
      return new Map();
    }
    const isValidShape =
      typeof obj.updated_at === 'string' &&
      typeof obj.entries === 'object' && obj.entries !== null && !Array.isArray(obj.entries);
    if (!isValidShape) {
      // phase 693: 拆 result + raw 为两 col
      audit?.write(
        FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED,
        `result=skipped_schema_invalid`,
        `raw=${audit?.message(raw) ?? raw}`,
      );
      return new Map();
    }
    const validParsed = parsed as PersistFormatV1;
    const map = new Map(Object.entries(validParsed.entries));
    // phase 693: 拆 result + entry_count 为两 col
    audit?.write(
      FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED,
      `result=ok`,
      `entry_count=${map.size}`,
    );
    return map;
  } catch (err) {
    // phase 693: 拆 result + reason 为两 col
    audit?.write(
      FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_LOADED,
      `result=parse_failed`,
      `reason=${formatErr(err)}`,
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
  // phase 220 Step A: drain any pending fire-and-forget persist before delete.
  // Otherwise a persist started by recordReadResult earlier in the dialog may resolve
  // AFTER our delete, re-creating read-state.json post-regime-switch.
  const pending = inflightPersist.get(ctx);
  if (pending) {
    await pending.catch(() => { /* silent: pending persist failures already audit READ_FILE_STATE_PERSIST_FAILED inside _doPersistReadFileState; drain only needs ordering */ });
    inflightPersist.delete(ctx);
  }
  try {
    await ctx.fs.delete(READ_STATE_FILE);
  } catch (err) {
    if (isFileNotFound(err)) return;
    // phase 693: 拆 op + reason 为两 col
    ctx.auditWriter?.write(
      FILE_TOOL_AUDIT_EVENTS.READ_FILE_STATE_PERSIST_FAILED,
      `op=clear`,
      `reason=${formatErr(err)}`,
    );
  }
}
