/**
 * Phase 1976：首次 start / init 的单一配置向导。
 *
 * 语义顺序（probe-before-commit）：
 *   交互收集内存 draft → （高风险草稿）脱敏确认 → 多端点候选选择 → 对 draft
 *   做一次身份绑定 probe → 身份复核 → 独占提交 root staging → L4 收敛独立
 *   LLM 文档并清理 root.llm → 发布 ready。
 *
 * 失败留在向导内修复（retry / 改 key / 改 model / 换服务 / 取消）；失败或
 * 取消不发布 root config 与 ready marker。取消退出码由 start 决定（3）。
 * 凭据 owner 在 probe 前可能已写入新条目——本模块记录「本次新建」的 ref，
 * 失败/取消时只删除值仍等于本次写入值的条目（并发/用户改动则保留）。
 */

import * as readline from 'readline';
import type { RootConfigAdmin } from '../assembly/index.js';
import {
  GlobalConfigAlreadyExistsError,
} from '../assembly/index.js';
import {
  isCredentialReference,
  executeLLMSetupAttempt,
  runLLMSetupWorkflow,
  LLMSetupIdentityChangedError,
  type LLMConfigurationAdmin,
  type LLMConfigurationCommitResult,
  type LLMSetupDraft,
  type LLMSetupWorkflowEvent,
  type LLMSetupWorkflowDeps,
} from '../core/llm-configuration/index.js';
import { createAuthenticationSetup } from '../core/llm-configuration/setup.js';
import { INIT_LLM_IDLE_TIMEOUT_MS } from '../foundation/llm-orchestrator/index.js';
import { DEFAULT_MAX_CONCURRENT_TASKS } from '../core/async-task-system/index.js';
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from '../core/heartbeat/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { question as askQuestion } from './utils/prompt.js';
import { CliError } from './errors.js';
import { CLI_AUDIT_EVENTS } from './audit-events.js';
import {
  formatLLMError,
  summarizeLLMFailure,
  type LLMFailureSummary,
  type LLMRepairAction,
  type VerifiedLLMConfig,
} from './llm-connection-check.js';
import {
  findSetupProvider,
  makeExplicitSetupDraft,
  createExplicitSetupDraft,
  type ExplicitSetupDraft,
  type SetupProviderChoice,
} from './setup-provider-catalog.js';
import { FORMAT_MAP } from './provider-format-map.js';
import {
  collectExplicitLLMConfig,
  discardCreatedCredentials,
  recordCreatedCredential,
  repairExplicitLLMConfig,
  storeSetupApiKey,
  type Question,
  type StoredCredential,
} from './llm-config-editor.js';
export { discardCreatedCredentials, recordCreatedCredential } from './llm-config-editor.js';
export type { Question, StoredCredential } from './llm-config-editor.js';
import {
  emitLLMSetupWorkflowAudit,
  formatSetupProbeFailureLines,
  makeLLMSetupWorkflowProbe,
  recheckLLMSetupIdentity,
} from './setup-provider-probe.js';
import {
  SETUP_CANCELLED,
  setupConnectingLine,
  setupRepairMenuLines,
} from '../templates/messages/index.js';
import {
  START_GATE_EXIT_CODE,
  START_USAGE_EXIT_CODE,
  START_LLM_API_KEY_ENV,
  missingStartLLMParams,
  resolveNonInteractiveApiKey,
  type StartLLMOptions,
} from './start-llm-gate.js';

export interface FirstRunDeps {
  fsFactory(baseDir: string): FileSystem;
  rootConfig: Pick<RootConfigAdmin, 'saveGlobalExclusive' | 'completeInitialization'>;
  llmConfiguration: Pick<LLMConfigurationAdmin, 'store'>;
}

export type FirstRunConfigInput = ExplicitSetupDraft;

export type FirstRunSetupOutcome =
  | { kind: 'verified'; verified: VerifiedLLMConfig }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'concurrent' };


/**
 * 初始 global config 模板（Phase 1925 Step E 提取单源）：init / start 首次配置共用，
 * 字段默认值不得两处漂移。
 */
export function buildInitialRootConfig() {
  return {
    version: '1',
    tool_timeout_ms: 60_000,
    motion: {
      heartbeat_interval_ms: HEARTBEAT_DEFAULT_INTERVAL_MS,
      max_concurrent_tasks: DEFAULT_MAX_CONCURRENT_TASKS,
      llm_idle_timeout_ms: INIT_LLM_IDLE_TIMEOUT_MS,
    },
  };
}

function explicitDraft(draft: ExplicitSetupDraft): LLMSetupDraft {
  return makeExplicitSetupDraft(draft);
}

interface FirstRunCommitState {
  /** 调用 L4 即保守保留凭据：写后 snapshot/audit 失败也可能已有绑定文档。 */
  commitAttempted?: boolean;
  llmCommitted?: boolean;
  concurrent?: boolean;
  commit?: LLMConfigurationCommitResult;
}

