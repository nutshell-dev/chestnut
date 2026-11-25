import { describe, it, expect } from 'vitest';
import {
  resolveLLMConfig,
  snapshotLLMConfig,
  snapshotLLMConfigInput,
  llmConfigIdentity,
  LLMConfigIdentityMismatchError,
  type ProviderAuthenticationCapability,
  type SharedLLMInput,
} from '../../../src/core/llm-configuration/index.js';
import { createGlobalConfigSchema } from '../../../src/assembly/config/compose-config.js';

/** Explicit configuration round-trip fixtures; these are not production defaults. */
const RETRY_DELAY_FIXTURE_MS = 1_234;
const CIRCUIT_RESET_FIXTURE_MS = 120_000;
const DEFAULT_CIRCUIT_RESET_FIXTURE_MS = 60_000;

const input = {
  llm: {
    primary: { entry_id: '11111111-1111-4111-8111-111111111111', provider_id: 'custom:anthropic', api_format: 'anthropic', auth_profile: 'api_key', api_key: '${PRIMARY_KEY}', model: 'claude-fixed', base_url: 'https://provider.example.test' },
    fallbacks: [{ entry_id: '22222222-2222-4222-8222-222222222222', provider_id: 'custom:openai', api_format: 'openai', auth_profile: 'api_key', api_key: '${FALLBACK_KEY}', model: 'gpt-fixed', base_url: 'https://provider.example.test/v1' }],
    retry_attempts: 4,
    retry_delay_ms: RETRY_DELAY_FIXTURE_MS,
    circuit_breaker: { failure_threshold: 5, reset_timeout_ms: CIRCUIT_RESET_FIXTURE_MS },
  },
} as const;

const override = {
  llm: { primary: { entry_id: '33333333-3333-4333-8333-333333333333', provider_id: 'custom:openai', api_format: 'openai', auth_profile: 'api_key', api_key: '${OVERRIDE_KEY}', model: 'gpt-override', base_url: 'https://provider.example.test/v1' } },
} as const;

function snapshotWithPrimary(primary: SharedLLMInput['primary']) {
  return snapshotLLMConfigInput({ llm: { primary } });
}

function credentialsWith(
  entries: Record<string, { source: 'env' | 'file'; accountId?: string }>,
): ProviderAuthenticationCapability {
  return {
    resolve: async (ref) => ({ accessToken: entries[ref]?.source ?? 'missing' }),
    describe: (ref) => ({
      configured: entries[ref] !== undefined,
      source: entries[ref]?.source,
      writable: entries[ref]?.source === 'file',
      identityRef: ref,
      accountId: entries[ref]?.accountId,
      identityVersion: 1,
    }),
  };
}

