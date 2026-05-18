/**
 * @module L4.ContractSystem.Acceptance
 * Acceptance pipeline — sync + async + script + LLM + inbox 通知 + error 处理
 */

import * as path from 'path';
import type { FileSystem } from '../../foundation/fs/types.js';
import type { LLMOrchestrator } from '../../foundation/llm-orchestrator/index.js';
import type { AuditLog } from '../../foundation/audit/index.js';
import type { Contract, AcceptanceFailedNotification, LastFailedFeedback } from '../../types/contract.js';
import { ToolError, ToolTimeoutError, isProgrammingBug } from '../../types/errors.js';
import type { ToolRegistry } from '../../foundation/tools/index.js';
import { exec } from '../../foundation/process-exec/index.js';
import { ProcessExecError } from '../../foundation/process-exec/index.js';
import { CONTRACT_SCRIPT_TIMEOUT_MS } from './constants.js';
import { DEFAULT_LLM_IDLE_TIMEOUT_MS } from '../../foundation/llm-orchestrator/index.js';
import { DEFAULT_MAX_STEPS } from '../agent-executor/index.js';
import { InboxWriter } from '../../foundation/messaging/index.js';
import type { ContractYaml, ProgressData, AcceptanceResult, VerifierConfig, VerifierResult } from './types.js';
import { withProgressLock, type LockContext } from './lock.js';
import { runContractVerifier } from './verifier-job.js';
import { CONTRACT_AUDIT_EVENTS } from './audit-events.js';
import { formatErr } from '../../types/utils.js';

// ───── module-level helpers ─────

type AcceptanceConfig =
  | { subtask_id: string; type: 'script'; script_file?: string }
  | { subtask_id: string; type: 'llm'; prompt_file?: string };

function formatValidIds(progress: ProgressData): string {
  return Object.keys(progress.subtasks).join(', ');
}

function auditError(
  audit: AuditLog,
  event: string,
  err: unknown,
  ...extras: string[]
): void {
  audit.write(event, ...extras, `error=${formatErr(err)}`);
}

type NotifyType = 'subtask_completed' | 'acceptance_failed' | 'contract_completed';

function safeNotify(
  ctx: AcceptanceContext,
  type: NotifyType,
  data: Record<string, unknown>,
): void {
  try {
    ctx.onNotify?.(type, data);
  } catch (err) {
    auditError(
      ctx.audit,
      CONTRACT_AUDIT_EVENTS.NOTIFY_FAILED,
      err,
      `notify_type=${type}`,
    );
  }
}

async function archiveAndEmit(
  ctx: AcceptanceContext,
  contractId: string,
  title: string,
  contextLabel: string,
): Promise<void> {
  try {
    await ctx.moveContractToArchive(contractId);
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.COMPLETED,
      contractId,
      `title=${title}`,
      `claw=${ctx.clawId}`,
    );
    await ctx.emitContractCompleted(contractId);
    safeNotify(ctx, 'contract_completed', { contractId, title });
  } catch (err) {
    auditError(
      ctx.audit,
      CONTRACT_AUDIT_EVENTS.MOVE_ARCHIVE_FAILED,
      err,
      `context=${contextLabel}`,
      `message=moveToArchive failed; contract stays in active/`,
    );
  }
}

async function runAcceptanceByType(
  ctx: AcceptanceContext,
  acceptanceConfig: AcceptanceConfig,
  contractAbsDir: string,
  contractId: string,
  subtaskId: string,
  subtaskDesc: string,
  evidence: string,
  artifacts: string[],
): Promise<AcceptanceResult> {
  if (acceptanceConfig.type === 'script') {
    const scriptFile = acceptanceConfig.script_file;
    if (!scriptFile) {
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED,
        `context=ContractSystem.runAcceptanceByType`,
        `message=acceptance config missing script_file`,
      );
      return { passed: false, feedback: 'acceptance config script 类型缺少 script_file' };
    }
    return ctx.runScriptAcceptance(scriptFile, contractAbsDir);
  }

  const promptFile = acceptanceConfig.prompt_file;
  if (!promptFile) {
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED,
      `context=ContractSystem.runAcceptanceByType`,
      `message=acceptance config missing prompt_file`,
    );
    return { passed: false, feedback: 'acceptance config llm 类型缺少 prompt_file' };
  }
  return ctx.runLLMAcceptance(
    promptFile,
    contractAbsDir,
    contractId,
    subtaskId,
    subtaskDesc,
    evidence,
    artifacts,
  );
}

