/**
 * @module L6.CLI.Subagent.Helpers
 * Shared helpers for subagent CLI commands
 */

import * as fs from 'fs';
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

export function resolveClawDir(clawId: string): string {
  return clawId === MOTION_CLAW_ID ? getNamedSubrootDir(MOTION_CLAW_ID) : getClawDir(clawId);
}

export function inferKind(id: string, clawDir: string): SubagentKind {
  if (id.startsWith('verifier-')) return 'verifier';

  // Try to find task.json in queue dirs
  for (const qdir of QUEUE_DIRS) {
    const taskPath = path.join(clawDir, qdir, `${id}.json`);
    if (fs.existsSync(taskPath)) {
      try {
        const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
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
      } catch { /* ignore parse errors */ }
    }
  }

  // Fallback: check audit.tsv for random_dream signals
  const auditPath = path.join(clawDir, TASKS_QUEUES_RESULTS_DIR, id, 'audit.tsv');
  if (fs.existsSync(auditPath)) {
    try {
      const audit = fs.readFileSync(auditPath, 'utf-8');
      if (audit.includes('cron_random_dream_job')) return 'random_dream';
    } catch { /* ignore */ }
  }

  return 'spawn';
}

export function inferStatus(resultDir: string): SubagentStatus {
  if (fs.existsSync(path.join(resultDir, 'result.txt'))) return 'completed';

  const auditPath = path.join(resultDir, 'audit.tsv');
  if (fs.existsSync(auditPath)) {
    try {
      const content = fs.readFileSync(auditPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (line.includes('task_failed') || line.includes('task_handler_failed') || line.includes('task_start_failed')) return 'failed';
        if (line.includes('task_completed')) return 'completed';
      }
    } catch { /* ignore */ }
  }

  return 'running';
}

export function getStartedAt(resultDir: string, id: string, clawDir: string): Date | undefined {
  // Try task.json createdAt first
  for (const qdir of QUEUE_DIRS) {
    const taskPath = path.join(clawDir, qdir, `${id}.json`);
    if (fs.existsSync(taskPath)) {
      try {
        const task = JSON.parse(fs.readFileSync(taskPath, 'utf-8'));
        if (task.createdAt) return new Date(task.createdAt);
      } catch { /* ignore */ }
    }
  }

  // Fallback to audit.tsv first line timestamp
  const auditPath = path.join(resultDir, 'audit.tsv');
  if (fs.existsSync(auditPath)) {
    try {
      const content = fs.readFileSync(auditPath, 'utf-8');
      const firstLine = content.split('\n').find(l => l.trim());
      if (firstLine) {
        const ts = firstLine.split('\t')[0];
        if (ts) return new Date(ts);
      }
    } catch { /* ignore */ }
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

export function scanSubagentResults(clawDir: string): SubagentEntry[] {
  const entries: SubagentEntry[] = [];

  // Scan async path: tasks/queues/results/<taskId>/
  const asyncDir = path.join(clawDir, TASKS_QUEUES_RESULTS_DIR);
  if (fs.existsSync(asyncDir)) {
    const ids = fs.readdirSync(asyncDir);
    for (const id of ids) {
      const resultDir = path.join(asyncDir, id);
      const stat = fs.statSync(resultDir);
      if (!stat.isDirectory()) continue;
      const kind = inferKind(id, clawDir);
      const status = inferStatus(resultDir);
      const startedAt = getStartedAt(resultDir, id, clawDir);
      let durationMs: number | undefined;
      if (startedAt) {
        // Use result.txt mtime or audit last event ts as end time
        const resultTxt = path.join(resultDir, 'result.txt');
        if (fs.existsSync(resultTxt)) {
          durationMs = fs.statSync(resultTxt).mtimeMs - startedAt.getTime();
        } else {
          const auditPath = path.join(resultDir, 'audit.tsv');
          if (fs.existsSync(auditPath)) {
            durationMs = fs.statSync(auditPath).mtimeMs - startedAt.getTime();
          }
        }
      }
      entries.push({ id, kind, status, startedAt, durationMs });
    }
  }

  // Scan sync paths: tasks/sync/subagent/ + tasks/sync/spawn/ + tasks/sync/shadow/
  entries.push(...scanSyncDir(clawDir, TASKS_SYNC_SUBAGENT_DIR, 'verifier-'));
  entries.push(...scanSyncDir(clawDir, TASKS_SYNC_SPAWN_DIR, undefined, 'spawn'));
  entries.push(...scanSyncDir(clawDir, TASKS_SYNC_SHADOW_DIR, undefined, 'shadow'));

  return entries;
}

function scanSyncDir(
  clawDir: string,
  syncSubDir: string,
  filterPrefix?: string,
  defaultKind?: SubagentKind,
): SubagentEntry[] {
  const dirPath = path.join(clawDir, syncSubDir);
  if (!fs.existsSync(dirPath)) return [];
  const results: SubagentEntry[] = [];
  const ids = fs.readdirSync(dirPath);
  for (const id of ids) {
    const resultDir = path.join(dirPath, id);
    const stat = fs.statSync(resultDir);
    if (!stat.isDirectory()) continue;
    if (filterPrefix && !id.startsWith(filterPrefix)) continue;
    const kind = defaultKind ?? inferKind(id, clawDir);
    const status = inferStatus(resultDir);
    const startedAt = getStartedAt(resultDir, id, clawDir);
    let durationMs: number | undefined;
    if (startedAt) {
      const auditPath = path.join(resultDir, 'audit.tsv');
      if (fs.existsSync(auditPath)) {
        durationMs = fs.statSync(auditPath).mtimeMs - startedAt.getTime();
      }
    }
    // contractId only meaningful for verifier-<contractId>-<subtaskId>
    let contractId: string | undefined;
    if (id.startsWith('verifier-')) {
      const rest = id.slice('verifier-'.length);
      const lastDash = rest.lastIndexOf('-');
      if (lastDash > 0) contractId = rest.slice(0, lastDash);
    }
    results.push({ id, kind, status, startedAt, durationMs, contractId });
  }
  return results;
}
