import * as path from 'path';
import { formatErr } from "../../../foundation/node-utils/index.js";
import * as yaml from 'js-yaml';
import { isFileNotFound, stat, type FileSystem } from '../../../foundation/fs/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { ProgressData } from '../manager.js';
import type { ArchiveState } from '../types.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { PROGRESS_FILE, CONTRACT_YAML_FILE } from '../dirs.js';
import { listArchiveContractLocations, archiveContainerDir, type ArchiveListEntry } from '../locations.js';
import { ContractProgressArchiveLooseSchema } from '../schemas.js';
import { LEGACY_PROGRESS_STATUSES_TUPLE } from '../schemas.js';
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

// Step F: observer processes current ArchiveState plus legacy 'crashed' audit-only entries.
type ObservedArchiveStatus = ArchiveState | 'crashed';

interface FormattedEvent {
  body: string;
  hasFailure: boolean;     // 任意 subtask 有 last_failed_feedback
  status: ObservedArchiveStatus;
  reason?: string;
  cause?: string;
}

// Step F: current archive state comes from the directory path (SoT).
function formatCurrentArchiveEvent(
  clawId: ClawId,
  contractDirName: string,
  meta: { title?: string; goal?: string },
  progress: ProgressData,
  state: ArchiveState,
): FormattedEvent | null {
  switch (state) {
    case 'completed':
      return formatCompleted(clawId, contractDirName, meta, progress);
    case 'cancelled':
      return formatCancelled(clawId, contractDirName, meta, progress);
    case 'corrupted':
      return {
        body: `[contract_archive_corrupted] claw=${clawId} contract=${contractDirName}`,
        hasFailure: true,
        status: 'corrupted',
        reason: 'archive_corrupted',
        cause: `Contract ${contractDirName} is in corrupted archive state`,
      };
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

// Step F: legacy flat-archive entries derive their status from progress.json.
// The legacy adapter is read-only; it maps/audits historical literals but never
// writes them back.
function formatLegacyFlatArchiveEvent(
  clawId: ClawId,
  contractDirName: string,
  meta: { title?: string; goal?: string },
  progress: ProgressData,
  audit: AuditLog,
): FormattedEvent | null {
  // Step F: progress.status is DerivableStatus at runtime type; legacy flat entries
  // may carry any historical literal, so cast through the legacy vocabulary.
  const status = progress.status as unknown as (typeof LEGACY_PROGRESS_STATUSES_TUPLE)[number];
  switch (status) {
    case 'completed':
      return formatCompleted(clawId, contractDirName, meta, progress);
    case 'cancelled':
      return formatCancelled(clawId, contractDirName, meta, progress);
    case 'crashed':
      return formatCrashed(clawId, contractDirName, meta, progress);
    case 'archive_corrupted':
      return {
        body: `[contract_archive_corrupted] claw=${clawId} contract=${contractDirName}`,
        hasFailure: true,
        status: 'corrupted',
        reason: 'archive_corrupted',
        cause: `Contract ${contractDirName} is marked archive_corrupted`,
      };
    case 'archive_pending_recovery':
      // Step F: this was a transient current-lifecycle state; it is no longer
      // produced and has no current archive destination. Read-only skip.
      return null;
    case 'pending':
    case 'running':
    case 'paused':
      // Active status in archive is a state-machine break.
      // Audit at collector level — the "upper layer" has no visibility into this.
      audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_ACTIVE_STATE_DETECTED,
        `clawId=${clawId}`,
        `contract=${contractDirName}`,
        `status=${status}`,
        `cause=active status in legacy flat archive`,
      );
      return null;
    default: {
      // Unknown legacy literal: best-effort audit as active-state break and skip.
      audit.write(
        CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_ACTIVE_STATE_DETECTED,
        `clawId=${clawId}`,
        `contract=${contractDirName}`,
        `status=${String(status)}`,
        `cause=unknown status in legacy flat archive`,
      );
      return null;
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

/**
 * phase 37: 结构化 entry、含 contractId（caller 可作 dedup key）+ ms 时间戳（caller 可作 sinceTs filter）。
 */
export interface ArchivedContractEntry {
  contractId: string;
  body: string;
  hasFailure: boolean;
  /** archive 时间戳 ms epoch；优先 max(subtask.completed_at)，无完成 subtask 时 fallback 到 progress.json mtime */
  archivedAt: number;
  // Step F: observer processes current ArchiveState plus legacy 'crashed' audit-only entries.
  status: ObservedArchiveStatus;
  reason?: string;            // cancelled 时填
  cause?: string;             // corrupted/crashed 时填
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
  dedup?: { corrupted: Set<string>; activeState: Set<string> },
): Promise<ArchivedContractScanResult> {
  const entries: ArchivedContractEntry[] = [];
  let incomplete = false;
  const archiveDir = path.join(clawDir, archiveContainerDir());

  // phase 1127 Step C: fail-open on archive container list errors, but audit non-ENOENT failures.
  try {
    fs.listSync(archiveDir, { includeDirs: true });
  } catch (err) {
    if (!isFileNotFound(err)) {
      incomplete = true;
      const code = (err as NodeJS.ErrnoException)?.code;
      audit?.write(
        CONTRACT_AUDIT_EVENTS.EVENT_COLLECTOR_SCAN_FAILED,
        `dir=${archiveDir}`,
        `code=${code ?? 'unknown'}`,
        `error=${formatErr(err)}`,
      );
    }
    return { entries, incomplete };
  }

  const locations: ArchiveListEntry[] = listArchiveContractLocations({ fs, archiveDir });

  for (const loc of locations) {
    const progressPath = path.join(loc.contractRoot, PROGRESS_FILE);
    try {
      const raw = fs.readSync(progressPath);
      const rawParsed: unknown = JSON.parse(raw);
      const obj = rawParsed as Record<string, unknown>;
      delete obj.contract_id;
      const result = ContractProgressArchiveLooseSchema.safeParse(obj);
      if (!result.success) {
        incomplete = true;
        const dedupKey = `${clawId}:${loc.contractId}`;
        if (!dedup?.corrupted.has(dedupKey)) {
          audit?.write(
            CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
            `clawId=${clawId}`,
            `contract=${loc.contractId}`,
            `context=schema_validation_failed`,
            `issues=${result.error.issues.map(i => i.message).join('; ')}`,
          );
          dedup?.corrupted.add(dedupKey);
        }
        continue;
      }
      const progress = {
        ...result.data,
        contract_id: loc.contractId,
        status: 'completed' as const,
      } as ProgressData;
      let archivedAt = Object.values(progress.subtasks)
        .reduce((max, s) => {
          if (!s.completed_at) return max;
          const ts = new Date(s.completed_at).getTime();
          return ts > max ? ts : max;
        }, 0);
      if (archivedAt === 0) {
        try {
          const statResult = await stat(progressPath);
          archivedAt = statResult.mtime.getTime();
        } catch { // silent: stat 失败回落当前时间（archive mtime 不可得、best-effort 排序用途、不阻断事件收集）
          archivedAt = Date.now();
        }
      }
      const meta = readContractMeta(fs, loc.contractRoot);
      let formatted: FormattedEvent | null;
      if (loc.kind === 'current' && loc.state) {
        formatted = formatCurrentArchiveEvent(clawId, loc.contractId, meta, progress, loc.state);
      } else {
        // Step F: legacy flat archive — derive status from historical progress.json field.
        (progress as unknown as Record<string, unknown>).status = result.data.status ?? 'completed';
        formatted = formatLegacyFlatArchiveEvent(clawId, loc.contractId, meta, progress, audit);
      }
      if (formatted === null) continue;
      entries.push({
        contractId: loc.contractId,
        body: formatted.body,
        hasFailure: formatted.hasFailure,
        archivedAt,
        status: formatted.status,
        reason: formatted.reason,
        cause: formatted.cause,
      });
    } catch (err) {
      if (isFileNotFound(err)) {
        continue;
      }
      incomplete = true;
      const dedupKey = `${clawId}:${loc.contractId}`;
      if (!dedup?.corrupted.has(dedupKey)) {
        audit?.write(
          CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
          `clawId=${clawId}`,
          `contract=${loc.contractId}`,
          `context=event_collector_archive`,
          `error=${formatErr(err)}`,
        );
        dedup?.corrupted.add(dedupKey);
      }
      continue;
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
    events: filtered.map(e => e.body).filter(b => b.length > 0),
    problemPairs: filtered
      .filter(e => e.hasFailure)
      .map(e => `${clawId}:${e.contractId}`),
  };
}