async function applyAcceptanceOutcome(
  ctx: AcceptanceContext,
  contractId: string,
  subtaskId: string,
  subtaskDesc: string,
  result: AcceptanceResult,
  contractYaml: ContractYaml,
  acceptanceConfig: AcceptanceConfig,
): Promise<{ allCompleted: boolean; passed: boolean } | null> {
  return ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);

    // phase 791 (P0.18): cancellation guard
    // cancel 后 async pipeline 完成时不该覆盖 cancelled status
    if (progress.status === 'cancelled') {
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED,
        contractId,
        `subtaskId=${subtaskId}`,
        `context=applyAcceptanceOutcome`,
        `message=contract already cancelled, skip acceptance outcome write`,
      );
      return null;
    }

    const subtask = progress.subtasks[subtaskId];
    if (!subtask) {
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED,
        `context=ContractSystem.applyAcceptanceOutcome`,
        `contractId=${contractId}`,
        `subtaskId=${subtaskId}`,
        `error=subtask missing from progress after in_progress mark`,
      );
      return null;
    }

    if (result.passed) {
      subtask.status = 'completed';
      subtask.completed_at = new Date().toISOString();
      safeNotify(ctx, 'subtask_completed', { contractId, subtaskId });
      const subtaskTotal = contractYaml.subtasks.length;
      const completedCount = Object.values(progress.subtasks).filter(s => s.status === 'completed').length;
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED,
        `${contractId}/${subtaskId}`,
        `progress=${completedCount}/${subtaskTotal}`,
        `claw=${ctx.clawId}`,
      );
      ctx.audit.write(CONTRACT_AUDIT_EVENTS.PASSED, `${contractId}/${subtaskId}`);

      const allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
      if (allCompleted) {
        progress.status = 'completed';
        // phase 791 (P0.17): COMPLETED audit single-source via archiveAndEmit, not here
      }
      await ctx.saveProgress(contractId, progress);
      writeAcceptanceInbox(ctx, contractId, subtaskId, 'passed', allCompleted);

      return { allCompleted, passed: true };
    }

    // failed path
    subtask.retry_count = (subtask.retry_count || 0) + 1;
    subtask.last_failed_feedback = {
      feedback: result.feedback,
      cause: 'llm_rejected',
    };
    subtask.status = 'todo';
    const maxRetries = contractYaml.escalation?.max_retries ?? 3;
    safeNotify(ctx, 'acceptance_failed', {
      contract_id: contractId,
      subtask_id: subtaskId,
      cause: 'llm_rejected',
      feedback: result.feedback,
      retry_count: subtask.retry_count,
      max_retries: maxRetries,
    } satisfies AcceptanceFailedNotification);
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.ACCEPTANCE_FAILED,
      `${contractId}/${subtaskId}`,
      `feedback=${result.feedback}`,
    );
    await ctx.saveProgress(contractId, progress);

    const acceptanceFile = acceptanceConfig.type === 'script'
      ? acceptanceConfig.script_file ?? 'unknown'
      : acceptanceConfig.prompt_file ?? 'unknown';
    const formattedFeedback = result.structured
      ? formatRejectionFeedback(
          subtaskId,
          subtaskDesc,
          result.structured.reason,
          result.structured.issues || [],
          subtask.retry_count,
          maxRetries,
          acceptanceConfig.type,
          acceptanceFile,
        )
      : result.feedback;
    writeAcceptanceInbox(ctx, contractId, subtaskId, 'rejected', false, formattedFeedback, subtask.retry_count);

    if (subtask.retry_count >= maxRetries) {
      subtask.escalated_at = new Date().toISOString();
      await ctx.saveProgress(contractId, progress);
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.ESCALATED,
        `${contractId}/${subtaskId}`,
        `retry_count=${subtask.retry_count}`,
        `claw=${ctx.clawId}`,
      );
    }
    return { allCompleted: false, passed: false };
  });
}

