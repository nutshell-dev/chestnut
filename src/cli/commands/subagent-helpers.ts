/**
 * @module L6.CLI.Subagent.Helpers
 * Shared helpers for subagent CLI commands
 */

import { getNamedSubrootDir } from '../../foundation/claw-identity/index.js';
import { getClawDir } from '../../foundation/claw-identity/index.js';
import * as path from 'path';
import { TASKS_QUEUES_RESULTS_DIR } from '../../core/async-task-system/index.js';
// phase 1874 Step G: task 事实经 ATS owner 窄查询（目录布局 / shape 校验归 owner）
import { loadSubAgentTask } from '../../core/async-task-system/index.js';
import { TASKS_SYNC_SUBAGENT_DIR } from '../../core/subagent/index.js';
import { TASKS_SYNC_SPAWN_DIR } from '../../core/spawn-system/index.js';
import { TASKS_SYNC_SHADOW_DIR } from '../../core/shadow-system/index.js';
import { MOTION_CLAW_ID } from '../../core/claw-topology/index.js';
import {
  SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME,
  SUMMON_CALLER_TYPES,
} from '../../core/summon-system/index.js';
import type { FileSystem } from '../../foundation/fs/index.js';
import { type ContractId, makeContractId } from '../../core/contract/index.js';
import { AUDIT_FILE, auditFileContains, auditFileGetMtime, auditFirstTimestamp } from '../../foundation/audit/index.js';
import type { TaskIdResolver } from '../../core/async-task-system/index.js';
import { deriveShortIdFromTaskId, makeFullTaskId } from '../../core/async-task-system/index.js';



export const SUBAGENT_KIND_VALUES = ['summon', 'spawn', 'shadow', 'verifier', 'random_dream', 'cron'] as const;
export type SubagentKind = typeof SUBAGENT_KIND_VALUES[number];

export const SUBAGENT_STATUS_VALUES = ['completed', 'running', 'failed', 'error'] as const;
export type SubagentStatus = typeof SUBAGENT_STATUS_VALUES[number];

/** Phase 849: resolve a task id (short or full) to the id used for filesystem paths. */
function resolvePathTaskId(id: string, shortIdIndex?: TaskIdResolver): string {
  if (id.length === 36) return id;
  const resolved = shortIdIndex?.resolve(id);
  return resolved ?? id;
}

/** Phase 849: derive the display id (shortId) from a path/task id. */
function deriveDisplayTaskId(id: string): string {
  if (id.length === 36) return deriveShortIdFromTaskId(makeFullTaskId(id));
  return id;
}

export function resolveClawDir(clawId: string): string {
  return clawId === MOTION_CLAW_ID ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(clawId);
}

export async function inferKind(deps: { fsFactory: (baseDir: string) => FileSystem; shortIdIndex?: TaskIdResolver }, id: string, clawDir: string): Promise<SubagentKind> {
  if (id.startsWith('verifier-')) return 'verifier';

  const clawFs = deps.fsFactory(clawDir);
  // Phase 849: queue files are keyed by fullTaskId; use resolved path id for lookups.
  const pathId = resolvePathTaskId(id, deps.shortIdIndex);

  // phase 1874 Step G: task.json 读取经 ATS owner 窄查询 loadSubAgentTask
  // （四目录顺序 / shape 校验 / kind 过滤内部化；缺失 undefined）——CLI 不再 JSON.parse 直读。
  // full id 判据与本文件 resolvePathTaskId 一致（36 长度）：非 full id（sync 目录名等）不可能是
  // 队列文件的文件名键、直接走 audit fallback（与旧探测语义等价）。
  const task = pathId.length === 36
    ? await loadSubAgentTask(clawFs, makeFullTaskId(pathId))
    : undefined;
  if (task) {
    const intentText = task.intent;
    const systemPrompt = task.systemPrompt;
    if (systemPrompt?.includes('RANDOM_DREAM') || intentText?.includes('[DREAM_OUTPUT]')) {
      return 'random_dream';
    }
    // phase 1863 (AT-D8)：新任务写 correlation.source；legacy callerType 双读（旧任务文件）。
    // callerType 为存量文件残留键（zod strip 校验容忍、owner 类型未声明）——按结构读取。
    const correlationSource = typeof task.correlation?.source === 'string' ? task.correlation.source : undefined;
    const legacyCallerType = (task as { callerType?: unknown }).callerType;
    const callerSource = correlationSource ?? (typeof legacyCallerType === 'string' ? legacyCallerType : undefined);
    if (callerSource === SUMMON_CALLER_TYPES.SHADOW || callerSource === SUMMON_CALLER_TYPES.MINER || task.postProcessor === SUMMON_CONTRACT_EXTRACT_POSTPROCESSOR_NAME || task.postProcessor === 'dispatch-contract-extract') {
      return 'summon';
    }
    if (callerSource === 'spawn_subagent') {
      return 'spawn';
    }
    return 'spawn';
  }

  // Fallback: check audit.tsv for random_dream signals（audit 事实经 foundation/audit owner reader helper）
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

async function getStartedAt(deps: { fsFactory: (baseDir: string) => FileSystem; shortIdIndex?: TaskIdResolver }, resultDir: string, id: string, clawDir: string): Promise<Date | undefined> {
  const clawFs = deps.fsFactory(clawDir);
  // Phase 849: queue files are keyed by fullTaskId; use resolved path id for lookups.
  const pathId = resolvePathTaskId(id, deps.shortIdIndex);

  // phase 1874 Step G: createdAt 经 owner 窄查询（同上表）；非 full id 直接走 audit fallback
  const task = pathId.length === 36
    ? await loadSubAgentTask(clawFs, makeFullTaskId(pathId))
    : undefined;
  if (task && typeof task.createdAt === 'string') return new Date(task.createdAt);

  // Fallback to audit.tsv first line timestamp（foundation/audit owner reader helper）
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

export async function scanSubagentResults(deps: { fsFactory: (baseDir: string) => FileSystem; shortIdIndex?: TaskIdResolver }, clawDir: string): Promise<SubagentEntry[]> {
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
      const kind = await inferKind(deps, id, clawDir);
      const status = inferStatus(deps, resultDir);
      const startedAt = await getStartedAt(deps, resultDir, id, clawDir);
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
  entries.push(...await scanSyncDir(deps, clawDir, TASKS_SYNC_SUBAGENT_DIR, 'verifier-'));
  entries.push(...await scanSyncDir(deps, clawDir, TASKS_SYNC_SPAWN_DIR, undefined, 'spawn'));
  entries.push(...await scanSyncDir(deps, clawDir, TASKS_SYNC_SHADOW_DIR, undefined, 'shadow'));

  return entries;
}

async function scanSyncDir(
  deps: { fsFactory: (baseDir: string) => FileSystem; shortIdIndex?: TaskIdResolver },
  clawDir: string,
  syncSubDir: string,
  filterPrefix?: string,
  defaultKind?: SubagentKind,
): Promise<SubagentEntry[]> {
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
    const kind = defaultKind ?? await inferKind(deps, id, clawDir);
    const status = inferStatus(deps, resultDir);
    const startedAt = await getStartedAt(deps, resultDir, id, clawDir);
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
