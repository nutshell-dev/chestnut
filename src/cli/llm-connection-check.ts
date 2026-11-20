/**
 * LLM connection check + interactive reconfigure helpers.
 *
 * Shared by `init` (post-config verification) and `start` (every-run health check).
 * Extracted from start.ts in phase 1470.
 */

import * as readline from 'readline';
import { formatErr, newUuid } from "../foundation/node-utils/index.js";

import type { LLMConfigurationAdmin } from '../core/llm-configuration/index.js';
import {
  createAuthenticationCapability,
  ApiKeyConfigError,
  snapshotLLMConfig,
  type LLMConfigSnapshot,
} from '../core/llm-configuration/index.js';
import {
  createAuthenticationSetup,
  type AuthenticationSetupCapability,
} from '../core/llm-configuration/setup.js';
import { llmProviderCall, llmProviderCredentialRuntime } from '../foundation/llm-provider/index.js';
type ProviderInput = llmProviderCall.ProviderInput;
type ProviderFactory = llmProviderCall.ProviderFactory;

import {
  LLM_PROBE_MAX_TOKENS,
  classifyLLMError,
  getUserActionHint,
} from '../foundation/llm-orchestrator/index.js';
import { createLLMOrchestrator } from '../foundation/llm-orchestrator/index.js';
import { toOrchestratorConfig } from '../assembly/index.js';
import { passwordQuestion } from './utils/password-prompt.js';
import { question as askQuestion } from './utils/prompt.js';
import {
  collectExplicitLLMConfig,
  discardCreatedCredentials,
  type ExplicitLLMConfigResult,
  type StoredCredential,
} from './llm-config-editor.js';
import {
  makeExplicitSetupProvider,
  SETUP_PROVIDER_CATALOG,
} from './setup-provider-catalog.js';

import type { AtomicWriteResult, FileSystem } from '../foundation/fs/index.js';
// Phase 1925 Step B：reconfigure 的明文 key 经 Credentials owner 落凭据文件、配置写 `${REF}`。
import { storeKeyAsCredential } from './credentials-prompt.js';

export type LLMErrorType = 'auth' | 'model' | 'network' | 'rate_limit' | 'quota' | 'unknown';

/**
 * Phase 1926 Step C：已通过 probe 的配置事实（init ↔ start 门控交接契约）。
 * 取代 Phase 1925 的无主 boolean `probeVerified`——复用条件只有一条：
 * `verified.snapshot.identity` 与消费时当前快照身份相等。
 */
export interface VerifiedLLMConfig {
  snapshot: LLMConfigSnapshot;
  probe: { model: string };
  via: 'init' | 'start';
}

function reportDegradedConfigWrite(write: AtomicWriteResult): void {
  if (write.kind === 'durable') return;
  const errorSummary = formatErr(write.error).replace(/\s+/g, ' ').trim().slice(0, 240);
  console.error(`⚠ LLM primary config committed with degraded durability (kind=${write.kind}): ${errorSummary}`);
}

interface LLMConfigDeps {
  fsFactory: (baseDir: string) => FileSystem;
  llmConfiguration: Pick<LLMConfigurationAdmin, 'loadGlobal' | 'patchPrimary'> &
    Partial<Pick<LLMConfigurationAdmin, 'migrateLegacyApiKeys'>>;
}

export function classifyLLMErrorForDisplay(err: unknown): LLMErrorType {
  switch (getUserActionHint(err)) {
    case 'rotate_api_key': return 'auth';
    case 'switch_primary': return 'model';
    case 'wait_retry_after': return 'rate_limit';
    case 'check_quota': return 'quota';
    case 'check_endpoint':
    case 'check_network': return 'network';
    case null:
      return classifyLLMError(err) === 'transient' ? 'network' : 'unknown';
  }
}

export const LLM_ERROR_LABELS: Record<LLMErrorType, string> = {
  auth: 'API key invalid or unauthorized',
  model: 'Model not found or unavailable',
  network: 'Network error — could not reach provider',
  rate_limit: 'Rate limit exceeded',
  quota: 'Account quota or credit exhausted',
  unknown: 'Unrecognized provider error',
};