export interface AcceptanceContext extends LockContext {
  clawDir: string;
  clawId: string;
  llm?: LLMOrchestrator;
  contractDir: (contractId: string) => Promise<string>;
  loadContractYaml: (contractId: string) => Promise<ContractYaml>;
  getProgress: (contractId: string) => Promise<ProgressData>;
  saveProgress: (contractId: string, progress: ProgressData) => Promise<void>;
  checkAllSubtasksCompleted: (contractId: string, progress: ProgressData) => Promise<boolean>;
  moveContractToArchive: (contractId: string) => Promise<void>;
  emitContractCompleted: (contractId: string) => Promise<void>;
  onNotify?: (type: string, data: Record<string, unknown>) => void;
  runScriptAcceptance: (scriptFile: string, contractAbsDir: string) => Promise<AcceptanceResult>;
  runLLMAcceptance: (
    promptFile: string,
    contractAbsDir: string,
    contractId: string,
    subtaskId: string,
    subtaskDesc: string,
    evidence: string,
    artifacts: string[],
  ) => Promise<AcceptanceResult>;
  withProgressLock: <T>(contractId: string, fn: () => Promise<T>) => Promise<T>;
  /** phase 704: verifier subagent toolset 注入源 */
  toolRegistry: ToolRegistry;
  /** phase 1020 (r124 C fork): wrap runContractVerifier with cancel-propagation controller */
  runVerifierWithCancel: (contractId: string, config: Omit<VerifierConfig, 'signal'>) => Promise<VerifierResult>;
  /** Tool-level wall-clock timeout inherited from globalConfig.tool_timeout_ms (phase 1029 / F-2) */
  toolTimeoutMs?: number;
}

export async function completeSubtaskSync(
  ctx: AcceptanceContext,
  contractId: string,
  subtaskId: string,
  evidence: string,
  artifacts?: string[],
): Promise<AcceptanceResult> {
  let allCompleted = false;
  let result: AcceptanceResult = { passed: true, feedback: 'No acceptance criteria configured' };
  const contractYaml = await ctx.loadContractYaml(contractId);

  await ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);

    // phase 791 (P0.18): cancellation guard
    if (progress.status === 'cancelled') {
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED,
        contractId,
        `subtaskId=${subtaskId}`,
        `context=completeSubtaskSync`,
        `message=contract already cancelled, skip subtask completion write`,
      );
      return;
    }

    if (!progress.subtasks[subtaskId]) {
      result = { passed: false, feedback: `Unknown subtask "${subtaskId}". Valid subtask IDs: ${formatValidIds(progress)}` };
      ctx.audit.write(CONTRACT_AUDIT_EVENTS.PROGRESS_CORRUPTED, `context=ContractSystem._completeSubtaskSync`, `contractId=${contractId}`, `subtaskId=${subtaskId}`, `message=Unknown subtaskId`);
      return;
    }

    const currentStatus = progress.subtasks[subtaskId].status;
    if (currentStatus === 'in_progress') {
      result = { passed: false, feedback: `Subtask "${subtaskId}" acceptance is already in progress — duplicate done() call ignored.` };
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.SUBTASK_DUPLICATE_DONE,
        `contractId=${contractId}`,
        `subtaskId=${subtaskId}`,
      );
      return;
    }
    if (currentStatus === 'completed') {
      result = { passed: false, feedback: `Subtask "${subtaskId}" is already completed.` };
      ctx.audit.write(
        CONTRACT_AUDIT_EVENTS.SUBTASK_ALREADY_COMPLETED,
        `contractId=${contractId}`,
        `subtaskId=${subtaskId}`,
      );
      return;
    }

    progress.subtasks[subtaskId] = {
      ...progress.subtasks[subtaskId],
      status: 'completed',
      completed_at: new Date().toISOString(),
      evidence,
      artifacts,
    };
    safeNotify(ctx, 'subtask_completed', { contractId, subtaskId });
    const subtaskTotal = contractYaml.subtasks.length;
    const completedCount = Object.values(progress.subtasks).filter(s => s.status === 'completed').length;
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.SUBTASK_COMPLETED,
      `${contractId}/${subtaskId}`,
      `progress=${completedCount}/${subtaskTotal}`,
      `claw=${ctx.clawId}`,
    );

    allCompleted = await ctx.checkAllSubtasksCompleted(contractId, progress);
    if (allCompleted) {
      progress.status = 'completed';
      // phase 791 (P0.17): COMPLETED audit single-source via archiveAndEmit, not here
    }

    await ctx.saveProgress(contractId, progress);
    ctx.audit.write(CONTRACT_AUDIT_EVENTS.UPDATED, `contractId=${contractId}`, `subtaskId=${subtaskId}`, `status=${allCompleted ? 'completed' : 'running'}`);
  });

  if (allCompleted) {
    await archiveAndEmit(ctx, contractId, contractYaml.title, 'ContractSystem._completeSubtaskSync');
  }

  return { ...result, allCompleted };
}

