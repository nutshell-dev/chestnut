/**
 * @module L2b.DialogStore
 * DialogStore lookup helper (phase 147 Step B)
 *
 * 4 级降级路径查找 tool_use_id 对应的 content.
 * Owner: dialog-store (M#3: dialog content 归 dialog-store SoT).
 */

import { sha256ShortHex } from  '../node-utils/index.js';
import type { FileSystem } from '../fs/index.js';
import type { ToolUseId } from '../tool-protocol/index.js';

/** Lookup result discriminated union (phase 147 / 4 级降级路径). */
export type LookupResult =
  | { source: 'current'; content: string }
  | { source: 'archive'; content: string; archivedAt: string }
  | { source: 'archive'; content: string; archivedAt: string; hashVerified: true }
  | { source: 'unavailable'; reason: 'not_in_current' | 'not_in_archive' | 'hash_mismatch' | 'all_failed' };

export interface LookupOptions {
  /** Optional sha8 hash for integrity verification (level 3 降级). */
  contentHash?: string;
}

/**
 * 4 级降级路径查找 tool_use_id 对应的 content（phase 136 §5.D + phase 147 Step B）.
 *
 * 1. current → 2. archive → 3. hash 核 → 4. unavailable
 *
 * @param fs - FileSystem 实例
 * @param dialogDir - 绝对路径 dialog 目录（含 current.json + archive/）
 * @param toolUseId - 目标 tool_use_id
 * @param options - 可选 contentHash 用于完整性核（level 3）
 */
export function lookupContentByToolUseId(
  fs: FileSystem,
  dialogDir: string,
  toolUseId: ToolUseId | string,
  options?: LookupOptions,
): LookupResult {
  const idStr = String(toolUseId);

  // phase 918: dialogDir 不存在 → 整体不可用
  if (!fs.existsSync(dialogDir)) {
    return { source: 'unavailable', reason: 'all_failed' };
  }

  // Level 1: current
  const currentPath = `${dialogDir}/current.json`;
  const currentAccessible = fs.existsSync(currentPath);
  if (currentAccessible) {
    const currentResult = lookupInCurrent(fs, dialogDir, idStr);
    if (currentResult !== null) {
      return { source: 'current', content: currentResult };
    }
  }

  // Level 2: archive 扫
  const archiveResult = lookupInArchive(fs, dialogDir, idStr);
  if (archiveResult.found) {
    // Level 3: hash 核（若提供 contentHash）
    if (options?.contentHash) {
      const hash = computeSha8(archiveResult.content);
      if (hash !== options.contentHash) {
        return { source: 'unavailable', reason: 'hash_mismatch' };
      }
      return {
        source: 'archive',
        content: archiveResult.content,
        archivedAt: archiveResult.archivedAt,
        hashVerified: true,
      };
    }
    return {
      source: 'archive',
      content: archiveResult.content,
      archivedAt: archiveResult.archivedAt,
    };
  }

  // Level 4: unavailable
  // phase 918: archive 目录读失败单独报告 not_in_archive
  if (archiveResult.inaccessible) {
    return { source: 'unavailable', reason: 'not_in_archive' };
  }
  // phase 918: current 不存在（或不可读）且 archive 也未命中 → not_in_current
  if (!currentAccessible) {
    return { source: 'unavailable', reason: 'not_in_current' };
  }
  return { source: 'unavailable', reason: 'all_failed' };
}

function lookupInCurrent(fs: FileSystem, dialogDir: string, toolUseId: string): string | null {
  const currentPath = `${dialogDir}/current.json`;
  if (!fs.existsSync(currentPath)) return null;
  try {
    const session = JSON.parse(fs.readSync(currentPath));
    // phase 521 (review-round4 Foundation M): shape guard、防 session=null/null-prototype/array
    // 致 session.messages 访问抛错被外 catch silent 吞、有效线索可观察
    if (typeof session !== 'object' || session === null || Array.isArray(session)) return null;
    return findContentInMessages(session.messages ?? [], toolUseId);
  } catch (err) {
    process.stderr.write(`[dialog-lookup] current.json parse failed: ${err}\n`);
    return null;
  }
}

type ArchiveLookupResult =
  | { found: true; content: string; archivedAt: string; inaccessible: false }
  | { found: false; inaccessible: boolean };

function lookupInArchive(
  fs: FileSystem,
  dialogDir: string,
  toolUseId: string,
): ArchiveLookupResult {
  const archiveDir = `${dialogDir}/archive`;
  if (!fs.existsSync(archiveDir)) return { found: false, inaccessible: false };

  let entries;
  try {
    entries = fs.listSync(archiveDir);
  } catch (err) {
    process.stderr.write(`[dialog-lookup] archive list failed: ${err}\n`);
    return { found: false, inaccessible: true };
  }

  // archive entries 形态：`<timestamp>_<uuid>.json` 文件（store.ts archive() 生成）
  // 按 timestamp 降序扫（最新的优先）
  const sorted = entries
    .filter(e => e.isFile && e.name.endsWith('.json'))
    .sort((a, b) => {
      const ta = parseArchiveTs(a.name);
      const tb = parseArchiveTs(b.name);
      return tb - ta;
    });

  for (const entry of sorted) {
    const sessionPath = `${archiveDir}/${entry.name}`;
    try {
      const session = JSON.parse(fs.readSync(sessionPath));
      // phase 521 (review-round4 Foundation M): shape guard、同 lookupInCurrent
      if (typeof session !== 'object' || session === null || Array.isArray(session)) continue;
      const content = findContentInMessages(session.messages ?? [], toolUseId);
      if (content !== null) {
        const archivedAt = String(parseArchiveTs(entry.name));
        return { found: true, content, archivedAt, inaccessible: false };
      }
    } catch (err) {
      process.stderr.write(`[dialog-lookup] archive ${entry.name} parse failed: ${err}\n`);
      continue;
    }
  }

  return { found: false, inaccessible: false };
}

function parseArchiveTs(name: string): number {
  const idx = name.indexOf('_');
  if (idx === -1) return 0;
  const n = parseInt(name.slice(0, idx), 10);
  return Number.isFinite(n) ? n : 0;
}

function findContentInMessages(messages: unknown[], toolUseId: string): string | null {
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (typeof m.content === 'string') continue;
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as Record<string, unknown>;
      if (b?.type === 'tool_result' && b?.tool_use_id === toolUseId) {
        const c = b.content;
        return typeof c === 'string' ? c : JSON.stringify(c);
      }
    }
  }
  return null;
}

function computeSha8(content: string): string {
  return sha256ShortHex(content, 8);
}
