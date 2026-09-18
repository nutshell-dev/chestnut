/**
 * `chestnut audit query` subcommand
 *
 * Read-only audit log query with filters and optional follow.
 * Does NOT emit audit events (ML 5).
 */

import * as path from 'path';
import { getClawDir, getClawConfigPath } from '../../foundation/claw-identity/index.js';
import { getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { getChestnutRoot } from '../../foundation/claw-identity/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import {
  createAuditReader,
  listAuditFiles,
  listWorkspaceAuditSegments,
  readWorkspaceAuditMerged,
  AUDIT_FILE_STEM,
  type AuditRecord,
  type ReadOptions,
  type WorkspaceAuditSegmentIssue,
} from '../../foundation/audit/index.js';
import type { AuditCommandDeps } from './audit-command-deps.js';

/**
 * Phase 1288 Step D: workspace 根 scope 保留 id（audit query/info 专用）。
 * 该 scope 读根审计 legacy/new 两段（segments 查询），非 claw 目录。
 */
export const WORKSPACE_AUDIT_SCOPE = 'workspace';

interface AuditQueryOpts {
  claw: string;
  file: string;
  allFiles?: boolean;
  type?: string;
  sinceTs?: string;
  untilTs?: string;
  fromSeq?: number;
  toSeq?: number;
  trace?: string;
  col?: Record<string, string>;
  limit?: number;
  json?: boolean;
  follow?: boolean;

  // phase 152 typed filter
  toolUseId?: string;
  step?: number;
  contractId?: string;
  subtaskId?: string;
  // phase 216 Step D
  noHint?: boolean;
}

export async function auditQueryCommand(
  deps: AuditCommandDeps,
  opts: AuditQueryOpts,
): Promise<void> {
  deps.rootConfig.loadGlobal();

  // 1. validate claw (motion-aware: motion does not require clawExists;
  // workspace scope 是根审计 segments 查询、非 claw 目录)
  const isWorkspace = opts.claw === WORKSPACE_AUDIT_SCOPE;
  const isMotion = opts.claw === MOTION_CLAW_ID;
  if (!isWorkspace && !isMotion && deps.rootConfig.loadClaw(getClawConfigPath(opts.claw)) === undefined) {
    throw new CliError(`Claw "${opts.claw}" does not exist`);
  }

  // 2. validate flag combinations
  if (opts.allFiles && opts.file !== AUDIT_FILE_STEM) {
    throw new CliError('--file and --all-files are mutually exclusive');
  }
  if (opts.follow && opts.allFiles) {
    throw new CliError('--follow is incompatible with --all-files (follow targets a single file)');
  }

  // Phase 1288 Step D: workspace 根 scope → segments 查询（显式双段、不拼接伪造全序）
  if (isWorkspace) {
    if (opts.allFiles) {
      throw new CliError('--all-files is claw-scoped (workspace scope reads the root audit segments)');
    }
    if (opts.file !== AUDIT_FILE_STEM) {
      throw new CliError('--file is claw-scoped (workspace scope reads the root audit only)');
    }
  }

  // 3. resolve files (motion-aware: mirror claw-steps.ts:20 pattern；workspace scope 无 claw 目录)
  const clawDir = isMotion ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(opts.claw);
  const fs = deps.fsFactory(clawDir);
  const files = isWorkspace
    ? []
    : opts.allFiles
      ? listAuditFiles(fs, clawDir)
      : [{
          name: opts.file,
          path: path.join(clawDir, `${opts.file}.tsv`),
          isBusinessMain: opts.file === AUDIT_FILE_STEM,
        }];

  if (!isWorkspace && files.length === 0) {
    return;
  }

  // 4. build read options
  const readOpts: ReadOptions = {
    typePattern: opts.type,
    sinceTs: opts.sinceTs,
    untilTs: opts.untilTs,
    fromSeq: opts.fromSeq,
    toSeq: opts.toSeq,
    traceId: opts.trace,
    colFilter: opts.col,
    limit: opts.limit,
    // phase 152 typed filter
    toolUseId: opts.toolUseId,
    stepNumber: opts.step,
    contractId: opts.contractId,
    subtaskId: opts.subtaskId,
  };

  // 5. dispatch read or follow
  let scannedRows = 0;
  let matchedRows = 0;
  if (isWorkspace) {
    const result = await auditQueryWorkspaceScope(deps, opts, readOpts);
    scannedRows = result.scannedRows;
    matchedRows = result.matchedRows;
  } else if (opts.follow) {
    const reader = createAuditReader(fs, files[0].path);
    const sigintHandler = () => { reader.close(); };
    process.on('SIGINT', sigintHandler);
    try {
      for await (const rec of reader.follow(readOpts)) {
        scannedRows++;
        matchedRows++;
        emit(rec, files[0].name, opts.json ?? false);
      }
    } finally {
      process.off('SIGINT', sigintHandler);
    }
  } else {
    for (const f of files) {
      if (!fs.existsSync(f.path)) continue;
      const reader = createAuditReader(fs, f.path);
      // Count all successfully parsed rows (unfiltered) for scannedRows
      for await (const _ of reader.read({})) {
        scannedRows++;
      }
      for await (const rec of reader.read(readOpts)) {
        matchedRows++;
        emit(rec, f.name, opts.json ?? false);
      }
    }
  }

  // phase 269: exit code 3 = "result unavailable / 0 matches" — align audit-lookup phase 152 strict semantics
  // exit code 独立于 --no-hint flag（exit code 是 cli 契约、--no-hint 仅控 stderr UX）
  if (matchedRows === 0) {
    process.exitCode = 3;
    if (!opts.noHint) {
      // phase 216 Step D: 0 result hint std-2
      const filterDesc = formatFilters(opts);
      const claw = opts.claw ?? 'default';
      if (process.stderr.isTTY) {
        process.stderr.write(
          `No audit rows match filter (${filterDesc}) in claw '${claw}'.\n` +
          `(${scannedRows} rows scanned)\n`
        );
      } else {
        process.stderr.write(
          `No audit rows match filter (${filterDesc}) in claw '${claw}'. (${scannedRows} rows scanned)\n`
        );
      }
    }
  }
}

