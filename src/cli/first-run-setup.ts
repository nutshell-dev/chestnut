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
import { formatErr } from '../foundation/node-utils/index.js';
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
import { FORMAT_MAP } from './provider-format-map.js';
import { DEFAULT_MAX_CONCURRENT_TASKS } from '../core/async-task-system/index.js';
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from '../core/heartbeat/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { passwordQuestion } from './utils/password-prompt.js';
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
import { storeKeyAsCredential } from './credentials-prompt.js';
import {
  SETUP_PROVIDER_CATALOG,
  describeEffectiveThinking,
  findSetupProvider,
  isCustomSetupChoice,
  makeExplicitSetupDraft,
  resolveExplicitSetupTarget,
  describeExplicitSetupTarget,
  type SetupProviderChoice,
} from './setup-provider-catalog.js';
import {
  emitLLMSetupWorkflowAudit,
  formatSetupProbeFailureLines,
  makeLLMSetupWorkflowProbe,
  recheckLLMSetupIdentity,
} from './setup-provider-probe.js';
import {
  SETUP_WELCOME,
  SETUP_CANCELLED,
  SETUP_OTHER_FORMAT_LINES,
  SETUP_CONFIRM_PROMPT,
  setupApiKeyPrompt,
  setupProviderMenuLines,
  setupDraftPreviewLines,
  setupConnectingLine,
  setupRepairMenuLines,
  setupCredentialDiscardedLine,
  setupCredentialCleanupFailedLine,
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

export interface FirstRunConfigInput {
  presetId?: string;
  providerId?: string;
  apiKey?: string;
  model: string;
  baseUrl?: string;
}

export interface SetupDraft extends FirstRunConfigInput {
  choice: SetupProviderChoice;
  requiresConfirmation: boolean;
}

export type FirstRunSetupOutcome =
  | { kind: 'verified'; verified: VerifiedLLMConfig }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'concurrent' };

export type Question = (prompt: string, defaultValue?: string) => Promise<string>;

export interface StoredCredential {
  ref: string;
  value: string;
}

/**
 * 跟踪本次 setup 新建的凭据条目。同名条目在本次 setup 内被再次写入时复制最新值，
 * 使取消清理只删除「本次写入且仍未被外部改动」的值。
 */
export function recordCreatedCredential(
  created: StoredCredential[],
  ref: string,
  info: { created: boolean; value: string },
): void {
  const existing = created.find(entry => entry.ref === ref);
  if (existing) {
    existing.value = info.value;
    return;
  }
  if (info.created) created.push({ ref, value: info.value });
}

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

function draftToInput(draft: FirstRunConfigInput): FirstRunConfigInput {
  return {
    ...(draft.presetId !== undefined && { presetId: draft.presetId }),
    ...(draft.providerId !== undefined && { providerId: draft.providerId }),
    ...(draft.apiKey !== undefined && { apiKey: draft.apiKey }),
    model: draft.model,
    ...(draft.baseUrl !== undefined && { baseUrl: draft.baseUrl }),
  };
}

