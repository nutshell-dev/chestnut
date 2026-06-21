/**
 * @module L4.ContractSystem
 * phase 1424: contract-scoped audit slice view function
 *
 * derive 自 L2 AuditLog 持久化数据（audit.tsv 行）、按 contractId + timestamp 切片 + 按 tool family 聚合。
 * M#5 底层不预设上层：L2 AuditLog 不暴露契约级 API、本 view 在 L4 派生。
 * M#1 业务模块业务语义负责：契约履历是契约语义、归 ContractSystem。
 *
 * 实现：通过 FileSystem 读 audit.tsv 文件（per-claw audit.tsv）、行级 parse、filter、聚合。
 * 不动 AuditLog interface（仅 writes）。
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import { FileNotFoundError } from '../../foundation/fs/index.js';
import { AUDIT_FILE } from '../../foundation/audit/index.js';

/**
 * Default cap on recent execution sample count for contract footprint.
 * Derivation: 50 sample ≈ 一次典型 contract 完整 turn 的 exec 数（多 tool call）/
 * 平衡 footprint 精度 vs prompt token 灌爆 / 配 FOOTPRINT_READS_TOP_N=20 给 reads slot 留位.
 */
const RECENT_EXEC_N_DEFAULT = 50;

export interface FootprintWrite {
  file: string;
  bytes: number;
  step: number;
}

export interface FootprintEdit {
  file: string;
  step: number;
}

export interface FootprintSubmit {
  subtaskId: string;
  step: number;
}

export interface FootprintSpawn {
  taskId: string;
  step: number;
}

export interface FootprintSend {
  to: string;
  step: number;
}

export interface FootprintRead {
  file: string;
  step: number;
}

export interface FootprintExec {
  command: string;
  exitCode: number;
  step: number;
}

export interface ContractFootprint {
  contractId: string;
  /** Audit log seq 范围（[startSeq, endSeq]）/ step 概念由 audit log seq 近似 */
  stepRange: [number, number];
  writes: FootprintWrite[];
  edits: FootprintEdit[];
  submits: FootprintSubmit[];
  spawns: FootprintSpawn[];
  sends: FootprintSend[];
  reads: FootprintRead[];
  execCommands: FootprintExec[];
  toolCounts: Record<string, number>;
}

export interface ContractFootprintOptions {
  /** audit.tsv 文件路径（相对 fs.baseDir） */
  auditPath?: string;
  /** 从这个 timestamp（ms）开始的事件 / 默认无下限 */
  sinceTimestampMs?: number;
  /** exec 命令最近保留 N 条、默认 {@link RECENT_EXEC_N_DEFAULT} */
  recentExecN?: number;
}

interface AuditRow {
  timestampMs: number;
  seq: number;
  type: string;
  cols: string[];
}

function parseAuditRow(line: string): AuditRow | null {
  if (!line.trim()) return null;
  const parts = line.split('\t');
  if (parts.length < 3) return null;
  const tsStr = parts[0];
  const seqStr = parts[1];
  const type = parts[2];
  if (!tsStr || !seqStr || !type) return null;
  const timestampMs = Date.parse(tsStr);
  if (Number.isNaN(timestampMs)) return null;
  const seqMatch = seqStr.match(/^seq=(\d+)$/);
  const seq = seqMatch && seqMatch[1] !== undefined ? Number(seqMatch[1]) : 0;
  return { timestampMs, seq, type, cols: parts.slice(3) };
}

function colValue(cols: string[], key: string): string | undefined {
  const prefix = `${key}=`;
  for (const c of cols) {
    if (c.startsWith(prefix)) return c.slice(prefix.length);
  }
  return undefined;
}

/**
 * 读 audit.tsv 文件、行级 parse、按 contractId + sinceTimestampMs 切片、按 tool family 聚合。
 *
 * @param fs FileSystem（按 audit.tsv 所在目录 root 配置）
 * @param contractId 目标 contractId（filter contract event rows + 时间窗内全 tool event）
 * @param opts 切片参数
 */
export async function contractFootprint(
  fs: FileSystem,
  contractId: string,
  opts?: ContractFootprintOptions,
): Promise<ContractFootprint> {
  const auditPath = opts?.auditPath ?? AUDIT_FILE;
  const sinceTimestampMs = opts?.sinceTimestampMs ?? 0;
  const recentExecN = opts?.recentExecN ?? RECENT_EXEC_N_DEFAULT;

  let content: string;
  try {
    content = await fs.read(auditPath);
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      return emptyFootprint(contractId);
    }
    throw err;
  }

  const writes: FootprintWrite[] = [];
  const edits: FootprintEdit[] = [];
  const submits: FootprintSubmit[] = [];
  const spawns: FootprintSpawn[] = [];
  const sends: FootprintSend[] = [];
  const reads: FootprintRead[] = [];
  const execCommands: FootprintExec[] = [];
  const toolCounts: Record<string, number> = {};
  let minSeq = Number.POSITIVE_INFINITY;
  let maxSeq = 0;

  for (const line of content.split('\n')) {
    const row = parseAuditRow(line);
    if (!row) continue;
    if (row.timestampMs < sinceTimestampMs) continue;

    const rowContractId = colValue(row.cols, 'contractId') ?? colValue(row.cols, 'contract_id');
    const seq = row.seq;
    // contract-attributed events: filter by contractId
    if (rowContractId !== undefined) {
      if (rowContractId !== contractId) continue;
      if (seq < minSeq) minSeq = seq;
      if (seq > maxSeq) maxSeq = seq;
    } else {
      // tool events without contractId: include based on timestamp window (sinceTimestampMs)
      if (sinceTimestampMs === 0) {
        // 0 = unbounded; include all to give footprint some signal
      }
      if (seq < minSeq) minSeq = seq;
      if (seq > maxSeq) maxSeq = seq;
    }

    routeRow(row, { writes, edits, submits, spawns, sends, reads, execCommands, toolCounts });
  }

  // trim exec commands to recent N
  const trimmedExec = execCommands.slice(-recentExecN);

  return {
    contractId,
    stepRange: [minSeq === Number.POSITIVE_INFINITY ? 0 : minSeq, maxSeq],
    writes,
    edits,
    submits,
    spawns,
    sends,
    reads,
    execCommands: trimmedExec,
    toolCounts,
  };
}