export const LLM_ERROR_HINTS: Partial<Record<LLMErrorType, string>> = {
  // Phase 1926 Step D：auth 类含 ambient 缺失（AWS 链/ADC/env）与 OAuth 未登录/refresh 失败
  auth: 'Update API key via "chestnut config provider add", run "chestnut config provider login <label>" for OAuth providers, or fix ambient credentials (AWS profile / Google ADC / provider env).',
  model: 'Check that model name matches provider docs exactly.',
  network: 'Check internet connection or provider status page.',
  rate_limit: 'Wait a few seconds and retry; lower request frequency.',
  quota: 'Top up account credit or switch provider via "chestnut config".',
  unknown: 'See raw provider message above; report bug if persistent.',
};

import { stripOrchestratorWrapper, truncateLLMMessage } from './utils/text.js';

/**
 * Phase 1976：首次 setup 失败后的修复动作。菜单呈现归 setup 向导；
 * 本模块只提供稳定的动作集合与失败摘要，不再持有 start 的首屏菜单。
 */
import { LLM_REPAIR_ACTIONS, type LLMRepairAction } from './llm-repair-action.js';
export { LLM_REPAIR_ACTIONS };
export type { LLMRepairAction };

export interface LLMFailureSummary {
  errorType: LLMErrorType;
  message: string;
  provider?: string;
  hint?: string;
  repairActions: readonly LLMRepairAction[];
}

export function summarizeLLMFailure(
  probe: { errorType: LLMErrorType; message: string; provider?: string },
): LLMFailureSummary {
  const hint = LLM_ERROR_HINTS[probe.errorType];
  return {
    errorType: probe.errorType,
    message: probe.message,
    ...(probe.provider !== undefined && { provider: probe.provider }),
    ...(hint !== undefined && { hint }),
    repairActions: LLM_REPAIR_ACTIONS,
  };
}

/**
 * Format a failed LLM probe result as console output lines (callers do console.log(...lines)).
 * Single source of truth for LLM error display across init / config / reconfigure.
 */
export function formatLLMError(
  probe: { errorType: LLMErrorType; message: string; provider?: string; hint?: string },
): string[] {
  const lines: string[] = [];
  lines.push(`✗ ${LLM_ERROR_LABELS[probe.errorType]}`);
  if (probe.provider) {
    lines.push(`  Provider: ${probe.provider}`);
  }
  // phase 464 (review N3-L): 按 codepoint 截断，避免 UTF-16 surrogate pair 被切断；
  // Phase 1983 follow-up：用户可见输出剥离 orchestrator 聚合包装。
  lines.push(`  ${truncateLLMMessage(stripOrchestratorWrapper(probe.message))}`);
  if (probe.hint) {
    lines.push(`  Hint: ${probe.hint}`);
  }
  return lines;
}

export interface LLMProbeOptions {
  /** 显式 setup 组合；raw store 只在 provider factory 闭包内创建。 */
  authentication?: AuthenticationSetupCapability;
  /** start 整轮重验可传入固定组合生命周期；仍是中性公共面。 */
  providerFactory?: ProviderFactory;
}

export function createProbeProviderFactory(
  authentication?: AuthenticationSetupCapability,
): ProviderFactory {
  const credentialStore = authentication === undefined
    ? undefined
    : llmProviderCredentialRuntime.createStore(authentication);
  return {
    create: input => llmProviderCall.createProviderFromInput(input, {
      ...(credentialStore !== undefined ? { credentialStore } : {}),
    }),
  };
}

function probeProviderFactory(options?: LLMProbeOptions): ProviderFactory {
  return options?.providerFactory ?? createProbeProviderFactory(options?.authentication);
}

/**
 * Phase 1926 Step C：对**给定快照**做真实 probe——probe 内不得再隐式读取另一份
 * 配置；返回结果携带被测 identity，调用方据此丢弃漂移结果。
 */
