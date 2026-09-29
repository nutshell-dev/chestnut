/**
 * @module L2a.Credentials
 *
 * Credentials public barrel（Phase 1925 Step B）。
 * 跨模块 import 必经本 barrel，禁止 deep-import ./local.js / ./errors.js 等。
 */

export type {
  CredentialSource,
  ResolvedCredential,
  CredentialInfo,
  CredentialsOwner,
} from './types.js';
export { isCredentialRefName } from './types.js';

export { CredentialsError, isCredentialsError } from './errors.js';
export type { CredentialsErrorCode } from './errors.js';

export {
  getCredentialsHome,
  getCredentialsFilePath,
  getUserDotEnvPath,
  getProjectDotEnvPath,
} from './paths.js';

export { createLocalCredentials } from './local.js';
export type { LocalCredentialsDeps } from './local.js';

export { parseDotEnv } from './dotenv.js';
