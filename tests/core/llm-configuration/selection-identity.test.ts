import { describe, it, expect } from 'vitest';
import {
  resolveLLMConfig,
  snapshotLLMConfig,
  snapshotLLMConfigInput,
  llmConfigIdentity,
  LLMConfigIdentityMismatchError,
  type CredentialsOwner,
} from '../../../src/core/llm-configuration/index.js';
import { createGlobalConfigSchema } from '../../../src/assembly/config/compose-config.js';

const input = {
  llm: {
    primary: { preset: 'anthropic', api_key: '${PRIMARY_KEY}', model: 'claude-fixed' },
    fallbacks: [{ preset: 'openai', api_key: '${FALLBACK_KEY}', model: 'gpt-fixed' }],
    retry_attempts: 4,
    retry_delay_ms: 1234,
    circuit_breaker: { failure_threshold: 5, reset_timeout_ms: 120000 },
  },
} as const;

const override = {
  llm: { primary: { preset: 'openai', api_key: '${OVERRIDE_KEY}', model: 'gpt-override' } },
} as const;

function credentialsWith(
  entries: Record<string, { source: 'env' | 'file'; accountId?: string }>,
): CredentialsOwner {
  return {
    describe: (ref) => ({
      configured: entries[ref] !== undefined,
      source: entries[ref]?.source,
      writable: entries[ref]?.source === 'file',
      credentialRef: ref,
      accountId: entries[ref]?.accountId,
      identityVersion: 1,
    }),
  } as CredentialsOwner;
}

describe('LLMConfiguration selection / identity', () => {
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
    expect(snapshot.operationalIdentity).toBe(llmConfigIdentity(snapshot.config));
    expect(snapshot.identity).not.toBe(snapshot.operationalIdentity);
  });

  it('claw 只覆盖 primary，scope 与 ref 可审计且共享策略不变', () => {
    const global = createGlobalConfigSchema().parse(input);
    const snapshot = snapshotLLMConfig(global, override, { clawId: 'claw-a' });
    expect(snapshot.config.primary.model).toBe('gpt-override');
    expect(snapshot.config.fallbacks?.map(provider => provider.model)).toEqual(['gpt-fixed']);
    expect(snapshot.config.maxAttempts).toBe(4);
    expect(snapshot.config.retryDelayMs).toBe(1234);
    expect(snapshot.config.circuitBreaker).toEqual({ failureThreshold: 5, resetTimeoutMs: 120000 });
    expect(snapshot.scope).toMatchObject({ primarySource: 'claw_override', clawId: 'claw-a' });
    expect(snapshot.auth[0]).toMatchObject({ credentialRef: 'OVERRIDE_KEY', authProfile: 'api_key' });
    expect(snapshot.operationalIdentity).toBe(llmConfigIdentity(resolveLLMConfig(global, override)));
  });

  it('draft 与磁盘同形配置身份一致，revision/source 不造成稳定身份抖动', () => {
    const fromInput = snapshotLLMConfigInput(input);
    const fromDisk = snapshotLLMConfig(createGlobalConfigSchema().parse(input), undefined, {
      revision: { id: '9', revision: 9 }, documentSource: 'document',
    });
    expect(fromInput.scope).toMatchObject({ workspaceRevision: 'uncommitted', documentSource: 'draft' });
    expect(fromDisk.scope).toMatchObject({ workspaceRevision: 9, documentSource: 'document' });
    expect(fromInput.identity).toBe(fromDisk.identity);
    expect(fromInput.operationalIdentity).toBe(fromDisk.operationalIdentity);
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

  it('extra header 的 ref/account 变化也改变稳定身份，来源变化不改变', () => {
    const withHeader = (ref: string) => ({
      llm: {
        primary: {
          preset: 'anthropic', api_key: '${PRIMARY_KEY}', model: 'claude-fixed',
          extra_headers: { 'X-Account': ref },
        },
      },
    } as const);
    const owner = credentialsWith({
      PRIMARY_KEY: { source: 'env' }, HEADER_A: { source: 'file', accountId: 'account-a' },
      HEADER_B: { source: 'file', accountId: 'account-a' },
    });
    const first = snapshotLLMConfigInput(withHeader('${HEADER_A}'), { credentials: owner });
    const refChanged = snapshotLLMConfigInput(withHeader('${HEADER_B}'), { credentials: owner });
    const sourceChanged = snapshotLLMConfigInput(withHeader('${HEADER_A}'), {
      credentials: credentialsWith({
        PRIMARY_KEY: { source: 'env' }, HEADER_A: { source: 'env', accountId: 'account-a' },
      }),
    });
    const accountChanged = snapshotLLMConfigInput(withHeader('${HEADER_A}'), {
      credentials: credentialsWith({
        PRIMARY_KEY: { source: 'env' }, HEADER_A: { source: 'file', accountId: 'account-b' },
      }),
    });
    expect(refChanged.identity).not.toBe(first.identity);
    expect(accountChanged.identity).not.toBe(first.identity);
    expect(sourceChanged.identity).toBe(first.identity);
  });

  it('oauth/ambient 使用稳定命名空间，缺失 api_key 显式 unresolved', () => {
    const oauth = snapshotLLMConfigInput({ llm: { primary: { preset: 'openai-codex' } } });
    const ambient = snapshotLLMConfigInput({ llm: { primary: { preset: 'amazon-bedrock' } } });
    const unresolved = snapshotLLMConfigInput({ llm: { primary: { preset: 'anthropic', auth_profile: 'api_key' } } });
    expect(oauth.auth[0]).toMatchObject({ credentialRef: 'PI_AI_CREDENTIAL_OPENAI_CODEX', status: 'stable' });
    expect(ambient.auth[0]).toMatchObject({ credentialRef: 'ambient:amazon-bedrock', status: 'stable' });
    expect(unresolved.auth[0]).toMatchObject({ credentialRef: 'unresolved:primary', status: 'unresolved' });
    expect(unresolved.credentials[0]?.configured).toBe(false);
  });

  it('legacy plaintext 不进入稳定 auth projection，mismatch 保留 typed 摘要证据', () => {
    const legacy = { llm: { primary: { preset: 'anthropic', api_key: 'sk-fixed-primary', model: 'claude-fixed' } } } as const;
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