function explicitDraft(draft: SetupDraft): LLMSetupDraft {
  const hasCatalogTarget = draft.choice.target.preset !== undefined || draft.choice.target.providerId !== undefined;
  const defaultBaseUrl = hasCatalogTarget
    ? describeExplicitSetupTarget(draft.choice.target).defaultBaseUrl
    : undefined;
  return makeExplicitSetupDraft({
    ...(draft.presetId !== undefined && { presetId: draft.presetId }),
    ...(draft.providerId !== undefined && { providerId: draft.providerId }),
    ...(draft.apiKey !== undefined && { apiKey: draft.apiKey }),
    model: draft.model,
    ...(draft.baseUrl !== undefined && { baseUrl: draft.baseUrl }),
    defaultBaseUrl,
    local: draft.choice.auth === 'local',
  }, draft.choice.probeCandidates);
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

export async function discardCreatedCredentials(
  deps: Pick<FirstRunDeps, 'fsFactory'>,
  created: readonly StoredCredential[],
  emit: boolean = true,
): Promise<void> {
  if (created.length === 0) return;
  const authentication = createAuthenticationSetup({ fsFactory: deps.fsFactory });
  for (const { ref, value } of created) {
    let removed = false;
    try {
      await authentication.modify(ref, async (current) => {
        if (current === value) {
          removed = true;
          return undefined;
        }
        return current;
      });
      if (emit && removed) console.log(setupCredentialDiscardedLine(ref));
    } catch (err) {
      if (emit) console.log(setupCredentialCleanupFailedLine(ref, formatErr(err)));
    }
  }
}

async function storeSetupApiKey(
  deps: FirstRunDeps,
  rawKey: string,
  choice: SetupProviderChoice,
  created: StoredCredential[],
  silent: boolean = false,
): Promise<string> {
  if (!rawKey) throw new CliError('API Key is required');
  if (choice.auth === 'advanced') {
    return storeKeyAsCredential(deps, rawKey, { seed: choice.id, onShadowedEnv: 'error' }, {
      onStored: (ref, info) => recordCreatedCredential(created, ref, info),
      silent,
    });
  }
  const presetId = choice.target.preset ?? choice.id;
  const envVar = choice.envVar;
  const storeCtx = envVar && process.env[envVar]
    ? { seed: presetId, onShadowedEnv: 'error' as const }
    : { envVar, seed: presetId, onShadowedEnv: 'error' as const };
  return storeKeyAsCredential(deps, rawKey, storeCtx, {
    onStored: (ref, info) => recordCreatedCredential(created, ref, info),
    silent,
  });
}

async function promptApiKey(
  deps: FirstRunDeps,
  rl: readline.Interface,
  choice: SetupProviderChoice,
  created: StoredCredential[],
): Promise<string> {
  if (choice.auth === 'advanced') {
    const rawKey = await passwordQuestion(rl, `${setupApiKeyPrompt()}: `);
    return storeSetupApiKey(deps, rawKey, choice, created);
  }

  const envVar = choice.envVar;
  const envReady = Boolean(envVar && process.env[envVar]);
  // Phase 1984 Step B：提示同时说明两种行为——回车=读环境变量，输入=使用输入值。
  const rawKey = await passwordQuestion(rl, `${setupApiKeyPrompt(envReady ? envVar : undefined)}: `);
  if (!rawKey && envReady && envVar) {
    console.log(`✓ Will read from ${envVar} at runtime`);
    return '${' + envVar + '}';
  }
  // env 同名已设置时，typed key 改用派生 ref 保存（不被 env 遮蔽）；派生 ref 仍被
  // 遮蔽则 loud 失败，不静默回退。env 未设置时保持 preset envVar ref。
  return storeSetupApiKey(deps, rawKey, choice, created);
}

async function promptModel(
  choice: SetupProviderChoice,
  question: Question,
): Promise<string> {
  const defaultModel = choice.defaultModel ?? '';
  // Phase 1983 Step C：默认值由共享 question helper 追加，prompt 文本不手写。
  const model = await question('Model', defaultModel || undefined);
  if (!model) throw new CliError('Model is required');
  return model;
}

async function collectSetupDraft(
  deps: FirstRunDeps,
  rl: readline.Interface,
  question: Question,
  created: StoredCredential[],
): Promise<SetupDraft> {
  console.log(SETUP_WELCOME.trimEnd());
  setupProviderMenuLines(SETUP_PROVIDER_CATALOG).forEach(line => console.log(line));

  let selected: SetupProviderChoice | undefined;
  while (!selected) {
    const raw = await question('\n> ');
    const idx = parseInt(raw, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= SETUP_PROVIDER_CATALOG.length) {
      console.log('Invalid choice.');
      continue;
    }
    selected = SETUP_PROVIDER_CATALOG[idx];
  }
  const choice = selected;

  if (choice.auth === 'advanced') {
    SETUP_OTHER_FORMAT_LINES.forEach(line => console.log(line));
    const fmt = await question('\n> ', '2');
    const presetId = FORMAT_MAP[fmt] ?? '';
    if (!presetId) throw new CliError('Invalid API format');
    const baseUrl = await question('Base URL');
    if (!baseUrl) throw new CliError('Base URL is required');
    const apiKey = await promptApiKey(deps, rl, choice, created);
    const model = await question('Model');
    if (!model) throw new CliError('Model is required');
    return { choice, presetId, apiKey, model, baseUrl, requiresConfirmation: true };
  }

  const presetId = choice.target.preset;
  const providerId = choice.target.providerId;
  if (!presetId && !providerId) {
    throw new CliError(`Internal provider mapping missing for ${choice.label}`);
  }

  let apiKey: string | undefined;
  if (choice.auth === 'api_key') {
    apiKey = await promptApiKey(deps, rl, choice, created);
  } else {
    console.log(`ℹ ${choice.label}: local provider, no API key required.`);
  }

  const model = await promptModel(choice, question);
  // Phase 1983 Step B：仅 Other/Advanced 自定义配置需要参数确认；
  // 普通目录服务（含自定义 model）不确认，probe-before-commit 是真实校验门。
  const requiresConfirmation = isCustomSetupChoice(choice);

  return {
    choice,
    ...(presetId !== undefined && { presetId }),
    ...(providerId !== undefined && { providerId }),
    ...(apiKey !== undefined && { apiKey }),
    model,
    requiresConfirmation,
  };
}

function showDraftPreview(draft: SetupDraft): void {
  setupDraftPreviewLines({
    label: draft.choice.label,
    model: draft.model,
    auth: draft.choice.auth === 'local' ? 'local' : 'API key',
    role: 'primary',
    ...(describeEffectiveThinking(draft.presetId, draft.model) !== undefined && {
      thinking: describeEffectiveThinking(draft.presetId, draft.model),
    }),
    ...(draft.baseUrl !== undefined && { baseUrl: draft.baseUrl }),
    ...(draft.apiKey !== undefined && { keyRef: draft.apiKey }),
  }).forEach(line => console.log(line));
}

async function confirmDraft(draft: SetupDraft, question: Question): Promise<boolean> {
  if (!draft.requiresConfirmation) return true;
  showDraftPreview(draft);
  const answer = await question(`\n${SETUP_CONFIRM_PROMPT}`, 'Y');
  return answer.toLowerCase() !== 'n';
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

async function applyRepair(
  action: Exclude<LLMRepairAction, 'retry' | 'cancel'>,
  deps: FirstRunDeps,
  rl: readline.Interface,
  question: Question,
  draft: SetupDraft,
  created: StoredCredential[],
): Promise<SetupDraft> {
  if (action === 'edit-provider') {
    const next = await collectSetupDraft(deps, rl, question, created);
    const confirmed = await confirmDraft(next, question);
    if (!confirmed) throw new SetupCancelledError();
    return next;
  }

  if (action === 'edit-key') {
    if (draft.choice.auth === 'local') {
      console.log(`ℹ ${draft.choice.label}: local provider, no API key required.`);
      return draft;
    }
    const apiKey = await promptApiKey(deps, rl, draft.choice, created);
    return {
      ...draft,
      apiKey,
      ...(draft.choice.probeCandidates !== undefined && { baseUrl: undefined }),
    };
  }

  const model = await promptModel(draft.choice, question);
  return {
    ...draft,
    model,
    ...(draft.choice.probeCandidates !== undefined && { baseUrl: undefined }),
  };
}

class SetupCancelledError extends Error {
  constructor() {
    super('setup cancelled');
    this.name = 'SetupCancelledError';
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
    let draft = await collectSetupDraft(deps, rl, question, created);
    if (!(await confirmDraft(draft, question))) {
      await discardCreatedCredentials(deps, created);
      console.log(SETUP_CANCELLED);
      return { kind: 'cancelled', reason: 'user_cancelled' };
    }

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
            candidate: { presetId: '', baseUrl: candidate.url ?? '', label: candidate.identity },
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
        try {
          draft = await applyRepair(action, deps, rl, question, draft, created);
          return { kind: 'repair', draft: explicitDraft(draft) };
        } catch (err) {
          if (!(err instanceof SetupCancelledError)) throw err;
          return { kind: 'cancel', reason: 'user_cancelled' };
        }
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
    if (choice.auth !== 'local' && apiKey !== undefined && !isCredentialReference(apiKey)) {
      apiKey = await storeSetupApiKey(deps, apiKey, choice, created, true);
    }
    if (choice.auth === 'api_key' && apiKey === undefined) {
      const envVar = choice.envVar;
      if (envVar && process.env[envVar]) apiKey = '${' + envVar + '}';
    }
    if (choice.auth !== 'local' && apiKey === undefined) throw new CliError('API Key is required');
    const presetId = choice.target.preset ?? (choice.auth === 'advanced' ? FORMAT_MAP['2'] : undefined);
    const providerId = choice.target.providerId;
    if (!presetId && !providerId) throw new CliError(`Internal provider mapping missing for ${choice.label}`);
    if (choice.auth === 'advanced' && !raw.baseUrl) throw new CliError('Base URL is required');
    const input: FirstRunConfigInput = {
      ...(presetId !== undefined && { presetId }),
      ...(providerId !== undefined && { providerId }),
      ...(apiKey !== undefined && { apiKey }),
      model,
      ...(raw.baseUrl !== undefined && { baseUrl: raw.baseUrl }),
    };
    const draft: SetupDraft = { ...input, choice, requiresConfirmation: false };
    const outcome = await executeLLMSetupAttempt(
      firstRunWorkflowDeps(deps, audit, commitState),
      explicitDraft(draft),
      { kind: 'initialize' },
    );
    if (outcome.kind === 'repair') {
      return { kind: 'repair', failure: summarizeLLMFailure(outcome.failure), input: draftToInput(draft) };
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
    const draft = makeExplicitSetupDraft({
      ...(input.presetId !== undefined && { presetId: input.presetId }),
      ...(input.providerId !== undefined && { providerId: input.providerId }),
      ...(input.apiKey !== undefined && { apiKey: input.apiKey }),
      model: input.model,
      ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
    });
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
  const setup = opts.provider ? findSetupProvider(opts.provider) : undefined;
  if (setup?.auth === 'advanced') {
    throw new CliError(
      'Setup provider "other" requires the interactive wizard; run "chestnut start" without non-interactive flags.',
      { code: START_USAGE_EXIT_CODE },
    );
  }

  const target = opts.provider ? resolveExplicitSetupTarget(opts.provider) : undefined;
  const presetId = target?.preset;
  const setupProviderId = target?.providerId;
  if (!presetId && !setupProviderId) {
    throw new CliError('--provider is required for first-time non-interactive setup', {
      code: START_USAGE_EXIT_CODE,
    });
  }

  const missing = missingStartLLMParams(opts);
  if (missing.length > 0) {
    throw new CliError(
      `Missing required non-interactive params: ${missing.join(', ')}`,
      { code: START_USAGE_EXIT_CODE },
    );
  }

  let apiKey: string | undefined;
  if (opts.apiKeyEnv || process.env[START_LLM_API_KEY_ENV]) {
    apiKey = await resolveNonInteractiveApiKey(deps, opts, presetId ?? setupProviderId ?? '', {
      onStored: (ref, info) => recordCreatedCredential(created, ref, info),
    });
  }

  return {
    ...(setupProviderId !== undefined ? { providerId: setupProviderId } : { presetId }),
    ...(apiKey !== undefined && { apiKey }),
    model: opts.model ?? 'auto',
    ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
  };
}

