/**
 * @module L4.LLMConfiguration.AuthenticationStore
 *
 * 普通运行时认证面：只解析 API-key access token 并投影非 secret provenance。
 * legacy owner、文件/锁与 pi-ai runtime store 均不穿过此边界。
 */
import { ApiKeyConfigError } from './key-input.js';
import { createLocalCredentials } from './legacy-credentials/index.js';
import {
  describeAuthentication,
  type AuthenticationCapabilityDeps,
  type ProviderAuthenticationDescription,
} from './authentication-types.js';

export interface ProviderAuthenticationCapability {
  resolve(ref: string): Promise<{ readonly accessToken: string }>;
  describe(ref: string): ProviderAuthenticationDescription;
}

export type {
  AuthenticationCapabilityDeps,
  ProviderAuthenticationDescription,
} from './authentication-types.js';

/** 创建固定绑定兼容用户级 owner 的窄认证 capability；不暴露可写或 raw store 面。 */
export function createAuthenticationCapability(
  deps: AuthenticationCapabilityDeps,
): ProviderAuthenticationCapability {
  const credentials = createLocalCredentials(deps);
  return {
    async resolve(ref) {
      const resolved = credentials.resolve(ref);
      if (resolved === undefined) {
        throw new ApiKeyConfigError('credential_unavailable', 'provider.api_key', ref);
      }
      return { accessToken: resolved.value };
    },
    describe(ref) {
      return describeAuthentication(ref, credentials.describe(ref));
    },
  };
}