describe('LLMConfiguration selection / identity', () => {
  it('L4 自有 retry/reset 默认值保持既有数值', () => {
    const snapshot = snapshotLLMConfigInput({
      llm: {
        primary: { provider_id: 'custom:anthropic', api_format: 'anthropic', auth_profile: 'api_key', api_key: '${PRIMARY_KEY}', model: 'claude-fixed', base_url: 'https://provider.example.test' },
        circuit_breaker: {},
      },
    });
    expect(snapshot.config.retry).toEqual({ maxAttempts: 3, delayMs: 1000 });
    expect(snapshot.config.legacyCircuitBreaker).toEqual({
      failureThreshold: 3,
      resetTimeoutMs: DEFAULT_CIRCUIT_RESET_FIXTURE_MS,
    });
  });

  it('snapshot 明确 scope、revision、provenance 与独立 operational identity', () => {
    const global = createGlobalConfigSchema().parse(input);
    const snapshot = snapshotLLMConfig(global, undefined, {
      revision: { id: '7', revision: 7 },
      workspaceRoot: '/workspace',
      credentials: credentialsWith({ PRIMARY_KEY: { source: 'env' }, FALLBACK_KEY: { source: 'file' } }),
    });
    expect(snapshot.scope).toEqual({
      workspaceRoot: '/workspace', workspaceRevision: 7,
      primarySource: 'workspace', documentSource: 'legacy',
    });
    expect(snapshot.credentials).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'primary', ref: 'PRIMARY_KEY', source: 'env', configured: true }),
      expect.objectContaining({ role: 'fallbacks[0]', ref: 'FALLBACK_KEY', source: 'file', writable: true }),
    ]));
    expect(snapshot.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.operationalIdentity).toBe(llmConfigIdentity(
      snapshot.config, {}, { id: '7', revision: 7 },
    ));
    expect(snapshot.identity).not.toBe(snapshot.operationalIdentity);
  });

  it('claw 只覆盖 primary，scope 与 ref 可审计且共享策略不变', () => {
    const global = createGlobalConfigSchema().parse(input);
    const snapshot = snapshotLLMConfig(global, override, { clawId: 'claw-a' });
    expect(snapshot.config.primary.input.model).toBe('gpt-override');
    expect(snapshot.config.primary.entryId).toBe(override.llm.primary.entry_id);
    expect(snapshot.config.fallbacks.map(provider => provider.input.model)).toEqual(['gpt-fixed']);
    expect(snapshot.config.fallbacks[0]?.entryId).toBe(input.llm.fallbacks[0].entry_id);
    expect(snapshot.auth.map(entry => entry.entryId)).toEqual([
      override.llm.primary.entry_id, input.llm.fallbacks[0].entry_id,
    ]);
    expect(snapshot.config.primary.input).not.toHaveProperty('entryId');
    expect(snapshot.config.primary.input).not.toHaveProperty('entry_id');
    expect(snapshot.config.retry).toEqual({ maxAttempts: 4, delayMs: RETRY_DELAY_FIXTURE_MS });
    expect(snapshot.config.legacyCircuitBreaker).toEqual({ failureThreshold: 5, resetTimeoutMs: CIRCUIT_RESET_FIXTURE_MS });
    expect(snapshot.scope).toMatchObject({ primarySource: 'claw_override', clawId: 'claw-a' });
    expect(snapshot.auth[0]).toMatchObject({ credentialRef: 'OVERRIDE_KEY', authProfile: 'api_key' });
    expect(snapshot.operationalIdentity).toBe(llmConfigIdentity(resolveLLMConfig(global, override)));
  });

  it('entryId 透出候选与 auth，但不改变既有 stable/operational identity 或 auth hash', () => {
    const { entry_id: _primaryId, ...primaryWithoutId } = input.llm.primary;
    const { entry_id: _fallbackId, ...fallbackWithoutId } = input.llm.fallbacks[0];
    const withoutIds = snapshotLLMConfigInput({
      llm: { ...input.llm, primary: primaryWithoutId, fallbacks: [fallbackWithoutId] },
    });
    const withIds = snapshotLLMConfigInput(input);

    expect(withIds.config.primary.entryId).toBe(input.llm.primary.entry_id);
    expect(withIds.auth.map(entry => entry.entryId)).toEqual([
      input.llm.primary.entry_id, input.llm.fallbacks[0].entry_id,
    ]);
    expect(withoutIds.auth.map(entry => entry.entryId)).toEqual([undefined, undefined]);
    expect(withIds.identity).toBe(withoutIds.identity);
    expect(withIds.operationalIdentity).toBe(withoutIds.operationalIdentity);
    expect(withIds.auth.map(entry => entry.fingerprint))
      .toEqual(withoutIds.auth.map(entry => entry.fingerprint));
  });

  it('revision 不造成稳定身份抖动，但会推进有效 snapshot 的 operational identity', () => {
    const global = createGlobalConfigSchema().parse(input);
    const fromInput = snapshotLLMConfigInput(input);
    const fromDisk = snapshotLLMConfig(global, undefined, {
      revision: { id: '9', revision: 9 }, documentSource: 'document',
    });
    const nextRevision = snapshotLLMConfig(global, undefined, {
      revision: { id: '10', revision: 10 }, documentSource: 'document',
    });
    expect(fromInput.scope).toMatchObject({ workspaceRevision: 'uncommitted', documentSource: 'draft' });
    expect(fromDisk.scope).toMatchObject({ workspaceRevision: 9, documentSource: 'document' });
    expect(fromInput.identity).toBe(fromDisk.identity);
    expect(nextRevision.identity).toBe(fromDisk.identity);
    expect(fromInput.operationalIdentity).not.toBe(fromDisk.operationalIdentity);
    expect(nextRevision.operationalIdentity).not.toBe(fromDisk.operationalIdentity);
  });

  it('同 ref secret rotation 保持 auth identity，operational identity 变化且不泄露 secret', () => {
    const resolvedInput = (secret: string) => ({
      llm: {
        ...input.llm,
        primary: { ...input.llm.primary, api_key: secret },
        fallbacks: [{ ...input.llm.fallbacks[0], api_key: secret }],
      },
    });
    const first = snapshotLLMConfigInput(input, { resolvedInput: resolvedInput('sk-first-secret-value') });
    const rotated = snapshotLLMConfigInput(input, { resolvedInput: resolvedInput('sk-second-secret-value') });
    expect(rotated.identity).toBe(first.identity);
    expect(rotated.auth).toEqual(first.auth);
    expect(rotated.operationalIdentity).not.toBe(first.operationalIdentity);
    const serialized = JSON.stringify({
      scope: rotated.scope,
      credentials: rotated.credentials,
      auth: rotated.auth,
      identity: rotated.identity,
    });
    expect(serialized).not.toContain('sk-first-secret-value');
    expect(serialized).not.toContain('sk-second-secret-value');
  });

  it('model/baseUrl/protocol 改变连接身份，调用默认值只改变 operational identity', () => {
    const base = {
      provider_id: 'custom:anthropic', api_format: 'anthropic', auth_profile: 'api_key',
      label: 'provider-fixed',
      api_key: '${PRIMARY_KEY}',
      model: 'claude-fixed', base_url: 'https://provider.example.test',
      temperature: 0.4,
    } as const;
    const first = snapshotWithPrimary(base);
    const changes: Array<readonly [string, SharedLLMInput['primary']]> = [
      ['model', { ...base, model: 'claude-other' }],
      ['baseUrl', { ...base, base_url: 'https://other.example.test' }],
      ['protocol', { ...base, provider_id: 'custom:openai', api_format: 'openai' }],
      ['behavior', { ...base, temperature: 0.8 }],
    ];

    for (const [field, primary] of changes) {
      const changed = snapshotWithPrimary(primary);
      if (field === 'behavior') expect(changed.identity, field).toBe(first.identity);
      else expect(changed.identity, field).not.toBe(first.identity);
      expect(changed.operationalIdentity, field).not.toBe(first.operationalIdentity);
    }
  });

  it('旧 extra_headers 在运行投影中 fail closed，且不泄露 header 值', () => {
    const base = {
      provider_id: 'custom:anthropic', api_format: 'anthropic', auth_profile: 'api_key',
      api_key: '${PRIMARY_KEY}',
      model: 'claude-fixed', base_url: 'https://provider.example.test',
      extra_headers: { 'X-Account': 'header-secret-value' },
    } as const;
    expect(() => snapshotWithPrimary(base)).toThrow(/extra_headers/);
    try {
      snapshotWithPrimary(base);
    } catch (error) {
      expect(String(error)).not.toContain('header-secret-value');
    }
  });

  it('不同 credentialRef/accountId 改变 auth identity，来源变化只改变 provenance', () => {
    const first = snapshotLLMConfigInput(input, {
      credentials: credentialsWith({
        PRIMARY_KEY: { source: 'env', accountId: 'account-a' },
        FALLBACK_KEY: { source: 'file' },
      }),
    });
    const sourceChanged = snapshotLLMConfigInput(input, {
      credentials: credentialsWith({
        PRIMARY_KEY: { source: 'file', accountId: 'account-a' },
        FALLBACK_KEY: { source: 'file' },
      }),
    });
    const accountChanged = snapshotLLMConfigInput(input, {
      credentials: credentialsWith({
        PRIMARY_KEY: { source: 'file', accountId: 'account-b' },
        FALLBACK_KEY: { source: 'file' },
      }),
    });
    const refChanged = snapshotLLMConfigInput({
      llm: { ...input.llm, primary: { ...input.llm.primary, api_key: '${OTHER_KEY}' } },
    });
    expect(sourceChanged.identity).toBe(first.identity);
    expect(sourceChanged.credentials[0]?.source).toBe('file');
    expect(accountChanged.identity).not.toBe(first.identity);
    expect(accountChanged.auth[0]?.fingerprint).not.toBe(first.auth[0]?.fingerprint);
    expect(refChanged.identity).not.toBe(first.identity);
    expect(refChanged.auth[0]?.credentialRef).toBe('OTHER_KEY');
  });

  it('旧 header 引用仍可由 raw 配置定位，但不进入运行身份', () => {
    const source = {
      llm: {
        primary: {
          provider_id: 'custom:anthropic', api_format: 'anthropic', auth_profile: 'api_key', api_key: '${PRIMARY_KEY}', model: 'claude-fixed', base_url: 'https://provider.example.test',
          extra_headers: { 'X-Account': '${HEADER_A}' },
        },
      },
    } as const;
    const parsed = createGlobalConfigSchema().parse(source);
    expect(parsed.llm.primary.extra_headers).toEqual({ 'X-Account': '${HEADER_A}' });
    expect(() => snapshotLLMConfig({ ...parsed, raw: source.llm })).toThrow(/extra_headers/);
  });

  it('oauth/ambient 与缺失 api_key 均在运行投影中 fail closed', () => {
    const oauthPrimary = { provider_id: 'openai-codex', api_format: 'openai-codex-responses', auth_profile: 'oauth', model: 'gpt-6.1-sol' } as const;
    const ambientPrimary = { provider_id: 'amazon-bedrock', api_format: 'bedrock-converse-stream', auth_profile: 'ambient', model: 'anthropic.claude-sonnet-4-6' } as const;
    const unresolvedInput = { llm: { primary: { provider_id: 'custom:anthropic', api_format: 'anthropic', auth_profile: 'api_key', model: 'claude-fixed', base_url: 'https://provider.example.test' } } } as const;
    expect(() => snapshotWithPrimary(oauthPrimary)).toThrow(/api_key connection/);
    expect(() => snapshotWithPrimary(ambientPrimary)).toThrow(/api_key connection/);
    expect(() => snapshotLLMConfigInput(unresolvedInput)).toThrow(/api_key/);
  });

  it('raw fallback evidence 缺失仍 fail closed', () => {
    const parsed = createGlobalConfigSchema().parse(input);
    expect(() => snapshotLLMConfig({
      ...parsed,
      raw: { ...input.llm, fallbacks: undefined },
    })).toThrow('Incomplete raw LLM credential evidence: fallbacks[0]');
  });

  it('legacy plaintext 不进入稳定 auth projection，mismatch 保留 typed 摘要证据', () => {
    const legacy = { llm: { primary: { provider_id: 'custom:anthropic', api_format: 'anthropic', auth_profile: 'api_key', api_key: 'sk-fixed-primary', model: 'claude-fixed', base_url: 'https://provider.example.test' } } } as const;
    const first = snapshotLLMConfigInput(legacy);
    const second = snapshotLLMConfigInput({ llm: { primary: { ...legacy.llm.primary, model: 'other' } } });
    expect(first.auth[0]).toMatchObject({ status: 'legacy', credentialRef: 'legacy:primary' });
    expect(JSON.stringify(first.auth)).not.toContain('sk-fixed-primary');
    const error = new LLMConfigIdentityMismatchError(first.identity, second.identity);
    expect(error.expected).toBe(first.identity);
    expect(error.actual).toBe(second.identity);
    expect(error.message).toContain(first.identity.slice(0, 12));
  });
});