export async function probeLLMConnection(
  snapshot: LLMConfigSnapshot,
  options?: LLMProbeOptions,
): Promise<
  { ok: true; model: string; identity: string } | { ok: false; errorType: LLMErrorType; message: string; provider: string; identity: string }
> {
  const svc = createLLMOrchestrator(toOrchestratorConfig({
    ...snapshot.config,
    retry: { maxAttempts: 1, delayMs: 0 },
  }, {
    events: { emit: () => {} },
    providerFactory: probeProviderFactory(options),
    lifecycle: { mode: 'ephemeral' },
  }));
  let callFailure: { error: unknown } | undefined;
  try {
    await svc.call({
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: LLM_PROBE_MAX_TOKENS,
    });
    return { ok: true, model: snapshot.config.primary.model, identity: snapshot.identity };
  } catch (err) {
    callFailure = { error: err };
    return { ok: false, errorType: classifyLLMErrorForDisplay(err), message: formatErr(err), provider: llmProviderCall.describeProviderInput(snapshot.config.primary).providerId, identity: snapshot.identity };
  } finally {
    try {
      await svc.close();
    } catch (closeErr) {
      if (callFailure) {
        throw new AggregateError(
          [callFailure.error, closeErr],
          'LLM connection probe and orchestrator close failed',
          { cause: callFailure.error },
        );
      }
      throw closeErr;
    }
  }
}

/**
 * Test LLM connectivity with a minimal call.
 * Returns { ok: true, model } on success, { ok: false, errorType, message } on failure.
 * Phase 1926 Step C：读取即快照后委托 probeLLMConnection（读取与 probe 同一份
 * resolved object）；需要身份协议的调用方（init/start 门控）应自行 snapshot 后
 * 直接调 probeLLMConnection。
 */
export async function checkLLMConnection(deps: LLMConfigDeps): Promise<
  { ok: true; model: string; identity: string } | { ok: false; errorType: LLMErrorType; message: string; provider: string; identity: string }
> {
  const authentication = createAuthenticationSetup({ fsFactory: deps.fsFactory });
  const snapshot = snapshotLLMConfig(deps.llmConfiguration.loadGlobal(), undefined, {
    credentials: createAuthenticationCapability({ fsFactory: deps.fsFactory }),
  });
  return probeLLMConnection(snapshot, { authentication });
}

/**
 * Probe an explicit provider config (not the active global primary).
 * Used by `config provider add/set-primary` to verify a candidate before commit.
 */
export async function checkLLMConnectionFor(
  provider: ProviderInput,
  options?: LLMProbeOptions,
): Promise<
  { ok: true; model: string } | { ok: false; errorType: LLMErrorType; message: string; provider: string }
> {
  const svc = createLLMOrchestrator(toOrchestratorConfig({
    primary: provider,
    fallbacks: [],
    retry: { maxAttempts: 1, delayMs: 0 },
  }, {
    events: { emit: () => {} },
    providerFactory: probeProviderFactory(options),
    lifecycle: { mode: 'ephemeral' },
  }));
  let callFailure: { error: unknown } | undefined;
  try {
    await svc.call({
      messages: [{ role: 'user', content: 'Hi' }],
      maxTokens: LLM_PROBE_MAX_TOKENS,
    });
    return { ok: true, model: provider.model };
  } catch (err) {
    callFailure = { error: err };
    return { ok: false, errorType: classifyLLMErrorForDisplay(err), message: formatErr(err), provider: llmProviderCall.describeProviderInput(provider).providerId };
  } finally {
    try {
      await svc.close();
    } catch (closeErr) {
      if (callFailure) {
        throw new AggregateError(
          [callFailure.error, closeErr],
          'LLM connection probe and orchestrator close failed',
          { cause: callFailure.error },
        );
      }
      throw closeErr;
    }
  }
}

/**
 * Interactive reconfigure prompt shown when LLM connection fails.
 * Phase 1926 Step C：成功时返回**已 probe 的配置快照**（身份证据；probe 与快照
 * 同一 resolved object），用户退出返回 null。调用方复用前必须比对当前身份。
 *
 * Menu: 1=API key, 2=model, 3=provider, n=exit
 * After any change, re-tests the connection automatically.
 */
