/**
 * @module L4.ContractSystem.VerificationOutcome
 * Phase 1201 Step C: durable immutable verification outcome store.
 *
 * 长耗时 verifier 的计算结果先入此 store（immutable fact），再经 per-contract
 * queue 做 guarded apply。进程在「计算完成 → queued apply」窗口崩溃时，boot 从
 * 磁盘事实 replay，而不是把 in_progress 直接 reset 为 todo 丢弃结果（DP1/DP4）。
 *
 * 语义：
 * - 稳定路径 `contract/verification-outcomes/<contract-id>/<attempt-id>.json`；
 *   位于 active/archive 之外，不随 terminal rename 删除，也不是 lifecycle SoT。
 * - filename 由 attempt ID 决定；内容 identity（contract/subtask/attempt）必须与
 *   path 一致。
 * - writeExclusive：EEXIST 时读取并比较完整 payload；相同为 idempotent，不同
 *   fail-closed（保留原文件、audit conflict、不覆盖不删除）。
 * - malformed / identity mismatch 的文件保留原样并 audit read issue。
 * - immutable file 不写 "processed" 布尔；是否仍可应用由 active progress 的
 *   status + attempt ID 证明。
 */

import { z } from 'zod';
import { isFileNotFound, type FileSystem } from '../../foundation/fs/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import { formatErr } from '../../foundation/node-utils/index.js';
import { CONTRACT_VERIFICATION_OUTCOMES_DIR } from './dirs.js';
import type { ContractId, SubtaskId } from './types.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';

export const VERIFICATION_OUTCOME_SCHEMA_VERSION = 1 as const;

const RejectCauseSchema = z.enum(['llm_rejected', 'script_failed', 'programming_bug', 'subagent_timeout']);
export type VerificationOutcomeRejectCause = z.infer<typeof RejectCauseSchema>;

