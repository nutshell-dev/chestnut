/**
 * @module L2b.DialogStore.Restore
 * 从 marker 恢复消息历史（current.json + archive 扫描）。
 *
 * 抽出自 store.ts、dialogstore-auditor §M-01 + §M-03 follow-up：
 * - SRP 拆分
 * - 纯函数化、解耦 DialogStore 实例（单测友好 + 离线分析可用）
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import { isFileNotFound } from '../fs/index.js';
import type { AuditLog } from '../audit/index.js';
import type { Message } from '../llm-provider/types.js';
import type { SessionData, DialogMarker, RestoreResult } from './types.js';
import { MarkerNotFoundError, detectAndMigrateVersion, validateSessionData } from './validate.js';
import { CURRENT_DIALOG_FILE } from './dirs.js';
import { DIALOG_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from '../node-utils/index.js';
import { DialogStoreError } from './errors.js';

/** Phase 987: read faults (except ENOENT) propagate as io_error; parse faults are corruption. */
function isReadIOError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && code !== 'ENOENT';
}

/**
 * Restore messages up to (or excluding) the given marker.
 *
 * @param fs FileSystem (instance 注入)
 * @param currentPath dialog/current.json 路径
 * @param archiveDir dialog/archive/ 路径
 * @param marker target marker
 * @param inclusive 是否包含 marker 本身
 * @param audit AuditLog（optional、用 DIALOG_AUDIT_EVENTS 写）
 */
