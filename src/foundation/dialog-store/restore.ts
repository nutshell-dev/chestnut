/**
 * @module L2.DialogStore.Restore
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
import { formatErr } from '../utils/index.js';

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
  try {
    const content = await fs.read(currentPath);
    const parsed = JSON.parse(content) as Partial<SessionData>;
    const detected = detectAndMigrateVersion(parsed, CURRENT_DIALOG_FILE, audit);
    if (detected === null) {
      // version unknown — treat as corrupted and fall through to archive
      throw new Error('session version unknown');
    }
    const data = validateSessionData(detected, audit);
    const sliced = sliceMessagesAtMarker(data.messages, marker.toolUseId, inclusive);
    if (sliced !== null) {
      return {
        messages: sliced,
        systemPrompt: data.systemPrompt,
        toolsForLLM: data.toolsForLLM,
        meta: { foundIn: 'current' },
      };
    }
  } catch (err) {
    if (!isFileNotFound(err)) {
      audit?.write?.(
        DIALOG_AUDIT_EVENTS.CORRUPTED,
        'file=current.json',
        `context=restore_${inclusive ? 'prefix' : 'before'}`,
        `reason=${formatErr(err)}`,
      );
    }
    // current 不存在或损坏 / 走 archive
  }

  // 2. Scan archive/*.json (按时间倒序 / 找首个含 toolUseId 的)
  try {
    // ensureDir 不在此调用——restoreMessages 是只读操作，不应有 fs 副作用
    // 若 archive dir 不存在，后续 fs.list() 抛 ENOENT → catch → 抛 MarkerNotFoundError（正确语义）
    const entries = await fs.list(archiveDir);
    const sorted = entries
      .filter(e => e.isFile && e.name.endsWith('.json') && !isNaN(parseInt(e.name.split('_')[0], 10)))
      .sort((a, b) => parseInt(b.name.split('_')[0], 10) - parseInt(a.name.split('_')[0], 10)); // Newest first / 与 loadLatestArchive 一致

    for (const entry of sorted) {
      try {
        const content = await fs.read(path.join(archiveDir, entry.name));
        const parsed = JSON.parse(content) as Partial<SessionData>;
        const detected = detectAndMigrateVersion(parsed, entry.name, audit);
        if (detected === null) {
          continue; // version unknown (version > SESSION_CURRENT_VERSION)
        }
        const data = validateSessionData(detected, audit);
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
  } catch (err) {
    audit?.write?.(
      DIALOG_AUDIT_EVENTS.ARCHIVE_DIR_FAILED,
      `reason=${formatErr(err)}`,
    );
    // archive dir 失败 / 走最终抛错
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
