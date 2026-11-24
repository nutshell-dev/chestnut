/** Leaf LLM probe, failure classification and display primitives. */
import { formatErr } from '../foundation/node-utils/index.js';
import type { LLMConfigSnapshot } from '../core/llm-configuration/index.js';
import type { AuthenticationSetupCapability } from '../core/llm-configuration/setup.js';
import { llmProviderCall, llmProviderCredentialRuntime } from '../foundation/llm-provider/index.js';
import {
  LLM_PROBE_MAX_TOKENS,
  classifyLLMError,
  createLLMOrchestrator,
  getUserActionHint,
} from '../foundation/llm-orchestrator/index.js';
import { toOrchestratorConfig } from '../assembly/index.js';
import { stripOrchestratorWrapper, truncateLLMMessage } from './utils/text.js';
import { LLM_REPAIR_ACTIONS, type LLMRepairAction } from './llm-repair-action.js';

type ProviderInput = llmProviderCall.ProviderInput;
type ProviderFactory = llmProviderCall.ProviderFactory;

export type LLMErrorType = 'auth' | 'model' | 'network' | 'rate_limit' | 'quota' | 'unknown';

export function classifyLLMErrorForDisplay(err: unknown): LLMErrorType {
  switch (getUserActionHint(err)) {
    case 'rotate_api_key': return 'auth';
    case 'switch_primary': return 'model';
    case 'wait_retry_after': return 'rate_limit';
    case 'check_quota': return 'quota';
    case 'check_endpoint':
    case 'check_network': return 'network';
    case null: return classifyLLMError(err) === 'transient' ? 'network' : 'unknown';
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
  auth: 'Update API key via "chestnut config provider repair <reference>", run "chestnut config provider login <label>" for OAuth providers, or fix ambient credentials (AWS profile / Google ADC / provider env).',
  model: 'Check that model name matches provider docs exactly.',
  network: 'Check internet connection or provider status page.',
  rate_limit: 'Wait a few seconds and retry; lower request frequency.',
  quota: 'Top up account credit or switch provider via "chestnut config".',
  unknown: 'See raw provider message above; report bug if persistent.',
};

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

export function formatLLMError(
  probe: { errorType: LLMErrorType; message: string; provider?: string; hint?: string },
): string[] {
  const lines = [`✗ ${LLM_ERROR_LABELS[probe.errorType]}`];
  if (probe.provider) lines.push(`  Provider: ${probe.provider}`);
  lines.push(`  ${truncateLLMMessage(stripOrchestratorWrapper(probe.message))}`);
  if (probe.hint) lines.push(`  Hint: ${probe.hint}`);
  return lines;
}

export interface LLMProbeOptions {
  authentication?: AuthenticationSetupCapability;
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

export async function probeLLMConnection(
  snapshot: LLMConfigSnapshot,
  options?: LLMProbeOptions,
): Promise<
  { ok: true; model: string; identity: string } |
  { ok: false; errorType: LLMErrorType; message: string; provider: string; identity: string }
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
    await svc.call({ messages: [{ role: 'user', content: 'Hi' }], maxTokens: LLM_PROBE_MAX_TOKENS });
    return { ok: true, model: snapshot.config.primary.input.model, identity: snapshot.identity };
  } catch (err) {
    callFailure = { error: err };
    return {
      ok: false,
      errorType: classifyLLMErrorForDisplay(err),
      message: formatErr(err),
      provider: snapshot.config.primary.displayName
        ?? llmProviderCall.describeProviderInput(snapshot.config.primary.input).providerId,
      identity: snapshot.identity,
    };
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

export async function checkLLMConnectionFor(
  provider: ProviderInput,
  options?: LLMProbeOptions,
): Promise<
  { ok: true; model: string } |
  { ok: false; errorType: LLMErrorType; message: string; provider: string }
> {
  const svc = createLLMOrchestrator(toOrchestratorConfig({
    primary: { input: provider, callDefaults: {} },
    fallbacks: [],
    retry: { maxAttempts: 1, delayMs: 0 },
  }, {
    events: { emit: () => {} },
    providerFactory: probeProviderFactory(options),
    lifecycle: { mode: 'ephemeral' },
  }));
  let callFailure: { error: unknown } | undefined;
  try {
    await svc.call({ messages: [{ role: 'user', content: 'Hi' }], maxTokens: LLM_PROBE_MAX_TOKENS });
    return { ok: true, model: provider.model };
  } catch (err) {
    callFailure = { error: err };
    return {
      ok: false,
      errorType: classifyLLMErrorForDisplay(err),
      message: formatErr(err),
      provider: llmProviderCall.describeProviderInput(provider).providerId,
    };
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
