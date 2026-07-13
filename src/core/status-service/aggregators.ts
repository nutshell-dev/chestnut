/**
 * Status aggregators — pure data views over (ContractSystem, FileSystem).
 *
 * Phase 1472 (Step A) — 抽出 status-tool 内嵌的 3 个 getXxxStatus 为 pure function +
 * format helper、让 agent-facing status tool 与 CLI `claw <name> status` 共用。
 *
 * 设计原则：
 * - aggregator 不写 audit、无副作用（除 FS 读）/ 把错误折进 view 形态、由调用方决定是否 audit
 * - format helper 把 view → 文本（agent 与 CLI 共用、避免输出漂移）
 * - CLI 也用同一组 aggregator + format、只是把 fs 切到目标 claw 的 clawDir 根
 */

import type { FileSystem } from '../../foundation/fs/index.js';
import { isFileNotFound } from '../../foundation/fs/index.js';
import { formatErr } from "../../foundation/node-utils/index.js";
import type { ContractSystem } from '../contract/index.js';
import { TASKS_QUEUES_PENDING_DIR, TASKS_QUEUES_RUNNING_DIR } from '../async-task-system/index.js';
import { CLAWSPACE_DIR, CLAW_MEMORY_FILE } from '../../foundation/claw-identity/index.js';

// ── Views ───────────────────────────────────────────────────────────────────

export type ContractView =
  | { type: 'no-active' }
  | {
      type: 'active';
      title: string;
      doneCount: number;
      totalCount: number;
      subtasks: { id: string; description: string; status: string }[];
    }
  | { type: 'error'; message: string };

export type TaskView =
  | { type: 'counts'; running: number; pending: number; pendingError?: string; runningError?: string }
  | { type: 'unavailable'; message: string };

export type StorageMemoryView =
  | { type: 'size'; bytes: number }
  | { type: 'not-found' }
  | { type: 'error'; message: string };

export type StorageClawspaceView =
  | { type: 'count'; files: number }
  | { type: 'error'; message: string };

export interface StorageView {
  memoryMd: StorageMemoryView;
  clawspace: StorageClawspaceView;
}

// ── Aggregators ─────────────────────────────────────────────────────────────

export async function computeContractView(contractSystem: ContractSystem): Promise<ContractView> {
  try {
    const contract = await contractSystem.loadActive();
    if (!contract) return { type: 'no-active' };
    const doneCount = contract.subtasks.filter(s => s.status === 'completed').length;
    return {
      type: 'active',
      title: contract.title,
      doneCount,
      totalCount: contract.subtasks.length,
      subtasks: contract.subtasks.map(s => ({
        id: s.id,
        description: s.description,
        status: s.status,
      })),
    };
  } catch (err) {
    // silent: pure aggregator 不写 audit / loadActive 失败折进 view 由调用方写 STATUS_AUDIT_EVENTS.CONTRACT_ERROR
    return { type: 'error', message: formatErr(err) };
  }
}

export async function computeTaskView(fs: FileSystem): Promise<TaskView> {
  try {
    let pending = 0;
    let running = 0;
    let pendingError: string | undefined;
    let runningError: string | undefined;

    try {
      pending = (await fs.list(TASKS_QUEUES_PENDING_DIR, { includeDirs: false })).length;
    } catch (err) {
      // silent: ENOENT/FS_NOT_FOUND 视作"队列目录尚未建"、非业务错误；其余 error 折进 pendingError 字段由调用方 audit
      if (!isFileNotFound(err)) {
        pendingError = formatErr(err);
      }
    }

    try {
      running = (await fs.list(TASKS_QUEUES_RUNNING_DIR, { includeDirs: false })).length;
    } catch (err) {
      // silent: 同 pending 段、ENOENT 视作未建队列、其余折进 runningError
      if (!isFileNotFound(err)) {
        runningError = formatErr(err);
      }
    }

    return { type: 'counts', running, pending, pendingError, runningError };
  } catch (err) {
    // silent: pure aggregator 不写 audit / 外层兜底任何意外、折进 view 形态由调用方决定降级文本
    return { type: 'unavailable', message: formatErr(err) };
  }
}

export async function computeStorageView(fs: FileSystem): Promise<StorageView> {
  let memoryMd: StorageMemoryView;
  try {
    if (await fs.exists(CLAW_MEMORY_FILE)) {
      const content = await fs.read(CLAW_MEMORY_FILE);
      memoryMd = { type: 'size', bytes: Buffer.byteLength(content, 'utf8') };
    } else {
      memoryMd = { type: 'not-found' };
    }
  } catch (err) {
    // silent: pure aggregator 不写 audit / MEMORY.md 读失败折进 view 由调用方决定降级文本
    memoryMd = { type: 'error', message: err instanceof Error ? err.message : 'unknown' };
  }

  let clawspace: StorageClawspaceView;
  try {
    const entries = await fs
      .list(CLAWSPACE_DIR, { recursive: true, includeDirs: false })
      .catch((err: unknown) => {
        // silent: ENOENT/FS_NOT_FOUND 视作"空 clawspace"返回 []、其余真错重抛由外层兜底
        if (isFileNotFound(err)) return [];
        throw err;
      });
    clawspace = { type: 'count', files: entries.length };
  } catch (err) {
    // silent: pure aggregator 不写 audit / clawspace list 失败折进 view
    clawspace = { type: 'error', message: err instanceof Error ? err.message : 'unknown' };
  }

  return { memoryMd, clawspace };
}

// ── Format helpers (shared by agent tool + CLI) ─────────────────────────────

export function formatContractView(v: ContractView): string {
  if (v.type === 'no-active') return 'Contract: No active contract';
  if (v.type === 'error') return 'Contract: Error loading';
  if (v.type === 'active') {
    const lines = [`Contract: "${v.title}" (${v.doneCount}/${v.totalCount} subtasks done)`];
    for (const s of v.subtasks) {
      const icon = s.status === 'completed' ? '✓' : '○';
      lines.push(`  ${icon} ${s.id}: ${s.description}`);
    }
    return lines.join('\n');
  }
  const _exhaustive: never = v;
  return _exhaustive;
}

export function formatTaskView(v: TaskView): string {
  if (v.type === 'unavailable') return `Tasks: unavailable (${v.message})`;
  if (v.type === 'counts') {
    const parts: string[] = [];
    if (v.running > 0) parts.push(`${v.running} running`);
    if (v.pending > 0) parts.push(`${v.pending} pending`);
    if (v.pendingError) parts.push(`pending error: ${v.pendingError}`);
    if (v.runningError) parts.push(`running error: ${v.runningError}`);
    if (parts.length === 0) return 'Tasks: idle';
    return `Tasks: ${parts.join(', ')}`;
  }
  const _exhaustive: never = v;
  return _exhaustive;
}

export function formatStorageView(v: StorageView): string[] {
  const lines: string[] = [];
  const md = v.memoryMd;
  if (md.type === 'size') {
    lines.push(`MEMORY.md: ${(md.bytes / 1024).toFixed(1)}KB`);
  } else if (md.type === 'not-found') {
    lines.push('MEMORY.md: Not found');
  } else if (md.type === 'error') {
    lines.push(`MEMORY.md: Error (${md.message})`);
  } else {
    const _exhaustiveMd: never = md;
    void _exhaustiveMd;
  }

  const cs = v.clawspace;
  if (cs.type === 'count') {
    lines.push(`Clawspace: ${cs.files} files`);
  } else if (cs.type === 'error') {
    lines.push(`Clawspace: Error (${cs.message})`);
  } else {
    const _exhaustiveCs: never = cs;
    void _exhaustiveCs;
  }

  return lines;
}
