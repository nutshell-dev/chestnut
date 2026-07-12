import * as path from 'path';
import { formatErr } from "../../../foundation/node-utils/index.js";
import * as yaml from 'js-yaml';
import { isFileNotFound, stat, type FileSystem } from '../../../foundation/fs/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { ProgressData } from '../manager.js';
import type { ArchiveAllowedStatus, ActiveStatus } from '../types.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { CONTRACT_ARCHIVE_DIR, PROGRESS_FILE, CONTRACT_YAML_FILE } from '../dirs.js';
import { ContractProgressArchiveLooseSchema } from '../schemas.js';
import type { ClawId } from '../../../foundation/claw-identity/index.js';

function readContractMeta(
  fs: FileSystem,
  contractDir: string,
): { title?: string; goal?: string } {
  try {
    const raw = fs.readSync(path.join(contractDir, CONTRACT_YAML_FILE));
    const parsed = yaml.load(raw) as { title?: unknown; goal?: unknown } | undefined;
    return {
      title: typeof parsed?.title === 'string' ? parsed.title : undefined,
      goal: typeof parsed?.goal === 'string' ? parsed.goal : undefined,
    };
  } catch {
    // silent: contract.yaml meta is decorative for event-collector; missing/corrupt yaml falls back to bare event (claw+contract still emitted)
    return {};
  }
}

interface FormattedEvent {
  body: string;
  hasFailure: boolean;     // 任意 subtask 有 last_failed_feedback 或状态机断裂
  status: ArchiveAllowedStatus | ActiveStatus;
  reason?: string;
  cause?: string;
}

