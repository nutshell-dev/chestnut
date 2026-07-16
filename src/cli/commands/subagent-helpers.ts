/**
 * @module L6.CLI.Subagent.Helpers
 * Shared helpers for subagent CLI commands
 */

import { getNamedSubrootDir } from '../../core/claw-topology/index.js';
import { getClawDir } from '../../core/claw-topology/index.js';
import * as path from 'path';
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
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import {
  SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME,
  SUMMON_CALLER_TYPES,
} from '../../core/summon-system/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { type ContractId, makeContractId } from '../../core/contract/types.js';
import { AUDIT_FILE, auditFileContains, auditFileGetMtime, auditFirstTimestamp } from '../../foundation/audit/index.js';
import type { ShortIdIndex } from '../../core/async-task-system/types.js';
import { deriveShortIdFromTaskId, makeFullTaskId } from '../../core/async-task-system/types.js';



export type SubagentKind = 'summon' | 'spawn' | 'shadow' | 'verifier' | 'random_dream' | 'cron';
export type SubagentStatus = 'completed' | 'running' | 'failed' | 'error';

/** Phase 849: resolve a task id (short or full) to the id used for filesystem paths. */
function resolvePathTaskId(id: string, shortIdIndex?: ShortIdIndex): string {
  if (id.length === 36) return id;
  const resolved = shortIdIndex?.resolve(id);
  return resolved ?? id;
}

/** Phase 849: derive the display id (shortId) from a path/task id. */
function deriveDisplayTaskId(id: string): string {
  if (id.length === 36) return deriveShortIdFromTaskId(makeFullTaskId(id));
  return id;
}

// 文件级 const，cli/commands/subagent-helpers.ts inferKind + getStartedAt 两处共用
// 单源 = src/types/paths.ts 既有 4 const、避免 cross-line + cross-file value drift
// 顺序与原 inline 一致（done/failed/pending/running）：fs.existsSync 查 dir 早 break、保现行为
const QUEUE_DIRS = [
  TASKS_QUEUES_DONE_DIR,
  TASKS_QUEUES_FAILED_DIR,
  TASKS_QUEUES_PENDING_DIR,
  TASKS_QUEUES_RUNNING_DIR,
];

export function resolveClawDir(clawId: string): string {
  return clawId === MOTION_CLAW_ID ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(clawId);
}

export function inferKind(deps: { fsFactory: (baseDir: string) => FileSystem; shortIdIndex?: ShortIdIndex }, id: string, clawDir: string): SubagentKind {
  if (id.startsWith('verifier-')) return 'verifier';

  const clawFs = deps.fsFactory(clawDir);
  // Phase 849: queue files are keyed by fullTaskId; use resolved path id for lookups.
  const pathId = resolvePathTaskId(id, deps.shortIdIndex);

  // Try to find task.json in queue dirs
  for (const qdir of QUEUE_DIRS) {
    const taskRel = path.join(qdir, `${pathId}.json`);
    if (clawFs.existsSync(taskRel)) {
      try {
        // phase 355 C3 (review-2026-06-13): JSON.parse 返非对象（string / number）会让
        // 下游 `.intent` NPE。先验对象 shape、否则 skip 当 partial 文件。
        const raw: unknown = JSON.parse(clawFs.readSync(taskRel));
        if (typeof raw !== 'object' || raw === null) continue;
        const task = raw as { intent?: unknown; systemPrompt?: unknown; callerType?: unknown; postProcessor?: unknown };
        const intentText = typeof task.intent === 'string' ? task.intent : undefined;
        const systemPrompt = typeof task.systemPrompt === 'string' ? task.systemPrompt : undefined;
        if (systemPrompt?.includes('RANDOM_DREAM') || intentText?.includes('[DREAM_OUTPUT]')) {
          return 'random_dream';
        }
        if (task.callerType === SUMMON_CALLER_TYPES.SHADOW || task.callerType === SUMMON_CALLER_TYPES.MINER || task.postProcessor === SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME || task.postProcessor === 'dispatch-contract-extract') {
          return 'summon';
        }
        if (task.callerType === 'spawn_subagent') {
          return 'spawn';
        }
        return 'spawn';
      } catch { /* silent: parse 失败属 partial / corrupt task.json，按 spawn fallback 容忍 */ }
    }
  }

  // Fallback: check audit.tsv for random_dream signals
  const auditRel = path.join(TASKS_QUEUES_RESULTS_DIR, pathId, AUDIT_FILE);
  const randomDreamResult = auditFileContains(clawFs, auditRel, 'cron_random_dream_job');
  if (randomDreamResult.ok && randomDreamResult.value) return 'random_dream';
  // I/O error reading audit: cannot confirm random_dream, conservatively fallback to spawn.

  return 'spawn';
}

