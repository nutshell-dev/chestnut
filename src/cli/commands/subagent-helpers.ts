/**
 * @module L6.CLI.Subagent.Helpers
 * Shared helpers for subagent CLI commands
 */

import * as path from 'path';
import {
  getClawDir,
  getNamedSubrootDir,
} from '../../foundation/paths.js';
import {
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
  TASKS_QUEUES_RESULTS_DIR,
} from '../../core/async-task-system/index.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../../core/subagent/index.js';
import { TASKS_SYNC_SPAWN_DIR } from '../../core/spawn-system/index.js';
import { TASKS_SYNC_SHADOW_DIR } from '../../core/shadow-system/index.js';
import { MOTION_CLAW_ID } from '../../constants.js';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { ClawId } from '../../foundation/identity/index.js';
import { type ContractId, makeContractId } from '../../core/contract/types.js';



export type SubagentKind = 'summon' | 'spawn' | 'shadow' | 'verifier' | 'random_dream' | 'cron';
export type SubagentStatus = 'completed' | 'running' | 'failed';

// 文件级 const，cli/commands/subagent-helpers.ts inferKind + getStartedAt 两处共用
// 单源 = src/types/paths.ts 既有 4 const、避免 cross-line + cross-file value drift
// 顺序与原 inline 一致（done/failed/pending/running）：fs.existsSync 查 dir 早 break、保现行为
const QUEUE_DIRS = [
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
];

export function resolveClawDir(clawId: ClawId): string {
  return clawId === MOTION_CLAW_ID ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(clawId);
}

export function inferKind(deps: { fsFactory: (baseDir: string) => FileSystem }, id: string, clawDir: string): SubagentKind {
  if (id.startsWith('verifier-')) return 'verifier';

  const clawFs = deps.fsFactory(clawDir);

  // Try to find task.json in queue dirs
  for (const qdir of QUEUE_DIRS) {
    const taskRel = path.join(qdir, `${id}.json`);
    if (clawFs.existsSync(taskRel)) {
      try {
        const task = JSON.parse(clawFs.readSync(taskRel));
        const intentText = task.mode === 'shadow' ? task.intentPreview : task.intent;
        if (task.systemPrompt?.includes('RANDOM_DREAM') || intentText?.includes('[DREAM_OUTPUT]')) {
          return 'random_dream';
        }
        // SUNSET (per phase 1180): 'dispatch-contract-extract' branch 与 assemble.ts:295 sibling、同步删 if audit 0 触发 30 天
        if (task.callerType === 'shadow' || task.callerType === 'miner' || task.postProcessor === 'summon-contract-extract' || task.postProcessor === 'dispatch-contract-extract') {
          return 'summon';
        }
        if (task.callerType === 'subagent') {
          return 'spawn';
        }
        return 'spawn';
      } catch { /* silent: ignore parse errors */ }
    }
  }

  // Fallback: check audit.tsv for random_dream signals
  const auditRel = path.join(TASKS_QUEUES_RESULTS_DIR, id, 'audit.tsv');
  if (clawFs.existsSync(auditRel)) {
    try {
      const audit = clawFs.readSync(auditRel);
      if (audit.includes('cron_random_dream_job')) return 'random_dream';
    } catch { /* silent: ignore */ }
  }

  return 'spawn';
}

export function inferStatus(deps: { fsFactory: (baseDir: string) => FileSystem }, resultDir: string): SubagentStatus {
  const resultFs = deps.fsFactory(resultDir);
  if (resultFs.existsSync('result.txt')) return 'completed';

  const auditRel = path.join(resultDir, 'audit.tsv');
  if (resultFs.existsSync(auditRel)) {
    try {
      const content = resultFs.readSync(auditRel);
      const lines = content.split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.includes('task_failed') || line.includes('task_handler_failed') || line.includes('task_start_failed')) return 'failed';
        if (line.includes('task_completed')) return 'completed';
      }
    } catch { /* silent: ignore */ }
  }

  return 'running';
}

export function getStartedAt(deps: { fsFactory: (baseDir: string) => FileSystem }, resultDir: string, id: string, clawDir: string): Date | undefined {
  const clawFs = deps.fsFactory(clawDir);

  // Try task.json createdAt first
  for (const qdir of QUEUE_DIRS) {
    const taskRel = path.join(qdir, `${id}.json`);
    if (clawFs.existsSync(taskRel)) {
      try {
        const task = JSON.parse(clawFs.readSync(taskRel));
        if (task.createdAt) return new Date(task.createdAt);
      } catch { /* silent: ignore */ }
    }
  }

  // Fallback to audit.tsv first line timestamp
  const resultFs = deps.fsFactory(resultDir);
  const auditRel = path.join(resultDir, 'audit.tsv');
  if (resultFs.existsSync(auditRel)) {
    try {
      const content = resultFs.readSync(auditRel);
      const firstLine = content.split('\n').find(l => l.trim());
      if (firstLine) {
        const ts = firstLine.split('\t')[0];
        if (ts) return new Date(ts);
      }
    } catch { /* silent: ignore */ }
  }

  return undefined;
}