const VerificationResultFactSchema = z.object({
  passed: z.boolean(),
  feedback: z.string(),
  structured: z.object({
    passed: z.boolean(),
    reason: z.string(),
    issues: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict();
export type VerificationResultFact = z.infer<typeof VerificationResultFactSchema>;

const SerializableErrorFactSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
}).strict();
export type SerializableErrorFact = z.infer<typeof SerializableErrorFactSchema>;

const OutcomeIdentitySchema = z.object({
  schema_version: z.literal(VERIFICATION_OUTCOME_SCHEMA_VERSION),
  contract_id: z.string().min(1),
  subtask_id: z.string().min(1),
  attempt_id: z.string().min(1),
  completed_at: z.string().min(1),
}).strict();

export const VerificationOutcomeSchema = z.discriminatedUnion('kind', [
  OutcomeIdentitySchema.extend({
    kind: z.literal('passed'),
    result: VerificationResultFactSchema,
  }).strict(),
  OutcomeIdentitySchema.extend({
    kind: z.literal('rejected'),
    result: VerificationResultFactSchema,
    cause: RejectCauseSchema,
    max_attempts: z.number().int().positive(),
  }).strict(),
  OutcomeIdentitySchema.extend({
    kind: z.literal('errored'),
    error: SerializableErrorFactSchema,
    cause: RejectCauseSchema,
    feedback: z.string(),
    max_attempts: z.number().int().positive(),
  }).strict(),
  OutcomeIdentitySchema.extend({
    kind: z.literal('interrupted'),
    reason: z.string(),
  }).strict(),
]);

export type VerificationOutcomeIntent = z.infer<typeof VerificationOutcomeSchema>;

export type VerificationOutcomeIssueReason =
  | 'parse_failed'
  | 'schema_invalid'
  | 'identity_mismatch'
  | 'list_failed';

export interface VerificationOutcomeIssue {
  attemptId: string;
  path: string;
  reason: VerificationOutcomeIssueReason;
  detail?: string;
}

export type PersistVerificationOutcomeResult = 'persisted' | 'idempotent' | 'conflict';

function verificationOutcomeDir(baseDir: string, contractId: ContractId): string {
  return `${baseDir}/${CONTRACT_VERIFICATION_OUTCOMES_DIR}/${contractId}`;
}

export function verificationOutcomePath(baseDir: string, contractId: ContractId, attemptId: string): string {
  return `${verificationOutcomeDir(baseDir, contractId)}/${attemptId}.json`;
}

function isAlreadyExists(err: unknown): boolean {
  return !isFileNotFound(err) && err instanceof Error && 'code' in err
    && (err as NodeJS.ErrnoException).code === 'EEXIST';
}

function sameOutcomePayload(a: VerificationOutcomeIntent, b: VerificationOutcomeIntent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emitOutcomeReadIssue(audit: AuditLog, contractId: string, issue: VerificationOutcomeIssue): void {
  const cols = [
    `contractId=${contractId}`,
    `attemptId=${issue.attemptId}`,
    `reason=${issue.reason}`,
  ];
  if (issue.detail !== undefined) cols.push(`detail=${issue.detail}`);
  audit.write(CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_READ_ISSUE, ...cols);
}

/**
 * Persist an immutable verification outcome with exclusive create semantics.
 *
 * - attemptId 决定 filename；retry 复用同一 outcome payload 是 idempotent。
 * - EEXIST + 完整 payload 相同 → 'idempotent'。
 * - EEXIST + payload 不同 → fail-closed：保留原文件、audit conflict、返回 'conflict'。
 */
export async function persistVerificationOutcome(
  fs: FileSystem,
  audit: AuditLog,
  baseDir: string,
  outcome: VerificationOutcomeIntent,
): Promise<PersistVerificationOutcomeResult> {
  const contractId = outcome.contract_id as ContractId;
  const filePath = verificationOutcomePath(baseDir, contractId, outcome.attempt_id);
  const serialized = JSON.stringify(outcome, null, 2);

  try {
    await fs.writeExclusive(filePath, serialized);
  } catch (err) {
    if (isAlreadyExists(err)) {
      const existing = await readVerificationOutcomeFile(fs, filePath);
      if (existing && sameOutcomePayload(existing, outcome)) {
        audit.write(
          CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_IDEMPOTENT,
          `contractId=${outcome.contract_id}`,
          `subtaskId=${outcome.subtask_id}`,
          `attemptId=${outcome.attempt_id}`,
          `kind=${outcome.kind}`,
        );
        return 'idempotent';
      }
      // fail-closed：不覆盖、不删除；留原文件供 forensics。
      audit.write(
        CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_CONFLICT,
        `contractId=${outcome.contract_id}`,
        `subtaskId=${outcome.subtask_id}`,
        `attemptId=${outcome.attempt_id}`,
        `kind=${outcome.kind}`,
        `reason=eexist_payload_mismatch`,
      );
      return 'conflict';
    }
    throw err;
  }

  audit.write(
    CONTRACT_AUDIT_EVENTS.VERIFICATION_OUTCOME_PERSISTED,
    `contractId=${outcome.contract_id}`,
    `subtaskId=${outcome.subtask_id}`,
    `attemptId=${outcome.attempt_id}`,
    `kind=${outcome.kind}`,
  );
  return 'persisted';
}

/** Strict single-file reader：schema + identity 不过关返回 null（调用方决定 issue 记录）。 */
export async function readVerificationOutcomeFile(
  fs: FileSystem,
  filePath: string,
): Promise<VerificationOutcomeIntent | null> {
  let raw: string;
  try {
    raw = await fs.read(filePath);
  } catch (err) {
    if (isFileNotFound(err)) return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = VerificationOutcomeSchema.safeParse(parsed);
  if (!result.success) return null;
  return result.data;
}

/**
 * Read all valid durable outcomes for a contract.
 *
 * malformed / identity mismatch（filename attempt_id、dir contract_id 与内容不一致）
 * 成为 typed issue 并 audit；原文件保留，不删除不覆盖。有效 outcome 按
 * (completed_at, attempt_id) 排序以保证 deterministic replay。
 */
export async function readVerificationOutcomesForContract(
  fs: FileSystem,
  audit: AuditLog,
  baseDir: string,
  contractId: ContractId,
): Promise<{ outcomes: VerificationOutcomeIntent[]; issues: VerificationOutcomeIssue[] }> {
  const dir = verificationOutcomeDir(baseDir, contractId);
  const outcomes: VerificationOutcomeIntent[] = [];
  const issues: VerificationOutcomeIssue[] = [];

  let entries: { name: string; isDirectory: boolean }[] = [];
  try {
    if (await fs.exists(dir)) {
      entries = await fs.list(dir, { includeDirs: false });
    }
  } catch (err) {
    const issue = { attemptId: '<list>', path: dir, reason: 'list_failed' as const, detail: formatErr(err) };
    emitOutcomeReadIssue(audit, contractId, issue);
    return { outcomes: [], issues: [issue] };
  }

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.name.endsWith('.json')) continue;
    const attemptId = entry.name.slice(0, -5);
    const filePath = `${dir}/${entry.name}`;

    let raw: string;
    try {
      raw = await fs.read(filePath);
    } catch (err) {
      issues.push({ attemptId, path: filePath, reason: 'parse_failed', detail: formatErr(err) });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      issues.push({ attemptId, path: filePath, reason: 'parse_failed', detail: formatErr(err) });
      continue;
    }

    const result = VerificationOutcomeSchema.safeParse(parsed);
    if (!result.success) {
      issues.push({
        attemptId,
        path: filePath,
        reason: 'schema_invalid',
        detail: result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      continue;
    }

    if (result.data.contract_id !== contractId || result.data.attempt_id !== attemptId) {
      issues.push({
        attemptId,
        path: filePath,
        reason: 'identity_mismatch',
        detail: `expected=${contractId}/${attemptId} actual=${result.data.contract_id}/${result.data.attempt_id}`,
      });
      continue;
    }

    outcomes.push(result.data);
  }

  for (const issue of issues) {
    emitOutcomeReadIssue(audit, contractId, issue);
  }

  outcomes.sort((a, b) => {
    const t = a.completed_at.localeCompare(b.completed_at);
    return t !== 0 ? t : a.attempt_id.localeCompare(b.attempt_id);
  });

  return { outcomes, issues };
}

/**
 * 分类 helper：durable outcome 是否已反映在 subtask 记录上（idempotent replay 判定）。
 * 仅用于 audit 分类（already_applied vs superseded），不是 mutation authority；
 * 相似 feedback 撞车可能误分类，但不会因此产生任何 progress 写入。
 */
export function isOutcomeAlreadyApplied(
  subtask: {
    status: string;
    completed_at?: string;
    retry_count?: number;
    verification_attempt_id?: string;
    last_failed_feedback?: { feedback: string; cause: string };
  },
  outcome: VerificationOutcomeIntent,
): boolean {
  switch (outcome.kind) {
    case 'passed':
      return subtask.status === 'completed' && subtask.completed_at === outcome.completed_at;
    case 'rejected':
      return subtask.status !== 'in_progress'
        && (subtask.retry_count ?? 0) > 0
        && subtask.last_failed_feedback?.feedback === outcome.result.feedback;
    case 'errored':
      return subtask.status !== 'in_progress'
        && (subtask.retry_count ?? 0) > 0
        && subtask.last_failed_feedback?.feedback === outcome.feedback;
    case 'interrupted':
      return subtask.status === 'todo' && subtask.verification_attempt_id === undefined;
  }
}

/** 构造 outcome 的 builder（identity + completed_at 由 caller 一次性给定）。 */
export function buildVerificationOutcome(
  identity: {
    contractId: ContractId;
    subtaskId: SubtaskId;
    attemptId: string;
    completedAt: string;
  },
  body:
    | { kind: 'passed'; result: VerificationResultFact }
    | { kind: 'rejected'; result: VerificationResultFact; cause: VerificationOutcomeRejectCause; maxAttempts: number }
    | { kind: 'errored'; error: SerializableErrorFact; cause: VerificationOutcomeRejectCause; feedback: string; maxAttempts: number }
    | { kind: 'interrupted'; reason: string },
): VerificationOutcomeIntent {
  const base = {
    schema_version: VERIFICATION_OUTCOME_SCHEMA_VERSION,
    contract_id: identity.contractId as string,
    subtask_id: identity.subtaskId as string,
    attempt_id: identity.attemptId,
    completed_at: identity.completedAt,
  };
  switch (body.kind) {
    case 'passed':
      return { ...base, kind: 'passed', result: body.result };
    case 'rejected':
      return {
        ...base,
        kind: 'rejected',
        result: body.result,
        cause: body.cause,
        max_attempts: body.maxAttempts,
      };
    case 'errored':
      return {
        ...base,
        kind: 'errored',
        error: body.error,
        cause: body.cause,
        feedback: body.feedback,
        max_attempts: body.maxAttempts,
      };
    case 'interrupted':
      return { ...base, kind: 'interrupted', reason: body.reason };
  }
}
