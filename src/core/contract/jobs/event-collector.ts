import * as path from 'path';
import { formatErr } from "../../../foundation/node-utils/index.js";
import * as yaml from 'js-yaml';
import { isFileNotFound, type FileSystem } from '../../../foundation/fs/index.js';
import type { AuditLog } from '../../../foundation/audit/index.js';
import type { ProgressData } from '../manager.js';
import type { ArchiveState, LifecycleIntent, LifecycleIntentIssue } from '../types.js';
import { deriveProgressStatus } from '../types.js';
import { CONTRACT_AUDIT_EVENTS } from '../audit-events.js';
import { PROGRESS_FILE, CONTRACT_YAML_FILE } from '../dirs.js';
import { listArchiveContractLocations, archiveContainerDir, type ArchiveListEntry } from '../locations.js';
import { ContractProgressArchiveLooseSchema } from '../schemas.js';
import { LEGACY_PROGRESS_STATUSES_TUPLE } from '../schemas.js';
import type { ClawId } from '../../../foundation/claw-identity/index.js';
import { readLifecycleIntentsForContract } from '../lifecycle-intent.js';
import {
  contractCancelledCheckpointLine,
  contractCancelledLegacyReasonLine,
  contractCancelledNoReasonLine,
  contractCancelledPartialReadNoteLine,
  contractCancelledRequestReasonLine,
  contractCancelledRequestsHeading,
  contractCancelledStateLine,
  contractCancelledSubtaskIdLine,
  contractCancelledSubtasksHeading,
  contractCompletedExecutorLine,
  contractCompletedForceAcceptedNoteLine,
  contractCompletedGoalLine,
  contractCompletedHistoryFeedbackLine,
  contractCompletedMaterialLine,
  contractCompletedStateLine,
  contractCompletedSubtasksHeading,
  contractEventCauseLine,
  contractEventEvidenceRefLine,
  contractEventGoalLine,
  contractEventHeader,
  contractEventReasonLine,
  contractEventSubtaskIdLine,
  contractEventSubtasksHeading,
  contractEventTitleLine,
} from '../../../templates/messages/index.js';

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

/**
 * phase 1833：取消原因事实联合（局限本文件，不是公共业务类型）。
 * - requests：有 cancelled 请求记录——逐条完整保留，incomplete 表示另有读取失败；
 * - legacy：无请求记录、checkpoint 带显式 `cancelled:` 前缀——checkpoint 为前缀后原文（可空）；
 * - unavailable：无请求记录且无取消前缀 checkpoint——checkpoint 为非取消检查点原文（完整保留不当原因）。
 * 列表异常返回空 intents/issues 时落入 unavailable/legacy，措辞「未取得」不断言根本没有原因。
 */
type CancelReasonFacts =
  | { kind: 'requests'; reasons: readonly string[]; incomplete: boolean }
  | { kind: 'legacy'; checkpoint: string }
  | { kind: 'unavailable'; checkpoint?: string };

/**
 * phase 1833：取消原因事实 + 兼容串派生（owner 职责；模板只渲染已选择行）。
 * compatReason 保持 ArchivedContractEntry.reason 既有兼容串值（原 formatCancelledReason
 * 语义），独立于新中文正文，避免其它查询调用者观察到不必要变化。
 */
function deriveCancelledReasonFacts(
  intents: LifecycleIntent[],
  issues: LifecycleIntentIssue[],
  checkpointRaw: string,
): { facts: CancelReasonFacts; compatReason: string } {
  const reasons = intents
    .filter((i): i is LifecycleIntent & { requested_state: 'cancelled'; reason: string } =>
      i.requested_state === 'cancelled')
    .map(i => i.reason);
  if (reasons.length > 0) {
    return {
      facts: { kind: 'requests', reasons, incomplete: issues.length > 0 },
      compatReason: reasons.length === 1 ? reasons[0] : `requests: ${reasons.join('; ')}`,
    };
  }
  if (checkpointRaw.startsWith('cancelled:')) {
    const stripped = checkpointRaw.replace(/^cancelled:\s*/, '');
    return {
      facts: { kind: 'legacy', checkpoint: stripped },
      compatReason: stripped || '(no reason given)',
    };
  }
  return {
    facts: checkpointRaw ? { kind: 'unavailable', checkpoint: checkpointRaw } : { kind: 'unavailable' },
    compatReason: checkpointRaw || '(no reason given)',
  };
}

