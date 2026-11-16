/**
 * @module L4.LLMConfiguration.Identity
 *
 * LLM 配置快照、稳定 auth identity 与 operational identity。secret 值不进入
 * scope、auth 或稳定身份；旧哈希仅保留给 adapter/reload 的 operational 判定。
 */
import type { LLMOrchestratorConfig } from '../../foundation/llm-orchestrator/index.js';
import { llmOrchestratorConfigSchema } from './config-schema.js';
import type { llmProviderCall } from '../../foundation/llm-provider/index.js';
type ProviderConnection = llmProviderCall.ProviderConnection;
import { llmProviderCredentialRuntime } from '../../foundation/llm-provider/index.js';
const { piAiCredentialRef } = llmProviderCredentialRuntime;
import { sha256Hex } from '../../foundation/node-utils/index.js';
import type { CredentialSource, CredentialsOwner } from './legacy-credentials/index.js';
import { classifyApiKeyConfigValue } from './key-input.js';
import {
  resolveLLMConfig,
  type LLMClawConfigView,
  type LLMConfigInput,
  type LLMGlobalConfigView,
  type SharedLLMInput,
  type LLMConnectionSelection,
} from './selection.js';

export interface LLMConfigScope {
  workspaceRoot?: string;
  workspaceRevision: number | 'uncommitted';
  primarySource: 'workspace' | 'claw_override';
  clawId?: string;
  documentSource: 'document' | 'draft' | 'legacy';
}

export interface CredentialProvenance {
  role: string;
  ref: string;
  source: CredentialSource | 'unresolved';
  identityRef: string;
  configured: boolean;
  writable: boolean;
  legacy: boolean;
  accountId?: string;
  identityVersion?: number;
}

export interface LLMAuthIdentity {
  role: string;
  provider: string;
  credentialRef: string;
  authProfile: string;
  accountId?: string;
  identityVersion: number;
  status: 'stable' | 'legacy' | 'unresolved';
  fingerprint: string;
}

export interface LLMConfigSnapshot {
  config: LLMConnectionSelection;
  scope: LLMConfigScope;
  credentials: readonly CredentialProvenance[];
  auth: readonly LLMAuthIdentity[];
  /** 稳定、非 secret 的 scope/config/auth 摘要，可入 audit/env。 */
  identity: string;
  /** 含 secret 变更检测的 operational 摘要；仅供 probe/reload/adapter 失效判定。 */
  operationalIdentity: string;
}

export interface LLMConfigSnapshotOptions {
  credentials?: CredentialsOwner;
  clawId?: string;
  workspaceRoot?: string;
  revision?: { readonly id: string; readonly revision: number };
  documentSource?: 'document' | 'draft' | 'legacy';
  credentialSources?: Readonly<Record<string, CredentialSource>>;
}

