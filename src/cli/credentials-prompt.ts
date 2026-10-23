/**
 * credentials-prompt - 交互输入 API key → Credentials owner + 配置引用（Phase 1925 Step B）
 *
 * 纪律：配置只保存 `${REF}` reference，secret 值由用户级 Credentials owner 管理
 * （~/.chestnut/credentials.yaml，0600/0700）。用户输入 `${VAR}` 字面时原样保留
 * （不触碰凭据文件）；输入明文 key 时经 owner set 落凭据文件、配置写 `${REF}`。
 * 进程环境已提供同名 ref（shadowed）时不写文件——`${REF}` 引用经 env 层即可解析。
 */

import type { FileSystem } from '../foundation/fs/index.js';
import {
  createLocalCredentials,
  isCredentialsError,
} from '../foundation/credentials/index.js';

/** `${VAR}` 字面引用判定（整串恰为一个引用）。 */
const REF_LITERAL_RE = /^\$\{[^}]+\}$/;

export function isCredentialReference(input: string): boolean {
  return REF_LITERAL_RE.test(input.trim());
}

/**
 * 派生合法 ref 名：`CHESTNUT_<SANITIZED>_API_KEY`。
 * sanitize：非 [A-Za-z0-9_] 折叠为 '_'、大写；数字开头前缀 '_'；空种子回落 'PRIMARY'。
 */
export function deriveCredentialRef(seed: string): string {
  const sanitized = seed
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase()
    .replace(/^([0-9])/, '_$1')
    .replace(/^_+|_+$/g, '');
  return `CHESTNUT_${sanitized === '' ? 'PRIMARY' : sanitized}_API_KEY`;
}

export interface StoreKeyContext {
  /** preset 携带的环境变量名（如 ANTHROPIC_API_KEY）——优先作为 ref。 */
  envVar?: string;
  /** 无 preset envVar 时的派生种子（label / preset id / format id）。 */
  seed?: string;
}

/** Phase 1976：setup 向导需要知道本次是否新建了凭据文件条目，以便失败/取消时清理。 */
export interface StoreKeyHooks {
  onStored?(ref: string, info: { created: boolean; value: string }): void;
}

/**
 * 把用户输入的 API key 转为配置可存的 `${REF}` 引用：
 * - 输入已是 `${VAR}` 字面 → 原样返回（引用语义由用户显式给出，不碰凭据文件）；
 * - 明文 → credentials.set(ref, value) 后返回 `${ref}`；
 * - shadowed_by_env（进程环境已提供同名值）→ 不写文件，同样返回 `${ref}`
 *   （env 层优先，引用可解析）；
 * - 其它 CredentialsError（permissions/io_error 等）loud 上抛。
 */
export async function storeKeyAsCredential(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  input: string,
  ctx: StoreKeyContext,
  hooks?: StoreKeyHooks,
): Promise<string> {
  const trimmed = input.trim();
  if (isCredentialReference(trimmed)) return trimmed;
  const ref = ctx.envVar ?? deriveCredentialRef(ctx.seed ?? 'primary');
  const credentials = createLocalCredentials({ fsFactory: deps.fsFactory });
  // 逐层已可解析（env / credentials 文件 / .env）= 已存在，取消时不得删除。
  const existed = credentials.resolve(ref) !== undefined;
  try {
    await credentials.set(ref, trimmed);
    console.log(`✓ Stored key as credential reference \${${ref}} (user credentials file)`);
    hooks?.onStored?.(ref, { created: !existed, value: trimmed });
  } catch (err) {
    if (isCredentialsError(err) && err.code === 'shadowed_by_env') {
      console.log(`✓ Will read ${ref} from the process environment at runtime`);
      hooks?.onStored?.(ref, { created: false, value: trimmed });
    } else {
      throw err;
    }
  }
  return '${' + ref + '}';
}

/**
 * 把配置态 api_key（可能是 `${REF}` 引用或 legacy 明文）解析为运行值。
 * 供 CLI 探测等「不经过 config-store 展开」的内存链路使用；引用无法解析时
 * 返回 undefined（调用方按缺凭据处理）。
 */
export function resolveCredentialReference(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  raw: string,
): string | undefined {
  const trimmed = raw.trim();
  const match = /^\$\{([^}]+)\}$/.exec(trimmed);
  if (!match) return raw;
  const credentials = createLocalCredentials({ fsFactory: deps.fsFactory });
  return credentials.resolve(match[1])?.value;
}