export async function runAcceptancePipeline(
  ctx: AcceptanceContext,
  params: { contractId: string; subtaskId: string; evidence: string; artifacts?: string[] },
): Promise<AcceptanceResult> {
  const { contractId, subtaskId, evidence, artifacts } = params;
  const contractYaml = await ctx.loadContractYaml(contractId);
  const acceptanceConfig = contractYaml.acceptance?.find(a => a.subtask_id === subtaskId);

  if (!acceptanceConfig) {
    return completeSubtaskSync(ctx, contractId, subtaskId, evidence, artifacts);
  }

  await ctx.withProgressLock(contractId, async () => {
    const progress = await ctx.getProgress(contractId);
    if (!progress.subtasks[subtaskId]) {
      throw new ToolError(`Unknown subtask "${subtaskId}". Valid subtask IDs: ${formatValidIds(progress)}`);
    }
    const currentStatus = progress.subtasks[subtaskId].status;
    if (currentStatus === 'in_progress') {
      throw new ToolError(`Subtask "${subtaskId}" acceptance is already in progress — duplicate done() call ignored.`);
    }
    if (currentStatus === 'completed') {
      throw new ToolError(`Subtask "${subtaskId}" is already completed.`);
    }
    progress.subtasks[subtaskId] = {
      ...progress.subtasks[subtaskId],
      status: 'in_progress',
      evidence,
      artifacts,
    };
    await ctx.saveProgress(contractId, progress);
    ctx.audit.write(CONTRACT_AUDIT_EVENTS.ACCEPTANCE_STARTED, `contractId=${contractId}`, `subtaskId=${subtaskId}`);
  });

  runAcceptanceInBackground(ctx, params, contractYaml, acceptanceConfig)
    .catch(err => {
      if (isProgrammingBug(err)) {
        ctx.audit.write(
          CONTRACT_AUDIT_EVENTS.UNEXPECTED_ASYNC_THROW,
          `context=ContractSystem.backgroundAcceptance`,
          `contractId=${contractId}`,
          `subtaskId=${subtaskId}`,
          `errorType=${err instanceof Error ? err.constructor.name : typeof err}`,
          `error=${formatErr(err)}`,
          `stack=${err instanceof Error ? err.stack ?? '' : ''}`,
        );
      } else {
        auditError(
          ctx.audit,
          CONTRACT_AUDIT_EVENTS.ACCEPTANCE_BACKGROUND_FAILED,
          err,
          `contractId=${contractId}`,
          `subtaskId=${subtaskId}`,
        );
      }
      writeAcceptanceError(ctx, contractId, subtaskId, err).catch(inboxErr => {
        auditError(
          ctx.audit,
          CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED,
          inboxErr,
          `context=ContractSystem.backgroundAcceptance.writeError`,
        );
      });
    });

  return { passed: false, feedback: '', async: true };
}

export async function runAcceptanceInBackground(
  ctx: AcceptanceContext,
  params: { contractId: string; subtaskId: string; evidence: string; artifacts?: string[] },
  contractYaml: ContractYaml,
  acceptanceConfig: AcceptanceConfig,
): Promise<void> {
  const { contractId, subtaskId, evidence, artifacts = [] } = params;
  const subtaskDef = contractYaml.subtasks.find(st => st.id === subtaskId);
  const subtaskDesc = subtaskDef?.description || subtaskId;
  const contractAbsDir = path.join(ctx.clawDir, await ctx.contractDir(contractId), contractId);

  let outcomeKind: 'passed' | 'failed' | 'error' = 'error';
  try {
    const result = await runAcceptanceByType(
      ctx,
      acceptanceConfig,
      contractAbsDir,
      contractId,
      subtaskId,
      subtaskDesc,
      evidence,
      artifacts,
    );

    const outcome = await applyAcceptanceOutcome(
      ctx,
      contractId,
      subtaskId,
      subtaskDesc,
      result,
      contractYaml,
      acceptanceConfig,
    );
    outcomeKind = outcome?.passed ? 'passed' : 'failed';

    // archive 拆出 lock（mirror completeSubtaskSync pattern / 0 lock holding 长 IO）
    if (outcome?.passed && outcome.allCompleted) {
      await archiveAndEmit(ctx, contractId, contractYaml.title, 'ContractSystem._runAcceptanceInBackground');
    }
  } finally {
    ctx.audit.write(
      CONTRACT_AUDIT_EVENTS.ACCEPTANCE_BACKGROUND_DONE,
      `contractId=${contractId}`,
      `subtaskId=${subtaskId}`,
      `result=${outcomeKind}`,
    );
  }
}

