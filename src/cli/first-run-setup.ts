/**
 * Phase 1976：首次 start / init 的单一配置向导。
 *
 * 语义顺序（probe-before-commit）：
 *   交互收集内存 draft → （高风险草稿）脱敏确认 → 多端点候选选择 → 对 draft
 *   做一次身份绑定 probe → 身份复核 → 独占提交 root config → 发布 ready。
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
  snapshotLLMConfigInput,
  createUserPiAiCredentialStore,
  type LLMConfigSnapshot,
} from '../assembly/index.js';
import {
  FORMAT_MAP,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_RETRY_ATTEMPTS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_RESET_TIMEOUT_MS,
  INIT_LLM_IDLE_TIMEOUT_MS,
} from '../foundation/llm-orchestrator/index.js';
import { PRESETS, isCatalogProvider } from '../foundation/llm-provider/index.js';
import { DEFAULT_MAX_CONCURRENT_TASKS } from '../core/async-task-system/index.js';
import { HEARTBEAT_DEFAULT_INTERVAL_MS } from '../core/heartbeat/index.js';
import { createLocalCredentials } from '../foundation/credentials/index.js';
import type { AuditLog } from '../foundation/audit/index.js';
import type { FileSystem } from '../foundation/fs/index.js';
import { passwordQuestion } from './utils/password-prompt.js';
import { CliError } from './errors.js';
import { CLI_AUDIT_EVENTS } from './audit-events.js';
import {
  probeLLMConnection,
  formatLLMError,
  summarizeLLMFailure,
  type LLMFailureSummary,
  type LLMRepairAction,
  type VerifiedLLMConfig,
} from './llm-connection-check.js';
import {
  storeKeyAsCredential,
  resolveCredentialReference,
  isCredentialReference,
} from './credentials-prompt.js';
import {
  SETUP_PROVIDER_CATALOG,
  findSetupProvider,
  type SetupProviderChoice,
  type SetupProbeCandidate,
} from './setup-provider-catalog.js';
import { makeSetupCandidateProbe, probeSetupCandidates } from './setup-provider-probe.js';
import {
  SETUP_WELCOME,
  SETUP_CANCELLED,
  SETUP_OTHER_FORMAT_LINES,
  SETUP_CONFIRM_PROMPT,
  SETUP_ENDPOINTS_ALL_FAILED,
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

type Question = (prompt: string, defaultValue?: string) => Promise<string>;

interface StoredCredential {
  ref: string;
  value: string;
}

interface DraftProbeFailure {
  errorType: LLMFailureSummary['errorType'];
  message: string;
  provider: string;
}

/**
 * 跟踪本次 setup 新建的凭据条目。同名条目在本次 setup 内被再次写入时复制最新值，
 * 使取消清理只删除「本次写入且仍未被外部改动」的值。
 */
