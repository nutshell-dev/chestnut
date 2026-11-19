/**
 * @module L4.LLMConfiguration.Setup
 *
 * 显式 setup/assembly 认证公开入口。普通配置 barrel 不转发本模块；调用方必须
 * 明确选择同步展开、写入、compare-and-delete 或 raw read/modify 组合能力。
 * 文件格式、环境优先级、锁与 OAuth JSON 仍由 legacy owner/L1 adapter 所有。
 */
import {
  createLocalCredentials,
  type CredentialSource,
} from './legacy-credentials/index.js';
import {
  describeAuthentication,
  type AuthenticationCapabilityDeps,
  type ProviderAuthenticationDescription,
} from './authentication-types.js';

export interface ResolvedAuthenticationSetupCredential {
  readonly accessToken: string;
  readonly source: CredentialSource;
}

export interface AuthenticationSetupCapability {
  resolveSync(ref: string): ResolvedAuthenticationSetupCredential | undefined;
  describe(ref: string): ProviderAuthenticationDescription;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
  /** L1 CredentialStore setup 专用的原始字符串读取；普通认证面不提供。 */
  read(ref: string): Promise<string | undefined>;
  /** 完整闭包在 legacy owner 跨进程锁内执行，供 OAuth refresh/login 使用。 */
  modify(
    ref: string,
    fn: (current: string | undefined) => Promise<string | undefined>,
  ): Promise<string | undefined>;
}

/** 每次构造固定绑定同一个兼容 owner；不注册全局 backend，不引入 singleton。 */
export function createAuthenticationSetup(
  deps: AuthenticationCapabilityDeps,
): AuthenticationSetupCapability {
  const credentials = createLocalCredentials(deps);
  return {
    resolveSync(ref) {
      const resolved = credentials.resolve(ref);
      return resolved === undefined
        ? undefined
        : { accessToken: resolved.value, source: resolved.source };
    },
    describe(ref) {
      return describeAuthentication(ref, credentials.describe(ref));
    },
    set: (ref, value) => credentials.set(ref, value),
    unset: (ref) => credentials.unset(ref),
    read: (ref) => Promise.resolve(credentials.resolve(ref)?.value),
    modify: (ref, fn) => credentials.modify(ref, fn),
  };
}