export async function runScriptAcceptance(
  ctx: AcceptanceContext,
  scriptFile: string,
  contractAbsDir: string,
): Promise<AcceptanceResult> {
  const resolved = path.resolve(contractAbsDir, scriptFile);
  if (!resolved.startsWith(contractAbsDir + path.sep)) {
    return { passed: false, feedback: `路径安全拒绝: script_file 必须在契约目录内` };
  }
  ctx.audit.write(
    CONTRACT_AUDIT_EVENTS.ACCEPTANCE_SCRIPT_STARTED,
    `script=${scriptFile}`,
    `cwd=${ctx.clawDir}`,
  );
  try {
    await exec('sh', [resolved], {
      cwd: ctx.clawDir,
      timeout: CONTRACT_SCRIPT_TIMEOUT_MS,
    });
    return { passed: true, feedback: 'Script acceptance passed' };
  } catch (err) {
    if (!(err instanceof ProcessExecError)) {
      return { passed: false, feedback: `验收失败: ${formatErr(err)}` };
    }
    const prefix = err.killed ? '验收脚本超时' : '验收失败';
    const detail = err.output || err.message;
    const firstLine = detail.split('\n').find(l => l.trim()) ?? detail.trim();
    return { passed: false, feedback: `${prefix}: ${firstLine}` };
  }
}

export async function runLLMAcceptance(
  ctx: AcceptanceContext,
  promptFile: string,
  contractAbsDir: string,
  contractId: string,
  subtaskId: string,
  subtaskDesc: string,
  evidence: string,
  artifacts: string[],
): Promise<AcceptanceResult> {
  if (!ctx.llm) {
    return { passed: false, feedback: 'LLM 验收未配置（llm 未注入）' };
  }
  const resolved = path.resolve(contractAbsDir, promptFile);
  if (!resolved.startsWith(contractAbsDir + path.sep)) {
    return { passed: false, feedback: '路径安全拒绝: prompt_file 必须在契约目录内' };
  }
  try {
    const relativePath = path.relative(ctx.clawDir, resolved);
    if (relativePath.startsWith('..')) {
      return { passed: false, feedback: '路径安全拒绝: prompt_file 解析后逃出 claw 目录' };
    }
    let promptTemplate: string;
    try {
      promptTemplate = await ctx.fs.read(relativePath);
    } catch (readErr) {
      return { passed: false, feedback: `prompt_file 读失败 (${relativePath}): ${formatErr(readErr)}` };
    }
    const filledPrompt = promptTemplate
      .replace(/\{\{evidence\}\}/g, evidence)
      .replace(/\{\{artifacts\}\}/g, artifacts.join(', '))
      .replace(/\{\{subtask_description\}\}/g, subtaskDesc);

    const result = await ctx.runVerifierWithCancel(contractId, {
      agentId: `verifier-${contractId}-${subtaskId}`,
      prompt: filledPrompt,
      clawDir: ctx.clawDir,
      clawId: ctx.clawId,        // phase 514
      llm: ctx.llm!,
      fs: ctx.fs,
      audit: ctx.audit,                                         // phase 646 ⚓ verifier cleanup audit injection
      maxSteps: DEFAULT_MAX_STEPS,
      idleTimeoutMs: DEFAULT_LLM_IDLE_TIMEOUT_MS,
      onIdleTimeout: () => {
        ctx.audit.write(
          CONTRACT_AUDIT_EVENTS.ACCEPTANCE_TIMEOUT,
          `${contractId}/${subtaskId}`,
          `claw=${ctx.clawId}`,
        );
      },
      toolRegistry: ctx.toolRegistry,                          // phase 704
      toolTimeoutMs: ctx.toolTimeoutMs,                        // phase 1029 / F-2
    });
    return result;
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      return { passed: false, feedback: '验收子代理超时' };
    }
    const msg = formatErr(err);
    return { passed: false, feedback: `LLM 验收失败: ${msg}` };
  }
}

