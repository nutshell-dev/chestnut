/**
 * Phase 1973 Step C：setup 多端点候选 probe。
 *
 * 五家供应商（DeepSeek/Kimi/Qwen/GLM/MiniMax）在 setup（init 与
 * `config provider add`）中按固定顺序 probe 候选 Anthropic 端点：
 * 第一个 ok 的候选把其 endpoint/base URL 写入显式 setup draft；全败不保存并逐候选报告。
 * 运行时不再 probe——重启直接使用落盘的显式 endpoint/base URL。
 */

import { DEFAULT_LLM_TIMEOUT_MS } from '../foundation/llm-orchestrator/index.js';
import {
  snapshotLLMProviderDraft,
  type LLMSetupDraft,
  type LLMSetupProbeResult,
  type LLMSetupVerified,
  type LLMSetupWorkflowEvent,
} from '../core/llm-configuration/index.js';
import {
  probeLLMConnection,
  classifyLLMErrorForDisplay,
  LLM_ERROR_HINTS,
  LLM_ERROR_LABELS,
  type LLMErrorType,
} from './llm-connection-check.js';
import type { SetupProbeCandidate } from './setup-provider-catalog.js';
import { stripOrchestratorWrapper, truncateLLMMessage } from './utils/text.js';
import { SETUP_MULTI_ENDPOINT_HINT } from '../templates/messages/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import { CLI_AUDIT_EVENTS } from './audit-events.js';
import { createAuthenticationSetup } from '../core/llm-configuration/setup.js';
import { formatErr } from '../foundation/node-utils/index.js';

/**
 * 单候选 probe 的 bounded timeout：不把用户生产 timeout 拉满。
 * Qwen 7 候选最坏 ~105s，可接受；保存配置仍使用用户 timeout_ms。
 */
export const SETUP_PROBE_TIMEOUT_MS = 15_000;

export type SetupProbeResult =
  | { ok: true; model: string }
  | { ok: false; errorType: LLMErrorType; message: string; provider: string };

export interface SetupProbeAttempt {
  candidate: Pick<SetupProbeCandidate, 'baseUrl' | 'label'>;
  result: SetupProbeResult;
}

export interface SetupProbeOutcome {
  winner?: SetupProbeCandidate;
  winnerModel?: string;
  attempts: SetupProbeAttempt[];
}

/**
 * 纯迭代 helper：按候选顺序逐个 probe，首胜即停（后续候选不调用）；
 * 全败返回全部 attempts。probe 由 caller 注入，便于测试与复用。
 */
export async function probeSetupCandidates(
  candidates: readonly SetupProbeCandidate[],
  probe: (candidate: SetupProbeCandidate) => Promise<SetupProbeResult>,
): Promise<SetupProbeOutcome> {
  const attempts: SetupProbeAttempt[] = [];
  for (const candidate of candidates) {
    const result = await probe(candidate);
    attempts.push({ candidate, result });
    if (result.ok) return { winner: candidate, winnerModel: result.model, attempts };
  }
  return { attempts };
}

export interface SetupProbeFailureGroup {
  errorType: LLMErrorType;
  label: string;
  attempts: SetupProbeAttempt[];
}

/** 按错误类别分组（保持首次出现顺序）。 */
export function groupSetupProbeFailures(
  attempts: readonly SetupProbeAttempt[],
): SetupProbeFailureGroup[] {
  const groups = new Map<LLMErrorType, SetupProbeFailureGroup>();
  for (const attempt of attempts) {
    if (attempt.result.ok) continue;
    const { errorType } = attempt.result;
    let group = groups.get(errorType);
    if (!group) {
      group = {
        errorType,
        label: LLM_ERROR_LABELS[errorType],
        attempts: [],
      };
      groups.set(errorType, group);
    }
    group.attempts.push(attempt);
  }
  return [...groups.values()];
}

/**
 * 全败摘要：每个错误类别一组，URL 归组；hint 只给一条。
 * - 同类失败：该类别 hint；
 * - 混合失败：用户的 key 通常只属于某个 endpoint/plan，给一条 endpoint/plan 提示。
 * unknown 附首条原始消息，避免只看到 “Unrecognized”。
 */
export function formatSetupProbeFailureLines(
  attempts: readonly SetupProbeAttempt[],
): string[] {
  const groups = groupSetupProbeFailures(attempts);
  const failed = groups.reduce((count, group) => count + group.attempts.length, 0);
  if (failed === 0) return [];

  const lines = [`✗ All ${failed} endpoints failed — configuration not saved.`];
  for (const group of groups) {
    lines.push(`  ${group.label}:`);
    for (const attempt of group.attempts) {
      lines.push(`    ${attempt.candidate.baseUrl}`);
    }
    if (group.errorType === 'unknown') {
      const representative = group.attempts[0]?.result;
      if (representative && !representative.ok) {
        lines.push(`    ${truncateLLMMessage(stripOrchestratorWrapper(representative.message))}`);
      }
    }
  }

  if (groups.length === 1) {
    const hint = LLM_ERROR_HINTS[groups[0].errorType];
    if (hint !== undefined) lines.push(`  Hint: ${hint}`);
  } else {
    lines.push(`  Hint: ${SETUP_MULTI_ENDPOINT_HINT}`);
  }
  return lines;
}