function firstRunWorkflowDeps(
  deps: FirstRunDeps,
  audit: AuditLog | undefined,
  state: FirstRunCommitState,
  emit?: (event: LLMSetupWorkflowEvent) => void,
): LLMSetupWorkflowDeps {
  return {
    store: {
      commitExplicitProvider: async (target, config, expectedRevision) => {
        if (target.kind === 'initialize') {
          try {
            // Durable root intent contains no LLM provider document.
            deps.rootConfig.saveGlobalExclusive(buildInitialRootConfig());
          } catch (error) {
            // A prior/concurrent root intent is recoverable. The exclusive L4
            // initialize below decides which already-probed draft wins.
            if (!(error instanceof GlobalConfigAlreadyExistsError)) throw error;
          }
        }
        // 宁可保留一个未被采用的凭据，也不能在提交结果不确定时删除已绑定值。
        state.commitAttempted = true;
        const commit = await deps.llmConfiguration.store.commitExplicitProvider(target, config, expectedRevision);
        state.llmCommitted = true;
        state.commit = commit;
        return commit;
      },
    },
    probe: makeLLMSetupWorkflowProbe(deps, audit),
    recheckIdentity: (draft, verified) => recheckLLMSetupIdentity(deps, draft, verified),
    emit: (event) => {
      emitLLMSetupWorkflowAudit(audit, event);
      emit?.(event);
    },
  };
}

function finishFirstRunCommit(
  deps: FirstRunDeps,
  state: FirstRunCommitState,
  audit: AuditLog | undefined,
  outcome: 'committed' | 'concurrent',
): void {
  if (outcome === 'concurrent') state.concurrent = true;
  if (outcome === 'committed' && state.commit?.write.kind !== 'durable') {
    // LLM 文档与凭据均已提交并可供下次 init 恢复；目录项耐久性未确认时
    // 不得发布 ready，把仅文件 fsync 的写入伪装成完整初始化。
    throw new Error(
      'LLM configuration committed but durable initialization was not confirmed; ready marker NOT published',
    );
  }
  deps.rootConfig.completeInitialization();
  if (outcome === 'committed') audit?.write(CLI_AUDIT_EVENTS.INIT_DONE);
  else audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_SKIPPED, 'reason=concurrent_winner');
}

// Phase 1983 Step C：question 统一为 cli/utils/prompt.ts 共享 helper（默认值只显示一次）。
function makeQuestion(rl: readline.Interface): Question {
  return (prompt: string, defaultValue?: string): Promise<string> =>
    askQuestion(rl, prompt, defaultValue);
}

function parseRepairChoice(raw: string): LLMRepairAction | undefined {
  switch (raw.trim().toLowerCase()) {
    case '1': case 'retry': return 'retry';
    case '2': case 'key': return 'edit-key';
    case '3': case 'model': return 'edit-model';
    case '4': case 'provider': return 'edit-provider';
    case 'n': case 'cancel': return 'cancel';
    default: return undefined;
  }
}

export async function promptRepairAction(question: Question): Promise<LLMRepairAction> {
  setupRepairMenuLines().forEach(line => console.log(line));
  for (;;) {
    const raw = await question('\n> ');
    const action = parseRepairChoice(raw);
    if (action) return action;
    console.log('Invalid choice.');
  }
}


/**
 * 交互式首次配置向导：返回 verified（已提交并发布 ready）、cancelled 或
 * concurrent（并发 winner 已提交，调用方应经门控重验 winner 配置）。
 */