export function writeAcceptanceInbox(
  ctx: AcceptanceContext,
  contractId: string,
  subtaskId: string,
  verdict: 'passed' | 'rejected',
  allCompleted: boolean,
  feedback?: string,
  retryCount?: number,
): void {
  const extraFields: Record<string, string> = {
    contract_id: contractId,
    subtask_id: subtaskId,
    verdict,
  };
  if (retryCount !== undefined) extraFields.retry_count = String(retryCount);

  let body: string;
  if (verdict === 'passed') {
    body = allCompleted
      ? `Subtask ${subtaskId} accepted. All subtasks complete!`
      : `Subtask ${subtaskId} accepted.`;
  } else {
    body = feedback || 'No feedback provided';
  }

  const audit = ctx.audit;
  new InboxWriter(
    ctx.fs,
    path.join(ctx.clawDir, 'inbox', 'pending'),
    audit,
  ).writeSync({
    type: verdict === 'passed' ? 'acceptance_result' : 'acceptance_rejection',
    source: 'contract_system',
    to: ctx.clawId,
    priority: verdict === 'rejected' ? 'high' : 'normal',
    body,
    filenameTag: verdict === 'rejected' ? 'high' : 'normal',
    extraFields,
  });
}

export async function writeAcceptanceError(
  ctx: AcceptanceContext,
  contractId: string,
  subtaskId: string,
  error: unknown,
): Promise<void> {
  const errorMsg = formatErr(error);
  const cause: LastFailedFeedback['cause'] =
    error instanceof ToolTimeoutError ? 'subagent_timeout' : 'programming_bug';
  const feedbackText =
    cause === 'subagent_timeout'
      ? `Acceptance verifier timed out after ${(error as ToolTimeoutError).context?.timeoutMs ?? '?'}ms. 资源 / 网络问题 / 重试可能修复。Error: ${errorMsg}`
      : `Acceptance verification crashed (system bug). Error: ${errorMsg}. 修代码后再 retry。`;

  try {
    const audit = ctx.audit;
    new InboxWriter(
      ctx.fs,
      path.join(ctx.clawDir, 'inbox', 'pending'),
      audit,
    ).writeSync({
      type: 'acceptance_error',
      source: 'contract_system',
      to: ctx.clawId,
      priority: 'high',
      body: `Acceptance verification failed with error: ${errorMsg}`,
      idPrefix: 'acceptance_error',
      filenameTag: 'high',
      extraFields: {
        contract_id: contractId,
        subtask_id: subtaskId,
      },
    });
  } catch (e) {
    auditError(
      ctx.audit,
      CONTRACT_AUDIT_EVENTS.ACCEPTANCE_INBOX_FAILED,
      e,
      'context=ContractSystem._writeAcceptanceError',
    );
  }

  try {
    await ctx.withProgressLock(contractId, async () => {
      const progress = await ctx.getProgress(contractId);
      const subtask = progress.subtasks[subtaskId];
      if (subtask && subtask.status === 'in_progress') {
        subtask.status = 'todo';
        subtask.retry_count = (subtask.retry_count || 0) + 1;
        subtask.last_failed_feedback = { feedback: feedbackText, cause };
        await ctx.saveProgress(contractId, progress);

        const contractYaml = await ctx.loadContractYaml(contractId);
        const maxRetries = contractYaml.escalation?.max_retries ?? 3;
        safeNotify(ctx, 'acceptance_failed', {
          contract_id: contractId,
          subtask_id: subtaskId,
          cause,
          feedback: feedbackText,
          retry_count: subtask.retry_count,
          max_retries: maxRetries,
        } satisfies AcceptanceFailedNotification);
      }
    });
  } catch (e) {
    auditError(
      ctx.audit,
      CONTRACT_AUDIT_EVENTS.ACCEPTANCE_RESET_FAILED,
      e,
      'context=ContractSystem._writeAcceptanceError.resetStatus',
    );
  }
}

export function formatRejectionFeedback(
  subtaskId: string,
  subtaskDesc: string,
  reason: string,
  issues: string[],
  retryCount: number,
  maxRetries: number,
  acceptanceType: string,
  acceptanceFile: string,
): string {
  const issuesList = issues.length > 0
    ? issues.map(i => `- ${i}`).join('\n')
    : '- (未提供具体问题)';

  return [
    `## 验收失败 — ${subtaskId}`,
    '',
    `**子任务：** ${subtaskDesc}`,
    '',
    '**失败原因：**',
    reason,
    '',
    '**需要修正的问题：**',
    issuesList,
    '',
    `**验收标准：** ${acceptanceType} (${acceptanceFile})`,
    '',
    `已失败 ${retryCount}/${maxRetries} 次。`,
  ].join('\n');
}
