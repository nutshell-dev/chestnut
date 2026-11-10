/**
 * credentials-prompt - 交互输入 API key 的呈现外壳。
 *
 * 引用与存储决策归 L4 LLMConfiguration；本模块只保留 console、hooks 与
 * CliError 映射。配置只保存 `${REF}`，secret 仍由兼容用户级 owner 管理。
 */

import type { FileSystem } from '../foundation/fs/index.js';
import {
  createLocalCredentials,
  deriveCredentialRef,
  isCredentialsError,
  storeCredentialInput,
} from '../core/llm-configuration/index.js';
import { CliError } from './errors.js';

export interface StoreKeyContext {
  /** preset 携带的环境变量名（如 ANTHROPIC_API_KEY）——优先作为 ref。 */
  envVar?: string;
  /** 无 preset envVar 时的派生种子（label / preset id / format id）。 */
  seed?: string;
  /** 'error' 时同名进程环境遮蔽 loud；缺省/'fallback' 保持静默回退。 */
  onShadowedEnv?: 'fallback' | 'error';
}

/** setup 向导记录新建条目，以便失败/取消时按原值清理。 */
export interface StoreKeyHooks {
  onStored?(ref: string, info: { created: boolean; value: string }): void;
  /** Machine adapters keep stdout reserved for their versioned protocol. */
  silent?: boolean;
}

/** 把用户输入转为配置引用，并呈现 L4 返回的存储事实。 */
export async function storeKeyAsCredential(
  deps: { fsFactory: (baseDir: string) => FileSystem },
  input: string,
  ctx: StoreKeyContext,
  hooks?: StoreKeyHooks,
): Promise<string> {
  const trimmed = input.trim();
  const ref = ctx.envVar ?? deriveCredentialRef(ctx.seed ?? 'primary');
  const credentials = createLocalCredentials({ fsFactory: deps.fsFactory });
  try {
    const result = await storeCredentialInput(
      credentials,
      trimmed,
      ref,
      ctx.onShadowedEnv ?? 'fallback',
    );
    if (result.kind === 'reference') return result.reference;
    if (result.kind === 'stored') {
      if (!hooks?.silent) console.log(`✓ Stored key as credential reference \${${ref}} (user credentials file)`);
      hooks?.onStored?.(ref, { created: result.created, value: trimmed });
    } else {
      if (!hooks?.silent) console.log(`✓ Will read ${ref} from the process environment at runtime`);
      hooks?.onStored?.(ref, { created: false, value: trimmed });
    }
    return result.reference;
  } catch (err) {
    if (ctx.onShadowedEnv === 'error' && isCredentialsError(err) && err.code === 'shadowed_by_env') {
      throw new CliError(
        `Credential ref ${ref} is set in the process environment; ` +
        `the key you typed cannot be stored. Unset ${ref} and retry.`,
      );
    }
    throw err;
  }
}