interface SetupWorkflowProbeDeps {
  fsFactory(baseDir: string): FileSystem;
}

function setupDraftSnapshot(
  deps: SetupWorkflowProbeDeps,
  draft: LLMSetupDraft,
  probeCandidate: boolean,
) {
  return snapshotLLMProviderDraft(deps, draft.provider, {
    ...(probeCandidate ? {
      timeoutMs: Math.min(
        draft.provider.timeout_ms ?? DEFAULT_LLM_TIMEOUT_MS,
        SETUP_PROBE_TIMEOUT_MS,
      ),
    } : {}),
  }).snapshot;
}

/** The single CLI probe adapter used by initialize/primary/fallback workflows. */
export function makeLLMSetupWorkflowProbe(
  deps: SetupWorkflowProbeDeps,
  audit?: AuditLog,
): (draft: LLMSetupDraft, candidate: { kind: 'candidate' | 'direct' }) => Promise<LLMSetupProbeResult> {
  return async (draft, candidate) => {
    let snapshot: ReturnType<typeof setupDraftSnapshot>;
    try {
      snapshot = setupDraftSnapshot(deps, draft, candidate.kind === 'candidate');
    } catch (error) {
      const failure = {
        ok: false as const,
        errorType: classifyLLMErrorForDisplay(error),
        message: formatErr(error),
        provider: draft.provider.provider_id,
      };
      audit?.write(
        CLI_AUDIT_EVENTS.INIT_PROBE_FAILED,
        `error_type=${failure.errorType}`,
        `message=${audit.message(failure.message)}`,
      );
      return failure;
    }
    const result = await probeLLMConnection(snapshot, {
      authentication: createAuthenticationSetup({ fsFactory: deps.fsFactory }),
    });
    if (result.ok) return { ok: true, model: result.model, snapshot };
    const failure = {
      ok: false as const,
      errorType: result.errorType,
      message: result.message,
      provider: result.provider,
    };
    audit?.write(
      CLI_AUDIT_EVENTS.INIT_PROBE_FAILED,
      `error_type=${failure.errorType}`,
      `message=${audit.message(failure.message)}`,
    );
    return failure;
  };
}

export async function recheckLLMSetupIdentity(
  deps: SetupWorkflowProbeDeps,
  draft: LLMSetupDraft,
  verified: LLMSetupVerified,
): Promise<boolean> {
  return setupDraftSnapshot(deps, draft, false).operationalIdentity === verified.snapshot.operationalIdentity;
}

/** Audit projection excludes config, credential refs, raw URLs and failure messages. */
export function emitLLMSetupWorkflowAudit(audit: AuditLog | undefined, event: LLMSetupWorkflowEvent): void {
  if (!audit) return;
  switch (event.type) {
    case 'probe_attempted':
      audit.write(
        CLI_AUDIT_EVENTS.INIT_PROBE_ATTEMPTED,
        `provider=${event.provider}`,
        `model=${event.model}`,
        `candidate=${event.identity}`,
        `kind=${event.kind}`,
        `started_at=${event.startedAt}`,
      );
      return;
    case 'probe_finished':
      // Failure details are emitted separately by the probe adapter through
      // audit.message; this record carries only non-secret result/timing/winner.
      audit.write(
        event.result.ok ? CLI_AUDIT_EVENTS.INIT_PROBE_SUCCEEDED : CLI_AUDIT_EVENTS.INIT_PROBE_FAILED,
        `candidate=${event.identity}`,
        `kind=${event.kind}`,
        ...(event.result.model !== undefined ? [`model=${event.result.model}`] : []),
        ...(event.result.errorType !== undefined ? [`error_type=${event.result.errorType}`] : []),
        `started_at=${event.startedAt}`,
        `completed_at=${event.completedAt}`,
        `winner=${event.winner}`,
      );
      return;
    case 'repair':
      audit.write(CLI_AUDIT_EVENTS.INIT_PROBE_RECONFIGURED, `action=${event.action}`);
      return;
    case 'cancelled':
      audit.write(CLI_AUDIT_EVENTS.INIT_PROBE_SKIPPED, `reason=${audit.message(event.reason)}`);
      return;
    case 'committed':
      audit.write(
        CLI_AUDIT_EVENTS.CONFIG_SAVED,
        'command=setup_workflow',
        `target=${event.target}`,
        `revision=${event.revision}`,
        `identity=${event.identity}`,
      );
      return;
  }
}
