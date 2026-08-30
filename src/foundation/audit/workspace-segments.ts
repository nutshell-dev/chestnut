/**
 * @module L2a.AuditLog.WorkspaceSegments
 * @layer L2 基础层（AuditLog）
 *
 * Phase 1288 Step D: workspace 根审计 segments typed 查询 — 兼容期完整观察
 * legacy 根 `audit.tsv` 与新 `audit/audit.tsv` 两段历史。
 *
 * 语义契约（Phase 1288 总览拍板 / Step D 红线）：
 * - 返回显式 segment 列表，每段保留 origin（legacy/new）与 path；
 * - 不把两个文件字符串拼接伪造全序；需要时间序视图的 caller 用
 *   readWorkspaceAuditMerged：按 record.ts 排序、以 (segment 列表序, 段内 offset)
 *   作稳定 tie-break；
 * - 读取失败逐段分型（typed issue per segment，missing ≠ unreadable），
 *   经 onIssue 呈现、不静默丢段、不把单段失败当整体空；
 * - legacy 段本 Phase 只读：本模块零 delete/move/append/write（arch ratchet 冻结）；
 *   legacy 清退须后续 Phase 有「无 legacy writer」磁盘证据后另行计划。
 *
 * 边界：本模块是 AUDIT_LEGACY_PATHS.audit 的唯一读取消费方（arch 白名单）；
 * 通用原语（reader.ts）保持路径中立、不知 segments 布局。
 */

import * as path from 'path';
import type { FileSystem } from '../fs/index.js';
import { formatErr } from '../node-utils/index.js';
import { AUDIT_PATHS, AUDIT_LEGACY_PATHS } from './layout.js';
import { createAuditReader, type AuditRecord, type ReadOptions } from './reader.js';

/** segment 来源：legacy = 兼容期只读旧段；new = 唯一生产写入目标段。 */
export type WorkspaceAuditSegmentOrigin = 'legacy' | 'new';

/** 逐段分型读取失败（stage: probe = 存在性探测；read = 内容读取）。 */
export interface WorkspaceAuditSegmentIssue {
  readonly origin: WorkspaceAuditSegmentOrigin;
  readonly path: string;
  readonly stage: 'probe' | 'read';
  readonly code: string;
  readonly message: string;
}

interface WorkspaceAuditSegmentBase {
  readonly origin: WorkspaceAuditSegmentOrigin;
  readonly path: string;
}

export interface WorkspaceAuditSegmentOk extends WorkspaceAuditSegmentBase {
  readonly status: 'ok';
  /** 单段读取（malformed 行 warn+skip 语义同 createAuditReader）。 */
  read(opts?: ReadOptions): AsyncIterableIterator<AuditRecord>;
}

export interface WorkspaceAuditSegmentMissing extends WorkspaceAuditSegmentBase {
  /** 段不存在是合法状态（fresh workspace 无 legacy / 新文件尚未创建），非失败。 */
  readonly status: 'missing';
}

export interface WorkspaceAuditSegmentUnreadable extends WorkspaceAuditSegmentBase {
  readonly status: 'unreadable';
  readonly issue: WorkspaceAuditSegmentIssue;
}

export type WorkspaceAuditSegment =
  | WorkspaceAuditSegmentOk
  | WorkspaceAuditSegmentMissing
  | WorkspaceAuditSegmentUnreadable;

/** merged 时间序视图的单条记录：保留 segment 身份与段内 offset（稳定 tie-break）。 */
export interface WorkspaceAuditSegmentRecord {
  readonly segment: {
    readonly origin: WorkspaceAuditSegmentOrigin;
    readonly path: string;
  };
  /** 段内迭代序号（0-based，按段内文件顺序）。 */
  readonly offset: number;
  readonly record: AuditRecord;
}

