/** Shared neutral authentication contracts; no owner, setup, or runtime dependencies. */
import type { FileSystem } from '../../foundation/fs/index.js';
import type { CredentialSource } from './legacy-credentials/index.js';

export interface ProviderAuthenticationDescription {
  readonly identityRef: string;
  readonly accountId?: string;
  readonly identityVersion: number;
  readonly configured: boolean;
  readonly writable: boolean;
  readonly source?: CredentialSource;
}

export interface AuthenticationCapabilityDeps {
  fsFactory(baseDir: string): FileSystem;
  env?: NodeJS.ProcessEnv;
}

/** 将 legacy owner 的非 secret 元数据收窄为普通认证投影。 */
export function describeAuthentication(
  ref: string,
  info: {
    credentialRef?: string;
    accountId?: string;
    identityVersion?: number;
    configured: boolean;
    writable: boolean;
    source?: CredentialSource;
  },
): ProviderAuthenticationDescription {
  return {
    identityRef: info.credentialRef ?? ref,
    ...(info.accountId !== undefined ? { accountId: info.accountId } : {}),
    identityVersion: info.identityVersion ?? 1,
    configured: info.configured,
    writable: info.writable,
    ...(info.source !== undefined ? { source: info.source } : {}),
  };
}