function recordCreatedCredential(
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

type DraftProbeOutcome =
  | { ok: true; verified: VerifiedLLMConfig; latencyMs: number }
  | { ok: false; failure: DraftProbeFailure };

/**
 * 初始 global config 模板（Phase 1925 Step E 提取单源）：init / start 首次配置共用，
 * 字段默认值不得两处漂移。
 */
export function buildInitialConfig(input: FirstRunConfigInput) {
  const primary = {
    ...(input.providerId ? { provider_id: input.providerId } : { preset: input.presetId }),
    ...(input.apiKey && { api_key: input.apiKey }),
    model: input.model,
    temperature: 0.7,
    timeout_ms: DEFAULT_LLM_TIMEOUT_MS,
    ...(input.baseUrl && { base_url: input.baseUrl }),
  };
  return {
    version: '1',
    llm: {
      primary,
      retry_attempts: DEFAULT_LLM_RETRY_ATTEMPTS,
      retry_delay_ms: DEFAULT_RETRY_DELAY_MS,
      circuit_breaker: {
        failure_threshold: 3,
        reset_timeout_ms: DEFAULT_RESET_TIMEOUT_MS,
      },
    },
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

function resolveDraftApiKey(deps: FirstRunDeps, raw: string): string {
  if (!isCredentialReference(raw)) return raw;
  const resolved = resolveCredentialReference(deps, raw);
  if (resolved === undefined) {
    throw new CliError(
      `API key reference ${raw} is not set (not in process env, credentials file, or .env fallbacks)`,
      { code: START_GATE_EXIT_CODE },
    );
  }
  return resolved;
}

/**
 * probe 只消费「解析后 key 的同一份 resolved config」：与磁盘 loadGlobal 的
 * env/credentials 展开同源，因此身份可跨 probe/提交/门控比较。
 */
function snapshotForProbe(deps: FirstRunDeps, input: FirstRunConfigInput): LLMConfigSnapshot {
  const apiKey = input.apiKey !== undefined ? resolveDraftApiKey(deps, input.apiKey) : undefined;
  const probeInput: FirstRunConfigInput = {
    ...input,
    ...(apiKey !== undefined && { apiKey }),
  };
  return snapshotLLMConfigInput(buildInitialConfig(probeInput));
}

async function probeDraft(
  deps: FirstRunDeps,
  input: FirstRunConfigInput,
  audit: AuditLog | undefined,
): Promise<DraftProbeOutcome> {
  let snapshot: LLMConfigSnapshot;
  try {
    snapshot = snapshotForProbe(deps, input);
  } catch (err) {
    const message = formatErr(err);
    audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_FAILED, 'error_type=auth', `message=${audit.message(message)}`);
    return {
      ok: false,
      failure: { errorType: 'auth', message, provider: input.presetId ?? input.providerId ?? 'unknown' },
    };
  }

  audit?.write(
    CLI_AUDIT_EVENTS.INIT_PROBE_ATTEMPTED,
    `preset=${input.presetId ?? input.providerId ?? ''}`,
    `model=${input.model}`,
  );
  const t0 = Date.now();
  const probe = await probeLLMConnection(snapshot, {
    credentials: createUserPiAiCredentialStore({ fsFactory: deps.fsFactory }),
  });
  const latencyMs = Date.now() - t0;

  if (probe.ok) {
    audit?.write(
      CLI_AUDIT_EVENTS.INIT_PROBE_SUCCEEDED,
      `preset=${input.presetId ?? input.providerId ?? ''}`,
      `model=${probe.model}`,
      `latency_ms=${latencyMs}`,
    );
    return {
      ok: true,
      verified: { snapshot, probe: { model: probe.model }, via: 'init' },
      latencyMs,
    };
  }

  audit?.write(
    CLI_AUDIT_EVENTS.INIT_PROBE_FAILED,
    `preset=${input.presetId ?? input.providerId ?? ''}`,
    `error_type=${probe.errorType}`,
    `message=${audit.message(probe.message)}`,
  );
  return {
    ok: false,
    failure: { errorType: probe.errorType, message: probe.message, provider: probe.provider },
  };
}

/**
 * probe 成功后、提交前重新解析 draft 身份：probe 期间凭据/环境若变化，
 * 已验证身份不再代表将要写入的配置 → fail-closed（不发布未验证配置）。
 */
interface FirstRunCommitState {
  /** root config 已独占提交：此后异常不得清理已绑定凭据。 */
  rootConfigWritten?: boolean;
}

async function commitFirstRun(
  deps: FirstRunDeps,
  input: FirstRunConfigInput,
  verified: VerifiedLLMConfig,
  audit: AuditLog | undefined,
  state: FirstRunCommitState,
): Promise<'committed' | 'concurrent'> {
  const current = snapshotForProbe(deps, input);
  if (current.identity !== verified.snapshot.identity) {
    throw new CliError(
      'Configuration changed during verification; refusing to commit unverified config (fail-closed)',
      { code: START_GATE_EXIT_CODE },
    );
  }

  try {
    deps.rootConfig.saveGlobalExclusive(buildInitialConfig(input));
    state.rootConfigWritten = true;
  } catch (err) {
    if (err instanceof GlobalConfigAlreadyExistsError) {
      // 并发 winner 已提交：本进程的 draft 证明不了 winner 配置，放弃验证事实。
      deps.rootConfig.completeInitialization();
      audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_SKIPPED, 'reason=concurrent_winner');
      return 'concurrent';
    }
    throw err;
  }

  deps.rootConfig.completeInitialization();
  audit?.write(CLI_AUDIT_EVENTS.INIT_DONE);
  return 'committed';
}

function makeQuestion(rl: readline.Interface): Question {
  return (prompt: string, defaultValue?: string): Promise<string> =>
    new Promise((resolve) => {
      const fullPrompt = defaultValue !== undefined
        ? `${prompt} (default: ${defaultValue}): `
        : `${prompt}: `;
      rl.question(fullPrompt, (answer) => {
        resolve(answer.trim() || defaultValue || '');
      });
    });
}

async function discardCreatedCredentials(
  deps: FirstRunDeps,
  created: readonly StoredCredential[],
): Promise<void> {
  if (created.length === 0) return;
  const credentials = createLocalCredentials({ fsFactory: deps.fsFactory });
  for (const { ref, value } of created) {
    let removed = false;
    try {
      await credentials.modify(ref, async (current) => {
        if (current === value) {
          removed = true;
          return undefined;
        }
        return current;
      });
      if (removed) console.log(setupCredentialDiscardedLine(ref));
    } catch (err) {
      console.log(setupCredentialCleanupFailedLine(ref, formatErr(err)));
    }
  }
}

async function promptApiKey(
  deps: FirstRunDeps,
  rl: readline.Interface,
  choice: SetupProviderChoice,
  created: StoredCredential[],
): Promise<string> {
  if (choice.auth === 'advanced') {
    const rawKey = await passwordQuestion(rl, 'API Key: ');
    if (!rawKey) throw new CliError('API Key is required');
    return storeKeyAsCredential(deps, rawKey, { seed: choice.id }, {
      onStored: (ref, info) => recordCreatedCredential(created, ref, info),
    });
  }

  const presetId = choice.target.preset ?? '';
  const preset = PRESETS[presetId];
  const envReady = Boolean(preset?.envVar && process.env[preset.envVar]);
  const hint = envReady ? ` (press Enter to use ${preset.envVar})` : '';
  const rawKey = await passwordQuestion(rl, `API Key${hint}: `);
  if (!rawKey && envReady && preset?.envVar) {
    console.log(`✓ Will read from ${preset.envVar} at runtime`);
    return '${' + preset.envVar + '}';
  }
  if (!rawKey) throw new CliError('API Key is required');
  return storeKeyAsCredential(deps, rawKey, { envVar: preset?.envVar, seed: presetId }, {
    onStored: (ref, info) => recordCreatedCredential(created, ref, info),
  });
}

async function promptModel(
  choice: SetupProviderChoice,
  question: Question,
): Promise<string> {
  const preset = choice.target.preset ? PRESETS[choice.target.preset] : undefined;
  const defaultModel = choice.defaultModel ?? preset?.defaultModel ?? '';
  const model = await question(
    `Model${defaultModel ? ` (default: ${defaultModel})` : ''}`,
    defaultModel || undefined,
  );
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
  const preset = presetId ? PRESETS[presetId] : undefined;
  if (!presetId && !providerId) {
    throw new CliError(`Internal provider mapping missing for ${choice.label}`);
  }

  let apiKey: string | undefined;
  if (choice.auth === 'api_key') {
    apiKey = await promptApiKey(deps, rl, choice, created);
  } else {
    console.log(`ℹ ${choice.label}: local provider, no API key required.`);
  }

  const defaultModel = choice.defaultModel ?? preset?.defaultModel ?? '';
  const model = await promptModel(choice, question);
  const requiresConfirmation = defaultModel === '' || model !== defaultModel;

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

async function selectSetupEndpoint(
  deps: FirstRunDeps,
  draft: SetupDraft,
  audit: AuditLog | undefined,
): Promise<{ ok: true } | { ok: false; failure: DraftProbeFailure }> {
  const candidates = draft.choice.probeCandidates ?? [];
  if (candidates.length === 0) return { ok: true };

  console.log(`\nEndpoint probes (model=${draft.model}):`);
  const candidateProbe = makeSetupCandidateProbe(
    { label: draft.choice.label, ...(draft.apiKey !== undefined && { apiKey: draft.apiKey }), model: draft.model },
    {
      resolveKey: (ref) => resolveCredentialReference(deps, ref),
      credentials: createUserPiAiCredentialStore({ fsFactory: deps.fsFactory }),
    },
  );

  let outcome;
  try {
    outcome = await probeSetupCandidates(candidates, async (candidate: SetupProbeCandidate) => {
      const result = await candidateProbe(candidate);
      console.log(`→ ${candidate.label} ... ${result.ok ? '✓' : `✗ ${result.errorType}`}`);
      return result;
    });
  } catch (err) {
    const failure: DraftProbeFailure = {
      errorType: 'auth',
      message: formatErr(err),
      provider: draft.choice.label,
    };
    audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_FAILED, 'error_type=auth', `message=${audit.message(failure.message)}`);
    return { ok: false, failure };
  }

  if (!outcome.winner) {
    console.log(SETUP_ENDPOINTS_ALL_FAILED);
    const firstFailure = outcome.attempts.find(attempt => !attempt.result.ok)?.result;
    const failure: DraftProbeFailure = firstFailure && !firstFailure.ok
      ? { errorType: firstFailure.errorType, message: firstFailure.message, provider: firstFailure.provider }
      : { errorType: 'unknown', message: 'All endpoint candidates failed', provider: draft.choice.label };
    audit?.write(
      CLI_AUDIT_EVENTS.INIT_PROBE_FAILED,
      `error_type=${failure.errorType}`,
      `message=${audit.message(failure.message)}`,
    );
    return { ok: false, failure };
  }

  draft.baseUrl = outcome.winner.baseUrl;
  console.log(`Selected: ${outcome.winner.label} — ${outcome.winner.baseUrl}`);
  return { ok: true };
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

async function promptRepairAction(question: Question): Promise<LLMRepairAction> {
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

    for (;;) {
      let failure: LLMFailureSummary | undefined;

      if (draft.choice.probeCandidates !== undefined && draft.baseUrl === undefined) {
        const selection = await selectSetupEndpoint(deps, draft, audit);
        if (!selection.ok) {
          failure = summarizeLLMFailure(selection.failure);
          formatLLMError(failure).forEach(line => console.log(line));
        }
      }

      if (failure === undefined) {
        console.log(setupConnectingLine(draft.choice.label, draft.model));
        const result = await probeDraft(deps, draftToInput(draft), audit);
        if (result.ok) {
          const commit = await commitFirstRun(deps, draftToInput(draft), result.verified, audit, commitState);
          if (commit === 'concurrent') {
            console.log('✓ Already initialized (a concurrent setup completed first; keeping its config)');
            return { kind: 'concurrent' };
          }
          console.log(`✓ ${result.verified.probe.model} (${result.latencyMs}ms)`);
          return { kind: 'verified', verified: result.verified };
        }
        failure = summarizeLLMFailure(result.failure);
        formatLLMError(failure).forEach(line => console.log(line));
      }

      const action = await promptRepairAction(question);
      if (action === 'cancel') {
        audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_SKIPPED, 'reason=user_cancel');
        await discardCreatedCredentials(deps, created);
        console.log(SETUP_CANCELLED);
        return { kind: 'cancelled', reason: 'user_cancelled' };
      }
      if (action === 'retry') continue;

      audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_RECONFIGURED, `action=${action}`);
      try {
        draft = await applyRepair(action, deps, rl, question, draft, created);
      } catch (err) {
        if (!(err instanceof SetupCancelledError)) throw err;
        await discardCreatedCredentials(deps, created);
        console.log(SETUP_CANCELLED);
        return { kind: 'cancelled', reason: 'user_cancelled' };
      }
    }
  } catch (err) {
    // 异常中止：仅在 root config 尚未提交时清理本次新建凭据（已提交则引用已绑定）。
    if (!commitState.rootConfigWritten) await discardCreatedCredentials(deps, created);
    throw err;
  } finally {
    rl.close();
  }
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
    const result = await probeDraft(deps, input, audit);
    if (!result.ok) {
      formatLLMError(summarizeLLMFailure(result.failure)).forEach(line => console.error(line));
      audit?.write(CLI_AUDIT_EVENTS.INIT_PROBE_SKIPPED, 'reason=non_interactive');
      throw new CliError(
        `LLM verification failed (${result.failure.errorType}); start aborted (non-interactive)`,
        { code: START_GATE_EXIT_CODE },
      );
    }

    const commit = await commitFirstRun(deps, input, result.verified, audit, commitState);
    if (commit === 'concurrent') return { kind: 'concurrent' };
    return { kind: 'verified', verified: result.verified };
  } catch (err) {
    if (!commitState.rootConfigWritten) await discardCreatedCredentials(deps, created);
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

  const presetId = setup?.target.preset ?? opts.provider;
  const setupProviderId = setup?.target.providerId;
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

  const catalogProviderId = setupProviderId
    ?? (presetId && !PRESETS[presetId] && isCatalogProvider(presetId) ? presetId : undefined);

  let apiKey: string | undefined;
  if (opts.apiKeyEnv || process.env[START_LLM_API_KEY_ENV]) {
    apiKey = await resolveNonInteractiveApiKey(deps, opts, presetId ?? '', {
      onStored: (ref, info) => recordCreatedCredential(created, ref, info),
    });
  }

  return {
    ...(catalogProviderId !== undefined ? { providerId: catalogProviderId } : { presetId }),
    ...(apiKey !== undefined && { apiKey }),
    model: opts.model ?? 'auto',
    ...(opts.baseUrl !== undefined && { baseUrl: opts.baseUrl }),
  };
}