function formatCorruptedCause(
  _contractDirName: string,
  progress: ProgressData,
  intents: LifecycleIntent[],
): { cause: string; notes?: string } {
  const corruptedIntents = intents.filter(
    (i): i is LifecycleIntent & { requested_state: 'corrupted'; evidence: { reason: string; relativePath: string } } =>
      i.requested_state === 'corrupted',
  );
  if (corruptedIntents.length > 0) {
    const entries = corruptedIntents.map(i => `${i.evidence.reason} (${i.evidence.relativePath})`);
    return { cause: entries.length === 1 ? entries[0] : `requests: ${entries.join('; ')}` };
  }
  // Legacy fallback.
  const legacy = (progress.checkpoint ?? '').replace(/^archive_corrupted:\s*/, '') || '(no cause given)';
  return { cause: legacy, notes: '(from legacy checkpoint)' };
}

// Phase 1396 Step D: failed intent projection (no legacy fallback — failed is a new state).
function formatFailedReason(
  intents: LifecycleIntent[],
): { reason: string; evidenceRef?: string } {
  const failedIntents = intents.filter(
    (i): i is LifecycleIntent & { requested_state: 'failed'; failure: { reason: string; evidenceRef: string; producer: string } } =>
      i.requested_state === 'failed',
  );
  if (failedIntents.length > 0) {
    const reasons = failedIntents.map(i => i.failure.reason);
    const evidenceRefs = failedIntents.map(i => i.failure.evidenceRef);
    return {
      reason: reasons.length === 1 ? reasons[0] : `requests: ${reasons.join('; ')}`,
      evidenceRef: evidenceRefs.length === 1 ? evidenceRefs[0] : `requests: ${evidenceRefs.join('; ')}`,
    };
  }
  return { reason: '(no reason given)' };
}