export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

export function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export function truncateId(id: string, maxLen = 36): string {
  if (id.length <= maxLen) return id;
  return id.slice(0, maxLen - 3) + '...';
}

export interface SubagentEntry {
  id: string;
  kind: SubagentKind;
  status: SubagentStatus;
  startedAt?: Date;
  durationMs?: number;
  contractId?: string;
}

export function scanSubagentResults(deps: { fsFactory: (baseDir: string) => FileSystem }, clawDir: string): SubagentEntry[] {
  const entries: SubagentEntry[] = [];
  const clawFs = deps.fsFactory(clawDir);

  // Scan async path: tasks/queues/results/<taskId>/
  const asyncRel = TASKS_QUEUES_RESULTS_DIR;
  if (clawFs.existsSync(asyncRel)) {
    const ids = clawFs.listSync(asyncRel, { includeDirs: true }).map(e => e.name);
    for (const id of ids) {
      const resultDir = path.join(clawDir, asyncRel, id);
      const resultFs = deps.fsFactory(resultDir);
      const stat = resultFs.statSync('.');
      if (!stat.isDirectory) continue;
      const kind = inferKind(deps, id, clawDir);
      const status = inferStatus(deps, resultDir);
      const startedAt = getStartedAt(deps, resultDir, id, clawDir);
      let durationMs: number | undefined;
      if (startedAt) {
        // Use result.txt mtime or audit last event ts as end time
        const resultTxtRel = path.join(asyncRel, id, 'result.txt');
        if (clawFs.existsSync(resultTxtRel)) {
          durationMs = clawFs.statSync(resultTxtRel).mtime.getTime() - startedAt.getTime();
        } else {
          const auditRel = path.join(asyncRel, id, 'audit.tsv');
          if (clawFs.existsSync(auditRel)) {
            durationMs = clawFs.statSync(auditRel).mtime.getTime() - startedAt.getTime();
          }
        }
      }
      entries.push({ id, kind, status, startedAt, durationMs });
    }
  }

  // Scan sync paths: tasks/sync/subagent/ + tasks/sync/spawn/ + tasks/sync/shadow/
  entries.push(...scanSyncDir(deps, clawDir, TASKS_SYNC_SUBAGENT_DIR, 'verifier-'));
  entries.push(...scanSyncDir(deps, clawDir, TASKS_SYNC_SPAWN_DIR, undefined, 'spawn'));
  entries.push(...scanSyncDir(deps, clawDir, TASKS_SYNC_SHADOW_DIR, undefined, 'shadow'));

  return entries;
}

function scanSyncDir(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  clawDir: string,
  syncSubDir: string,
  filterPrefix?: string,
  defaultKind?: SubagentKind,
): SubagentEntry[] {
  const clawFs = deps.fsFactory(clawDir);
  const dirRel = syncSubDir;
  if (!clawFs.existsSync(dirRel)) return [];
  const results: SubagentEntry[] = [];
  const ids = clawFs.listSync(dirRel, { includeDirs: true }).map(e => e.name);
  for (const id of ids) {
    const resultDir = path.join(clawDir, dirRel, id);
    const resultFs = deps.fsFactory(resultDir);
    const stat = resultFs.statSync('.');
    if (!stat.isDirectory) continue;
    if (filterPrefix && !id.startsWith(filterPrefix)) continue;
    const kind = defaultKind ?? inferKind(deps, id, clawDir);
    const status = inferStatus(deps, resultDir);
    const startedAt = getStartedAt(deps, resultDir, id, clawDir);
    let durationMs: number | undefined;
    if (startedAt) {
      const auditRel = path.join(dirRel, id, 'audit.tsv');
      if (clawFs.existsSync(auditRel)) {
        durationMs = clawFs.statSync(auditRel).mtime.getTime() - startedAt.getTime();
      }
    }
    // contractId only meaningful for verifier-<contractId>-<subtaskId>
    let contractId: ContractId | undefined;
    if (id.startsWith('verifier-')) {
      const rest = id.slice('verifier-'.length);
      const lastDash = rest.lastIndexOf('-');
      if (lastDash > 0) contractId = makeContractId(rest.slice(0, lastDash));
    }
    results.push({ id, kind, status, startedAt, durationMs, contractId });
  }
  return results;
}