export async function promptReconfigure(
  deps: LLMConfigDeps,
  rl: readline.Interface,
  _errorType: LLMErrorType,
): Promise<LLMConfigSnapshot | null> {
  try {
    deps.llmConfiguration.loadGlobal();
  } catch (error) {
    if (error instanceof ApiKeyConfigError && error.code === 'legacy_plaintext_unmigrated') {
      await deps.llmConfiguration.migrateLegacyApiKeys?.();
    } else {
      throw error;
    }
  }
  const question = (prompt: string, defaultValue?: string): Promise<string> =>
    askQuestion(rl, prompt, defaultValue);

  const passwordPrompt = (prompt: string) => passwordQuestion(rl, `${prompt}: `);

  while (true) {
    console.log('\nReconfigure LLM:');
    console.log('1. Update API key');
    console.log('2. Change model');
    console.log('3. Change provider');
    console.log('n. Exit');
    const choice = await question('\n> ');

    if (choice === 'n' || choice === 'N') return null;

    if (choice === '1') {
      const raw = await passwordPrompt('New API key');
      if (raw === 'b') continue;
      if (!raw) { console.log('API key is required.'); continue; }
      // API key ref 只从当前显式 provider identity 对应的 setup descriptor 派生。
      // 未知/custom identity 不猜环境变量，仍使用 credential seed 生成独立引用。
      const currentPrimary = deps.llmConfiguration.loadGlobal().llm.primary;
      const currentSetup = SETUP_PROVIDER_CATALOG.find(choice =>
        choice.providerId === currentPrimary.provider_id);
      const envVar = currentSetup?.envVar;
      const envReady = Boolean(envVar && process.env[envVar]);
      const seed = currentPrimary.label ?? currentPrimary.provider_id;
      const stored = await storeKeyAsCredential(deps, raw, envReady
        ? { seed, onShadowedEnv: 'error' as const }
        : { envVar, seed, onShadowedEnv: 'error' as const });
      reportDegradedConfigWrite(await deps.llmConfiguration.patchPrimary({ api_key: stored }));

    } else if (choice === '2') {
      const raw = await question('New model (b = back)');
      if (raw === 'b') continue;
      if (!raw) { console.log('Model is required.'); continue; }
      reportDegradedConfigWrite(await deps.llmConfiguration.patchPrimary({ model: raw }));

    } else if (choice === '3') {
      const created: StoredCredential[] = [];
      let collected: ExplicitLLMConfigResult;
      try {
        collected = await collectExplicitLLMConfig(deps, rl, question, created, {
          // Cancellation must never overwrite a credential used by another entry.
          credentialSeed: `reconfigure-${newUuid()}`,
        });
      } catch (error) {
        await discardCreatedCredentials(deps, created);
        throw error;
      }
      if (collected.kind === 'cancelled') {
        await discardCreatedCredentials(deps, created);
        return null;
      }
      // Replacing primary must not move the old primary to fallback; clear only the
      // legacy field while committing the shared editor's explicit provider facts.
      reportDegradedConfigWrite(await deps.llmConfiguration.patchPrimary({
        ...makeExplicitSetupProvider(collected.draft),
        preset: undefined,
      }));

    } else {
      console.log('Invalid choice.');
      continue;
    }

    console.log('Testing connection...');
    const snapshot = snapshotLLMConfig(deps.llmConfiguration.loadGlobal(), undefined, {
      credentials: createAuthenticationCapability({ fsFactory: deps.fsFactory }),
    });
    const authentication = createAuthenticationSetup({ fsFactory: deps.fsFactory });
    const result = await probeLLMConnection(snapshot, { authentication });
    if (result.ok) {
      console.log('✓ Connection successful!');
      return snapshot;
    }
    formatLLMError({
      errorType: result.errorType,
      message: result.message,
      provider: undefined,
      hint: LLM_ERROR_HINTS[result.errorType],
    }).forEach(line => console.log(line));
  }
}
