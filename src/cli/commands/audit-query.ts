/**
 * `chestnut audit query` subcommand
 *
 * Read-only audit log query with filters and optional follow.
 * Does NOT emit audit events (ML 5).
 */

import * as path from 'path';
import { loadGlobalConfig, clawExists } from '../../assembly/config-load.js';
import { getClawDir, getClawConfigPath } from '../../core/claw-topology/index.js';
import { getNamedSubrootDir } from '../../core/claw-topology/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import { CliError } from '../errors.js';
import {
  createAuditReader,
  listAuditFiles,
  type AuditRecord,
  type ReadOptions,
} from '../../foundation/audit/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';

export interface AuditQueryOpts {
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
  deps: { fsFactory: (baseDir: string) => FileSystem },
  opts: AuditQueryOpts,
): Promise<void> {
  loadGlobalConfig(deps);

  // 1. validate claw (motion-aware: motion does not require clawExists)
  const isMotion = opts.claw === MOTION_CLAW_ID;
  if (!isMotion && !clawExists(deps, getClawConfigPath(opts.claw))) {
    throw new CliError(`Claw "${opts.claw}" does not exist`);
  }

  // 2. validate flag combinations
  if (opts.allFiles && opts.file !== 'audit') {
    throw new CliError('--file and --all-files are mutually exclusive');
  }
  if (opts.follow && opts.allFiles) {
    throw new CliError('--follow is incompatible with --all-files (follow targets a single file)');
  }

  // 3. resolve files (motion-aware: mirror claw-steps.ts:20 pattern)
  const clawDir = isMotion ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(opts.claw);
  const fs = deps.fsFactory(clawDir);
  const files = opts.allFiles
    ? listAuditFiles(fs, clawDir)
    : [{
        name: opts.file,
        path: path.join(clawDir, `${opts.file}.tsv`),
        isBusinessMain: opts.file === 'audit',
      }];

  if (files.length === 0) {
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
  if (opts.follow) {
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
      process.stdout.write(`  → 详情：chestnut audit lookup ${rec.toolUseId} -c <claw>\n`);
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