function formatContractEvent(
  clawId: ClawId,
  contractDirName: string,
  meta: { title?: string; goal?: string },
  progress: ProgressData,
): FormattedEvent | null {
  const status = progress.status;
  switch (status) {
    case 'completed':
      return formatCompleted(clawId, contractDirName, meta, progress);
    case 'cancelled':
      return formatCancelled(clawId, contractDirName, meta, progress);
    case 'crashed':
      return formatCrashed(clawId, contractDirName, meta, progress);
    case 'archive_pending_recovery':
      return formatPendingRecovery(clawId, contractDirName, meta, progress);
    case 'archive_corrupted':
      // phase 951: archive-level corruption marker — terminal, no motion delivery
      return {
        body: `[contract_archive_corrupted] claw=${clawId} contract=${contractDirName}`,
        hasFailure: true,
        status: 'archive_corrupted',
        reason: 'archive_corrupted',
        cause: `Contract ${contractDirName} is marked archive_corrupted`,
      };
    case 'pending':
    case 'running':
    case 'paused':
      // Active state in archive is a state-machine break.
      // Audit at collector level — the "upper layer" has no visibility into this.
      return {
        body: '',
        hasFailure: true,
        status,
        reason: 'state_machine_break',
        cause: `Contract ${contractDirName} has active status "${status}" in archive`,
      };
    default: {
      // exhaustive check：未来加新 status 编译期失败
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function formatCompleted(
  clawId: ClawId,
  dirName: string,
  meta: { title?: string; goal?: string },
  progress: ProgressData,
): FormattedEvent {
  const lines: string[] = [`[contract_completed] claw=${clawId} contract=${dirName}`];
  if (meta.title) lines.push(`  title: ${meta.title}`);
  if (meta.goal) lines.push(`  goal: ${meta.goal}`);

  let hasFailure = false;
  const completed = Object.entries(progress.subtasks)
    .filter(([, st]) => st.status === 'completed');
  if (completed.length > 0) {
    lines.push('  subtasks:');
    for (const [stId, st] of completed) {
      // phase 1487: 去 [force-accepted] prefix（语义诚实化 / motion 是决策主体 / DP）
      const ev = st.evidence ?? '';
      lines.push(`    [${stId}] ${ev}`);
      if (st.last_failed_feedback?.feedback) {
        lines.push(`      ⚠ last_failure: ${st.last_failed_feedback.feedback}`);
        hasFailure = true;
      }
    }
  }
  return { body: lines.join('\n'), hasFailure, status: 'completed' };
}

function formatCancelled(
  clawId: ClawId,
  dirName: string,
  meta: { title?: string; goal?: string },
  progress: ProgressData,
): FormattedEvent {
  const reason = (progress.checkpoint ?? '').replace(/^cancelled:\s*/, '') || '(no reason given)';
  const lines: string[] = [`[contract_cancelled] claw=${clawId} contract=${dirName}`];
  if (meta.title) lines.push(`  title: ${meta.title}`);
  if (meta.goal) lines.push(`  goal: ${meta.goal}`);
  lines.push(`  reason: ${reason}`);
  const completed = Object.entries(progress.subtasks).filter(([, st]) => st.status === 'completed');
  if (completed.length > 0) {
    lines.push(`  subtasks (completed before cancel):`);
    for (const [stId] of completed) lines.push(`    [${stId}]`);
  }
  return { body: lines.join('\n'), hasFailure: true, status: 'cancelled', reason };
}

function formatCrashed(
  clawId: ClawId,
  dirName: string,
  meta: { title?: string; goal?: string },
  progress: ProgressData,
): FormattedEvent {
  const cause = (progress.checkpoint ?? '').replace(/^crashed:\s*/, '') || '(no cause given)';
  const lines: string[] = [`[contract_crashed] claw=${clawId} contract=${dirName}`];
  if (meta.title) lines.push(`  title: ${meta.title}`);
  if (meta.goal) lines.push(`  goal: ${meta.goal}`);
  lines.push(`  cause: ${cause}`);
  const completed = Object.entries(progress.subtasks).filter(([, st]) => st.status === 'completed');
  if (completed.length > 0) {
    lines.push(`  subtasks (completed before crash):`);
    for (const [stId] of completed) lines.push(`    [${stId}]`);
  }
  return { body: lines.join('\n'), hasFailure: true, status: 'crashed', cause };
}

function formatPendingRecovery(
  clawId: ClawId,
  dirName: string,
  meta: { title?: string; goal?: string },
  _progress: ProgressData,
): FormattedEvent {
  const lines: string[] = [`[contract_archive_pending_recovery] claw=${clawId} contract=${dirName}`];
  if (meta.title) lines.push(`  title: ${meta.title}`);
  lines.push(`  note: archive partial recovery state (phase 1371 sub-2)、boot reconcile 待处理`);
  return { body: lines.join('\n'), hasFailure: true, status: 'archive_pending_recovery' };
}

/**
 * phase 37: 结构化 entry、含 contractId（caller 可作 dedup key）+ ms 时间戳（caller 可作 sinceTs filter）。
 */
export interface ArchivedContractEntry {
  contractId: string;
  body: string;
  hasFailure: boolean;
  /** archive 时间戳 ms epoch；优先 max(subtask.completed_at)，无完成 subtask 时 fallback 到 progress.json mtime */
  archivedAt: number;
  // phase 63 NEW
  status: ArchiveAllowedStatus | ActiveStatus;     // entry 状态、observer 据此分流
  reason?: string;            // cancelled / state_machine_break 时填
  cause?: string;             // crashed / state_machine_break 时填
}

/**
 * phase 950: 结构化 scan 结果，使 caller 能感知扫描是否完整。
 */
export interface ArchivedContractScanResult {
  entries: ArchivedContractEntry[];
  /** true when at least one contract could not be parsed / validated / read */
  incomplete: boolean;
}

/**
 * phase 37: 扫 archive 全 completed contract、不 filter。
 * Caller 按需 filter (sinceTs / notifiedSet / 其他)。
 *
 * 抽出动机：observer race 治本要求按 dedup-set 过滤（不依赖时间戳）、
 * 同时保留 CLI's `chestnut claw <id> events --since <ts>` sinceTs 语义。
 *
 * phase 950: 返回 `{ entries, incomplete }`；incomplete 时 observer 不推进该 claw 水位。
 */
export async function scanArchivedContracts(
  fs: FileSystem,
  clawDir: string,
  clawId: ClawId,
  audit: AuditLog,
): Promise<ArchivedContractScanResult> {
  const entries: ArchivedContractEntry[] = [];
  let incomplete = false;
  const archiveDir = path.join(clawDir, CONTRACT_ARCHIVE_DIR);
  try {
    const dirs = fs.listSync(archiveDir, { includeDirs: true })
      .filter(e => e.isDirectory);
    for (const d of dirs) {
      const progressPath = path.join(archiveDir, d.name, PROGRESS_FILE);
      try {
        const raw = fs.readSync(progressPath);
        // phase 332 Zod SoT loose schema (M#2 archive 业务语义 = historical preservation、
        // 218/274 archive legacy file 不 strict-end reject、loose Zod schema_version.optional())
        const rawParsed: unknown = JSON.parse(raw);
        // strip legacy derive fields (contract_id) before safeParse、status field 保留 (archive 可含 non-derivable lifecycle)
        const obj = rawParsed as Record<string, unknown>;
        delete obj.contract_id;
        const result = ContractProgressArchiveLooseSchema.safeParse(obj);
        if (!result.success) {
          incomplete = true;
          audit?.write(
            CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
            `clawId=${clawId}`,
            `contract=${d.name}`,
            `context=schema_validation_failed`,
            `issues=${result.error.issues.map(i => i.message).join('; ')}`,
          );
          continue;
        }
        const progress = {
          ...result.data,
          contract_id: d.name,
          status: result.data.status ?? 'completed',
        } as ProgressData;
        let archivedAt = Object.values(progress.subtasks)
          .reduce((max, s) => {
            if (!s.completed_at) return max;
            const ts = new Date(s.completed_at).getTime();
            return ts > max ? ts : max;
          }, 0);
        // When no subtask has a completion timestamp, fall back to the progress.json mtime
        // (the time the contract entered its terminal state and was archived).
        if (archivedAt === 0) {
          try {
            const statResult = await stat(progressPath);
            archivedAt = statResult.mtime.getTime();
          } catch {
            // silent: stat fallback — use collection time when progress.json mtime is unavailable
            archivedAt = Date.now();
          }
        }
        const meta = readContractMeta(fs, path.join(archiveDir, d.name));
        const formatted = formatContractEvent(clawId, d.name, meta, progress);
        if (formatted === null) continue;
        if (formatted.status === 'pending' || formatted.status === 'running' || formatted.status === 'paused') {
          audit?.write(
            CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_ACTIVE_STATE_DETECTED,
            `clawId=${clawId}`,
            `contract=${d.name}`,
            `status=${formatted.status}`,
            `cause=${formatted.cause ?? 'active status in archive'}`,
          );
        }
        entries.push({
          contractId: d.name,
          body: formatted.body,
          hasFailure: formatted.hasFailure,
          archivedAt,
          status: formatted.status,
          reason: formatted.reason,
          cause: formatted.cause,
        });
      } catch (err) {
        // phase 1154 r+ derive: ENOENT-equivalent = progress.json absent (archive 常态 + active 升级 race)、非 corruption 语义
        // phase 587 ⚓ invariant: PROGRESS_CORRUPTED 仅用真 JSON.parse 失败 / schema_invalid 已独立 const
        if (isFileNotFound(err)) {
          continue; // silent skip absent / 不入 audit
        }
        incomplete = true;
        audit?.write(
          CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
          `clawId=${clawId}`,
          `contract=${d.name}`,
          `context=event_collector_archive`,
          `error=${formatErr(err)}`,
        );
        continue;
      }
    }
  } catch (err) {
    // phase 1154 r+ derive: 双码 narrow via foundation helper (FileSystem 抽象层抛 FS_NOT_FOUND)
    if (!isFileNotFound(err)) {
      incomplete = true;
      const code = (err as NodeJS.ErrnoException)?.code;
      // phase 717: dir col 改为实际 archiveDir 路径、与 phase 696/697 同语义 listing-failed 形态对齐
      audit?.write(
        CONTRACT_AUDIT_EVENTS.EVENT_COLLECTOR_SCAN_FAILED,
        `dir=${archiveDir}`,
        `code=${code ?? 'unknown'}`,
        `error=${formatErr(err)}`,
      );
    }
  }
  return { entries, incomplete };
}

/**
 * phase 1487: 返回结构化 result 替 string[].
 * `events` 字段保留原 join 兼容性 / `problemPairs` 用于 motion guidance composer extraMeta.
 */
export interface CollectedContractEventsResult {
  events: string[];
  /** [`<clawId>:<contractDirName>`, ...] for entries with last_failure feedback */
  problemPairs: string[];
}

/**
 * phase 37: thin wrapper over scanArchivedContracts + sinceTs filter (CLI / 既有 API 兼容)
 */
export async function collectContractEvents(
  fs: FileSystem,
  clawDir: string,
  clawId: ClawId,
  sinceTs: number,
  audit: AuditLog,
): Promise<CollectedContractEventsResult> {
  const { entries } = await scanArchivedContracts(fs, clawDir, clawId, audit);
  const filtered = entries.filter(e => e.archivedAt > sinceTs);
  return {
    events: filtered.map(e => e.body),
    problemPairs: filtered.filter(e => e.hasFailure).map(e => `${clawId}:${e.contractId}`),
  };
}