export async function runFirstRunSetup(
  deps: FirstRunDeps,
  opts: { audit?: AuditLog } = {},
): Promise<FirstRunSetupOutcome> {
  const { audit } = opts;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = makeQuestion(rl);
  const created: StoredCredential[] = [];
  const commitState: FirstRunCommitState = {};

  try {
    const collected = await collectExplicitLLMConfig(deps, rl, question, created);
    if (collected.kind === 'cancelled') {
      await discardCreatedCredentials(deps, created);
      console.log(SETUP_CANCELLED);
      return { kind: 'cancelled', reason: collected.reason };
    }
    let draft = collected.draft;

    console.log(setupConnectingLine(draft.choice.label, draft.model));
    if (draft.choice.probeCandidates !== undefined && draft.choice.probeCandidates.length > 0) {
      console.log(`\nEndpoint probes (model=${draft.model}):`);
    }
    const outcome = await runLLMSetupWorkflow(
      firstRunWorkflowDeps(deps, audit, commitState, (event) => {
        if (event.type !== 'probe_finished') return;
        if (event.kind === 'candidate' && event.url !== undefined) {
          console.log(`→ ${event.url} ... ${event.result.ok ? '✓' : '✗'}`);
          if (event.winner) console.log(`Selected: ${event.url}`);
        }
      }),
      explicitDraft(draft),
      { kind: 'initialize' },
      async (attempt) => {
        const failure = summarizeLLMFailure(attempt.failure);
        if (attempt.candidates.some(candidate => candidate.kind === 'candidate')) {
          formatSetupProbeFailureLines(attempt.candidates.map(candidate => ({
            candidate: { baseUrl: candidate.url ?? '', label: candidate.identity },
            result: candidate.result.ok
              ? { ok: true as const, model: candidate.result.model }
              : {
                ok: false as const,
                errorType: candidate.result.errorType,
                message: candidate.result.message,
                provider: candidate.result.provider,
              },
          }))).forEach(line => console.log(line));
        } else {
          formatLLMError(failure).forEach(line => console.log(line));
        }
        const action = await promptRepairAction(question);
        if (action === 'cancel') return { kind: 'cancel', reason: 'user_cancelled' };
        if (action === 'retry') return { kind: 'retry' };
        audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_RECONFIGURED, `action=${action}`);
        const repaired = await repairExplicitLLMConfig(action, deps, rl, question, draft, created);
        if (repaired.kind === 'cancelled') return { kind: 'cancel', reason: repaired.reason };
        draft = repaired.draft;
        return { kind: 'repair', draft: explicitDraft(draft) };
      },
    );
    if (outcome.kind === 'cancelled') {
      await discardCreatedCredentials(deps, created);
      console.log(SETUP_CANCELLED);
      return { kind: 'cancelled', reason: outcome.reason };
    }
    if (outcome.kind === 'concurrent') {
      finishFirstRunCommit(deps, commitState, audit, 'concurrent');
      console.log('✓ Already initialized (a concurrent setup completed first; keeping its config)');
      return { kind: 'concurrent' };
    }
    finishFirstRunCommit(deps, commitState, audit, 'committed');
    const winner = outcome.candidates[outcome.candidates.length - 1];
    const latencyMs = winner
      ? Date.parse(winner.completedAt) - Date.parse(winner.startedAt)
      : 0;
    console.log(`✓ ${outcome.verified.model} (${latencyMs}ms)`);
    return {
      kind: 'verified',
      verified: {
        snapshot: outcome.verified.snapshot,
        probe: { model: outcome.verified.model },
        via: 'init',
      },
    };
  } catch (err) {
    // commitAttempted 起结果即不确定；只在尚未调用提交口时清理未绑定凭据。
    if (!commitState.commitAttempted && !commitState.llmCommitted && !commitState.concurrent) {
      await discardCreatedCredentials(deps, created);
    }
    if (err instanceof LLMSetupIdentityChangedError) {
      throw new CliError(err.message, { code: START_GATE_EXIT_CODE, cause: err });
    }
    throw err;
  } finally {
    rl.close();
  }
}

