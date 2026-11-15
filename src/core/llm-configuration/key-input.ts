/**
 * @module L4.LLMConfiguration.KeyInput
 *
 * 凭据引用识别、派生、解析与存储决策；不包含交互、日志或错误呈现。
 */
import {
  createLocalCredentials,
  isCredentialsError,
  type CredentialsOwner,
  type LocalCredentialsDeps,
} from './legacy-credentials/index.js';
import { isCredentialRefName } from './legacy-credentials/index.js';

const REF_LITERAL_RE = /^\$\{[^}]+\}$/;

/** `${VAR}` 字面引用判定（整串恰为一个引用）。 */
export function isCredentialReference(input: string): boolean {
  return REF_LITERAL_RE.test(input.trim());
}

/** 派生合法 ref 名：`CHESTNUT_<SANITIZED>_API_KEY`。 */
export function deriveCredentialRef(seed: string): string {
  const sanitized = seed
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase()
    .replace(/^([0-9])/, '_$1')
    .replace(/^_+|_+$/g, '');
  return `CHESTNUT_${sanitized === '' ? 'PRIMARY' : sanitized}_API_KEY`;
}

export type ApiKeyConfigValue =
  | { kind: 'reference'; ref: string }
  | { kind: 'legacy-plaintext'; value: string; source: 'config' | 'env' | 'fallback' }
  | { kind: 'missing' }
  | { kind: 'invalid-reference'; ref: string };

export class ApiKeyConfigError extends Error {
  constructor(
    readonly code: 'legacy_plaintext_unmigrated' | 'credential_unavailable' |
      'invalid_reference' | 'migration_conflict' | 'migration_not_confirmed',
    readonly role: string,
    readonly ref?: string,
  ) {
    super(`${code}: ${role}${ref ? ` (${ref})` : ''}`);
    this.name = 'ApiKeyConfigError';
  }
}

export function classifyApiKeyConfigValue(
  raw: unknown,
  source: 'config' | 'env' | 'fallback' = 'config',
): ApiKeyConfigValue {
  if (raw === undefined || raw === null || raw === '') return { kind: 'missing' };
  if (typeof raw !== 'string') return { kind: 'invalid-reference', ref: 'non-string' };
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'missing' };
  const match = /^\$\{([^}]+)\}$/.exec(trimmed);
  if (match) {
    return isCredentialRefName(match[1])
      ? { kind: 'reference', ref: match[1] }
      : { kind: 'invalid-reference', ref: 'invalid-name' };
  }
  if (trimmed.includes('${')) return { kind: 'invalid-reference', ref: 'unparseable' };
  return { kind: 'legacy-plaintext', value: raw, source };
}

/** Synchronous readers fail closed; migration is an explicit async owner action. */
export function assertNoLegacyPlaintextApiKey(raw: unknown): void {
  const visit = (value: unknown, role: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${role}[${index}]`));
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      const nextRole = role ? `${role}.${key}` : key;
      if (key === 'api_key') {
        const classified = classifyApiKeyConfigValue(entry);
        if (classified.kind === 'legacy-plaintext') {
          throw new ApiKeyConfigError('legacy_plaintext_unmigrated', nextRole);
        }
        if (classified.kind === 'invalid-reference') {
          throw new ApiKeyConfigError('invalid_reference', nextRole, classified.ref);
        }
      } else {
        visit(entry, nextRole);
      }
    }
  };
  visit(raw, '');
}

export type StoredCredentialInput =
  | { kind: 'reference'; reference: string }
  | { kind: 'stored'; reference: string; ref: string; created: boolean }
  | { kind: 'environment'; reference: string; ref: string };

/** 将引用或明文输入转换为配置引用；明文经 owner 存储，环境遮蔽按策略处理。 */
export async function storeCredentialInput(
  credentials: CredentialsOwner,
  input: string,
  ref: string,
  shadow: 'fallback' | 'error',
): Promise<StoredCredentialInput> {
  const value = input.trim();
  if (isCredentialReference(value)) return { kind: 'reference', reference: value };
  // 四层来源均计入已存在，初始化取消/失败清理不得删除先前值。
  const existed = credentials.resolve(ref) !== undefined;
  try {
    await credentials.set(ref, value);
    return { kind: 'stored', reference: '${' + ref + '}', ref, created: !existed };
  } catch (error) {
    if (isCredentialsError(error) && error.code === 'shadowed_by_env' && shadow === 'fallback') {
      return { kind: 'environment', reference: '${' + ref + '}', ref };
    }
    throw error;
  }
}

/** 只解析引用；legacy 明文必须经显式迁移，不得直达 provider。 */
export function resolveCredentialReference(
  deps: LocalCredentialsDeps,
  raw: string,
): string | undefined {
  const classified = classifyApiKeyConfigValue(raw);
  if (classified.kind === 'missing') return undefined;
  if (classified.kind !== 'reference') {
    throw new ApiKeyConfigError(
      classified.kind === 'invalid-reference' ? 'invalid_reference' : 'legacy_plaintext_unmigrated',
      'provider.api_key',
      classified.kind === 'invalid-reference' ? classified.ref : undefined,
    );
  }
  const credentials = createLocalCredentials(deps);
  return credentials.resolve(classified.ref)?.value;
}
