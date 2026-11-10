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

/** 将配置态 api_key 解析为运行值；无法解析的引用返回 undefined。 */
export function resolveCredentialReference(
  deps: LocalCredentialsDeps,
  raw: string,
): string | undefined {
  const trimmed = raw.trim();
  const match = /^\$\{([^}]+)\}$/.exec(trimmed);
  if (!match) return raw;
  const credentials = createLocalCredentials(deps);
  return credentials.resolve(match[1])?.value;
}