function emptyFootprint(contractId: string): ContractFootprint {
  return {
    contractId,
    stepRange: [0, 0],
    writes: [],
    edits: [],
    submits: [],
    spawns: [],
    sends: [],
    reads: [],
    execCommands: [],
    toolCounts: {},
  };
}

interface RouteAccumulator {
  writes: FootprintWrite[];
  edits: FootprintEdit[];
  submits: FootprintSubmit[];
  spawns: FootprintSpawn[];
  sends: FootprintSend[];
  reads: FootprintRead[];
  execCommands: FootprintExec[];
  toolCounts: Record<string, number>;
}

/**
 * phase 19 Step B: routeRow dispatch via handler registries (OCP).
 * New row type / tool name = new entry, no source-code branch change.
 */
type ToolExecHandler = (cols: string[], seq: number, acc: RouteAccumulator) => void;

const TOOL_EXEC_HANDLERS: Record<string, ToolExecHandler> = {
  write: (cols, seq, acc) => {
    const file = colValue(cols, 'path') ?? colValue(cols, 'file') ?? '';
    const bytesStr = colValue(cols, 'bytes') ?? colValue(cols, 'size') ?? '0';
    acc.writes.push({ file, bytes: Number(bytesStr) || 0, step: seq });
  },
  edit: (cols, seq, acc) => {
    const file = colValue(cols, 'path') ?? colValue(cols, 'file') ?? '';
    acc.edits.push({ file, step: seq });
  },
  multi_edit: (cols, seq, acc) => {
    const file = colValue(cols, 'path') ?? colValue(cols, 'file') ?? '';
    acc.edits.push({ file, step: seq });
  },
  read: (cols, seq, acc) => {
    const file = colValue(cols, 'path') ?? colValue(cols, 'file') ?? '';
    acc.reads.push({ file, step: seq });
  },
  exec: (cols, seq, acc) => {
    const command = colValue(cols, 'command') ?? colValue(cols, 'cmd') ?? '';
    const exitStr = colValue(cols, 'exit') ?? colValue(cols, 'exit_code') ?? '0';
    acc.execCommands.push({ command, exitCode: Number(exitStr) || 0, step: seq });
  },
};

type RowHandler = (row: AuditRow, acc: RouteAccumulator) => void;

const handleToolExec: RowHandler = (row, acc) => {
  const toolName = row.cols[0] ?? 'unknown';
  acc.toolCounts[toolName] = (acc.toolCounts[toolName] ?? 0) + 1;
  TOOL_EXEC_HANDLERS[toolName]?.(row.cols, row.seq, acc);
};

const handleSubtaskCompleted: RowHandler = (row, acc) => {
  const subtaskId = colValue(row.cols, 'subtaskId') ?? colValue(row.cols, 'subtask_id') ?? '';
  acc.submits.push({ subtaskId, step: row.seq });
  acc.toolCounts['submit_subtask'] = (acc.toolCounts['submit_subtask'] ?? 0) + 1;
};

const handleSpawn: RowHandler = (row, acc) => {
  const taskId = colValue(row.cols, 'taskId') ?? colValue(row.cols, 'task_id') ?? '';
  acc.spawns.push({ taskId, step: row.seq });
  acc.toolCounts['spawn'] = (acc.toolCounts['spawn'] ?? 0) + 1;
};

const handleInbox: RowHandler = (row, acc) => {
  const to = colValue(row.cols, 'to') ?? '';
  acc.sends.push({ to, step: row.seq });
  acc.toolCounts['send'] = (acc.toolCounts['send'] ?? 0) + 1;
};

const ROW_HANDLERS: Record<string, RowHandler> = {
  tool_exec: handleToolExec,
  subtask_completed: handleSubtaskCompleted,
  spawn_task_created: handleSpawn,
  task_spawned: handleSpawn,
  inbox_written: handleInbox,
  outbox_written: handleInbox,
  inbox_send: handleInbox,
};

function routeRow(row: AuditRow, acc: RouteAccumulator): void {
  ROW_HANDLERS[row.type]?.(row, acc);
}