const TOOL_EVENT_TYPES = new Set([
  'tool_result', 'tool_call_input', 'tool_async_result', 'tool_execution_failed',
]);

/**
 * Phase 1288 Step D: workspace 根 scope 查询 —— legacy/new 两段显式 segment 读取。
 * merged 时间序视图按 ts 排序、segment+offset 稳定 tie-break；逐段失败分型呈现
 * （stderr），不静默丢段、不把单段失败当整体空。输出行契约与 claw scope 一致
 * （source name 统一 'audit' = 根审计 business main）。
 */
async function auditQueryWorkspaceScope(
  deps: Pick<AuditCommandDeps, 'fsFactory'>,
  opts: AuditQueryOpts,
  readOpts: ReadOptions,
): Promise<{ scannedRows: number; matchedRows: number }> {
  const chestnutRoot = getChestnutRoot();
  const segments = listWorkspaceAuditSegments(deps.fsFactory, chestnutRoot);

  const issues: WorkspaceAuditSegmentIssue[] = [];
  const onIssue = (issue: WorkspaceAuditSegmentIssue) => {
    // 两次 merged read（scanned/matched）可能重复报同一段失败 → 按 (origin, stage, code) 去重
    if (issues.some(i => i.origin === issue.origin && i.stage === issue.stage && i.code === issue.code)) return;
    issues.push(issue);
  };
  const reportIssues = () => {
    for (const issue of issues) {
      process.stderr.write(
        `[audit-query] workspace segment unreadable: origin=${issue.origin} stage=${issue.stage} ` +
        `path=${issue.path} code=${issue.code} error=${issue.message}\n`,
      );
    }
  };

  let scannedRows = 0;
  let matchedRows = 0;

  if (opts.follow) {
    // follow 只跟 new 段（唯一生产写入目标）：legacy 为冻结历史（仅旧版本进程可能
    // 追加），不作 tail 目标；new 段缺失时 follow 其路径等其创建（reader 原生语义）
    for (const seg of segments) {
      if (seg.status === 'unreadable') onIssue(seg.issue);
    }
    reportIssues();
    const current = segments.find(s => s.origin === 'new');
    const fs = deps.fsFactory(chestnutRoot);
    const reader = createAuditReader(fs, current!.path);
    const sigintHandler = () => { reader.close(); };
    process.on('SIGINT', sigintHandler);
    try {
      for await (const rec of reader.follow(readOpts)) {
        scannedRows++;
        matchedRows++;
        emit(rec, 'audit', opts.json ?? false);
      }
    } finally {
      process.off('SIGINT', sigintHandler);
    }
    return { scannedRows, matchedRows };
  }

  const scanned = await readWorkspaceAuditMerged(segments, { onIssue });
  scannedRows = scanned.length;
  const matched = await readWorkspaceAuditMerged(segments, { ...readOpts, onIssue });
  matchedRows = matched.length;
  for (const item of matched) {
    emit(item.record, 'audit', opts.json ?? false);
  }
  reportIssues();
  return { scannedRows, matchedRows };
}

