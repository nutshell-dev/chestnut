import { describe, expect, it } from 'vitest';
import type { LLMResolvedConfiguration } from '../../src/core/llm-configuration/index.js';
import {
  toOrchestratorConfig,
  type OrchestratorAssemblyDeps,
} from '../../src/assembly/llm-orchestrator-config.js';

/** Explicit configuration round-trip fixtures; these are not production defaults. */
const RETRY_DELAY_FIXTURE_MS = 1234;
const CIRCUIT_RESET_FIXTURE_MS = 120000;

const primary = {
  baseUrl: 'https://primary.example.test',
  authentication: { kind: 'api_key' as const, value: 'key', identity: 'key' },
  model: 'primary-model',
  protocol: 'anthropic' as const,
};
const fallbackA = { ...primary, baseUrl: 'https://fallback-a.example.test', model: 'fallback-a-model' };
const fallbackB = { ...primary, baseUrl: 'https://fallback-b.example.test', model: 'fallback-b-model' };

function deps(): OrchestratorAssemblyDeps {
  return {
    events: { emit: () => {} },
    providerFactory: { create: () => { throw new Error('not used'); } },
    lifecycle: { mode: 'ephemeral' },
  };
}

describe('Assembly toOrchestratorConfig', () => {
  it('maps retry, copies fallbacks in order, and injects runtime dependencies', () => {
    const resolved: LLMResolvedConfiguration = {
      primary,
      fallbacks: [fallbackA, fallbackB],
      retry: { maxAttempts: 4, delayMs: RETRY_DELAY_FIXTURE_MS },
      legacyCircuitBreaker: { failureThreshold: 5, resetTimeoutMs: CIRCUIT_RESET_FIXTURE_MS },
    };
    const runtimeDeps = deps();

    const config = toOrchestratorConfig(resolved, runtimeDeps);

    expect(config.primary).toBe(primary);
    expect(config.fallbacks).toEqual([fallbackA, fallbackB]);
    expect(config.fallbacks).not.toBe(resolved.fallbacks);
    expect(config.maxAttempts).toBe(4);
    expect(config.retryDelayMs).toBe(RETRY_DELAY_FIXTURE_MS);
    expect(config.circuitBreaker).toEqual(resolved.legacyCircuitBreaker);
    expect(config.circuitBreaker).not.toBe(resolved.legacyCircuitBreaker);
    expect(config.events).toBe(runtimeDeps.events);
    expect(config.providerFactory).toBe(runtimeDeps.providerFactory);
    expect(config.lifecycle).toBe(runtimeDeps.lifecycle);
  });

  it('omits circuitBreaker when the legacy configuration is absent', () => {
    const resolved: LLMResolvedConfiguration = {
      primary,
      fallbacks: [],
      retry: { maxAttempts: 3, delayMs: 1000 },
    };

    const config = toOrchestratorConfig(resolved, deps());

    expect(config.circuitBreaker).toBeUndefined();
    expect('circuitBreaker' in config).toBe(false);
    expect(resolved).toEqual({
      primary,
      fallbacks: [],
      retry: { maxAttempts: 3, delayMs: 1000 },
    });
  });
});