export async function restoreMessages(
  fs: FileSystem,
  currentPath: string,
  archiveDir: string,
  marker: DialogMarker,
  inclusive: boolean,
  audit?: AuditLog,
): Promise<RestoreResult> {
  // 1. Scan current.json
  let currentRaw: string;
  try {
    currentRaw = await fs.read(currentPath);
  } catch (err) {
    if (isFileNotFound(err)) {
      // ENOENT: current.json does not exist; fall through to archive search.
    } else {
      // Phase 987: any non-ENOENT read fault is an I/O error and must propagate.
      audit?.write?.(
        DIALOG_AUDIT_EVENTS.RESTORE_IO_ERROR,
        'file=current.json',
        `context=restore_${inclusive ? 'prefix' : 'before'}`,
        `reason=${formatErr(err)}`,
      );
      throw err;
    }
  }

  if (currentRaw! !== undefined) {
    try {
      const parsed = JSON.parse(currentRaw) as Partial<SessionData>;
      const detected = detectAndMigrateVersion(parsed, CURRENT_DIALOG_FILE, audit);
      if (detected === null) {
        // version unknown — treat as corrupted and fall through to archive
        throw new DialogStoreError('session version unknown');
      }
      const data = validateSessionData(detected, audit);
      // Phase 921: clawId consistency — mismatch means this source belongs to a different claw.
      // Legacy sessions without clawId are skipped (backward compatible).
      if (data.clawId && marker.clawId && data.clawId !== marker.clawId) {
        audit?.write?.(
          DIALOG_AUDIT_EVENTS.CLAWID_MISMATCH,
          `source=current`,
          `expected=${marker.clawId}`,
          `actual=${data.clawId}`,
          `toolUseId=${marker.toolUseId}`,
        );
        // fall through to archive search
      } else {
        const sliced = sliceMessagesAtMarker(data.messages, marker.toolUseId, inclusive);
        if (sliced !== null) {
          return {
            messages: sliced,
            systemPrompt: data.systemPrompt,
            toolsForLLM: data.toolsForLLM,
            meta: { foundIn: 'current' },
          };
        }
      }
    } catch (err) {
      if (isFileNotFound(err)) throw err;
      audit?.write?.(
        DIALOG_AUDIT_EVENTS.CORRUPTED,
        'file=current.json',
        `context=restore_${inclusive ? 'prefix' : 'before'}`,
        `reason=${formatErr(err)}`,
      );
    }
  }

  // 2. Scan archive/*.json (按时间倒序 / 找首个含 toolUseId 的)
  let entries: Awaited<ReturnType<FileSystem['list']>> = [];
  try {
    entries = await fs.list(archiveDir);
  } catch (err) {
    if (isFileNotFound(err)) {
      // archive dir 不存在 → 走最终抛错
      entries = [];
    } else if (isReadIOError(err)) {
      audit?.write?.(
        DIALOG_AUDIT_EVENTS.RESTORE_IO_ERROR,
        `dir=${archiveDir}`,
        `context=restore_${inclusive ? 'prefix' : 'before'}`,
        `reason=${formatErr(err)}`,
      );
      throw err;
    } else {
      // phase 680: 加 dir forensic col、与 store.ts:586 ARCHIVE_READ_FAILED 形态对齐
      audit?.write?.(
        DIALOG_AUDIT_EVENTS.ARCHIVE_DIR_FAILED,
        `dir=${archiveDir}`,
        `reason=${formatErr(err)}`,
      );
      // archive dir 失败 / 走最终抛错
      entries = [];
    }
  }

  const sorted = entries
    .filter(e => e.isFile && e.name.endsWith('.json') && !isNaN(parseInt(e.name.split('_')[0], 10)))
    .sort((a, b) => parseInt(b.name.split('_')[0], 10) - parseInt(a.name.split('_')[0], 10)); // Newest first / 与 loadLatestArchive 一致

  for (const entry of sorted) {
    const entryPath = path.join(archiveDir, entry.name);
    let archiveRaw: string;
    try {
      archiveRaw = await fs.read(entryPath);
    } catch (err) {
      if (isReadIOError(err)) {
        audit?.write?.(
          DIALOG_AUDIT_EVENTS.RESTORE_IO_ERROR,
          `file=${entry.name}`,
          `context=restore_${inclusive ? 'prefix' : 'before'}`,
          `reason=${formatErr(err)}`,
        );
        throw err;
      }
      audit?.write?.(
        DIALOG_AUDIT_EVENTS.ARCHIVE_PARSE_FAILED,
        `file=${entry.name}`,
        `reason=${formatErr(err)}`,
      );
      continue;
    }

    try {
      const parsed = JSON.parse(archiveRaw) as Partial<SessionData>;
      const detected = detectAndMigrateVersion(parsed, entry.name, audit);
      if (detected === null) {
        continue; // version unknown (version > SESSION_CURRENT_VERSION)
      }
      const data = validateSessionData(detected, audit);
      // Phase 921: skip archive files that belong to a different claw.
      // Legacy sessions without clawId remain backward compatible.
      if (data.clawId && marker.clawId && data.clawId !== marker.clawId) {
        audit?.write?.(
          DIALOG_AUDIT_EVENTS.CLAWID_MISMATCH,
          `source=archive`,
          `file=${entry.name}`,
          `expected=${marker.clawId}`,
          `actual=${data.clawId}`,
          `toolUseId=${marker.toolUseId}`,
        );
        continue;
      }
      const sliced = sliceMessagesAtMarker(data.messages, marker.toolUseId, inclusive);
      if (sliced !== null) {
        return {
          messages: sliced,
          systemPrompt: data.systemPrompt,
          toolsForLLM: data.toolsForLLM,
          meta: { foundIn: 'archive', foundFile: entry.name },
        };
      }
    } catch (err) {
      audit?.write?.(
        DIALOG_AUDIT_EVENTS.ARCHIVE_PARSE_FAILED,
        `file=${entry.name}`,
        `reason=${formatErr(err)}`,
      );
      // 单个 archive 损坏跳过 / 继续找
    }
  }

  // 3. 找不到
  throw new MarkerNotFoundError(marker.clawId, marker.toolUseId);
}

/** Slice messages at marker（helper for restoreMessages）*/
function sliceMessagesAtMarker(messages: Message[], toolUseId: string, inclusive = true): Message[] | null {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const hasMarker = msg.content.some(
        block => block.type === 'tool_use' && block.id === toolUseId,
      );
      if (hasMarker) {
        return messages.slice(0, inclusive ? i + 1 : i);  // inclusive 含 marker assistant message
      }
    }
  }
  return null;
}