/** 递归排序键的稳定序列化（函数成员丢弃——装配注入物不参与身份）。 */
function stableIdentityStringify(value: unknown): string {
  if (value === undefined || typeof value === 'function') return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableIdentityStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableIdentityStringify(v)}`);
  return `{${entries.join(',')}}`;
}

type LLMIdentityConfig = Pick<
  LLMOrchestratorConfig,
  'primary' | 'fallbacks' | 'maxAttempts' | 'retryDelayMs' | 'circuitBreaker'
>;

/** Operational 投影只携 connection owner 给出的非 secret 认证版本。 */
function providerOperationalProjection(p: ProviderConnection): Record<string, unknown> {
  return {
    providerId: p.providerId,
    model: p.model,
    baseUrl: p.baseUrl,
    apiFormat: p.apiFormat,
    authentication: {
      kind: p.authentication.kind,
      identity: p.authentication.identity,
      profile: p.authentication.profile,
    },
    defaults: p.defaults,
  };
}

/** resolved 配置的 operational 摘要；不是稳定账号身份。 */
export function llmConfigIdentity(config: LLMIdentityConfig): string {
  return sha256Hex(stableIdentityStringify({
    primary: providerOperationalProjection(config.primary),
    fallbacks: (config.fallbacks ?? []).map(providerOperationalProjection),
    maxAttempts: config.maxAttempts,
    retryDelayMs: config.retryDelayMs,
    circuitBreaker: config.circuitBreaker,
  }));
}

type RawProvider = SharedLLMInput['primary'];

function providerStableProjection(p: ProviderConnection): Record<string, unknown> {
  const extraHeaders = p.defaults?.extraHeaders;
  return {
    providerId: p.providerId,
    model: p.model,
    baseUrl: p.baseUrl,
    apiFormat: p.apiFormat,
    authentication: {
      kind: p.authentication.kind,
      profile: p.authentication.profile,
      ...(p.authentication.kind === 'capability' ? { identity: p.authentication.identity } : {}),
    },
    defaults: {
      ...p.defaults,
      extraHeaders: extraHeaders === undefined ? undefined : Object.keys(extraHeaders).sort(),
    },
  };
}

function describeRef(
  credentials: CredentialsOwner | undefined,
  ref: string,
  fallbackConfigured: boolean,
  observedSource?: CredentialSource,
): Pick<CredentialProvenance, 'source' | 'identityRef' | 'configured' | 'writable'> & { accountId?: string; identityVersion?: number } {
  const info = credentials?.describe(ref);
  return {
    source: observedSource ?? info?.source ?? 'unresolved',
    identityRef: info?.credentialRef ?? ref,
    configured: observedSource !== undefined ? true : info?.configured ?? fallbackConfigured,
    writable: observedSource !== undefined ? observedSource === 'file' : info?.writable ?? false,
    ...(info?.accountId !== undefined ? { accountId: info.accountId } : {}),
    ...(info?.identityVersion !== undefined ? { identityVersion: info.identityVersion } : {}),
  };
}

function credentialForProvider(
  role: string,
  raw: RawProvider,
  resolved: ProviderConnection,
  credentials: CredentialsOwner | undefined,
  credentialSources: Readonly<Record<string, CredentialSource>>,
): { provenance: CredentialProvenance; auth: LLMAuthIdentity } {
  const authProfile = resolved.authentication.profile ?? 'api_key';
  const classified = classifyApiKeyConfigValue(raw.api_key);
  let ref: string;
  let legacy = false;
  let status: LLMAuthIdentity['status'] = 'stable';
  let described: ReturnType<typeof describeRef>;

  if (classified.kind === 'reference') {
    ref = classified.ref;
    described = describeRef(credentials, ref, resolved.authentication.kind === 'api_key', credentialSources[ref]);
  } else if (classified.kind === 'legacy-plaintext') {
    ref = `legacy:${role}`;
    legacy = true;
    status = 'legacy';
    described = { source: 'unresolved', identityRef: ref, configured: true, writable: false };
  } else if (authProfile === 'oauth') {
    ref = piAiCredentialRef(raw.provider_id ?? raw.preset ?? resolved.providerId);
    described = describeRef(credentials, ref, false);
  } else if (authProfile === 'ambient') {
    ref = `ambient:${resolved.providerId}`;
    described = { source: 'unresolved', identityRef: ref, configured: true, writable: false };
  } else {
    ref = `unresolved:${role}`;
    status = 'unresolved';
    described = { source: 'unresolved', identityRef: ref, configured: false, writable: false };
  }

  const accountId = described.accountId;
  const identityVersion = described.identityVersion ?? 1;
  const fingerprint = sha256Hex(stableIdentityStringify({
    provider: resolved.providerId,
    authProfile,
    credentialRef: described.identityRef,
    accountId,
    identityVersion,
    status,
  }));
  return {
    provenance: {
      role,
      ref,
      source: described.source,
      identityRef: described.identityRef,
      configured: described.configured,
      writable: described.writable,
      legacy,
      ...(accountId !== undefined ? { accountId } : {}),
      identityVersion,
    },
    auth: {
      role,
      provider: resolved.providerId,
      credentialRef: described.identityRef,
      authProfile,
      ...(accountId !== undefined ? { accountId } : {}),
      identityVersion,
      status,
      fingerprint,
    },
  };
}

function headerCredentialProvenance(
  role: string,
  raw: RawProvider,
  resolved: ProviderConnection,
  credentials: CredentialsOwner | undefined,
  credentialSources: Readonly<Record<string, CredentialSource>>,
): CredentialProvenance[] {
  const result: CredentialProvenance[] = [];
  for (const [header, value] of Object.entries(raw.extra_headers ?? {})) {
    const classified = classifyApiKeyConfigValue(value);
    if (classified.kind !== 'reference') continue;
    const described = describeRef(
      credentials,
      classified.ref,
      resolved.defaults?.extraHeaders?.[header] !== undefined,
      credentialSources[classified.ref],
    );
    result.push({
      role: `${role}.extra_headers.${header}`,
      ref: classified.ref,
      source: described.source,
      identityRef: described.identityRef,
      configured: described.configured,
      writable: described.writable,
      legacy: false,
      ...(described.accountId !== undefined ? { accountId: described.accountId } : {}),
      identityVersion: described.identityVersion ?? 1,
    });
  }
  return result;
}

/** 读取即快照：resolve、scope、credential/auth 与两种身份同源派生。 */
export function snapshotLLMConfig(
  globalConfig: LLMGlobalConfigView,
  clawConfig?: LLMClawConfigView,
  options: LLMConfigSnapshotOptions = {},
): LLMConfigSnapshot {
  const config = resolveLLMConfig(globalConfig, clawConfig);
  const rawGlobal = globalConfig.raw ?? globalConfig.llm;
  const hasOverride = clawConfig?.llm?.primary !== undefined;
  const rawProviders: Array<{ role: string; raw: RawProvider; resolved: ProviderConnection }> = [
    {
      role: 'primary',
      raw: hasOverride ? clawConfig!.raw?.primary ?? clawConfig!.llm!.primary! : rawGlobal.primary,
      resolved: config.primary,
    },
    ...(config.fallbacks ?? []).map((resolved, index) => {
      const raw = rawGlobal.fallbacks?.[index];
      if (raw === undefined) throw new Error(`Incomplete raw LLM credential evidence: fallbacks[${index}]`);
      return { role: `fallbacks[${index}]`, raw, resolved };
    }),
  ];
  const credentialSources = options.credentialSources ?? {
    ...globalConfig.credentialSources,
    ...clawConfig?.credentialSources,
  };
  const projected = rawProviders.map(({ role, raw, resolved }) =>
    credentialForProvider(role, raw, resolved, options.credentials, credentialSources));
  const headerCredentials = rawProviders.flatMap(({ role, raw, resolved }) =>
    headerCredentialProvenance(role, raw, resolved, options.credentials, credentialSources));
  const credentials = [...projected.map(entry => entry.provenance), ...headerCredentials];
  const auth = projected.map(entry => entry.auth);
  const revision = options.revision ?? globalConfig.revision;
  const workspaceRoot = options.workspaceRoot ?? globalConfig.workspaceRoot;
  const scope: LLMConfigScope = {
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    workspaceRevision: revision?.revision ?? 'uncommitted',
    primarySource: hasOverride ? 'claw_override' : 'workspace',
    ...(options.clawId !== undefined ? { clawId: options.clawId } : {}),
    documentSource: options.documentSource ?? (globalConfig.raw !== undefined ? 'document' : 'legacy'),
  };
  const identity = sha256Hex(stableIdentityStringify({
    scope: {
      primarySource: scope.primarySource,
      clawId: scope.clawId,
    },
    primary: providerStableProjection(config.primary),
    fallbacks: (config.fallbacks ?? []).map(providerStableProjection),
    maxAttempts: config.maxAttempts,
    retryDelayMs: config.retryDelayMs,
    circuitBreaker: config.circuitBreaker,
    auth: auth.map(({ fingerprint: _fingerprint, ...entry }) => entry),
    credentialRefs: credentials.map(entry => ({
      role: entry.role,
      identityRef: entry.identityRef,
      accountId: entry.accountId,
      identityVersion: entry.identityVersion,
      legacy: entry.legacy,
    })),
  }));
  return {
    config,
    scope,
    credentials,
    auth,
    identity,
    operationalIdentity: llmConfigIdentity(config),
  };
}

/** 未落盘 draft 先经 owner schema 默认填充，再按磁盘同形配置派生身份。 */
export function snapshotLLMConfigInput(
  input: LLMConfigInput,
  options: LLMConfigSnapshotOptions & { resolvedInput?: LLMConfigInput } = {},
): LLMConfigSnapshot {
  const { resolvedInput = input, ...snapshotOptions } = options;
  return snapshotLLMConfig(
    { llm: llmOrchestratorConfigSchema.parse(resolvedInput.llm), raw: input.llm },
    undefined,
    { ...snapshotOptions, documentSource: 'draft' },
  );
}

/** typed invalidation：验证身份与消费时身份不一致（fail-closed 证据）。 */
export class LLMConfigIdentityMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  constructor(expected: string, actual: string) {
    super(
      `LLM config identity mismatch: verified config is no longer current ` +
      `(expected=${expected.slice(0, 12)}…, actual=${actual.slice(0, 12)}…)`,
    );
    this.name = 'LLMConfigIdentityMismatchError';
    this.expected = expected;
    this.actual = actual;
  }
}