interface WorkspaceAuditMergedOptions extends ReadOptions {
  /** 逐段失败回调（unreadable 段 + 读取中途失败段）；缺失段不触发。 */
  onIssue?: (issue: WorkspaceAuditSegmentIssue) => void;
}

/** 段定义：列表序即 merged tie-break 的段序（legacy 在前 = 较旧历史在前）。 */
const SEGMENT_DEFS: ReadonlyArray<{
  readonly origin: WorkspaceAuditSegmentOrigin;
  readonly relPath: string;
}> = [
  { origin: 'legacy', relPath: AUDIT_LEGACY_PATHS.audit },
  { origin: 'new', relPath: AUDIT_PATHS.audit },
];

/**
 * 探测 workspace 根审计全部 segments（固定两段、按 legacy→new 序）。
 * missing 段也保留在列表中（显式呈现、供 caller 区分「无此段」与「读失败」）。
 */
export function listWorkspaceAuditSegments(
  fsFactory: (baseDir: string) => FileSystem,
  chestnutRoot: string,
): WorkspaceAuditSegment[] {
  const fs = fsFactory(chestnutRoot);
  return SEGMENT_DEFS.map(({ origin, relPath }) => {
    const segmentPath = path.join(chestnutRoot, relPath);
    let exists: boolean;
    try {
      exists = fs.existsSync(segmentPath);
    } catch (err) {
      return {
        origin,
        path: segmentPath,
        status: 'unreadable' as const,
        issue: {
          origin,
          path: segmentPath,
          stage: 'probe' as const,
          code: (err as NodeJS.ErrnoException)?.code ?? 'unknown',
          message: formatErr(err),
        },
      };
    }
    if (!exists) {
      return { origin, path: segmentPath, status: 'missing' as const };
    }
    return {
      origin,
      path: segmentPath,
      status: 'ok' as const,
      read: (opts?: ReadOptions) => createAuditReader(fs, segmentPath).read(opts),
    };
  });
}

/**
 * 跨段 merged 时间序读取（物化后排序；audit 文件量级 ~MB，与 CLI query 现状一致）。
 *
 * - 不拼接文件字符串：逐段独立 parse，按 (record.ts, 段序, 段内 offset) 稳定排序；
 * - limit 在 merged 排序后应用（ReadOptions 其余过滤逐段生效）；
 * - 单段失败 → onIssue 分型呈现后继续其余段，不当整体空。
 */
export async function readWorkspaceAuditMerged(
  segments: readonly WorkspaceAuditSegment[],
  opts: WorkspaceAuditMergedOptions = {},
): Promise<WorkspaceAuditSegmentRecord[]> {
  const { onIssue, limit, ...perSegmentOpts } = opts;
  const collected: Array<WorkspaceAuditSegmentRecord & { segmentIndex: number }> = [];

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    if (segment.status === 'missing') continue;
    if (segment.status === 'unreadable') {
      onIssue?.(segment.issue);
      continue;
    }
    let offset = 0;
    try {
      for await (const record of segment.read(perSegmentOpts)) {
        collected.push({
          segmentIndex,
          segment: { origin: segment.origin, path: segment.path },
          offset: offset++,
          record,
        });
      }
    } catch (err) {
      // 读取中途失败（如 probe 后 race 删除外的 I/O 错误）：分型呈现、已收行保留、继续下一段
      onIssue?.({
        origin: segment.origin,
        path: segment.path,
        stage: 'read',
        code: (err as NodeJS.ErrnoException)?.code ?? 'unknown',
        message: formatErr(err),
      });
    }
  }

  collected.sort((a, b) => {
    if (a.record.ts < b.record.ts) return -1;
    if (a.record.ts > b.record.ts) return 1;
    if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
    return a.offset - b.offset;
  });

  const sorted: WorkspaceAuditSegmentRecord[] = collected.map(
    ({ segmentIndex: _segmentIndex, ...rest }) => rest,
  );
  return limit !== undefined ? sorted.slice(0, limit) : sorted;
}