export function inferStatus(deps: { fsFactory: (baseDir: string) => FileSystem }, resultDir: string): SubagentStatus {
  const resultFs = deps.fsFactory(resultDir);
  if (resultFs.existsSync('result.txt')) return 'completed';

  const auditRel = path.join(resultDir, AUDIT_FILE);
  const failedResult = auditFileContains(resultFs, auditRel, 'task_failed');
  const handlerFailedResult = auditFileContains(resultFs, auditRel, 'task_handler_failed');
  const startFailedResult = auditFileContains(resultFs, auditRel, 'task_start_failed');
  const completedResult = auditFileContains(resultFs, auditRel, 'task_completed');

  if (!failedResult.ok || !handlerFailedResult.ok || !startFailedResult.ok || !completedResult.ok) {
    return 'error';
  }
  if (failedResult.value || handlerFailedResult.value || startFailedResult.value) return 'failed';
  if (completedResult.value) return 'completed';

  return 'running';
}

export function getStartedAt(deps: { fsFactory: (baseDir: string) => FileSystem; shortIdIndex?: ShortIdIndex }, resultDir: string, id: string, clawDir: string): Date | undefined {
  const clawFs = deps.fsFactory(clawDir);
  // Phase 849: queue files are keyed by fullTaskId; use resolved path id for lookups.
  const pathId = resolvePathTaskId(id, deps.shortIdIndex);

  // Try task.json createdAt first
  for (const qdir of QUEUE_DIRS) {
    const taskRel = path.join(qdir, `${pathId}.json`);
    if (clawFs.existsSync(taskRel)) {
      try {
        // phase 355 C3: 验对象 shape + createdAt 是字符串、否则 skip
        const raw: unknown = JSON.parse(clawFs.readSync(taskRel));
        if (typeof raw === 'object' && raw !== null) {
          const task = raw as { createdAt?: unknown };
          if (typeof task.createdAt === 'string') return new Date(task.createdAt);
        }
      } catch { /* silent: parse 失败 fallback audit.tsv 行 */ }
    }
  }

  // Fallback to audit.tsv first line timestamp
  const resultFs = deps.fsFactory(resultDir);
  const auditRel = path.join(resultDir, AUDIT_FILE);
  const tsResult = auditFirstTimestamp(resultFs, auditRel);
  if (tsResult.ok && tsResult.value) return new Date(tsResult.value);

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

export function scanSubagentResults(deps: { fsFactory: (baseDir: string) => FileSystem; shortIdIndex?: ShortIdIndex }, clawDir: string): SubagentEntry[] {
  const entries: SubagentEntry[] = [];
  const clawFs = deps.fsFactory(clawDir);

  // Scan async path: tasks/queues/results/<fullTaskId>/
  const asyncRel = TASKS_QUEUES_RESULTS_DIR;
  if (clawFs.existsSync(asyncRel)) {
    const ids = clawFs.listSync(asyncRel, { includeDirs: true }).map(e => e.name);
    for (const id of ids) {
      // Phase 849: result directories are keyed by fullTaskId; derive shortId for display.
      const pathId = resolvePathTaskId(id, deps.shortIdIndex);
      const displayId = deriveDisplayTaskId(pathId);
      const resultDir = path.join(clawDir, asyncRel, pathId);
      const resultFs = deps.fsFactory(resultDir);
      const stat = resultFs.statSync('.');
      if (!stat.isDirectory) continue;
      const kind = inferKind(deps, id, clawDir);
      const status = inferStatus(deps, resultDir);
      const startedAt = getStartedAt(deps, resultDir, id, clawDir);
      let durationMs: number | undefined;
      if (startedAt) {
        // Use result.txt mtime or audit last event ts as end time
        const resultTxtRel = path.join(asyncRel, pathId, 'result.txt');
        if (clawFs.existsSync(resultTxtRel)) {
          durationMs = clawFs.statSync(resultTxtRel).mtime.getTime() - startedAt.getTime();
        } else {
          const auditRel = path.join(asyncRel, pathId, AUDIT_FILE);
          const mtimeResult = auditFileGetMtime(clawFs, auditRel);
          if (mtimeResult.ok && mtimeResult.value !== null) {
            durationMs = mtimeResult.value - startedAt.getTime();
          }
        }
      }
      entries.push({ id: displayId, kind, status, startedAt, durationMs });
    }
  }

  // Scan sync paths: tasks/sync/subagent/ + tasks/sync/spawn/ + tasks/sync/shadow/
  entries.push(...scanSyncDir(deps, clawDir, TASKS_SYNC_SUBAGENT_DIR, 'verifier-'));
  entries.push(...scanSyncDir(deps, clawDir, TASKS_SYNC_SPAWN_DIR, undefined, 'spawn'));
  entries.push(...scanSyncDir(deps, clawDir, TASKS_SYNC_SHADOW_DIR, undefined, 'shadow'));

  return entries;
}

function scanSyncDir(
  deps: { fsFactory: (baseDir: string) => FileSystem; shortIdIndex?: ShortIdIndex },
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
      const auditRel = path.join(dirRel, id, AUDIT_FILE);
      const mtimeResult = auditFileGetMtime(clawFs, auditRel);
      if (mtimeResult.ok && mtimeResult.value !== null) {
        durationMs = mtimeResult.value - startedAt.getTime();
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