export interface LauncherSetupAttemptInput {
  choice: SetupProviderChoice;
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export type LauncherSetupAttemptOutcome =
  | { kind: 'committed' | 'concurrent' }
  | { kind: 'repair'; failure: LLMFailureSummary; input: FirstRunConfigInput };

function launcherAudit(audit: AuditLog | undefined, rawKey: string | undefined): AuditLog | undefined {
  if (!audit || !rawKey || isCredentialReference(rawKey)) return audit;
  const redact = (text: string) => text.split(rawKey).join('[redacted]');
  return new Proxy(audit, {
    get(target, property) {
      if (property === 'write') {
        return (type: string, ...cols: (string | number)[]) =>
          target.write(type, ...cols.map(col => typeof col === 'string' ? redact(col) : col));
      }
      if (property === 'preview' || property === 'message' || property === 'summary') {
        return (text: string) => {
          const method = target[property] as (value: string) => string;
          return method.call(target, redact(text));
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Launcher adapter 与终端向导共用同一 draft/probe/identity-recheck/commit 路径。 */
export async function runLauncherSetupAttempt(
  deps: FirstRunDeps,
  raw: LauncherSetupAttemptInput,
  created: StoredCredential[],
  audit?: AuditLog,
): Promise<LauncherSetupAttemptOutcome> {
  const commitState: FirstRunCommitState = {};
  audit = launcherAudit(audit, raw.apiKey);
  try {
    const { choice } = raw;
    const model = raw.model.trim();
    if (!model) throw new CliError('Model is required');
    let apiKey = raw.apiKey;
    if (apiKey !== undefined && !isCredentialReference(apiKey)) {
      apiKey = await storeSetupApiKey(deps, apiKey, choice, created, true);
    }
    if (choice.auth === 'api_key' && apiKey === undefined) {
      const envVar = choice.envVar;
      if (envVar && process.env[envVar]) apiKey = '${' + envVar + '}';
    }
    if (apiKey === undefined) throw new CliError('API Key is required');
    if (choice.auth === 'advanced' && !raw.baseUrl) throw new CliError('Base URL is required');
    const draft = createExplicitSetupDraft(choice, {
      ...(apiKey !== undefined && { apiKey }),
      model,
      ...(raw.baseUrl !== undefined && { baseUrl: raw.baseUrl }),
      ...(choice.auth === 'advanced' && { apiFormat: FORMAT_MAP['2'] }),
    });
    const outcome = await executeLLMSetupAttempt(
      firstRunWorkflowDeps(deps, audit, commitState),
      explicitDraft(draft),
      { kind: 'initialize' },
    );
    if (outcome.kind === 'repair') {
      return { kind: 'repair', failure: summarizeLLMFailure(outcome.failure), input: draft };
    }
    finishFirstRunCommit(deps, commitState, audit, outcome.kind);
    return { kind: outcome.kind };
  } catch (err) {
    if (!commitState.commitAttempted && !commitState.llmCommitted && !commitState.concurrent) {
      await discardCreatedCredentials(deps, created, false);
    }
    throw err;
  }
}

/** 取消恢复 session 时仅清理本次新建且值未变化的凭据；session 本身不保存秘密值。 */
export async function discardLauncherCreatedCredentials(
  deps: FirstRunDeps,
  refs: readonly string[],
): Promise<void> {
  const authentication = createAuthenticationSetup(deps);
  const created = refs.flatMap((ref) => {
    const value = authentication.resolveSync(ref)?.accessToken;
    return value === undefined ? [] : [{ ref, value }];
  });
  await discardCreatedCredentials(deps, created, false);
}

/**
 * 非交互首次配置：draft 校验 → probe → 独占提交；失败 exit 3 且不落盘。
 * 并发 loser 返回 concurrent，调用方门控重验 winner 配置。
 */
export async function runNonInteractiveFirstRun(
  deps: FirstRunDeps,
  opts: StartLLMOptions,
  audit?: AuditLog,
): Promise<FirstRunSetupOutcome> {
  const created: StoredCredential[] = [];
  const commitState: FirstRunCommitState = {};
  try {
    const input = await buildNonInteractiveInput(deps, opts, created);
    const draft = makeExplicitSetupDraft(input);
    let failure: LLMFailureSummary | undefined;
    const outcome = await runLLMSetupWorkflow(
      firstRunWorkflowDeps(deps, audit, commitState),
      draft,
      { kind: 'initialize' },
      async (attempt) => {
        failure = summarizeLLMFailure(attempt.failure);
        formatLLMError(failure).forEach(line => console.error(line));
        return { kind: 'cancel', reason: 'non_interactive' };
      },
    );
    if (outcome.kind === 'cancelled') {
      throw new CliError(
        `LLM verification failed (${failure?.errorType ?? 'unknown'}); start aborted (non-interactive)`,
        { code: START_GATE_EXIT_CODE },
      );
    }
    finishFirstRunCommit(deps, commitState, audit, outcome.kind);
    if (outcome.kind === 'concurrent') return { kind: 'concurrent' };
    return {
      kind: 'verified',
      verified: {
        snapshot: outcome.verified.snapshot,
        probe: { model: outcome.verified.model },
        via: 'init',
      },
    };
  } catch (err) {
    if (!commitState.commitAttempted && !commitState.llmCommitted && !commitState.concurrent) {
      await discardCreatedCredentials(deps, created);
    }
    if (err instanceof LLMSetupIdentityChangedError) {
      throw new CliError(err.message, { code: START_GATE_EXIT_CODE, cause: err });
    }
    throw err;
  }
}

async function buildNonInteractiveInput(
  deps: FirstRunDeps,
  opts: StartLLMOptions,
  created: StoredCredential[],
): Promise<FirstRunConfigInput> {
  const missing = missingStartLLMParams(opts);
  if (missing.length > 0) {
    throw new CliError(
      `Missing required non-interactive params: ${missing.join(', ')}`,
      { code: START_USAGE_EXIT_CODE },
    );
  }

  const setup = findSetupProvider(opts.provider!)!;
  let apiKey: string | undefined;
  if (opts.apiKeyEnv || process.env[START_LLM_API_KEY_ENV]) {
    apiKey = await resolveNonInteractiveApiKey(deps, opts, {
      envVar: setup.envVar,
      seed: setup.id,
    }, {
      onStored: (ref, info) => recordCreatedCredential(created, ref, info),
    });
  }

  return createExplicitSetupDraft(setup, {
    ...(apiKey !== undefined && { apiKey }),
    model: opts.model ?? setup.defaultModel ?? '',
    ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
    ...(opts.apiFormat !== undefined && { apiFormat: opts.apiFormat }),
  });
}