function emit(rec: AuditRecord, sourceName: string, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify({
      ts: rec.ts,
      seq: rec.seq,
      type: rec.type,
      cols: rec.cols,
      ...(rec.trace_id ? { trace_id: rec.trace_id } : {}),
      // phase 152 typed ID 字段（可选）
      ...(rec.toolUseId ? { toolUseId: rec.toolUseId } : {}),
      ...(rec.stepNumber !== undefined ? { stepNumber: rec.stepNumber } : {}),
      ...(rec.contractId ? { contractId: rec.contractId } : {}),
      ...(rec.subtaskId ? { subtaskId: rec.subtaskId } : {}),
      ...(rec.contentSize !== undefined ? { contentSize: rec.contentSize } : {}),
      source: sourceName,
    }) + '\n');
  } else {
    const parts = [rec.ts, `seq=${rec.seq}`, rec.type, ...rec.cols];
    if (rec.trace_id) parts.push(`trace_id=${rec.trace_id}`);
    process.stdout.write(parts.join('\t') + '\n');

    // phase 152 jump hint（仅人读 + 仅 tool 类）
    if (TOOL_EVENT_TYPES.has(rec.type) && rec.toolUseId) {
      process.stdout.write(`  → 详情：chestnut audit lookup --tool-use-id ${rec.toolUseId} -c <claw>\n`);
    }
  }
}

function formatFilters(opts: AuditQueryOpts): string {
  const parts: string[] = [];
  if (opts.step !== undefined) parts.push(`--step ${opts.step}`);
  if (opts.toolUseId) parts.push(`--tool-use-id ${opts.toolUseId}`);
  if (opts.contractId) parts.push(`--contract-id ${opts.contractId}`);
  if (opts.subtaskId) parts.push(`--subtask-id ${opts.subtaskId}`);
  if (opts.type) parts.push(`--type ${opts.type}`);
  if (opts.trace) parts.push(`--trace ${opts.trace}`);
  if (opts.col && Object.keys(opts.col).length > 0) {
    for (const [k, v] of Object.entries(opts.col)) {
      parts.push(`--col ${k}=${v}`);
    }
  }
  if (parts.length === 0) return '(no filter)';
  return parts.join(' ');
}

export function collectColFilter(value: string, prev: Record<string, string> = {}): Record<string, string> {
  const eq = value.indexOf('=');
  if (eq === -1) {
    throw new CliError(`--col value must be key=val format (got: ${value})`);
  }
  return { ...prev, [value.slice(0, eq)]: value.slice(eq + 1) };
}