// Step F: current archive state comes from the directory path (SoT).
// phase 1833: 取消分支贯通外层真实 audit（原空 AuditLog 静默吞读取异常）；其他状态分支行为不变。
async function formatCurrentArchiveEvent(
  fs: FileSystem,
  clawDir: string,
  clawId: ClawId,
  contractDirName: string,
  meta: { title?: string; goal?: string },
  progress: ProgressData,
  state: ArchiveState,
  audit: AuditLog,
): Promise<FormattedEvent | null> {
  switch (state) {
    case 'completed':
      return formatCompleted(clawId, contractDirName, meta, progress);
    case 'cancelled': {
      const { intents, issues } = await readLifecycleIntentsForContract(
        fs,
        audit,
        clawDir,
        contractDirName as import('../types.js').ContractId,
      );
      const { facts, compatReason } = deriveCancelledReasonFacts(intents, issues, progress.checkpoint ?? '');
      return formatCancelled(clawId, contractDirName, meta, progress, compatReason, facts);
    }
    case 'corrupted': {
      const { intents } = await readLifecycleIntentsForContract(
        fs,
        { write: () => {} } as unknown as AuditLog,
        clawDir,
        contractDirName as import('../types.js').ContractId,
      );
      const { cause } = formatCorruptedCause(contractDirName, progress, intents);
      return {
        body: contractEventHeader('contract_archive_corrupted', clawId, contractDirName),
        hasFailure: true,
        status: 'corrupted',
        reason: 'archive_corrupted',
        cause: `Contract ${contractDirName} is in corrupted archive state: ${cause}`,
      };
    }
    case 'failed': {
      // Phase 1396 Step D: execution-failure terminal fact; reason/evidenceRef only,
      // no restart/cancel prescription (motion decision belongs to later phases).
      const { intents } = await readLifecycleIntentsForContract(
        fs,
        { write: () => {} } as unknown as AuditLog,
        clawDir,
        contractDirName as import('../types.js').ContractId,
      );
      const { reason, evidenceRef } = formatFailedReason(intents);
      const lines: string[] = [contractEventHeader('contract_failed', clawId, contractDirName)];
      lines.push(contractEventReasonLine(reason));
      if (evidenceRef) lines.push(contractEventEvidenceRefLine(evidenceRef));
      return {
        body: lines.join('\n'),
        hasFailure: true,
        status: 'failed',
        reason,
      };
    }
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
  activeStateDedup?: Set<string>,
): FormattedEvent | null {
  // Step F: progress.status is DerivableStatus at runtime type; legacy flat entries
  // may carry any historical literal, so cast through the legacy vocabulary.
  const status = progress.status as unknown as (typeof LEGACY_PROGRESS_STATUSES_TUPLE)[number];
  switch (status) {
    case 'completed':
      return formatCompleted(clawId, contractDirName, meta, progress);
    case 'cancelled': {
      // phase 1833: legacy flat 无 intent store，同一 checkpoint 分类语义（owner 解析来源）
      const { facts, compatReason } = deriveCancelledReasonFacts([], [], progress.checkpoint ?? '');
      return formatCancelled(clawId, contractDirName, meta, progress, compatReason, facts);
    }
    case 'crashed':
      return formatCrashed(clawId, contractDirName, meta, progress);
    case 'archive_corrupted':
      return {
        body: contractEventHeader('contract_archive_corrupted', clawId, contractDirName),
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
      emitLegacyActiveStateOnce(
        clawId,
        contractDirName,
        status,
        'active status in legacy flat archive',
        audit,
        activeStateDedup,
      );
      return null;
    default: {
      // Unknown legacy literal: best-effort audit as active-state break and skip.
      emitLegacyActiveStateOnce(
        clawId,
        contractDirName,
        String(status),
        'unknown status in legacy flat archive',
        audit,
        activeStateDedup,
      );
      return null;
    }
  }
}

function emitLegacyActiveStateOnce(
  clawId: ClawId,
  contractDirName: string,
  status: string,
  cause: string,
  audit: AuditLog,
  activeStateDedup?: Set<string>,
): void {
  const dedupKey = `${clawId}:${contractDirName}`;
  if (activeStateDedup?.has(dedupKey)) return;
  audit.write(
    CONTRACT_AUDIT_EVENTS.CONTRACT_ARCHIVE_ACTIVE_STATE_DETECTED,
    `clawId=${clawId}`,
    `contract=${contractDirName}`,
    `status=${status}`,
    `cause=${cause}`,
  );
  activeStateDedup?.add(dedupKey);
}

function formatCompleted(
  clawId: ClawId,
  dirName: string,
  meta: { title?: string; goal?: string },
  progress: ProgressData,
): FormattedEvent {
  // phase 1832: 完成正文准确呈现流程终态与提交材料——材料/放行/历史反馈均为
  // progress 已读原文；缺失仅明示事实，不补造细节、不反推验收结论。
  const lines: string[] = [
    contractCompletedStateLine(meta.title ?? '', dirName),
    contractCompletedExecutorLine(clawId),
  ];
  if (meta.goal) lines.push(contractCompletedGoalLine(meta.goal));

  let hasFailure = false;
  const completed = Object.entries(progress.subtasks)
    .filter(([, st]) => st.status === 'completed');
  if (completed.length > 0) {
    lines.push(contractCompletedSubtasksHeading());
    for (const [stId, st] of completed) {
      lines.push(contractCompletedMaterialLine(stId, st.evidence ?? ''));
      if (st.force_accepted === true) {
        lines.push(contractCompletedForceAcceptedNoteLine());
      }
      if (st.last_failed_feedback?.feedback) {
        lines.push(contractCompletedHistoryFeedbackLine(st.last_failed_feedback.feedback));
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
  compatReason: string,
  facts: CancelReasonFacts,
): FormattedEvent {
  // phase 1833: 取消正文准确呈现终态与原因记录——来源明确、原文保留、缺失明示；
  // 不给继续/重派/升级处方，不称其余子任务未开始。reason 字段保持既有兼容串值。
  const lines: string[] = [
    contractCancelledStateLine(meta.title ?? '', dirName),
    contractCompletedExecutorLine(clawId),
  ];
  if (meta.goal) lines.push(contractCompletedGoalLine(meta.goal));
  switch (facts.kind) {
    case 'requests': {
      lines.push(contractCancelledRequestsHeading());
      for (const reason of facts.reasons) lines.push(contractCancelledRequestReasonLine(reason));
      if (facts.incomplete) lines.push(contractCancelledPartialReadNoteLine());
      break;
    }
    case 'legacy':
      lines.push(contractCancelledLegacyReasonLine(facts.checkpoint));
      break;
    case 'unavailable':
      lines.push(contractCancelledNoReasonLine());
      if (facts.checkpoint) lines.push(contractCancelledCheckpointLine(facts.checkpoint));
      break;
  }
  const completed = Object.entries(progress.subtasks).filter(([, st]) => st.status === 'completed');
  if (completed.length > 0) {
    lines.push(contractCancelledSubtasksHeading());
    for (const [stId] of completed) lines.push(contractCancelledSubtaskIdLine(stId));
  }
  return { body: lines.join('\n'), hasFailure: true, status: 'cancelled', reason: compatReason };
}

function formatCrashed(
  clawId: ClawId,
  dirName: string,
  meta: { title?: string; goal?: string },
  progress: ProgressData,
): FormattedEvent {
  const cause = (progress.checkpoint ?? '').replace(/^crashed:\s*/, '') || '(no cause given)';
  const lines: string[] = [contractEventHeader('contract_crashed', clawId, dirName)];
  if (meta.title) lines.push(contractEventTitleLine(meta.title));
  if (meta.goal) lines.push(contractEventGoalLine(meta.goal));
  lines.push(contractEventCauseLine(cause));
  const completed = Object.entries(progress.subtasks).filter(([, st]) => st.status === 'completed');
  if (completed.length > 0) {
    lines.push(contractEventSubtasksHeading('before-crash'));
    for (const [stId] of completed) lines.push(contractEventSubtaskIdLine(stId));
  }
  return { body: lines.join('\n'), hasFailure: true, status: 'crashed', cause };
}

/**
 * phase 37: 结构化 entry、含 contractId（caller 可作 dedup key）+ ms 时间戳（caller 可作 sinceTs filter）。
 */
interface ArchivedContractEntry {
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
interface ArchivedContractScanResult {
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
          const statResult = await fs.stat(progressPath);
          archivedAt = statResult.mtime.getTime();
        } catch { // silent: stat 失败回落当前时间（archive mtime 不可得、best-effort 排序用途、不阻断事件收集）
          archivedAt = Date.now();
        }
      }
      const meta = readContractMeta(fs, loc.contractRoot);
      let formatted: FormattedEvent | null;
      if (loc.kind === 'current' && loc.state) {
        formatted = await formatCurrentArchiveEvent(fs, clawDir, clawId, loc.contractId, meta, progress, loc.state, audit);
      } else {
        // Step F: legacy flat archive — derive status from historical progress.json field.
        (progress as unknown as Record<string, unknown>).status = result.data.status
          ?? deriveProgressStatus(progress);
        formatted = formatLegacyFlatArchiveEvent(
          clawId,
          loc.contractId,
          meta,
          progress,
          audit,
          dedup?.activeState,
        );
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
interface CollectedContractEventsResult {
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
